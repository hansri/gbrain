/**
 * v0.37.7.0 #1204 — `gbrain extract --source-id <id>` scopes extraction.
 *
 * Federated brain users running `gbrain extract` need to scope by
 * source. Pre-fix, every run walked all sources together which
 * confused link resolution on cross-source duplicates. This test
 * pins the new `--source-id` flag: walk + extract only that source's
 * pages. Unqualified resolution stays within each origin source; only an
 * explicit `[[source:slug]]` may cross that boundary.
 *
 * Hermetic via PGLite in-memory (no DATABASE_URL needed). Dedicated
 * file per D4 lock.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtract } from '../src/commands/extract.ts';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function truncateAll(): Promise<void> {
  for (const t of ['content_chunks', 'links', 'timeline_entries', 'tags', 'raw_data', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
  await (engine as any).db.exec(`DELETE FROM sources WHERE id <> 'default'`);
}

describe('extract --source-id flag (#1204)', () => {
  beforeEach(async () => {
    await truncateAll();
    // Two sources, each with a page whose body contains a wikilink to
    // its sibling in the same source.
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('alpha', 'alpha'), ('beta', 'beta')
       ON CONFLICT (id) DO NOTHING`,
    );
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES
         ('people/alice', 'alpha', 'person', 'Alice', 'Met [[people/bob]] today.', ''),
         ('people/bob', 'alpha', 'person', 'Bob', 'Friend of [[people/alice]].', ''),
         ('people/carol', 'beta', 'person', 'Carol', 'Met [[people/dave]].', ''),
         ('people/dave', 'beta', 'person', 'Dave', 'Friend of [[people/carol]].', '')`,
    );
  });

  test('without --source-id, walks all sources', async () => {
    const captured: unknown[] = [];
    const origLog = console.log;
    console.log = (m: unknown) => { captured.push(m); };
    try {
      await runExtract(engine, ['links', '--source', 'db', '--json']);
    } finally {
      console.log = origLog;
    }
    // Some non-zero number of links across both sources.
    const linkRows = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM links`,
    );
    expect(Number(linkRows[0]?.n ?? 0)).toBeGreaterThanOrEqual(2);
  });

  test('--source-id alpha scopes extraction to alpha only', async () => {
    const captured: unknown[] = [];
    const origLog = console.log;
    console.log = (m: unknown) => { captured.push(m); };
    try {
      await runExtract(engine, ['links', '--source', 'db', '--source-id', 'alpha', '--json']);
    } finally {
      console.log = origLog;
    }
    // Links produced should only originate from alpha-source pages.
    const linkRows = await engine.executeRaw<{ slug: string; source_id: string }>(
      `SELECT p.slug, p.source_id FROM links l
         JOIN pages p ON l.from_page_id = p.id`,
    );
    // Every link's from-page must be in alpha.
    for (const r of linkRows) {
      expect(r.source_id).toBe('alpha');
    }
    // And there should be at least one such link.
    expect(linkRows.length).toBeGreaterThanOrEqual(1);
  });

  test('--source-id beta scopes to beta and produces beta-origin links only', async () => {
    const origLog = console.log;
    console.log = () => {};
    try {
      await runExtract(engine, ['links', '--source', 'db', '--source-id', 'beta', '--json']);
    } finally {
      console.log = origLog;
    }
    const linkRows = await engine.executeRaw<{ source_id: string }>(
      `SELECT p.source_id FROM links l
         JOIN pages p ON l.from_page_id = p.id`,
    );
    for (const r of linkRows) {
      expect(r.source_id).toBe('beta');
    }
  });

  test('--source-id with non-matching source produces zero links', async () => {
    const origLog = console.log;
    console.log = () => {};
    try {
      await runExtract(engine, ['links', '--source', 'db', '--source-id', 'nonexistent', '--json']);
    } finally {
      console.log = origLog;
    }
    const linkRows = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM links`,
    );
    expect(Number(linkRows[0]?.n ?? 0)).toBe(0);
  });

  test('unqualified DB extraction never falls back to a default/other-source target', async () => {
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES ('notes/strict-origin', 'alpha', 'note', 'Strict origin', 'See [[companies/only-beta]].', ''),
              ('companies/only-beta', 'beta', 'company', 'Only Beta', '', '')`,
    );

    await runExtract(engine, ['links', '--source', 'db', '--source-id', 'alpha']);
    const rows = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
        WHERE f.source_id = 'alpha' AND f.slug = 'notes/strict-origin'
          AND t.slug = 'companies/only-beta'`,
    );
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });

  test('qualified DB extraction may target exactly the named source', async () => {
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES ('notes/qualified-origin', 'alpha', 'note', 'Qualified origin', 'See [[beta:companies/only-beta]].', ''),
              ('companies/only-beta', 'beta', 'company', 'Only Beta', '', '')`,
    );

    await runExtract(engine, ['links', '--source', 'db', '--source-id', 'alpha']);
    const rows = await engine.executeRaw<{ from_source: string; to_source: string }>(
      `SELECT f.source_id AS from_source, t.source_id AS to_source
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
        WHERE f.slug = 'notes/qualified-origin' AND t.slug = 'companies/only-beta'`,
    );
    expect(rows).toEqual([{ from_source: 'alpha', to_source: 'beta' }]);
  });

  test('stale frontmatter resolver is source-scoped at exact and fuzzy tiers', async () => {
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline, frontmatter)
       VALUES ('deals/strict', 'alpha', 'deal', 'Strict', '', '', '{"investors":["Only Beta"]}'::jsonb),
              ('companies/only-beta', 'beta', 'company', 'Only Beta', '', '', '{}'::jsonb)`,
    );

    await runExtract(engine, ['--stale', '--source-id', 'alpha']);
    const rows = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
        WHERE t.source_id = 'alpha' AND t.slug = 'deals/strict'
          AND f.source_id <> 'alpha'`,
    );
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });

  test('filesystem CLI dispatch writes links and timeline rows into the explicit source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-extract-source-'));
    mkdirSync(join(dir, 'people'), { recursive: true });
    writeFileSync(
      join(dir, 'people/alice.md'),
      '# Alice\n\nMet [[people/bob]].\n\n- **2026-07-09** | Test — Boundary checkpoint.\n',
    );
    writeFileSync(join(dir, 'people/bob.md'), '# Bob\n');
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = 'alpha'`,
      [dir],
    );

    const originalLog = console.log;
    console.log = () => {};
    try {
      await runExtract(engine, [
        'all', '--source', 'fs', '--source-id', 'alpha', '--dir', dir,
      ]);
    } finally {
      console.log = originalLog;
      rmSync(dir, { recursive: true, force: true });
    }

    const links = await engine.executeRaw<{ from_source: string; to_source: string }>(
      `SELECT fp.source_id AS from_source, tp.source_id AS to_source
         FROM links l
         JOIN pages fp ON fp.id = l.from_page_id
         JOIN pages tp ON tp.id = l.to_page_id`,
    );
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links.every((row) => row.from_source === 'alpha' && row.to_source === 'alpha')).toBe(true);

    const timeline = await engine.executeRaw<{ source_id: string }>(
      `SELECT p.source_id
         FROM timeline_entries te
         JOIN pages p ON p.id = te.page_id`,
    );
    expect(timeline.length).toBeGreaterThanOrEqual(1);
    expect(timeline.every((row) => row.source_id === 'alpha')).toBe(true);
  });

  test('filesystem CLI dispatch preserves implicit local_path source resolution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-extract-source-implicit-'));
    mkdirSync(join(dir, 'people'), { recursive: true });
    writeFileSync(join(dir, 'people/alice.md'), '# Alice\n\nMet [[people/bob]].\n');
    writeFileSync(join(dir, 'people/bob.md'), '# Bob\n');
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = 'alpha'`,
      [dir],
    );

    const originalLog = console.log;
    console.log = () => {};
    try {
      await runExtract(engine, ['links', '--source', 'fs', '--dir', dir]);
    } finally {
      console.log = originalLog;
      rmSync(dir, { recursive: true, force: true });
    }

    const links = await engine.executeRaw<{ from_source: string; to_source: string }>(
      `SELECT fp.source_id AS from_source, tp.source_id AS to_source
         FROM links l
         JOIN pages fp ON fp.id = l.from_page_id
         JOIN pages tp ON tp.id = l.to_page_id`,
    );
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links.every((row) => row.from_source === 'alpha' && row.to_source === 'alpha')).toBe(true);
  });
});
