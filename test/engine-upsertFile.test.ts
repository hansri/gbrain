// Phase 3 + Eng-3E: BrainEngine.upsertFile contract.
//
// Verifies the v0.27.1 file-metadata API on PGLite (the default engine).
// Postgres parity is covered by test/e2e/pglite-files-parity.test.ts.

import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { FileSpec } from '../src/core/engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('BrainEngine.upsertFile (Phase 3 + Eng-3E)', () => {
  test('legacy callers without source_id remain scoped to default', async () => {
    // Deliberately bypass the current TypeScript contract to emulate an older
    // JavaScript client on the wire. New typed callers must provide source_id.
    const result = await engine.upsertFile({
      filename: 'legacy.jpg',
      storage_path: 'legacy/legacy.jpg',
      content_hash: 'sha256:legacy',
    } as unknown as FileSpec);

    expect(result.created).toBe(true);
    expect((await engine.getFile('default', 'legacy/legacy.jpg'))?.source_id).toBe('default');
  });

  test('happy path: inserts a new files row', async () => {
    const result = await engine.upsertFile({
      source_id: 'default',
      filename: 'photo.jpg',
      storage_path: 'originals/photos/photo.jpg',
      mime_type: 'image/jpeg',
      size_bytes: 12345,
      content_hash: 'sha256:abc',
    });
    expect(result.id).toBeGreaterThan(0);
    expect(result.created).toBe(true);

    const row = await engine.getFile('default', 'originals/photos/photo.jpg');
    expect(row).not.toBeNull();
    expect(row!.filename).toBe('photo.jpg');
    expect(row!.mime_type).toBe('image/jpeg');
    expect(row!.size_bytes).toBe(12345);
    expect(row!.content_hash).toBe('sha256:abc');
    expect(row!.source_id).toBe('default');
  });

  test('Eng-3E: ON CONFLICT idempotency — same path, same hash is no-op-ish', async () => {
    const r1 = await engine.upsertFile({
      source_id: 'default',
      filename: 'photo.jpg',
      storage_path: 'originals/photos/photo.jpg',
      mime_type: 'image/jpeg',
      size_bytes: 1000,
      content_hash: 'sha256:original',
    });
    const r2 = await engine.upsertFile({
      source_id: 'default',
      filename: 'photo.jpg',
      storage_path: 'originals/photos/photo.jpg',
      mime_type: 'image/jpeg',
      size_bytes: 1000,
      content_hash: 'sha256:original',
    });
    // Same id (no duplicate row), but the second call updated metadata in
    // place via DO UPDATE (xmax != 0 → created=false).
    expect(r2.id).toBe(r1.id);
    expect(r2.created).toBe(false);

    // Only one row exists at that storage_path.
    const row = await engine.getFile('default', 'originals/photos/photo.jpg');
    expect(row!.id).toBe(r1.id);
  });

  test('Eng-3E: ON CONFLICT updates metadata when content_hash changes', async () => {
    await engine.upsertFile({
      source_id: 'default',
      filename: 'photo.jpg',
      storage_path: 'originals/photos/photo.jpg',
      mime_type: 'image/jpeg',
      size_bytes: 1000,
      content_hash: 'sha256:v1',
    });
    // Image was replaced — same path, different content.
    const r2 = await engine.upsertFile({
      source_id: 'default',
      filename: 'photo.jpg',
      storage_path: 'originals/photos/photo.jpg',
      mime_type: 'image/jpeg',
      size_bytes: 9999,
      content_hash: 'sha256:v2',
    });
    expect(r2.created).toBe(false);

    const row = await engine.getFile('default', 'originals/photos/photo.jpg');
    expect(row!.content_hash).toBe('sha256:v2');
    expect(row!.size_bytes).toBe(9999);
  });

  test('listFilesForPage returns rows linked via page_id', async () => {
    const page = await engine.putPage('originals/meetings/foo', {
      type: 'meeting',
      title: 'Foo meeting',
      compiled_truth: 'Body',
      timeline: '',
    });
    await engine.upsertFile({
      source_id: 'default',
      page_id: page.id,
      page_slug: page.slug,
      filename: 'whiteboard.jpg',
      storage_path: 'originals/photos/whiteboard.jpg',
      mime_type: 'image/jpeg',
      size_bytes: 5000,
      content_hash: 'sha256:wb',
    });
    await engine.upsertFile({
      source_id: 'default',
      page_id: page.id,
      page_slug: page.slug,
      filename: 'sketch.png',
      storage_path: 'originals/photos/sketch.png',
      mime_type: 'image/png',
      size_bytes: 3000,
      content_hash: 'sha256:sk',
    });
    const rows = await engine.listFilesForPage(page.id);
    expect(rows.length).toBe(2);
    expect(rows.map(r => r.filename).sort()).toEqual(['sketch.png', 'whiteboard.jpg']);
  });

  test('getFile returns null when storage_path is unknown', async () => {
    const row = await engine.getFile('default', 'nonexistent/path.jpg');
    expect(row).toBeNull();
  });

  test('canary keeps legacy global path uniqueness until the rollback window closes', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ('source-a', 'source-a', '{}'::jsonb),
              ('source-b', 'source-b', '{}'::jsonb)`,
    );

    const a = await engine.upsertFile({
      source_id: 'source-a',
      filename: 'shared.jpg',
      storage_path: 'photos/shared.jpg',
      content_hash: 'sha256:a-v1',
    });
    expect(a.created).toBe(true);
    expect((await engine.getFile('source-a', 'photos/shared.jpg'))?.content_hash).toBe('sha256:a-v1');
    await expect(engine.upsertFile({
      source_id: 'source-b',
      filename: 'shared.jpg',
      storage_path: 'photos/shared.jpg',
      content_hash: 'sha256:b-v1',
    })).rejects.toThrow();
  });

  test('previous binary ON CONFLICT(storage_path) writer remains compatible', async () => {
    await engine.executeRaw(
      `INSERT INTO files (source_id, filename, storage_path, content_hash, metadata)
       VALUES ('default', 'legacy.jpg', 'legacy/rollback.jpg', 'sha256:v1', '{}'::jsonb)
       ON CONFLICT (storage_path) DO UPDATE SET content_hash = EXCLUDED.content_hash`,
    );
    await engine.executeRaw(
      `INSERT INTO files (source_id, filename, storage_path, content_hash, metadata)
       VALUES ('default', 'legacy.jpg', 'legacy/rollback.jpg', 'sha256:v2', '{}'::jsonb)
       ON CONFLICT (storage_path) DO UPDATE SET content_hash = EXCLUDED.content_hash`,
    );

    expect((await engine.getFile('default', 'legacy/rollback.jpg'))?.content_hash).toBe('sha256:v2');
  });
});
