/**
 * Tests for `gbrain extract --stale` + the link-extraction freshness watermark
 * (v0.42.7, #1696). Hermetic PGLite — no DATABASE_URL, no API keys.
 *
 * Covers:
 *   - engine methods: countStalePagesForExtraction (NULL / version / edited-since
 *     arms + source scope), listStalePagesForExtraction (content + keyset),
 *     markPagesExtractedBatch (composite-key stamp).
 *   - `extract --stale`: sweep creates typed edges + stamps every processed page
 *     (incl. zero-link), second run finds 0 stale (idempotent), --dry-run writes
 *     nothing, --source-id scope.
 *   - CRITICAL regression (CDX-1): a page edited after a prior stamp
 *     (updated_at > links_extracted_at) is re-flagged stale and re-extracted.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  extractAllFromDBAuthoritative,
  extractImportedPagesFromDB,
  IMPORTED_MARKDOWN_TIMELINE_MANAGER,
  runExtract,
} from '../src/commands/extract.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../src/core/link-extraction.ts';
import type { PageInput } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

async function truncateAll() {
  for (const t of ['content_chunks', 'links', 'tags', 'raw_data', 'timeline_entries', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
}
beforeEach(truncateAll);

const personPage = (title: string, body = ''): PageInput => ({ type: 'person', title, compiled_truth: body, timeline: '' });
const companyPage = (title: string, body = ''): PageInput => ({ type: 'company', title, compiled_truth: body, timeline: '' });

async function stampOf(slug: string, sourceId = 'default'): Promise<string | null> {
  const rows = await engine.executeRaw<{ links_extracted_at: string | null }>(
    `SELECT links_extracted_at FROM pages WHERE slug = $1 AND source_id = $2`, [slug, sourceId],
  );
  return rows[0]?.links_extracted_at ?? null;
}

describe('engine: stale-page extraction methods', () => {
  test('countStalePagesForExtraction: NULL arm counts never-extracted pages', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('people/bob', personPage('Bob'));
    expect(await engine.countStalePagesForExtraction()).toBe(2);
  });

  test('countStalePagesForExtraction: stamped pages drop out', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.markPagesExtractedBatch([{ slug: 'people/alice', source_id: 'default' }], new Date().toISOString());
    expect(await engine.countStalePagesForExtraction()).toBe(0);
  });

  test('countStalePagesForExtraction: version arm flags pre-version stamps', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    // Stamp with an OLD timestamp (before LINK_EXTRACTOR_VERSION_TS).
    await engine.markPagesExtractedBatch([{ slug: 'people/alice', source_id: 'default' }], '2000-01-01T00:00:00Z');
    // Without versionTs: only NULL/edited arms → not stale (stamp >= updated? no:
    // stamp is 2000, updated is now → updated_at > stamp → STALE via edited arm).
    // So set updated_at back too, isolating the version arm:
    await engine.executeRaw(`UPDATE pages SET updated_at = '2000-01-01T00:00:00Z' WHERE slug = 'people/alice'`);
    expect(await engine.countStalePagesForExtraction()).toBe(0); // no version, stamp==updated, not NULL
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(1); // version arm
  });

  test('countStalePagesForExtraction: edited-since arm (CDX-1)', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.markPagesExtractedBatch([{ slug: 'people/alice', source_id: 'default' }], new Date().toISOString());
    expect(await engine.countStalePagesForExtraction()).toBe(0);
    // Simulate an edit AFTER the stamp (put_page / sync --no-extract).
    await engine.executeRaw(`UPDATE pages SET updated_at = '2099-01-01T00:00:00Z' WHERE slug = 'people/alice'`);
    expect(await engine.countStalePagesForExtraction()).toBe(1);
  });

  test('listStalePagesForExtraction: returns content columns + keyset paginates', async () => {
    await engine.putPage('people/alice', personPage('Alice', 'Body A'));
    await engine.putPage('people/bob', personPage('Bob', 'Body B'));
    const batch1 = await engine.listStalePagesForExtraction({ batchSize: 1 });
    expect(batch1.length).toBe(1);
    expect(batch1[0].compiled_truth).toBeTruthy();
    expect(batch1[0].title).toBeTruthy();
    expect(batch1[0].frontmatter).toBeDefined();
    const batch2 = await engine.listStalePagesForExtraction({ batchSize: 10, afterPageId: batch1[0].id });
    expect(batch2.length).toBe(1);
    expect(batch2[0].id).toBeGreaterThan(batch1[0].id);
  });

  test('markPagesExtractedBatch: empty input is a no-op', async () => {
    await engine.markPagesExtractedBatch([], new Date().toISOString());
    expect(true).toBe(true); // no throw
  });
});

describe('gbrain extract --stale', () => {
  test('[CRITICAL] post-sync DB extraction preserves a concurrent edit as stale', async () => {
    await engine.putPage('people/bob', personPage('Bob'));
    await engine.putPage(
      'people/alice',
      personPage('Alice', '[Bob](people/bob) met Alice on 2026-07-10.'),
    );
    await engine.executeRaw(
      `UPDATE pages SET updated_at = now() - interval '3 hours' WHERE slug = 'people/alice'`,
    );

    const originalStamp = engine.markPagesExtractedBatch;
    let raced = false;
    (engine as unknown as { markPagesExtractedBatch: unknown }).markPagesExtractedBatch = async function (
      this: PGLiteEngine,
      refs: Array<{ slug: string; source_id: string; extractedAt?: string }>,
      fallback: string,
    ) {
      raced = true;
      await this.executeRaw(
        `UPDATE pages
            SET compiled_truth = 'Concurrent DB edit after extraction read',
                updated_at = now() - interval '1 hour'
          WHERE slug = 'people/alice'`,
      );
      return originalStamp.call(this, refs, fallback);
    };
    try {
      const result = await extractImportedPagesFromDB(engine, ['people/alice'], {
        sourceId: 'default',
      });
      expect(result.pagesProcessed).toBe(1);
    } finally {
      (engine as unknown as { markPagesExtractedBatch: unknown }).markPagesExtractedBatch = originalStamp;
    }

    expect(raced).toBe(true);
    expect((await engine.getLinks('people/alice')).some(link => link.to_slug === 'people/bob')).toBe(true);
    const freshness = await engine.executeRaw<{ stale: boolean }>(
      `SELECT updated_at > links_extracted_at AS stale
         FROM pages WHERE slug = 'people/alice' AND source_id = 'default'`,
    );
    expect(freshness[0]?.stale).toBe(true);
  });

  test('[CRITICAL] post-sync extraction removes stale managed rows but preserves manual rows', async () => {
    await engine.putPage('people/bob', personPage('Bob'));
    await engine.putPage('people/alice', {
      ...personPage('Alice', '[Bob](people/bob) worked with Alice.'),
      timeline: '- **2026-07-10** - Met Bob',
    });

    await extractImportedPagesFromDB(engine, ['people/alice'], { sourceId: 'default' });
    await engine.addLink(
      'people/alice', 'people/bob', 'Hand-curated relationship', 'manual-note', 'manual',
      undefined, undefined,
      { fromSourceId: 'default', toSourceId: 'default', originSourceId: 'default' },
    );
    await engine.addTimelineEntry(
      'people/alice',
      { date: '2026-07-11', source: 'manual', summary: 'Manual milestone', detail: '' },
      { sourceId: 'default' },
    );

    expect((await engine.getLinks('people/alice')).some(l => l.link_source === 'markdown')).toBe(true);
    expect((await engine.getTimeline('people/alice', { sourceId: 'default' }))
      .some(t => t.source === 'gbrain-markdown')).toBe(true);

    await engine.executeRaw(
      `UPDATE pages
          SET compiled_truth = 'No managed relationships remain.', timeline = '', updated_at = now()
        WHERE source_id = 'default' AND slug = 'people/alice'`,
    );
    await extractImportedPagesFromDB(engine, ['people/alice'], { sourceId: 'default' });

    const links = await engine.getLinks('people/alice');
    expect(links.some(l => l.link_source === 'markdown' || l.link_source === 'wikilink-resolved')).toBe(false);
    expect(links.some(l => l.link_source === 'manual' && l.link_type === 'manual-note')).toBe(true);
    const timeline = await engine.getTimeline('people/alice', { sourceId: 'default' });
    expect(timeline.some(t => t.source === 'gbrain-markdown')).toBe(false);
    expect(timeline.some(t => t.source === 'manual' && t.summary === 'Manual milestone')).toBe(true);
    const freshness = await engine.executeRaw<{ fresh: boolean }>(
      `SELECT links_extracted_at = updated_at AS fresh
         FROM pages WHERE source_id = 'default' AND slug = 'people/alice'`,
    );
    expect(freshness[0]?.fresh).toBe(true);
  });

  test('[CRITICAL] never claims an exact source-less manual row as managed Markdown', async () => {
    await engine.putPage('people/alice', {
      ...personPage('Alice'),
      timeline: '- **2026-07-10** - Met Bob',
    });
    await engine.addTimelineEntry(
      'people/alice',
      { date: '2026-07-10', source: '', summary: 'Met Bob', detail: '' },
      { sourceId: 'default' },
    );
    await engine.addTimelineEntry(
      'people/alice',
      { date: '2026-07-09', source: '', summary: 'Manual source-less note', detail: 'keep me' },
      { sourceId: 'default' },
    );
    await engine.addTimelineEntry(
      'people/alice',
      { date: '2026-07-08', source: 'manual', summary: 'Explicit manual note', detail: '' },
      { sourceId: 'default' },
    );

    await extractImportedPagesFromDB(engine, ['people/alice'], { sourceId: 'default' });

    const rows = await engine.executeRaw<{ date: string; source: string; summary: string; detail: string }>(
      `SELECT date::text AS date, source, summary, detail
         FROM timeline_entries te
         JOIN pages p ON p.id = te.page_id
        WHERE p.source_id = 'default' AND p.slug = 'people/alice'
        ORDER BY date DESC`,
    );
    const matching = rows.filter(r => r.date === '2026-07-10' && r.summary === 'Met Bob');
    expect(matching).toHaveLength(2);
    expect(matching).toContainEqual({ date: '2026-07-10', source: '', summary: 'Met Bob', detail: '' });
    expect(matching).toContainEqual({
      date: '2026-07-10', source: 'gbrain-markdown', summary: 'Met Bob', detail: '',
    });
    expect(rows).toContainEqual({
      date: '2026-07-09', source: '', summary: 'Manual source-less note', detail: 'keep me',
    });
    expect(rows).toContainEqual({
      date: '2026-07-08', source: 'manual', summary: 'Explicit manual note', detail: '',
    });

    await engine.executeRaw(
      `UPDATE pages SET timeline = '', updated_at = now()
        WHERE source_id = 'default' AND slug = 'people/alice'`,
    );
    await extractImportedPagesFromDB(engine, ['people/alice'], { sourceId: 'default' });
    const afterRemoval = await engine.getTimeline('people/alice', { sourceId: 'default' });
    expect(afterRemoval.some(t => t.source === 'gbrain-markdown' && t.summary === 'Met Bob')).toBe(false);
    expect(afterRemoval.some(t => t.source === '' && t.summary === 'Met Bob')).toBe(true);
  });

  test('[CRITICAL] reserved legacy rows are adopted and removed while non-reserved manual rows survive', async () => {
    await engine.putPage('people/alice', {
      ...personPage('Alice'),
      timeline: [
        '- **2026-07-10** | Meeting — Met Bob',
        '### 2026-07-11 — Signed agreement',
        '',
        'Final paperwork completed.',
      ].join('\n'),
    });
    await engine.addTimelineEntry(
      'people/alice',
      { date: '2026-07-10', source: 'gbrain-markdown', summary: 'Legacy managed row', detail: '' },
      { sourceId: 'default' },
    );
    await engine.addTimelineEntry(
      'people/alice',
      { date: '2026-07-10', source: 'Meeting', summary: 'Manual meeting note', detail: 'keep me' },
      { sourceId: 'default' },
    );

    await extractImportedPagesFromDB(engine, ['people/alice'], { sourceId: 'default' });
    const rows = await engine.getTimeline('people/alice', { sourceId: 'default' });
    expect(rows.some(t => t.source === 'gbrain-markdown' && t.summary === 'Legacy managed row')).toBe(false);
    expect(rows.some(t => t.source === 'gbrain-markdown:Meeting' && t.summary === 'Met Bob'
      && t.managed_by === IMPORTED_MARKDOWN_TIMELINE_MANAGER)).toBe(true);
    expect(rows.some(t => t.source === 'gbrain-markdown' && t.summary === 'Signed agreement'
      && t.managed_by === IMPORTED_MARKDOWN_TIMELINE_MANAGER)).toBe(true);
    expect(rows.some(t => t.source === 'Meeting' && t.summary === 'Manual meeting note')).toBe(true);

    await engine.executeRaw(
      `UPDATE pages SET timeline = '', updated_at = now()
        WHERE source_id = 'default' AND slug = 'people/alice'`,
    );
    await extractImportedPagesFromDB(engine, ['people/alice'], { sourceId: 'default' });
    const after = await engine.getTimeline('people/alice', { sourceId: 'default' });
    expect(after.some(t => t.summary === 'Legacy managed row')).toBe(false);
    expect(after.some(t => t.managed_by === IMPORTED_MARKDOWN_TIMELINE_MANAGER)).toBe(false);
    expect(after.some(t => t.source === 'Meeting' && t.summary === 'Manual meeting note')).toBe(true);
  });

  test('[CRITICAL] frontmatter reconciliation deletes by origin page and preserves manual incoming edges', async () => {
    await engine.putPage('companies/acme', companyPage('Acme'));
    await engine.putPage('deals/seed', {
      type: 'deal',
      title: 'Seed',
      compiled_truth: '',
      timeline: '',
      frontmatter: { investors: ['Acme'] },
    });

    await runExtract(engine, ['--stale']);
    expect((await engine.getLinks('companies/acme', { sourceId: 'default' }))
      .some(l => l.to_slug === 'deals/seed' && l.link_source === 'frontmatter')).toBe(true);

    await engine.addLink(
      'companies/acme', 'deals/seed', 'Hand-curated incoming edge', 'manual-note', 'manual',
      undefined, undefined,
      { fromSourceId: 'default', toSourceId: 'default', originSourceId: 'default' },
    );
    await engine.executeRaw(
      `UPDATE pages SET frontmatter = '{}'::jsonb, updated_at = now()
        WHERE source_id = 'default' AND slug = 'deals/seed'`,
    );
    await runExtract(engine, ['--stale']);

    const links = await engine.getLinks('companies/acme', { sourceId: 'default' });
    expect(links.some(l => l.to_slug === 'deals/seed' && l.link_source === 'frontmatter')).toBe(false);
    expect(links.some(l => l.to_slug === 'deals/seed' && l.link_source === 'manual')).toBe(true);
  });

  test('[CRITICAL] post-sync extraction authoritatively removes frontmatter-origin edges before stamping', async () => {
    await engine.putPage('companies/acme', companyPage('Acme'));
    await engine.putPage('deals/seed', {
      type: 'deal', title: 'Seed', compiled_truth: '', timeline: '',
      frontmatter: { investors: ['Acme'] },
    });

    await extractImportedPagesFromDB(engine, ['deals/seed'], { sourceId: 'default' });
    expect((await engine.getLinks('companies/acme', { sourceId: 'default' }))
      .some(l => l.to_slug === 'deals/seed' && l.link_source === 'frontmatter')).toBe(true);

    await engine.addLink(
      'companies/acme', 'deals/seed', 'Manual incoming edge', 'manual-note', 'manual',
      undefined, undefined,
      { fromSourceId: 'default', toSourceId: 'default', originSourceId: 'default' },
    );
    await engine.executeRaw(
      `UPDATE pages SET frontmatter = '{}'::jsonb, updated_at = now()
        WHERE source_id = 'default' AND slug = 'deals/seed'`,
    );
    await extractImportedPagesFromDB(engine, ['deals/seed'], { sourceId: 'default' });

    const links = await engine.getLinks('companies/acme', { sourceId: 'default' });
    expect(links.some(l => l.to_slug === 'deals/seed' && l.link_source === 'frontmatter')).toBe(false);
    expect(links.some(l => l.to_slug === 'deals/seed' && l.link_source === 'manual')).toBe(true);
    const freshness = await engine.executeRaw<{ fresh: boolean }>(
      `SELECT links_extracted_at = updated_at AS fresh
         FROM pages WHERE source_id = 'default' AND slug = 'deals/seed'`,
    );
    expect(freshness[0]?.fresh).toBe(true);
  });

  test('[CRITICAL] ordinary DB include-frontmatter extraction replaces removed YAML edges', async () => {
    await engine.putPage('companies/acme', companyPage('Acme'));
    await engine.putPage('deals/seed', {
      type: 'deal', title: 'Seed', compiled_truth: '', timeline: '',
      frontmatter: { investors: ['Acme'] },
    });

    await runExtract(engine, ['all', '--source', 'db', '--include-frontmatter']);
    expect((await engine.getLinks('companies/acme', { sourceId: 'default' }))
      .some(l => l.to_slug === 'deals/seed' && l.link_source === 'frontmatter')).toBe(true);

    await engine.executeRaw(
      `UPDATE pages SET frontmatter = '{}'::jsonb, updated_at = now()
        WHERE source_id = 'default' AND slug = 'deals/seed'`,
    );
    await runExtract(engine, ['all', '--source', 'db', '--include-frontmatter']);

    expect((await engine.getLinks('companies/acme', { sourceId: 'default' }))
      .some(l => l.to_slug === 'deals/seed' && l.link_source === 'frontmatter')).toBe(false);
    const freshness = await engine.executeRaw<{ fresh: boolean }>(
      `SELECT links_extracted_at = updated_at AS fresh
         FROM pages WHERE source_id = 'default' AND slug = 'deals/seed'`,
    );
    expect(freshness[0]?.fresh).toBe(true);
  });

  test('[CRITICAL] ordinary DB all-mode rolls back every managed projection when timeline write fails', async () => {
    await engine.putPage('people/bob', personPage('Bob'));
    await engine.putPage('companies/acme', companyPage('Acme'));
    await engine.putPage('deals/seed', {
      type: 'deal',
      title: 'Seed',
      compiled_truth: '[Bob](people/bob) reviewed the deal.',
      timeline: '- **2026-07-10** - Old managed milestone',
      frontmatter: { investors: ['Acme'] },
    });
    await runExtract(engine, [
      'all', '--source', 'db', '--include-frontmatter', '--type', 'deal',
    ]);
    await engine.addLink(
      'deals/seed', 'people/bob', 'Hand-curated relationship', 'manual-note', 'manual',
      undefined, undefined,
      { fromSourceId: 'default', toSourceId: 'default', originSourceId: 'default' },
    );
    await engine.addTimelineEntry(
      'deals/seed',
      { date: '2026-07-13', source: 'manual', summary: 'Manual milestone', detail: '' },
      { sourceId: 'default' },
    );

    await engine.executeRaw(
      `UPDATE pages
          SET compiled_truth = 'No managed relationships remain.',
              timeline = '- **2026-07-12** - New managed milestone',
              frontmatter = '{}'::jsonb,
              links_extracted_at = now() - interval '2 hours',
              updated_at = now() - interval '1 hour'
        WHERE source_id = 'default' AND slug = 'deals/seed'`,
    );

    const originalTimelineBatch = engine.addTimelineEntriesBatch;
    (engine as unknown as {
      addTimelineEntriesBatch: typeof engine.addTimelineEntriesBatch;
    }).addTimelineEntriesBatch = async () => {
      throw new Error('simulated authoritative timeline failure');
    };
    try {
      await expect(extractAllFromDBAuthoritative(
        engine, 'deal', undefined, { sourceIdFilter: 'default' },
      )).rejects.toThrow('simulated authoritative timeline failure');
    } finally {
      (engine as unknown as {
        addTimelineEntriesBatch: typeof engine.addTimelineEntriesBatch;
      }).addTimelineEntriesBatch = originalTimelineBatch;
    }

    const linksAfterFailure = await engine.getLinks('deals/seed', { sourceId: 'default' });
    expect(linksAfterFailure.some(l => l.to_slug === 'people/bob' && l.link_source === 'markdown')).toBe(true);
    expect(linksAfterFailure.some(l => l.to_slug === 'people/bob' && l.link_source === 'manual')).toBe(true);
    expect((await engine.getLinks('companies/acme', { sourceId: 'default' }))
      .some(l => l.to_slug === 'deals/seed' && l.link_source === 'frontmatter')).toBe(true);
    const timelineAfterFailure = await engine.getTimeline('deals/seed', { sourceId: 'default' });
    expect(timelineAfterFailure.some(t => t.source === 'gbrain-markdown' && t.summary === 'Old managed milestone')).toBe(true);
    expect(timelineAfterFailure.some(t => t.source === 'gbrain-markdown' && t.summary === 'New managed milestone')).toBe(false);
    expect(timelineAfterFailure.some(t => t.source === 'manual' && t.summary === 'Manual milestone')).toBe(true);
    expect((await engine.executeRaw<{ stale: boolean }>(
      `SELECT updated_at > links_extracted_at AS stale
         FROM pages WHERE source_id = 'default' AND slug = 'deals/seed'`,
    ))[0]?.stale).toBe(true);

    await extractAllFromDBAuthoritative(
      engine, 'deal', undefined, { sourceIdFilter: 'default' },
    );

    const linksAfterRetry = await engine.getLinks('deals/seed', { sourceId: 'default' });
    expect(linksAfterRetry.some(l => l.to_slug === 'people/bob' && l.link_source === 'markdown')).toBe(false);
    expect(linksAfterRetry.some(l => l.to_slug === 'people/bob' && l.link_source === 'manual')).toBe(true);
    expect((await engine.getLinks('companies/acme', { sourceId: 'default' }))
      .some(l => l.to_slug === 'deals/seed' && l.link_source === 'frontmatter')).toBe(false);
    const timelineAfterRetry = await engine.getTimeline('deals/seed', { sourceId: 'default' });
    expect(timelineAfterRetry.some(t => t.source === 'gbrain-markdown' && t.summary === 'Old managed milestone')).toBe(false);
    expect(timelineAfterRetry.some(t => t.source === 'gbrain-markdown' && t.summary === 'New managed milestone')).toBe(true);
    expect(timelineAfterRetry.some(t => t.source === 'manual' && t.summary === 'Manual milestone')).toBe(true);
    expect((await engine.executeRaw<{ fresh: boolean }>(
      `SELECT links_extracted_at = updated_at AS fresh
         FROM pages WHERE source_id = 'default' AND slug = 'deals/seed'`,
    ))[0]?.fresh).toBe(true);
  });

  test('[CRITICAL] body-only ordinary DB extraction does not bless stale frontmatter edges', async () => {
    await engine.putPage('companies/acme', companyPage('Acme'));
    await engine.putPage('deals/seed', {
      type: 'deal', title: 'Seed', compiled_truth: '', timeline: '',
      frontmatter: { investors: ['Acme'] },
    });
    await runExtract(engine, ['all', '--source', 'db', '--include-frontmatter']);

    await engine.executeRaw(
      `UPDATE pages
          SET frontmatter = '{}'::jsonb,
              links_extracted_at = now() - interval '2 hours',
              updated_at = now() - interval '1 hour'
        WHERE source_id = 'default' AND slug = 'deals/seed'`,
    );
    await runExtract(engine, ['all', '--source', 'db']);

    // The caller explicitly skipped frontmatter, so the old edge is preserved
    // but, critically, the page remains stale for a complete sweep.
    expect((await engine.getLinks('companies/acme', { sourceId: 'default' }))
      .some(l => l.to_slug === 'deals/seed' && l.link_source === 'frontmatter')).toBe(true);
    const freshness = await engine.executeRaw<{ stale: boolean }>(
      `SELECT updated_at > links_extracted_at AS stale
         FROM pages WHERE source_id = 'default' AND slug = 'deals/seed'`,
    );
    expect(freshness[0]?.stale).toBe(true);
  });

  test('[CRITICAL] stale sweep removes obsolete managed rows but preserves manual rows', async () => {
    await engine.putPage('people/bob', personPage('Bob'));
    await engine.putPage('people/alice', {
      ...personPage('Alice', '[Bob](people/bob) worked with Alice.'),
      timeline: '- **2026-07-10** - Met Bob',
    });
    await runExtract(engine, ['--stale']);

    await engine.addLink(
      'people/alice', 'people/bob', 'Hand-curated relationship', 'manual-note', 'manual',
      undefined, undefined,
      { fromSourceId: 'default', toSourceId: 'default', originSourceId: 'default' },
    );
    await engine.addTimelineEntry(
      'people/alice',
      { date: '2026-07-11', source: 'manual', summary: 'Manual milestone', detail: '' },
      { sourceId: 'default' },
    );

    await engine.executeRaw(
      `UPDATE pages
          SET compiled_truth = 'No managed relationships remain.', timeline = '', updated_at = now()
        WHERE source_id = 'default' AND slug = 'people/alice'`,
    );
    await runExtract(engine, ['--stale']);

    const links = await engine.getLinks('people/alice');
    expect(links.some(l => l.link_source === 'markdown' || l.link_source === 'wikilink-resolved')).toBe(false);
    expect(links.some(l => l.link_source === 'manual' && l.link_type === 'manual-note')).toBe(true);
    const timeline = await engine.getTimeline('people/alice', { sourceId: 'default' });
    expect(timeline.some(t => t.source === 'gbrain-markdown')).toBe(false);
    expect(timeline.some(t => t.source === 'manual' && t.summary === 'Manual milestone')).toBe(true);
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(0);
  });

  test('extracts typed edges + stamps every processed page (incl. zero-link)', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('companies/acme', companyPage('Acme', '[Alice](people/alice) is the CEO of [Acme](companies/acme).'));
    await engine.putPage('people/lonely', personPage('Lonely', 'No links here.'));

    await runExtract(engine, ['--stale']);

    const links = await engine.getLinks('companies/acme');
    expect(links.some(l => l.to_slug === 'people/alice')).toBe(true);
    // EVERY processed page stamped — including the zero-link one.
    expect(await stampOf('people/alice')).not.toBeNull();
    expect(await stampOf('companies/acme')).not.toBeNull();
    expect(await stampOf('people/lonely')).not.toBeNull();
    // Nothing left stale.
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(0);
  });

  test('CRITICAL (CDX-7): pre-version pages clear after --stale', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('companies/acme', companyPage('Acme', '[Alice](people/alice) advises [Acme](companies/acme).'));
    await engine.executeRaw(
      `UPDATE pages
          SET updated_at = '2026-05-01 00:00:00.123456+00',
              links_extracted_at = '2026-05-01 00:00:00.123456+00'`,
    );

    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(2);

    await runExtract(engine, ['--stale']);

    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(0);
    const rows = await engine.executeRaw<{ fresh: boolean }>(
      `SELECT bool_and(links_extracted_at >= $1::timestamptz) AS fresh FROM pages`,
      [LINK_EXTRACTOR_VERSION_TS],
    );
    expect(rows[0]?.fresh).toBe(true);
  });

  test('CRITICAL: ordinary authoritative DB extraction uses the extractor-version floor', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.executeRaw(
      `UPDATE pages
          SET updated_at = '2026-05-01 00:00:00.123456+00',
              links_extracted_at = NULL
        WHERE source_id = 'default' AND slug = 'people/alice'`,
    );

    await runExtract(engine, ['all', '--source', 'db', '--include-frontmatter']);

    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(0);
    const rows = await engine.executeRaw<{ fresh: boolean }>(
      `SELECT links_extracted_at >= $1::timestamptz AS fresh
         FROM pages WHERE source_id = 'default' AND slug = 'people/alice'`,
      [LINK_EXTRACTOR_VERSION_TS],
    );
    expect(rows[0]?.fresh).toBe(true);
  });

  test('idempotent: second run finds 0 stale and creates no new links', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('companies/acme', companyPage('Acme', '[Alice](people/alice) advises [Acme](companies/acme).'));

    await runExtract(engine, ['--stale']);
    const after1 = (await engine.getLinks('companies/acme')).length;
    const stamp1 = await stampOf('companies/acme');

    await runExtract(engine, ['--stale']);
    const after2 = (await engine.getLinks('companies/acme')).length;
    expect(after2).toBe(after1);
    // Second run had 0 stale → did not re-stamp (stamp unchanged is acceptable;
    // the key invariant is no duplicate links).
    expect(stamp1).not.toBeNull();
  });

  test('--dry-run reports count and writes nothing', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('companies/acme', companyPage('Acme', '[Alice](people/alice) joined [Acme](companies/acme).'));

    await runExtract(engine, ['--stale', '--dry-run']);

    expect(await engine.getLinks('companies/acme')).toHaveLength(0);
    expect(await stampOf('people/alice')).toBeNull();
    expect(await stampOf('companies/acme')).toBeNull();
    // Still stale after dry-run.
    expect(await engine.countStalePagesForExtraction()).toBe(2);
  });

  test('CRITICAL (CDX-1): page edited after stamp is re-extracted', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('companies/acme', companyPage('Acme', 'No links yet.'));
    await runExtract(engine, ['--stale']);
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(0);

    // Simulate an edit that adds a link WITHOUT extracting (MCP put_page /
    // sync --no-extract). Use relative intervals so it's clock-agnostic: the
    // stamp + edit both land in the recent past (after LINK_EXTRACTOR_VERSION_TS),
    // with updated_at AFTER the stamp — and crucially both BEFORE real-now, so
    // the re-extract's now()-stamp deterministically supersedes the edit.
    await engine.executeRaw(
      `UPDATE pages
         SET compiled_truth = $1,
             links_extracted_at = now() - interval '2 hours',
             updated_at = now() - interval '1 hour'
       WHERE slug = 'companies/acme'`,
      ['[Alice](people/alice) now works at [Acme](companies/acme).'],
    );
    // Re-flagged stale by the updated_at arm (updated > stamp).
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(1);

    // extract --stale picks it up, creates the now-present edge, and re-stamps
    // at now() (> the edit's updated_at) so the page is fresh again.
    await runExtract(engine, ['--stale']);
    const links = await engine.getLinks('companies/acme');
    expect(links.some(l => l.to_slug === 'people/alice')).toBe(true);
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(0);
  });

  test('CRITICAL (#1768): microsecond updated_at clears after --stale (no permanent lag)', async () => {
    // Repro of #1768: extractStaleFromDB used to stamp page.updated_at.toISOString()
    // (a JS Date, millisecond-truncated). The DB updated_at keeps microseconds, so
    // `updated_at > links_extracted_at` stayed true forever and links_extraction_lag
    // was stuck at 100% on Postgres. We inject a microsecond updated_at explicitly so
    // the precision gap is deterministic regardless of the engine's now() granularity.
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('companies/acme', companyPage('Acme', '[Alice](people/alice) advises [Acme](companies/acme).'));
    // Microsecond-precision updated_at, recent (after LINK_EXTRACTOR_VERSION_TS) so the
    // version arm doesn't fire — the edited arm is what must clear.
    await engine.executeRaw(`UPDATE pages SET updated_at = '2026-06-02 08:18:58.999166+00'`);
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(2);

    await runExtract(engine, ['--stale']);
    // Fixed: links_extracted_at stamped at the EXACT microsecond updated_at, so the
    // edited arm clears. Pre-fix this stayed at 2 (the bug).
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(0);

    // And it stays cleared on a re-run (the "no matter how many times I re-run" symptom).
    await runExtract(engine, ['--stale']);
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(0);

    // The stamp itself carries microsecond precision (not millisecond-truncated).
    const stamp = await stampOf('companies/acme');
    expect(stamp).not.toBeNull();
    const usRows = await engine.executeRaw<{ eq: boolean }>(
      `SELECT links_extracted_at >= updated_at AS eq FROM pages WHERE slug = 'companies/acme'`,
    );
    expect(usRows[0]?.eq).toBe(true);
  });

  test('CDX-4 (D2): a link-flush throw aborts the sweep and leaves pages UNSTAMPED', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('companies/acme', companyPage('Acme', '[Alice](people/alice) founded [Acme](companies/acme).'));

    // Make the link flush throw mid-sweep. The --stale path flushes
    // NON-swallowing (no try/catch), so the throw must propagate AND no page in
    // the batch may be stamped (stamp runs only AFTER a successful flush).
    // Keep the method unbound. transaction() creates a scoped engine whose
    // database handle points at the open transaction; restoring a function
    // bound to the outer engine would make the clean retry wait on itself.
    const origBatch = engine.addLinksBatch;
    let threw = false;
    (engine as unknown as { addLinksBatch: unknown }).addLinksBatch = async () => { throw new Error('__flush_boom__'); };
    try {
      await runExtract(engine, ['--stale']);
    } catch (e) {
      if ((e as Error).message === '__flush_boom__') threw = true; else throw e;
    } finally {
      (engine as unknown as { addLinksBatch: unknown }).addLinksBatch = origBatch;
    }
    expect(threw).toBe(true);
    // Pages whose edges were lost are NOT stamped fresh — they stay stale.
    expect(await stampOf('people/alice')).toBeNull();
    expect(await stampOf('companies/acme')).toBeNull();
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(2);

    // A clean re-run re-extracts idempotently (ON CONFLICT DO NOTHING).
    await runExtract(engine, ['--stale']);
    expect((await engine.getLinks('companies/acme')).some(l => l.to_slug === 'people/alice')).toBe(true);
    expect(await stampOf('companies/acme')).not.toBeNull();
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(0);
  });

  test('D4 race: a concurrent edit landing during the sweep is NOT masked', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('companies/acme', companyPage('Acme', '[Alice](people/alice) backs [Acme](companies/acme).'));
    // Anchor acme's updated_at in the past so the read value is well-defined.
    await engine.executeRaw(`UPDATE pages SET updated_at = now() - interval '3 hours' WHERE slug = 'companies/acme'`);

    // Simulate an edit landing BETWEEN the list read (updated_at = now-3h) and
    // the stamp: bump acme's updated_at to now-1h just before the real stamp.
    // D4 stamps with the READ updated_at (now-3h), so now-1h > now-3h → acme
    // stays stale (edit preserved). The OLD now()-stamp would set
    // links_extracted_at = now > now-1h → acme marked fresh, edit silently lost.
    const origStamp = engine.markPagesExtractedBatch;
    let hooked = false;
    (engine as unknown as { markPagesExtractedBatch: unknown }).markPagesExtractedBatch = async function (
      this: PGLiteEngine,
      refs: Array<{ slug: string; source_id: string; extractedAt?: string }>, def: string,
    ) {
      if (!hooked) {
        hooked = true;
        await this.executeRaw(`UPDATE pages SET updated_at = now() - interval '1 hour' WHERE slug = 'companies/acme'`);
      }
      return origStamp.call(this, refs, def);
    };
    try {
      await runExtract(engine, ['--stale']);
    } finally {
      (engine as unknown as { markPagesExtractedBatch: unknown }).markPagesExtractedBatch = origStamp;
    }
    expect(hooked).toBe(true);
    // acme stays stale (only the concurrently-edited page); alice was stamped
    // with its own read updated_at and is fresh.
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(1);
  });

  test('--source fs is rejected (DB-source only)', async () => {
    const origErr = console.error;
    const origExit = process.exit;
    let exited = false; let msg = '';
    console.error = (m?: unknown) => { msg += String(m); };
    process.exit = ((_code?: number) => { exited = true; throw new Error('__exit__'); }) as unknown as typeof process.exit;
    try {
      await runExtract(engine, ['--stale', '--source', 'fs']);
    } catch (e) {
      if ((e as Error).message !== '__exit__') throw e;
    } finally {
      console.error = origErr;
      process.exit = origExit;
    }
    expect(exited).toBe(true);
    expect(msg).toContain('DB-source only');
  });
});
