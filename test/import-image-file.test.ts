// Phase 8 (D1-D3 + cherry-2 + cherry-3 + Sec5 + Eng-1C): importImageFile
// + withImportTransaction shared helper. Verifies the core ingest path on
// PGLite without a real Voyage API key (uses noEmbed=true).
//
// Real-API embedding is exercised in test/e2e/voyage-multimodal.test.ts (gated
// VOYAGE_API_KEY) and the dual-engine parity gate lands in Phase 10.

import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  importCodeFile,
  importFileContent,
  importImageBuffer,
  importImageFile,
  isImageFilePath,
  pLimit,
  SUPPORTED_IMAGE_EXTS,
} from '../src/core/import-file.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let tmpDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Exercise the post-canary multi-source path while the shipped schema keeps
  // legacy global uniqueness for binary rollback compatibility.
  await engine.executeRaw('ALTER TABLE files DROP CONSTRAINT IF EXISTS files_storage_path_key');
  tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-img-test-'));
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('isImageFilePath / SUPPORTED_IMAGE_EXTS', () => {
  test('recognizes all supported extensions', () => {
    for (const ext of SUPPORTED_IMAGE_EXTS) {
      expect(isImageFilePath(`some/path/foo${ext}`)).toBe(true);
      expect(isImageFilePath(`some/path/FOO${ext.toUpperCase()}`)).toBe(true);
    }
  });

  test('rejects non-image extensions', () => {
    expect(isImageFilePath('readme.md')).toBe(false);
    expect(isImageFilePath('script.ts')).toBe(false);
    expect(isImageFilePath('image_no_ext')).toBe(false);
  });
});

describe('pLimit semaphore (Eng-1C)', () => {
  test('serializes work to the configured concurrency', async () => {
    const limit = pLimit(2);
    const order: string[] = [];
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    const tasks = [
      limit(async () => { order.push('A-start'); await sleep(20); order.push('A-end'); }),
      limit(async () => { order.push('B-start'); await sleep(20); order.push('B-end'); }),
      limit(async () => { order.push('C-start'); await sleep(5);  order.push('C-end'); }),
      limit(async () => { order.push('D-start'); await sleep(5);  order.push('D-end'); }),
    ];

    await Promise.all(tasks);

    // First two start before either finishes (concurrency=2). C/D wait.
    expect(order.indexOf('A-start')).toBeLessThan(order.indexOf('C-start'));
    expect(order.indexOf('B-start')).toBeLessThan(order.indexOf('C-start'));
    // All four eventually run.
    expect(order.filter(s => s.endsWith('-end')).length).toBe(4);
  });

  test('propagates rejections without leaving the slot held', async () => {
    const limit = pLimit(1);
    const reject = limit(async () => { throw new Error('boom'); });
    let caught: unknown;
    try { await reject; } catch (e) { caught = e; }
    expect((caught as Error).message).toBe('boom');
    // Slot must release; the next call should run promptly.
    const ok = await limit(async () => 'ok');
    expect(ok).toBe('ok');
  });
});

