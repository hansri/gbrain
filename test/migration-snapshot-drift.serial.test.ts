import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { getOrCreateDatabaseInstanceId } from '../src/core/database-instance-id.ts';
import { __testing } from '../src/commands/migrations/v0_29_1.ts';
import { migrationTestOpts } from './helpers/migration-opts.ts';
import { withEnv } from './helpers/with-env.ts';

async function seedUndatedPage(databasePath: string, slug: string): Promise<void> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: databasePath });
  try {
    await engine.initSchema();
    await engine.putPage(slug, {
      type: 'note',
      title: slug,
      compiled_truth: 'snapshot drift fixture',
      timeline: '',
      frontmatter: { event_date: '2026-03-04' },
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages
          SET effective_date = NULL, effective_date_source = NULL
        WHERE source_id = 'default' AND slug = $1`,
      [slug],
    );
  } finally {
    await engine.disconnect();
  }
}

async function effectiveDate(databasePath: string, slug: string): Promise<string | null> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: databasePath });
  try {
    const rows = await engine.executeRaw<{ effective_date: string | null }>(
      `SELECT effective_date::text AS effective_date
         FROM pages
        WHERE source_id = 'default' AND slug = $1`,
      [slug],
    );
    return rows[0]?.effective_date ?? null;
  } finally {
    await engine.disconnect();
  }
}

async function durableBrainId(databasePath: string): Promise<string> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: databasePath });
  try {
    return await getOrCreateDatabaseInstanceId(engine);
  } finally {
    await engine.disconnect();
  }
}

describe('migration brain snapshot', () => {
  test('ambient A-to-B config drift cannot redirect a legacy data phase', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-migration-drift-'));
    const databaseA = join(root, 'brain-a');
    const databaseB = join(root, 'brain-b');
    const ambientHome = join(root, 'ambient-b');
    const slug = 'notes/snapshot-target';

    try {
      await seedUndatedPage(databaseA, slug);
      await seedUndatedPage(databaseB, slug);

      // The runner captured A, then the ambient config changed to B before
      // this legacy phase began. The phase must still mutate only A.
      mkdirSync(join(ambientHome, '.gbrain'), { recursive: true, mode: 0o700 });
      writeFileSync(
        join(ambientHome, '.gbrain', 'config.json'),
        JSON.stringify({ engine: 'pglite', database_path: databaseB }),
        { mode: 0o600 },
      );
      const optsA = migrationTestOpts(
        {},
        { engine: 'pglite', database_path: databaseA },
      );
      optsA.brainId = await durableBrainId(databaseA);

      const rejected = await withEnv(
        {
          GBRAIN_HOME: ambientHome,
          DATABASE_URL: undefined,
          GBRAIN_DATABASE_URL: undefined,
        },
        () => __testing.phaseBBackfill({ ...optsA, brainId: 'wrong-brain-id' }),
      );
      expect(rejected.status).toBe('failed');
      expect(rejected.detail).toContain('Database identity changed');
      expect(await effectiveDate(databaseA, slug)).toBeNull();
      expect(await effectiveDate(databaseB, slug)).toBeNull();

      const result = await withEnv(
        {
          GBRAIN_HOME: ambientHome,
          DATABASE_URL: undefined,
          GBRAIN_DATABASE_URL: undefined,
        },
        () => __testing.phaseBBackfill(optsA),
      );

      expect(result.status).toBe('complete');
      expect(await effectiveDate(databaseA, slug)).not.toBeNull();
      expect(await effectiveDate(databaseB, slug)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
