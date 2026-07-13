import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importCodeFile, importFromContent } from '../src/core/import-file.ts';
import { slugifyCodePath } from '../src/core/sync.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
});

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 30_000);

describe('Markdown importer doc<->code edge authority', () => {
  test('removed citations retire only the origin-owned pair', async () => {
    const codePath = 'src/core/sync.ts';
    const codeSlug = slugifyCodePath(codePath);
    const guideSlug = 'guides/sync';
    await importCodeFile(
      engine,
      codePath,
      'export function sync() { return true; }\n',
      { noEmbed: true, sourceId: 'default' },
    );

    const first = await importFromContent(
      engine,
      guideSlug,
      `---\ntype: note\ntitle: Sync Guide\n---\n\nSee ${codePath}:42 for the implementation.`,
      { noEmbed: true, sourceId: 'default' },
    );
    expect(first.status).toBe('imported');

    // Same endpoints, but owned by independent authorities. These rows must
    // survive when the Markdown import later removes its code citation.
    const linkOpts = {
      fromSourceId: 'default',
      toSourceId: 'default',
      originSourceId: 'default',
    };
    await engine.addLink(
      guideSlug, codeSlug, 'body extractor edge', 'documents', 'markdown',
      undefined, undefined, linkOpts,
    );
    await engine.addLink(
      codeSlug, guideSlug, 'manual operator edge', 'documented_by', 'manual',
      undefined, undefined, linkOpts,
    );

    const before = await engine.executeRaw<{
      link_source: string;
      link_type: string;
      origin_owned: boolean;
    }>(
      `SELECT l.link_source, l.link_type, (l.origin_page_id IS NOT NULL) AS origin_owned
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
        WHERE f.source_id = 'default' AND t.source_id = 'default'
          AND ((f.slug = $1 AND t.slug = $2) OR (f.slug = $2 AND t.slug = $1))
        ORDER BY l.link_source, l.link_type, origin_owned`,
      [guideSlug, codeSlug],
    );
    expect(before.filter(row => row.link_source === 'markdown' && row.origin_owned)).toHaveLength(2);

    const second = await importFromContent(
      engine,
      guideSlug,
      `---\ntype: note\ntitle: Sync Guide\n---\n\nThe implementation reference was intentionally removed.`,
      { noEmbed: true, sourceId: 'default' },
    );
    expect(second.status).toBe('imported');

    const after = await engine.executeRaw<{
      link_source: string;
      link_type: string;
      origin_owned: boolean;
    }>(
      `SELECT l.link_source, l.link_type, (l.origin_page_id IS NOT NULL) AS origin_owned
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
        WHERE f.source_id = 'default' AND t.source_id = 'default'
          AND ((f.slug = $1 AND t.slug = $2) OR (f.slug = $2 AND t.slug = $1))
        ORDER BY l.link_source, l.link_type, origin_owned`,
      [guideSlug, codeSlug],
    );
    expect(after.filter(row => row.link_source === 'markdown' && row.origin_owned)).toEqual([]);
    expect(after).toContainEqual({
      link_source: 'markdown',
      link_type: 'documents',
      origin_owned: false,
    });
    expect(after).toContainEqual({
      link_source: 'manual',
      link_type: 'documented_by',
      origin_owned: false,
    });
  });

  test('markdown-to-code conversion also retires the old origin-owned pair', async () => {
    const referencedPath = 'src/core/sync.ts';
    const guideSlug = 'guides/implementation';
    await importCodeFile(
      engine,
      referencedPath,
      'export function sync() { return true; }\n',
      { noEmbed: true, sourceId: 'default' },
    );
    await importFromContent(
      engine,
      guideSlug,
      `---\ntype: note\ntitle: Guide\n---\n\nSee ${referencedPath}.`,
      {
        noEmbed: true,
        sourceId: 'default',
        sourcePath: 'guides/implementation.md',
      },
    );
    expect((await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM links l
        JOIN pages origin ON origin.id = l.origin_page_id
       WHERE origin.slug = $1 AND l.link_source = 'markdown'
         AND l.link_type IN ('documents', 'documented_by')`,
      [guideSlug],
    ))[0]?.n).toBe('2');

    const converted = await importCodeFile(
      engine,
      'src/converted.ts',
      'export const converted = true;\n',
      {
        noEmbed: true,
        sourceId: 'default',
        renameFromSlug: guideSlug,
        renameFromSourcePath: 'guides/implementation.md',
      },
    );
    expect(converted.status).toBe('imported');
    expect((await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM links
       WHERE origin_page_id = (SELECT id FROM pages WHERE source_id = 'default' AND slug = $1)
         AND link_source = 'markdown'
         AND link_type IN ('documents', 'documented_by')`,
      [converted.slug],
    ))[0]?.n).toBe('0');
  });
});
