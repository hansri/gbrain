import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  contentAddressedStoragePath,
  publishStoredFile,
  sha256Hex,
} from '../../src/core/file-storage-publish.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { LocalStorage } from '../../src/core/storage/local.ts';
import { getPostgresTestUrl } from '../helpers/postgres-test-authority.ts';

const DATABASE_URL = getPostgresTestUrl();
const skip = !DATABASE_URL;

if (skip) {
  test.skip('files object-safety Postgres E2E skipped (DATABASE_URL unset)', () => {});
}

describe.skipIf(skip)('files object-storage safety against real Postgres', () => {
  let engine: PostgresEngine;
  let storageRoot: string;
  let storage: LocalStorage;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
    await engine.initSchema();
    storageRoot = mkdtempSync(join(tmpdir(), 'gbrain-files-pg-storage-'));
    storage = new LocalStorage(storageRoot);
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
  }, 30_000);

  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM files');
    await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'files-pg/%'`);
    rmSync(storageRoot, { recursive: true, force: true });
    storage = new LocalStorage(storageRoot);
  });

  test('changed bytes switch one DB pointer only after immutable object verification', async () => {
    await engine.putPage('files-pg/report', {
      type: 'note', title: 'Report', compiled_truth: '',
    });
    const logicalPath = 'files-pg/report/report.pdf';
    const firstBytes = Buffer.from('postgres first revision');
    const first = await publishStoredFile({
      engine,
      storage,
      sourceId: 'default',
      logicalPath,
      pageSlug: 'files-pg/report',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      data: firstBytes,
    });
    const secondBytes = Buffer.from('postgres second revision');
    const second = await publishStoredFile({
      engine,
      storage,
      sourceId: 'default',
      logicalPath,
      pageSlug: 'files-pg/report',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      data: secondBytes,
    });

    expect(first.storagePath).toBe(contentAddressedStoragePath(
      'default', logicalPath, sha256Hex(firstBytes),
    ));
    expect(second.storagePath).toBe(contentAddressedStoragePath(
      'default', logicalPath, sha256Hex(secondBytes),
    ));
    const rows = await engine.executeRaw<{
      storage_path: string;
      content_hash: string;
      metadata_type: string;
      logical_path: string;
    }>(
      `SELECT storage_path,
              content_hash,
              jsonb_typeof(metadata) AS metadata_type,
              metadata->>'logical_path' AS logical_path
         FROM files
        WHERE source_id = 'default'`,
    );
    expect(rows).toEqual([{
      storage_path: second.storagePath,
      content_hash: sha256Hex(secondBytes),
      metadata_type: 'object',
      logical_path: logicalPath,
    }]);
    expect(existsSync(join(storageRoot, first.storagePath))).toBe(true);
    expect(existsSync(join(storageRoot, second.storagePath))).toBe(true);
  }, 30_000);

  test('a real transaction failure never deletes the prior referenced object', async () => {
    await engine.putPage('files-pg/critical', {
      type: 'note', title: 'Critical', compiled_truth: '',
    });
    const logicalPath = 'files-pg/critical/critical.pdf';
    const firstBytes = Buffer.from('postgres committed bytes');
    const first = await publishStoredFile({
      engine,
      storage,
      sourceId: 'default',
      logicalPath,
      pageSlug: 'files-pg/critical',
      filename: 'critical.pdf',
      mimeType: 'application/pdf',
      data: firstBytes,
    });
    const secondBytes = Buffer.from('postgres uncommitted bytes');
    const secondPath = contentAddressedStoragePath(
      'default', logicalPath, sha256Hex(secondBytes),
    );

    await engine.executeRaw(`
      CREATE OR REPLACE FUNCTION gbrain_test_fail_file_pointer_update()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'simulated pointer commit failure';
      END
      $$
    `);
    await engine.executeRaw(`
      CREATE TRIGGER gbrain_test_fail_file_pointer_update
      BEFORE UPDATE ON files
      FOR EACH ROW EXECUTE FUNCTION gbrain_test_fail_file_pointer_update()
    `);
    try {
      await expect(publishStoredFile({
        engine,
        storage,
        sourceId: 'default',
        logicalPath,
        pageSlug: 'files-pg/critical',
        filename: 'critical.pdf',
        mimeType: 'application/pdf',
        data: secondBytes,
      })).rejects.toThrow('simulated pointer commit failure');
    } finally {
      await engine.executeRaw('DROP TRIGGER IF EXISTS gbrain_test_fail_file_pointer_update ON files');
      await engine.executeRaw('DROP FUNCTION IF EXISTS gbrain_test_fail_file_pointer_update()');
    }

    const rows = await engine.executeRaw<{ storage_path: string; content_hash: string }>(
      `SELECT storage_path, content_hash FROM files WHERE source_id = 'default'`,
    );
    expect(rows).toEqual([{
      storage_path: first.storagePath,
      content_hash: sha256Hex(firstBytes),
    }]);
    expect(existsSync(join(storageRoot, first.storagePath))).toBe(true);
    expect(existsSync(join(storageRoot, secondPath))).toBe(true);
  }, 30_000);

  test('concurrent first writes serialize to one logical DB pointer', async () => {
    const logicalPath = 'files-pg/concurrent/report.pdf';
    const firstBytes = Buffer.from('concurrent revision one');
    const secondBytes = Buffer.from('concurrent revision two');
    const publish = (data: Buffer) => publishStoredFile({
      engine,
      storage,
      sourceId: 'default',
      logicalPath,
      pageSlug: null,
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      data,
    });

    const [first, second] = await Promise.all([
      publish(firstBytes),
      publish(secondBytes),
    ]);

    const rows = await engine.executeRaw<{ storage_path: string }>(
      `SELECT storage_path
         FROM files
        WHERE source_id = 'default'
          AND metadata->>'logical_path' = $1`,
      [logicalPath],
    );
    expect(rows).toHaveLength(1);
    expect([first.storagePath, second.storagePath]).toContain(rows[0]!.storage_path);
    expect(existsSync(join(storageRoot, first.storagePath))).toBe(true);
    expect(existsSync(join(storageRoot, second.storagePath))).toBe(true);
  }, 30_000);
});
