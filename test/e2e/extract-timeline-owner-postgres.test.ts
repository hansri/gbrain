import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  extractImportedPagesFromDB,
  IMPORTED_MARKDOWN_TIMELINE_MANAGER,
} from '../../src/commands/extract.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('Postgres legacy timeline ownership adoption', () => {
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => engine?.disconnect());

  test('reserved NULL-managed rows are adopted/reconciled while manual provenance survives', async () => {
    const sourceId = `e2e-timeline-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1)`, [sourceId]);
    try {
      await engine.putPage('people/alice', {
        type: 'person',
        title: 'Alice',
        compiled_truth: '',
        timeline: '### 2026-07-11 — Signed agreement\n\nFinal paperwork.',
        frontmatter: {},
      }, { sourceId });
      await engine.addTimelineEntry(
        'people/alice',
        { date: '2026-07-10', source: 'gbrain-markdown', summary: 'Legacy generated', detail: '' },
        { sourceId },
      );
      await engine.addTimelineEntry(
        'people/alice',
        { date: '2026-07-10', source: 'Meeting', summary: 'Manual evidence', detail: 'keep' },
        { sourceId },
      );

      await extractImportedPagesFromDB(engine, ['people/alice'], { sourceId });
      const first = await engine.getTimeline('people/alice', { sourceId });
      expect(first.some(row => row.summary === 'Legacy generated')).toBe(false);
      expect(first.some(row => row.summary === 'Signed agreement' && row.managed_by === IMPORTED_MARKDOWN_TIMELINE_MANAGER)).toBe(true);
      expect(first.some(row => row.summary === 'Manual evidence' && row.managed_by == null)).toBe(true);

      await engine.executeRaw(
        `UPDATE pages SET timeline = '', updated_at = now()
          WHERE source_id = $1 AND slug = 'people/alice'`,
        [sourceId],
      );
      await extractImportedPagesFromDB(engine, ['people/alice'], { sourceId });
      const second = await engine.getTimeline('people/alice', { sourceId });
      expect(second.some(row => row.managed_by === IMPORTED_MARKDOWN_TIMELINE_MANAGER)).toBe(false);
      expect(second.some(row => row.summary === 'Manual evidence')).toBe(true);
    } finally {
      await engine.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]);
    }
  });
});