describe('importImageFile happy path (noEmbed)', () => {
  test('imports a PNG fixture, creates a single image chunk + files row', async () => {
    // Copy the tiny.avif fixture as a stand-in for a generic image; the test
    // runs noEmbed:true so no decode/voyage call fires. Rename to .png so the
    // dispatcher routes correctly without needing actual decode.
    const target = join(tmpDir, 'photo.png');
    copyFileSync('test/fixtures/images/tiny.avif', target);

    const result = await importImageFile(engine, target, 'originals/photos/photo.png', { noEmbed: true });
    expect(result.status).toBe('imported');
    expect(result.chunks).toBe(1);

    const page = await engine.getPage('originals/photos/photo.png');
    expect(page).not.toBeNull();
    expect(page!.type).toBe('image');
    expect((page!.frontmatter as Record<string, unknown>).mime_type).toBe('image/png');

    const file = await engine.getFile('default', 'originals/photos/photo.png');
    expect(file).not.toBeNull();
    expect(file!.filename).toBe('photo.png');
    expect(file!.mime_type).toBe('image/png');
    expect(file!.page_id).toBe(page!.id);

    const chunks = await engine.getChunks('originals/photos/photo.png');
    expect(chunks.length).toBe(1);
    expect((chunks[0] as { chunk_source: string }).chunk_source).toBe('image_asset');
    // chunk_text falls back to filename when OCR is off (default).
    expect(chunks[0].chunk_text).toBe('photo.png');
  });

  test('idempotent on content_hash: re-import same bytes returns skipped', async () => {
    const target = join(tmpDir, 'photo2.png');
    writeFileSync(target, Buffer.from('fake-png-bytes-stable'));

    const r1 = await importImageFile(engine, target, 'photos/photo2.png', { noEmbed: true });
    expect(r1.status).toBe('imported');
    const r2 = await importImageFile(engine, target, 'photos/photo2.png', { noEmbed: true });
    expect(r2.status).toBe('skipped');
  });

  test('refuses oversized files (>20MB)', async () => {
    const target = join(tmpDir, 'huge.png');
    // Write a 21MB file. Buffer.alloc is fast.
    writeFileSync(target, Buffer.alloc(21 * 1024 * 1024));
    const result = await importImageFile(engine, target, 'photos/huge.png', { noEmbed: true });
    expect(result.status).toBe('skipped');
    expect(result.error).toMatch(/Image too large/);
  });

  test('same image slug and storage path stay isolated across sources', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ('source-a', 'source-a', '{}'::jsonb),
              ('source-b', 'source-b', '{}'::jsonb)`,
    );

    // Seed the same sibling slug in both sources so the image_of hook also
    // proves its read and write endpoints use the importing source.
    for (const sourceId of ['source-a', 'source-b']) {
      await engine.putPage('originals/notes/shared', {
        type: 'note',
        title: `Sibling ${sourceId}`,
        compiled_truth: `Owned by ${sourceId}`,
      }, { sourceId });
    }

    const path = 'originals/photos/shared.png';
    const aV1 = Buffer.from('source-a-image-v1');
    const bV1 = Buffer.from('source-b-image-v1');

    expect((await importImageBuffer(engine, aV1, path, {
      noEmbed: true,
      sourceId: 'source-a',
    })).status).toBe('imported');
    // A same-slug page already exists in source A. Source B must not read it
    // as its own idempotency record and skip this import.
    expect((await importImageBuffer(engine, bV1, path, {
      noEmbed: true,
      sourceId: 'source-b',
    })).status).toBe('imported');
    // Omitting sourceId is the public default-source path. It must resolve to
    // `default` explicitly rather than treating either foreign page as its
    // own idempotency record.
    expect((await importImageBuffer(engine, Buffer.from('default-image-v1'), path, {
      noEmbed: true,
    })).status).toBe('imported');

    const pageA1 = await engine.getPage(path, { sourceId: 'source-a' });
    const pageB1 = await engine.getPage(path, { sourceId: 'source-b' });
    const pageDefault1 = await engine.getPage(path, { sourceId: 'default' });
    const fileA1 = await engine.getFile('source-a', path);
    const fileB1 = await engine.getFile('source-b', path);
    const fileDefault1 = await engine.getFile('default', path);
    expect(pageA1?.source_id).toBe('source-a');
    expect(pageB1?.source_id).toBe('source-b');
    expect(pageA1?.id).not.toBe(pageB1?.id);
    expect(pageDefault1?.source_id).toBe('default');
    expect(fileA1?.page_id).toBe(pageA1?.id);
    expect(fileB1?.page_id).toBe(pageB1?.id);
    expect(fileDefault1?.page_id).toBe(pageDefault1?.id);
    expect(fileA1?.content_hash).not.toBe(fileB1?.content_hash);

    // Replacing source A exercises createVersion + chunk replacement + file
    // upsert. None of those writes may delete or overwrite source B's rows.
    expect((await importImageBuffer(engine, Buffer.from('source-a-image-v2'), path, {
      noEmbed: true,
      sourceId: 'source-a',
    })).status).toBe('imported');

    const pageA2 = await engine.getPage(path, { sourceId: 'source-a' });
    const pageB2 = await engine.getPage(path, { sourceId: 'source-b' });
    const fileA2 = await engine.getFile('source-a', path);
    const fileB2 = await engine.getFile('source-b', path);
    const fileDefault2 = await engine.getFile('default', path);
    expect(pageA2?.id).toBe(pageA1?.id);
    expect(pageB2?.content_hash).toBe(pageB1?.content_hash);
    expect(fileA2?.id).toBe(fileA1?.id);
    expect(fileA2?.content_hash).not.toBe(fileA1?.content_hash);
    expect(fileB2?.id).toBe(fileB1?.id);
    expect(fileB2?.content_hash).toBe(fileB1?.content_hash);
    expect(fileDefault2?.id).toBe(fileDefault1?.id);
    expect(fileDefault2?.content_hash).toBe(fileDefault1?.content_hash);
    expect((await engine.getChunks(path, { sourceId: 'source-a' })).length).toBe(1);
    expect((await engine.getChunks(path, { sourceId: 'source-b' })).length).toBe(1);
    expect((await engine.getChunks(path, { sourceId: 'default' })).length).toBe(1);
    expect((await engine.getVersions(path, { sourceId: 'source-a' })).length).toBe(1);
    expect((await engine.getVersions(path, { sourceId: 'source-b' })).length).toBe(0);

    const linksA = await engine.getLinks(path, { sourceId: 'source-a' });
    const linksB = await engine.getLinks(path, { sourceId: 'source-b' });
    expect(linksA.some(link => link.to_slug === 'originals/notes/shared')).toBe(true);
    expect(linksB.some(link => link.to_slug === 'originals/notes/shared')).toBe(true);
    const linkOwners = await engine.executeRaw<{
      from_source: string;
      to_source: string;
      origin_source: string | null;
    }>(
      `SELECT f.source_id AS from_source,
              t.source_id AS to_source,
              o.source_id AS origin_source
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
         LEFT JOIN pages o ON o.id = l.origin_page_id
        WHERE f.slug = $1
        ORDER BY f.source_id`,
      [path],
    );
    expect(linkOwners).toEqual([
      { from_source: 'source-a', to_source: 'source-a', origin_source: 'source-a' },
      { from_source: 'source-b', to_source: 'source-b', origin_source: 'source-b' },
    ]);

    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM files WHERE storage_path = $1 ORDER BY source_id`,
      [path],
    );
    expect(rows.map(row => row.source_id)).toEqual(['default', 'source-a', 'source-b']);
  });
});

