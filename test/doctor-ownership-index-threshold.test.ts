import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { buildCriticalOwnershipIndexCheck } from '../src/commands/doctor.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

describe('doctor ownership-index version thresholds', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.executeRaw('DROP INDEX pages_source_path_owner_uniq');
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('v123 is healthy with the canonical file index alone', async () => {
    expect(await buildCriticalOwnershipIndexCheck(engine, 123)).toMatchObject({
      status: 'ok',
      message: expect.stringContaining('page-path index starts at v124'),
    });
  });

  test('v124 fails when its page ownership index is absent', async () => {
    expect(await buildCriticalOwnershipIndexCheck(engine, 124)).toMatchObject({
      status: 'fail',
      message: expect.stringContaining('pages_source_path_owner_uniq'),
    });
  });
});
