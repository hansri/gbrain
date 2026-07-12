/**
 * v0.27.1 multimodal — real-Postgres E2E.
 *
 * Runs the v0.27.1 schema (migration v36 + dual embedding columns + files
 * table) against a real Postgres + pgvector and exercises every code path
 * the production user will hit: upsertFile / getFile / listFilesForPage,
 * upsertChunks with modality + embedding_image vector(1024), searchVector
 * column routing, modality filter on searchKeyword, partial HNSW
 * idx_chunks_embedding_image.
 *
 * Skips gracefully when DATABASE_URL is unset.
 *
 * Run: DATABASE_URL=postgresql://... bun test test/e2e/multimodal-postgres.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { FileSpec } from '../../src/core/engine.ts';
import { importFromContent, importImageBuffer } from '../../src/core/import-file.ts';
import { MIGRATIONS } from '../../src/core/migrate.ts';
import { getPostgresTestUrl } from '../helpers/postgres-test-authority.ts';

const DATABASE_URL = getPostgresTestUrl();
const skip = !DATABASE_URL;

if (skip) {
  test.skip('multimodal-postgres E2E skipped (DATABASE_URL unset)', () => {});
}

describe.skipIf(skip)('multimodal v0.27.1 against real Postgres', () => {
  let pg: PostgresEngine;
  let textEmbeddingDimensions = 0;

  beforeAll(async () => {
    pg = new PostgresEngine();
    await pg.connect({ database_url: DATABASE_URL! });
    await pg.initSchema();
    const dimensions = await pg.executeRaw<{ atttypmod: number }>(
      `SELECT atttypmod FROM pg_attribute
        WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'`,
    );
    textEmbeddingDimensions = dimensions[0]!.atttypmod;
  }, 60_000);

  afterAll(async () => {
    if (pg) await pg.disconnect();
  }, 30_000);

  beforeEach(async () => {
    // Clean slate so cross-test seeding doesn't bleed. CASCADE pages also
    // cleans content_chunks + tags + raw_data. files cascades on source_id
    // so we hit it explicitly to be safe.
    await pg.executeRaw('DELETE FROM content_chunks');
    await pg.executeRaw('DELETE FROM files');
    await pg.executeRaw('DELETE FROM slug_aliases');
    await pg.executeRaw('DELETE FROM pages');
  });

  function fakeImage1024(seed: number): Float32Array {
    const out = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) out[i] = (i + seed) / 1024;
    return out;
  }

  function fakeTextEmbedding(seed: number): Float32Array {
    const out = new Float32Array(textEmbeddingDimensions);
    for (let i = 0; i < textEmbeddingDimensions; i++) {
      out[i] = (i + seed) / textEmbeddingDimensions;
    }
    return out;
  }

  test('schema-drift: content_chunks has modality + embedding_image columns on Postgres', async () => {
    const rows = await pg.executeRaw<{ column_name: string; data_type: string; column_default: string | null }>(
      `SELECT column_name, data_type, column_default
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name='content_chunks'
         AND column_name IN ('modality','embedding_image')
       ORDER BY column_name`
    );
    expect(rows.length).toBe(2);
    const modality = rows.find(r => r.column_name === 'modality')!;
    expect(modality.data_type).toBe('text');
    expect(modality.column_default).toContain("'text'");
    const embImg = rows.find(r => r.column_name === 'embedding_image')!;
    expect(embImg.data_type).toBe('USER-DEFINED');
  }, 30_000);

  test('partial HNSW index idx_chunks_embedding_image exists with WHERE clause', async () => {
    const rows = await pg.executeRaw<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname='public' AND tablename='content_chunks'
         AND indexname='idx_chunks_embedding_image'`
    );
    expect(rows.length).toBe(1);
    expect(rows[0].indexdef.toLowerCase()).toContain('hnsw');
    expect(rows[0].indexdef.toLowerCase()).toContain('where');
    expect(rows[0].indexdef.toLowerCase()).toContain('embedding_image is not null');
  }, 30_000);

  test('files table parity: same column shape as PGLite', async () => {
    const rows = await pg.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='files'
       ORDER BY column_name`
    );
    const names = rows.map(r => r.column_name).sort();
    expect(names).toEqual([
      'content_hash',
      'created_at',
      'filename',
      'id',
      'metadata',
      'mime_type',
      'page_id',
      'page_slug',
      'size_bytes',
      'source_id',
      'storage_path',
    ]);
  }, 30_000);

  test('pages.page_kind CHECK admits image (migration v36 widening)', async () => {
    // Insert a page with page_kind='image'. CHECK pre-v0.27.1 would reject.
    const result = await pg.putPage('photos/test-image-page-kind', {
      type: 'image',
      page_kind: 'image',
      title: 'test',
      compiled_truth: '',
      timeline: '',
    });
    expect(result.id).toBeGreaterThan(0);
  }, 30_000);

  test('upsertFile end-to-end on Postgres', async () => {
    const r = await pg.upsertFile({
      source_id: 'default',
      filename: 'whiteboard.jpg',
      storage_path: 'originals/photos/whiteboard.jpg',
      mime_type: 'image/jpeg',
      size_bytes: 12345,
      content_hash: 'sha256:wb',
    });
    expect(r.id).toBeGreaterThan(0);
    expect(r.created).toBe(true);

    const fetched = await pg.getFile('default', 'originals/photos/whiteboard.jpg');
    expect(fetched).not.toBeNull();
    expect(fetched!.filename).toBe('whiteboard.jpg');

    // Re-upsert same path → no-op (created=false)
    const r2 = await pg.upsertFile({
      source_id: 'default',
      filename: 'whiteboard.jpg',
      storage_path: 'originals/photos/whiteboard.jpg',
      mime_type: 'image/jpeg',
      size_bytes: 12345,
      content_hash: 'sha256:wb',
    });
    expect(r2.id).toBe(r.id);
    expect(r2.created).toBe(false);
  }, 30_000);

  test('upsertFile preserves the legacy implicit-default contract on Postgres', async () => {
    // Runtime compatibility for an older untyped client; current TypeScript
    // callers are required to bind source_id explicitly.
    const r = await pg.upsertFile({
      filename: 'legacy-default.jpg',
      storage_path: 'legacy/default.jpg',
      content_hash: 'sha256:legacy-default',
    } as unknown as FileSpec);
    expect(r.created).toBe(true);
    expect((await pg.getFile('default', 'legacy/default.jpg'))?.source_id).toBe('default');
  }, 30_000);

  test('migration v123 adds composite identity while preserving previous-binary rollback', async () => {
    const migration = MIGRATIONS.find(entry => entry.version === 123);
    expect(migration?.name).toBe('files_source_storage_path_identity');

    // Recreate the canonical pre-v123 shape, then prove the migration can be
    // replayed safely without removing the legacy conflict target.
    await pg.executeRaw('DROP INDEX IF EXISTS idx_files_source_storage_path');
    await pg.executeRaw('ALTER TABLE files DROP CONSTRAINT IF EXISTS files_storage_path_key');
    await pg.executeRaw('ALTER TABLE files ADD CONSTRAINT files_storage_path_key UNIQUE(storage_path)');
    await pg.runMigration(123, migration!.sql);
    await pg.runMigration(123, migration!.sql);

    expect(await pg.executeRaw(
      `SELECT 1 FROM pg_constraint WHERE conname = 'files_storage_path_key'`,
    )).toHaveLength(1);
    expect(await pg.executeRaw(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'idx_files_source_storage_path'`,
    )).toHaveLength(1);

    // Exact SQL shape used by the immediately previous binary.
    await pg.executeRaw(
      `INSERT INTO files (source_id, filename, storage_path, content_hash, metadata)
       VALUES ('default', 'same.png', 'photos/same.png', 'a', '{}'::jsonb)
       ON CONFLICT (storage_path) DO UPDATE SET content_hash = EXCLUDED.content_hash`,
    );
    await pg.executeRaw(
      `INSERT INTO files (source_id, filename, storage_path, content_hash, metadata)
       VALUES ('default', 'same.png', 'photos/same.png', 'b', '{}'::jsonb)
       ON CONFLICT (storage_path) DO UPDATE SET content_hash = EXCLUDED.content_hash`,
    );
    expect((await pg.getFile('default', 'photos/same.png'))?.content_hash).toBe('b');
  }, 30_000);

  test('migration v123 rejects a non-canonical same-name file index', async () => {
    const migration = MIGRATIONS.find(entry => entry.version === 123)!;
    await pg.executeRaw('DROP INDEX IF EXISTS idx_files_source_storage_path');
    try {
      await pg.executeRaw(
        `CREATE UNIQUE INDEX idx_files_source_storage_path
           ON files(storage_path, source_id)`,
      );

      await expect(pg.runMigration(123, migration.sql!))
        .rejects.toThrow('non-canonical definition');

      expect(await pg.executeRaw(
        `SELECT 1 FROM pg_constraint WHERE conname = 'files_storage_path_key'`,
      )).toHaveLength(1);
      expect(await pg.executeRaw(
        `SELECT 1 FROM pg_indexes WHERE indexname = 'idx_files_source_storage_path'`,
      )).toHaveLength(1);
    } finally {
      await pg.executeRaw('DROP INDEX IF EXISTS idx_files_source_storage_path');
      await pg.runMigration(123, migration.sql!);
    }
  }, 30_000);

  test('migration v124 rejects duplicate source_path owners before creating its index', async () => {
    const migration = MIGRATIONS.find(entry => entry.version === 124)!;
    await pg.executeRaw('DROP INDEX IF EXISTS pages_source_path_owner_uniq');
    try {
      await pg.executeRaw(
        `INSERT INTO pages
           (source_id, slug, source_path, type, title, compiled_truth, timeline, frontmatter)
         VALUES
           ('default', 'v124/a', 'v124/shared.md', 'note', 'A', '', '', '{}'::jsonb),
           ('default', 'v124/b', 'v124/shared.md', 'note', 'B', '', '', '{}'::jsonb)`,
      );
      await expect(pg.runMigration(124, migration.sql!))
        .rejects.toThrow('v124 source_path ownership preflight failed');
      expect(await pg.executeRaw(
        `SELECT 1 FROM pg_indexes WHERE indexname = 'pages_source_path_owner_uniq'`,
      )).toHaveLength(0);
    } finally {
      await pg.executeRaw(`DELETE FROM pages WHERE slug IN ('v124/a', 'v124/b')`);
      await pg.runMigration(124, migration.sql!);
    }
  }, 30_000);

  test('migration v124 rejects a deferrable same-name ownership constraint', async () => {
    const migration = MIGRATIONS.find(entry => entry.version === 124)!;
    await pg.executeRaw('DROP INDEX IF EXISTS pages_source_path_owner_uniq');
    try {
      // A DEFERRABLE unique constraint creates an indisunique index with the
      // expected name and keys, but indimmediate=false. CREATE INDEX IF NOT
      // EXISTS would otherwise accept the lookalike and silently weaken the
      // ownership boundary.
      await pg.executeRaw(
        `ALTER TABLE pages
           ADD CONSTRAINT pages_source_path_owner_uniq
           UNIQUE (source_id, source_path)
           DEFERRABLE INITIALLY DEFERRED`,
      );
      const state = await pg.executeRaw<{ indimmediate: boolean }>(
        `SELECT i.indimmediate
           FROM pg_index i
           JOIN pg_class idx ON idx.oid = i.indexrelid
          WHERE idx.relname = 'pages_source_path_owner_uniq'`,
      );
      expect(state).toEqual([{ indimmediate: false }]);

      await expect(pg.runMigration(124, migration.sql!))
        .rejects.toThrow('non-canonical definition');
    } finally {
      await pg.executeRaw(
        'ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_source_path_owner_uniq',
      );
      await pg.runMigration(124, migration.sql!);
    }
  }, 30_000);

  test('updateSlug atomically moves independent fact keys in only the selected source', async () => {
    const oldSlug = 'rename-pg/old';
    const newSlug = 'rename-pg/new';
    await pg.executeRaw(`DELETE FROM facts WHERE source = 'rename-pg-test'`);
    await pg.executeRaw(`DELETE FROM take_proposals WHERE proposal_run_id = 'rename-pg-run'`);
    await pg.executeRaw(`DELETE FROM context_volunteer_events WHERE rationale = 'rename-pg-test'`);
    await pg.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ('rename-pg-other-source', 'rename-pg-other-source', '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    );
    await pg.putPage(oldSlug, {
      type: 'note', title: 'Old', compiled_truth: 'Old body', source_path: 'rename-pg/old.md',
    }, { sourceId: 'default' });
    await pg.executeRaw(
      `INSERT INTO facts
         (source_id, entity_slug, fact, source, source_markdown_slug, row_num)
       VALUES
         ('default', $1, 'self', 'rename-pg-test', $1, 1),
         ('default', $1, 'other-page', 'rename-pg-test', 'rename-pg/other', 2),
         ('default', 'people/other', 'source-only', 'rename-pg-test', $1, 3),
         ('rename-pg-other-source', $1, 'foreign-source', 'rename-pg-test', $1, 4)`,
      [oldSlug],
    );
    await pg.executeRaw(
      `INSERT INTO take_proposals
         (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
          status, claim_text, kind, holder, weight, model_id)
       VALUES ('default', $1, 'rename-pg-hash', 'v1', 'rename-pg-run',
               'pending', 'claim', 'belief', 'holder', 0.5, 'test')`,
      [oldSlug],
    );
    await pg.executeRaw(
      `INSERT INTO context_volunteer_events
         (source_id, slug, confidence, match_arm, rationale)
       VALUES ('default', $1, 0.9, 'test', 'rename-pg-test')`,
      [oldSlug],
    );

    await pg.updateSlug(oldSlug, newSlug, { sourceId: 'default' });
    const facts = await pg.executeRaw<{ fact: string; entity_slug: string; source_markdown_slug: string }>(
      `SELECT fact, entity_slug, source_markdown_slug FROM facts
        WHERE source = 'rename-pg-test' ORDER BY fact`,
    );
    expect(facts).toEqual([
      { fact: 'foreign-source', entity_slug: oldSlug, source_markdown_slug: oldSlug },
      { fact: 'other-page', entity_slug: newSlug, source_markdown_slug: 'rename-pg/other' },
      { fact: 'self', entity_slug: newSlug, source_markdown_slug: newSlug },
      { fact: 'source-only', entity_slug: 'people/other', source_markdown_slug: newSlug },
    ]);
    expect(await pg.executeRaw(
      `SELECT 1 FROM take_proposals WHERE proposal_run_id = 'rename-pg-run' AND page_slug = $1`,
      [newSlug],
    )).toHaveLength(1);
    expect(await pg.executeRaw(
      `SELECT 1 FROM context_volunteer_events WHERE rationale = 'rename-pg-test' AND slug = $1`,
      [newSlug],
    )).toHaveLength(1);
  }, 30_000);

  test('updateSlug is a true no-op when old and new slugs are identical', async () => {
    const slug = 'rename-pg/already-canonical';
    await pg.putPage(slug, {
      type: 'note', title: 'Canonical', compiled_truth: 'Canonical body', timeline: '',
    }, { sourceId: 'default' });
    await pg.setPageAliases(slug, 'default', ['canonical alias', 'second alias']);
    const before = await pg.executeRaw<{ alias_norm: string; slug: string }>(
      `SELECT alias_norm, slug FROM page_aliases
        WHERE source_id = 'default' AND slug = $1
        ORDER BY alias_norm`,
      [slug],
    );

    await pg.updateSlug(slug, slug, { sourceId: 'default' });

    expect(await pg.getPage(slug, { sourceId: 'default' })).not.toBeNull();
    expect(await pg.executeRaw<{ alias_norm: string; slug: string }>(
      `SELECT alias_norm, slug FROM page_aliases
        WHERE source_id = 'default' AND slug = $1
        ORDER BY alias_norm`,
      [slug],
    )).toEqual(before);
  }, 30_000);

  test('updateSlug same-slug no-op still fails closed when the selected origin is missing', async () => {
    await expect(pg.updateSlug(
      'rename-pg/missing-already-canonical',
      'rename-pg/missing-already-canonical',
      { sourceId: 'default' },
    )).rejects.toThrow(
      'expected exactly one row for default:rename-pg/missing-already-canonical',
    );
  }, 30_000);

  test('import remains fail-open before migration v110 creates page_aliases', async () => {
    const rollback = new Error('rollback pre-v110 postgres fixture');
    await expect(pg.transaction(async (tx) => {
      await tx.executeRaw('DROP TABLE page_aliases');
      const result = await importFromContent(
        tx,
        'rename-pg/pre-v110-import',
        '---\ntitle: Pre-v110 import\naliases: [Legacy Name]\n---\n\nBody survives.',
        { noEmbed: true },
      );
      expect(result.status).toBe('imported');
      expect(await tx.getPage(
        'rename-pg/pre-v110-import',
        { sourceId: 'default' },
      )).not.toBeNull();
      throw rollback;
    })).rejects.toBe(rollback);
  }, 30_000);

  test('updateSlug rejects a destination owned by another alias without moving the page', async () => {
    const oldSlug = 'rename-pg/alias-collision-old';
    const newSlug = 'rename-pg/alias-collision-new';
    const canonicalSlug = 'rename-pg/alias-owner';
    const original = await pg.putPage(oldSlug, {
      type: 'note', title: 'Old', compiled_truth: 'Old body', timeline: '',
    });
    await pg.putPage(canonicalSlug, {
      type: 'note', title: 'Alias owner', compiled_truth: 'Owner body', timeline: '',
    });
    await pg.executeRaw(
      `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug)
       VALUES ('default', $1, $2)`,
      [newSlug, canonicalSlug],
    );

    await expect(pg.updateSlug(oldSlug, newSlug, { sourceId: 'default' }))
      .rejects.toThrow('updateSlug destination alias collision');

    expect((await pg.getPage(oldSlug, { sourceId: 'default' }))?.id).toBe(original.id);
    expect(await pg.getPage(newSlug, { sourceId: 'default' })).toBeNull();
    expect(await pg.resolveSlugWithAlias(newSlug, 'default')).toBe(canonicalSlug);
  }, 30_000);

  test('concurrent updateSlug calls serialize one destination and roll back the loser', async () => {
    const oldA = 'rename-pg/concurrent-a';
    const oldB = 'rename-pg/concurrent-b';
    const destination = 'rename-pg/concurrent-destination';
    await pg.putPage(oldA, {
      type: 'note', title: 'A', compiled_truth: 'A body', timeline: '',
    });
    await pg.putPage(oldB, {
      type: 'note', title: 'B', compiled_truth: 'B body', timeline: '',
    });

    const results = await Promise.allSettled([
      pg.updateSlug(oldA, destination, { sourceId: 'default' }),
      pg.updateSlug(oldB, destination, { sourceId: 'default' }),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await pg.getPage(destination, { sourceId: 'default' })).not.toBeNull();
    const remainingOrigins = await pg.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages
        WHERE source_id = 'default' AND slug = ANY($1::text[])
        ORDER BY slug`,
      [[oldA, oldB]],
    );
    expect(remainingOrigins).toHaveLength(1);
    expect(await pg.executeRaw(
      `SELECT 1 FROM slug_aliases
        WHERE source_id = 'default' AND alias_slug = $1`,
      [destination],
    )).toHaveLength(0);
  }, 60_000);

  test('retryable batch failure retries the whole transaction on a fresh Postgres transaction', async () => {
    const slug = 'rename-pg/transaction-retry';
    const target = pg as unknown as {
      _addTimelineEntriesBatchOnce(entries: Array<{
        slug: string;
        date: string;
        source?: string;
        summary: string;
        detail?: string;
        source_id?: string;
      }>): Promise<number>;
    };
    const original = target._addTimelineEntriesBatchOnce;
    let transactionAttempts = 0;
    let batchAttempts = 0;
    target._addTimelineEntriesBatchOnce = async function (entries): Promise<number> {
      batchAttempts++;
      if (batchAttempts === 1) {
        throw Object.assign(new Error('ECONNRESET simulated transaction connection reset'), {
          code: 'ECONNRESET',
        });
      }
      return original.call(this, entries);
    };

    try {
      await pg.transaction(async tx => {
        transactionAttempts++;
        await tx.putPage(slug, {
          type: 'note',
          title: 'Transaction retry',
          compiled_truth: 'Committed exactly once.',
          timeline: '',
        }, { sourceId: 'default' });
        await tx.addTimelineEntriesBatch([{
          slug,
          date: '2026-07-10',
          source: 'test',
          summary: 'Committed with page',
          source_id: 'default',
        }]);
      }, { retryOnConnectionError: true });
    } finally {
      target._addTimelineEntriesBatchOnce = original;
    }

    expect(transactionAttempts).toBe(2);
    expect(batchAttempts).toBe(2);
    expect(await pg.executeRaw(
      `SELECT 1 FROM pages WHERE source_id = 'default' AND slug = $1`,
      [slug],
    )).toHaveLength(1);
    expect(await pg.getTimeline(slug, { sourceId: 'default' })).toHaveLength(1);
  }, 60_000);

  test('post-canary image import isolates identical paths after the legacy guard is retired', async () => {
    await pg.executeRaw('ALTER TABLE files DROP CONSTRAINT IF EXISTS files_storage_path_key');
    try {
    await pg.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ('source-a', 'source-a', '{}'::jsonb),
              ('source-b', 'source-b', '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    );

    const path = 'originals/photos/shared.png';
    expect((await importImageBuffer(pg, Buffer.from('source-a-v1'), path, {
      noEmbed: true,
      sourceId: 'source-a',
    })).status).toBe('imported');
    expect((await importImageBuffer(pg, Buffer.from('source-b-v1'), path, {
      noEmbed: true,
      sourceId: 'source-b',
    })).status).toBe('imported');

    const aV1 = await pg.getFile('source-a', path);
    const bV1 = await pg.getFile('source-b', path);
    expect(aV1).not.toBeNull();
    expect(bV1).not.toBeNull();
    expect(aV1!.id).not.toBe(bV1!.id);

    expect((await importImageBuffer(pg, Buffer.from('source-a-v2'), path, {
      noEmbed: true,
      sourceId: 'source-a',
    })).status).toBe('imported');

    const aV2 = await pg.getFile('source-a', path);
    const bV2 = await pg.getFile('source-b', path);
    expect(aV2!.id).toBe(aV1!.id);
    expect(aV2!.content_hash).not.toBe(aV1!.content_hash);
    expect(bV2!.id).toBe(bV1!.id);
    expect(bV2!.content_hash).toBe(bV1!.content_hash);
    expect((await pg.getChunks(path, { sourceId: 'source-a' })).length).toBe(1);
    expect((await pg.getChunks(path, { sourceId: 'source-b' })).length).toBe(1);

    const rows = await pg.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM files WHERE storage_path = $1 ORDER BY source_id`,
      [path],
    );
    expect(rows.map(row => row.source_id)).toEqual(['source-a', 'source-b']);
    } finally {
      await pg.executeRaw('DELETE FROM files');
      await pg.executeRaw('ALTER TABLE files ADD CONSTRAINT files_storage_path_key UNIQUE(storage_path)');
    }
  }, 30_000);

  test('upsertChunks writes embedding_image + modality columns (round-trip)', async () => {
    const page = await pg.putPage('photos/round-trip', {
      type: 'image', page_kind: 'image',
      title: 'round-trip', compiled_truth: '', timeline: '',
    });

    const vec = fakeImage1024(7);
    await pg.upsertChunks('photos/round-trip', [
      {
        chunk_index: 0,
        chunk_text: 'round-trip',
        chunk_source: 'image_asset',
        embedding_image: vec,
        modality: 'image',
      },
    ]);

    // Verify the row landed with modality='image' and embedding_image is non-NULL.
    const rows = await pg.executeRaw<{ modality: string; has_image: boolean; has_text: boolean }>(
      `SELECT modality,
              embedding_image IS NOT NULL AS has_image,
              embedding IS NOT NULL AS has_text
       FROM content_chunks WHERE page_id = $1`,
      [page.id]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].modality).toBe('image');
    expect(rows[0].has_image).toBe(true);
    expect(rows[0].has_text).toBe(false); // image rows leave embedding NULL
  }, 30_000);

  test('searchVector with embeddingColumn=embedding_image returns image rows on Postgres', async () => {
    // Seed one text page at the schema's configured primary width and two
    // image pages at the fixed 1024-dim embedding_image width.
    const textVec = fakeTextEmbedding(0);
    await pg.putPage('notes/text-only', {
      type: 'note', title: 'text only', compiled_truth: 'body', timeline: '',
    });
    await pg.upsertChunks('notes/text-only', [{
      chunk_index: 0, chunk_text: 'body',
      chunk_source: 'compiled_truth',
      embedding: textVec, modality: 'text',
    }]);

    const imgA = fakeImage1024(0);
    const imgB = fakeImage1024(500);
    await pg.putPage('photos/a', {
      type: 'image', page_kind: 'image',
      title: 'a', compiled_truth: '', timeline: '',
    });
    await pg.upsertChunks('photos/a', [{
      chunk_index: 0, chunk_text: 'a',
      chunk_source: 'image_asset',
      embedding_image: imgA, modality: 'image',
    }]);
    await pg.putPage('photos/b', {
      type: 'image', page_kind: 'image',
      title: 'b', compiled_truth: '', timeline: '',
    });
    await pg.upsertChunks('photos/b', [{
      chunk_index: 0, chunk_text: 'b',
      chunk_source: 'image_asset',
      embedding_image: imgB, modality: 'image',
    }]);

    // Image-similarity query nearest to imgB.
    const hits = await pg.searchVector(imgB, {
      limit: 5,
      embeddingColumn: 'embedding_image',
    });
    const slugs = hits.map(h => h.slug);
    expect(slugs).toContain('photos/b');
    // Modality filter excludes the text page even though dim mismatches.
    expect(slugs).not.toContain('notes/text-only');
    // Nearest-first ordering.
    expect(hits[0].slug).toBe('photos/b');
  }, 30_000);

  test('searchKeyword hides image rows by default (modality filter on Postgres)', async () => {
    // Seed text + image pages with chunk_text the FTS would normally match.
    const textVec = fakeTextEmbedding(1);
    await pg.putPage('notes/keyword', {
      type: 'note', title: 'keyword', compiled_truth: 'sunset photo at the beach', timeline: '',
    });
    await pg.upsertChunks('notes/keyword', [{
      chunk_index: 0,
      chunk_text: 'sunset photo at the beach',
      chunk_source: 'compiled_truth',
      embedding: textVec, modality: 'text',
    }]);
    await pg.putPage('photos/keyword', {
      type: 'image', page_kind: 'image',
      title: 'keyword image', compiled_truth: '', timeline: '',
    });
    await pg.upsertChunks('photos/keyword', [{
      chunk_index: 0,
      chunk_text: 'sunset photo at the beach',
      chunk_source: 'image_asset',
      embedding_image: fakeImage1024(2), modality: 'image',
    }]);

    const out = await pg.searchKeyword('sunset', { limit: 10 });
    const slugs = out.map(r => r.slug);
    expect(slugs).toContain('notes/keyword');
    expect(slugs).not.toContain('photos/keyword');
  }, 30_000);

  test('cross-engine parity: same fixture, identical chunk + file shape on PGLite + Postgres', async () => {
    // Direct comparison against PGLite for the dual-column architecture.
    // Closes Eng-3G (the v0.27.1 plan's parity gate).
    const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
    const pglite = new PGLiteEngine();
    await pglite.connect({});
    await pglite.initSchema();

    try {
      const vec = fakeImage1024(42);
      const slug = 'photos/parity-test';
      const fileSpec = {
        source_id: 'default',
        filename: 'parity.jpg',
        storage_path: 'originals/photos/parity-test.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 999,
        content_hash: 'sha256:parity',
      };

      // PGLite (already clean since it's fresh).
      const pglitePage = await pglite.putPage(slug, {
        type: 'image', page_kind: 'image',
        title: 'parity', compiled_truth: '', timeline: '',
      });
      await pglite.upsertFile({ ...fileSpec, page_id: pglitePage.id, page_slug: slug });
      await pglite.upsertChunks(slug, [{
        chunk_index: 0, chunk_text: 'parity',
        chunk_source: 'image_asset',
        embedding_image: vec, modality: 'image',
      }]);

      // Postgres.
      const pgPage = await pg.putPage(slug, {
        type: 'image', page_kind: 'image',
        title: 'parity', compiled_truth: '', timeline: '',
      });
      await pg.upsertFile({ ...fileSpec, page_id: pgPage.id, page_slug: slug });
      await pg.upsertChunks(slug, [{
        chunk_index: 0, chunk_text: 'parity',
        chunk_source: 'image_asset',
        embedding_image: vec, modality: 'image',
      }]);

      // Pull both pages and assert structural equality (excluding id + timestamps).
      const pgliteFile = await pglite.getFile('default', fileSpec.storage_path);
      const pgFile = await pg.getFile('default', fileSpec.storage_path);
      expect(pgliteFile).not.toBeNull();
      expect(pgFile).not.toBeNull();
      expect(pgliteFile!.filename).toBe(pgFile!.filename);
      expect(pgliteFile!.mime_type).toBe(pgFile!.mime_type);
      // PGLite returns size_bytes as BigInt, Postgres as Number — both are
      // valid for a BIGINT column. Compare numerically.
      expect(Number(pgliteFile!.size_bytes)).toBe(Number(pgFile!.size_bytes));
      expect(pgliteFile!.content_hash).toBe(pgFile!.content_hash);
      expect(pgliteFile!.source_id).toBe(pgFile!.source_id);

      // Modality + presence checks via raw SQL (chunk shape, not API).
      const pgliteRows = await pglite.executeRaw<{ modality: string; has_image: boolean }>(
        `SELECT modality, embedding_image IS NOT NULL AS has_image
         FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
         WHERE p.slug = $1`,
        [slug]
      );
      const pgRows = await pg.executeRaw<{ modality: string; has_image: boolean }>(
        `SELECT modality, embedding_image IS NOT NULL AS has_image
         FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
         WHERE p.slug = $1`,
        [slug]
      );
      expect(pgliteRows[0].modality).toBe(pgRows[0].modality);
      expect(pgliteRows[0].has_image).toBe(pgRows[0].has_image);
    } finally {
      await pglite.disconnect();
    }
  }, 30_000);

  test('migration v36 ran (schema_version >= 36)', async () => {
    // initSchema runs migrations; verify config table reflects v36+ landed.
    const v = await pg.getConfig('version');
    const ver = parseInt(v ?? '0', 10);
    expect(ver).toBeGreaterThanOrEqual(36);
  }, 30_000);
});