describe('atomic importer-owned rename', () => {
  test('code rename preserves page identity, relations, versions, and stamps new source_path', async () => {
    const content = 'export function answer(): number { return 42; }\n';
    expect((await importCodeFile(engine, 'src/old.ts', content, {
      noEmbed: true,
      sourceId: 'default',
    })).status).toBe('imported');
    const oldSlug = 'src-old-ts';
    const newSlug = 'src-new-ts';
    const oldPage = (await engine.getPage(oldSlug, { sourceId: 'default' }))!;
    await engine.putPage('notes/code-reference', {
      type: 'note', title: 'Code ref', compiled_truth: 'References code.',
    }, { sourceId: 'default' });
    await engine.addLink(
      'notes/code-reference', oldSlug, 'manual', 'mentions', 'manual',
      undefined, undefined,
      { fromSourceId: 'default', toSourceId: 'default', originSourceId: 'default' },
    );
    await engine.addTag(oldSlug, 'manual-enrichment', { sourceId: 'default' });
    await engine.createVersion(oldSlug, { sourceId: 'default' });
    const beforeVersions = await engine.getVersions(oldSlug, { sourceId: 'default' });

    const renamed = await importCodeFile(engine, 'src/new.ts', content, {
      noEmbed: true,
      sourceId: 'default',
      force: true,
      renameFromSlug: oldSlug,
      renameFromSourcePath: 'src/old.ts',
    });

    expect(renamed.status).toBe('imported');
    expect(await engine.getPage(oldSlug, { sourceId: 'default' })).toBeNull();
    expect((await engine.getPage(newSlug, { sourceId: 'default' }))?.id).toBe(oldPage.id);
    expect((await engine.getBacklinks(newSlug, { sourceId: 'default' }))[0]?.from_slug)
      .toBe('notes/code-reference');
    expect(await engine.getTags(newSlug, { sourceId: 'default' }))
      .toEqual(expect.arrayContaining(['code', 'typescript', 'manual-enrichment']));
    expect((await engine.getVersions(newSlug, { sourceId: 'default' })).length)
      .toBeGreaterThan(beforeVersions.length);
    expect((await engine.resolveSlugsByPaths(['src/new.ts'], { sourceId: 'default' })).get('src/new.ts'))
      .toBe(newSlug);
  });

  test('image rename moves the file ledger atomically and preserves page identity', async () => {
    const bytes = Buffer.from('stable-image-bytes');
    expect((await importImageBuffer(engine, bytes, 'photos/old.png', {
      noEmbed: true,
      sourceId: 'default',
    })).status).toBe('imported');
    const oldPage = (await engine.getPage('photos/old.png', { sourceId: 'default' }))!;
    const oldFile = await engine.getFile('default', 'photos/old.png');

    const renamed = await importImageBuffer(engine, bytes, 'photos/new.png', {
      noEmbed: true,
      sourceId: 'default',
      renameFromSlug: 'photos/old.png',
      renameFromSourcePath: 'photos/old.png',
    });

    expect(renamed.status).toBe('imported');
    expect(await engine.getPage('photos/old.png', { sourceId: 'default' })).toBeNull();
    const newPage = await engine.getPage('photos/new.png', { sourceId: 'default' });
    expect(newPage?.id).toBe(oldPage.id);
    expect(await engine.getFile('default', 'photos/old.png')).toBeNull();
    const newFile = await engine.getFile('default', 'photos/new.png');
    expect(newFile?.page_id).toBe(oldPage.id);
    expect(newFile?.page_slug).toBe('photos/new.png');
    expect(newFile?.id).not.toBe(oldFile?.id);
    expect((await engine.getVersions('photos/new.png', { sourceId: 'default' })).length).toBe(1);
    expect((await engine.resolveSlugsByPaths(['photos/new.png'], { sourceId: 'default' })).get('photos/new.png'))
      .toBe('photos/new.png');
  });

  test('code-edge write failure rolls back the rename and prior call graph', async () => {
    const oldContent = 'export function oldEntry() { return oldHelper(); }\n';
    expect((await importCodeFile(engine, 'src/old.ts', oldContent, {
      noEmbed: true, sourceId: 'default',
    })).status).toBe('imported');
    const oldPage = (await engine.getPage('src-old-ts', { sourceId: 'default' }))!;
    const edgeCountBefore = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM code_edges_symbol e
         JOIN content_chunks c ON c.id = e.from_chunk_id
        WHERE c.page_id = $1`,
      [oldPage.id],
    );
    expect(Number(edgeCountBefore[0]?.count ?? 0)).toBeGreaterThan(0);

    // Preserve the unbound method. The transactional engine inherits this
    // override from `engine`; restoring a function bound to the root engine
    // would make the next transaction issue its edge write outside the active
    // PGLite transaction and deadlock on itself.
    const originalAddCodeEdges = engine.addCodeEdges;
    (engine as unknown as { addCodeEdges: typeof engine.addCodeEdges }).addCodeEdges = async () => {
      throw new Error('simulated edge write failure');
    };
    try {
      await expect(importCodeFile(
        engine,
        'src/new.ts',
        'export function newEntry() { return newHelper(); }\n',
        {
          noEmbed: true,
          sourceId: 'default',
          force: true,
          renameFromSlug: 'src-old-ts',
          renameFromSourcePath: 'src/old.ts',
        },
      )).rejects.toThrow('simulated edge write failure');
    } finally {
      (engine as unknown as { addCodeEdges: typeof engine.addCodeEdges }).addCodeEdges = originalAddCodeEdges;
    }

    expect((await engine.getPage('src-old-ts', { sourceId: 'default' }))?.id).toBe(oldPage.id);
    expect(await engine.getPage('src-new-ts', { sourceId: 'default' })).toBeNull();
    const edgeCountAfter = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM code_edges_symbol e
         JOIN content_chunks c ON c.id = e.from_chunk_id
        WHERE c.page_id = $1`,
      [oldPage.id],
    );
    expect(Number(edgeCountAfter[0]?.count ?? 0)).toBe(Number(edgeCountBefore[0]?.count ?? 0));
  });

  test('code rename replays safely after commit-before-checkpoint interruption', async () => {
    const content = 'export function entry() { return helper(); }\n';
    expect((await importCodeFile(engine, 'src/old.ts', content, {
      noEmbed: true, sourceId: 'default',
    })).status).toBe('imported');
    const renamed = await importCodeFile(engine, 'src/new.ts', content, {
      noEmbed: true,
      sourceId: 'default',
      force: true,
      renameFromSlug: 'src-old-ts',
      renameFromSourcePath: 'src/old.ts',
    });
    expect(renamed.status).toBe('imported');
    const page = (await engine.getPage('src-new-ts', { sourceId: 'default' }))!;
    const beforeReplay = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM code_edges_symbol e
         JOIN content_chunks c ON c.id = e.from_chunk_id
        WHERE c.page_id = $1`,
      [page.id],
    );
    expect(Number(beforeReplay[0]?.count ?? 0)).toBeGreaterThan(0);

    // A sync killed after the DB commit but before its path checkpoint sees
    // the committed destination on replay. The immutable content hash skips
    // the import; the already-atomic edge set must remain complete.
    const replay = await importCodeFile(engine, 'src/new.ts', content, {
      noEmbed: true, sourceId: 'default',
    });
    expect(replay.status).toBe('skipped');
    const afterReplay = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM code_edges_symbol e
         JOIN content_chunks c ON c.id = e.from_chunk_id
        WHERE c.page_id = $1`,
      [page.id],
    );
    expect(Number(afterReplay[0]?.count ?? 0)).toBe(Number(beforeReplay[0]?.count ?? 0));
  });

  test('rename locks and rejects an origin whose source_path changed after resolution', async () => {
    expect((await importFileContent(
      engine,
      '---\ntype: note\ntitle: Old\n---\n\nOld body.',
      'notes/old.md',
      { noEmbed: true, sourceId: 'default' },
    )).status).toBe('imported');
    const oldPage = (await engine.getPage('notes/old', { sourceId: 'default' }))!;
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'notes/changed-behind-sync.md'
        WHERE id = $1`,
      [oldPage.id],
    );

    await expect(importFileContent(
      engine,
      '---\ntype: note\ntitle: New\n---\n\nNew body.',
      'notes/new.md',
      {
        noEmbed: true,
        sourceId: 'default',
        forceRechunk: true,
        renameFromSlug: 'notes/old',
        renameFromSourcePath: 'notes/old.md',
      },
    )).rejects.toThrow('Atomic rename source_path changed');

    expect((await engine.getPage('notes/old', { sourceId: 'default' }))?.id).toBe(oldPage.id);
    expect(await engine.getPage('notes/new', { sourceId: 'default' })).toBeNull();
  });
});

type CrossKind = 'markdown' | 'code' | 'image';

function fixturePath(kind: CrossKind, name: 'old' | 'new'): string {
  if (kind === 'markdown') return `notes/${name}.md`;
  if (kind === 'code') return `src/${name}.ts`;
  return `media/${name}.png`;
}

function fixtureSlug(kind: CrossKind, name: 'old' | 'new'): string {
  if (kind === 'markdown') return `notes/${name}`;
  if (kind === 'code') return `src-${name}-ts`;
  return `media/${name}.png`;
}

async function importKind(
  kind: CrossKind,
  name: 'old' | 'new',
  rename?: { slug: string; path: string },
) {
  const path = fixturePath(kind, name);
  const common = {
    noEmbed: true,
    sourceId: 'default',
    ...(rename ? { renameFromSlug: rename.slug, renameFromSourcePath: rename.path } : {}),
  };
  if (kind === 'markdown') {
    return importFileContent(engine, [
      '---',
      'type: note',
      `title: ${name}`,
      'aliases:',
      `  - ${name} alias`,
      '---',
      '',
      `Body for ${name}.`,
    ].join('\n'), path, { ...common, forceRechunk: true });
  }
  if (kind === 'code') {
    return importCodeFile(
      engine,
      path,
      `export function ${name}Entry() { return ${name}Helper(); }\n`,
      { ...common, force: true },
    );
  }
  return importImageBuffer(engine, Buffer.from(`${name}-image-bytes`), path, common);
}

for (const [fromKind, toKind] of [
  ['markdown', 'code'],
  ['markdown', 'image'],
  ['code', 'markdown'],
  ['code', 'image'],
  ['image', 'markdown'],
  ['image', 'code'],
] as Array<[CrossKind, CrossKind]>) {
  test(`cross-kind ${fromKind} -> ${toKind} retires only importer-generated state`, async () => {
    await engine.putPage('notes/keep-target', {
      type: 'note', title: 'Keep target', compiled_truth: 'Stable target.',
    }, { sourceId: 'default' });

    const oldPath = fixturePath(fromKind, 'old');
    const oldSlug = fixtureSlug(fromKind, 'old');
    const newSlug = fixtureSlug(toKind, 'new');
    expect((await importKind(fromKind, 'old')).status).toBe('imported');
    const oldPage = (await engine.getPage(oldSlug, { sourceId: 'default' }))!;

    // An unrelated uploaded attachment and manual link must survive every
    // conversion even when importer-owned rows are retired.
    const attachmentPath = `attachments/${fromKind}-to-${toKind}.bin`;
    await engine.upsertFile({
      source_id: 'default',
      page_slug: oldSlug,
      page_id: oldPage.id,
      filename: 'manual.bin',
      storage_path: attachmentPath,
      content_hash: `manual-${fromKind}-${toKind}`,
    });
    await engine.addLink(
      oldSlug, 'notes/keep-target', 'keep', 'manual_keep', 'manual',
      undefined, undefined,
      { fromSourceId: 'default', toSourceId: 'default', originSourceId: 'default' },
    );

    if (fromKind === 'code') {
      const oldChunk = (await engine.getChunks(oldSlug, { sourceId: 'default' }))[0]!;
      await engine.executeRaw(
        `INSERT INTO code_edges_symbol
           (from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, source_id)
         VALUES ($1, 'oldEntry', 'oldHelper', 'call', 'default')`,
        [oldChunk.id],
      );
    }
    if (fromKind === 'image') {
      // Generated image_of provenance is removed; a manual image_of without
      // importer origin remains.
      await engine.addLink(
        oldSlug, 'notes/keep-target', 'generated', 'image_of', 'manual',
        oldSlug, 'frontmatter',
        { fromSourceId: 'default', toSourceId: 'default', originSourceId: 'default' },
      );
      await engine.addLink(
        oldSlug, 'notes/keep-target', 'manual image relation', 'image_of', 'manual',
        undefined, undefined,
        { fromSourceId: 'default', toSourceId: 'default', originSourceId: 'default' },
      );
    }

    const converted = await importKind(toKind, 'new', { slug: oldSlug, path: oldPath });
    expect(converted.status).toBe('imported');
    expect(await engine.getPage(oldSlug, { sourceId: 'default' })).toBeNull();
    expect((await engine.getPage(newSlug, { sourceId: 'default' }))?.id).toBe(oldPage.id);

    const attachment = await engine.getFile('default', attachmentPath);
    expect(attachment?.page_id).toBe(oldPage.id);
    expect(attachment?.page_slug).toBe(newSlug);
    const keptLinks = await engine.executeRaw<{ link_type: string; origin_page_id: number | null }>(
      `SELECT link_type, origin_page_id FROM links
        WHERE from_page_id = $1 AND link_source = 'manual'
        ORDER BY link_type, origin_page_id NULLS FIRST`,
      [oldPage.id],
    );
    expect(keptLinks.some(row => row.link_type === 'manual_keep')).toBe(true);

    const aliases = await engine.executeRaw<{ alias_norm: string }>(
      `SELECT alias_norm FROM page_aliases WHERE source_id = 'default' AND slug = $1`,
      [newSlug],
    );
    if (toKind === 'markdown') {
      expect(aliases.map(row => row.alias_norm)).toContain('new alias');
    } else {
      expect(aliases).toHaveLength(0);
    }

    if (fromKind === 'code') {
      const remainingEdges = await engine.executeRaw<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM code_edges_symbol e
           JOIN content_chunks c ON c.id = e.from_chunk_id
          WHERE c.page_id = $1`,
        [oldPage.id],
      );
      expect(Number(remainingEdges[0]?.count ?? 0)).toBe(0);
    }
    if (fromKind === 'image') {
      expect(await engine.getFile('default', oldPath)).toBeNull();
      const imageLinks = await engine.executeRaw<{ origin_page_id: number | null }>(
        `SELECT origin_page_id FROM links
          WHERE from_page_id = $1 AND link_type = 'image_of' AND link_source = 'manual'`,
        [oldPage.id],
      );
      expect(imageLinks).toEqual([{ origin_page_id: null }]);
    }
    if (toKind === 'image') {
      expect(await engine.getFile('default', fixturePath('image', 'new'))).not.toBeNull();
    }
  });
}
