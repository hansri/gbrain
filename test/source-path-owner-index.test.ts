import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  isCanonicalFileStorageIndex,
  isCanonicalSourcePathOwnerIndex,
  assertCriticalOwnershipIndexesForVersion,
  verifyFileStorageIndex,
  verifySourcePathOwnerIndex,
  type SourcePathOwnerIndexState,
} from '../src/core/source-path-owner-index.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const pageIndex: SourcePathOwnerIndexState = {
  indisunique: true,
  indisvalid: true,
  indisready: true,
  indimmediate: true,
  definition:
    'CREATE UNIQUE INDEX pages_source_path_owner_uniq ON public.pages USING btree (source_id, source_path) WHERE (source_path IS NOT NULL)',
  predicate: '(source_path IS NOT NULL)',
};

const fileIndex: SourcePathOwnerIndexState = {
  indisunique: true,
  indisvalid: true,
  indisready: true,
  indimmediate: true,
  definition:
    'CREATE UNIQUE INDEX idx_files_source_storage_path ON public.files USING btree (source_id, storage_path)',
  predicate: null,
};

describe('multi-source ownership index post-conditions', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('accepts only the exact canonical page ownership index', () => {
    expect(isCanonicalSourcePathOwnerIndex(pageIndex)).toBe(true);
    expect(isCanonicalSourcePathOwnerIndex({ ...pageIndex, indisunique: false })).toBe(false);
    expect(isCanonicalSourcePathOwnerIndex({ ...pageIndex, indisvalid: false })).toBe(false);
    expect(isCanonicalSourcePathOwnerIndex({ ...pageIndex, indisready: false })).toBe(false);
    expect(isCanonicalSourcePathOwnerIndex({ ...pageIndex, indimmediate: false })).toBe(false);
    expect(isCanonicalSourcePathOwnerIndex({ ...pageIndex, predicate: null })).toBe(false);
    expect(isCanonicalSourcePathOwnerIndex({
      ...pageIndex,
      definition: pageIndex.definition.replace('(source_id, source_path)', '(slug)'),
    })).toBe(false);
  });

  test('accepts only the exact canonical unqualified file ownership index', () => {
    expect(isCanonicalFileStorageIndex(fileIndex)).toBe(true);
    expect(isCanonicalFileStorageIndex({ ...fileIndex, indisunique: false })).toBe(false);
    expect(isCanonicalFileStorageIndex({ ...fileIndex, indisvalid: false })).toBe(false);
    expect(isCanonicalFileStorageIndex({ ...fileIndex, indisready: false })).toBe(false);
    expect(isCanonicalFileStorageIndex({ ...fileIndex, indimmediate: false })).toBe(false);
    expect(isCanonicalFileStorageIndex({ ...fileIndex, predicate: 'storage_path IS NOT NULL' })).toBe(false);
    expect(isCanonicalFileStorageIndex({
      ...fileIndex,
      definition: fileIndex.definition.replace('(source_id, storage_path)', '(storage_path)'),
    })).toBe(false);
  });

  test('recognizes the real indexes created on a fresh PGLite brain', async () => {
    expect(await verifySourcePathOwnerIndex(engine)).toBe(true);
    expect(await verifyFileStorageIndex(engine)).toBe(true);
  }, 60_000);

  test('requires file identity at v123 and both ownership indexes from v124', async () => {
    await engine.executeRaw('DROP INDEX pages_source_path_owner_uniq');
    try {
      await expect(assertCriticalOwnershipIndexesForVersion(engine, 123)).resolves.toBeUndefined();
      await expect(assertCriticalOwnershipIndexesForVersion(engine, 124))
        .rejects.toThrow('pages_source_path_owner_uniq');
    } finally {
      await engine.executeRaw(
        'CREATE UNIQUE INDEX pages_source_path_owner_uniq ON pages(source_id, source_path) WHERE source_path IS NOT NULL',
      );
    }
  }, 60_000);
});
