import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runApplyMigrations } from '../src/commands/apply-migrations.ts';
import { runPostUpgradeRecoveryAction } from '../src/commands/upgrade.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  DATABASE_INSTANCE_ID_CONFIG_KEY,
  getOrCreateDatabaseInstanceId,
  readDatabaseInstanceId,
} from '../src/core/database-instance-id.ts';
import {
  appendAmbiguousMigration,
  appendCompletedMigration,
  loadCompletedMigrations,
} from '../src/core/preferences.ts';
import { VERSION } from '../src/version.ts';

let home: string;
let databasePath: string;
let brainId: string;
let priorHome: string | undefined;
let priorGbrainHome: string | undefined;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-apply-recovery-'));
  // macOS exposes the temp root through /var -> /private/var; the read-only
  // PGLite authority intentionally rejects symlinked path components.
  databasePath = join(realpathSync(home), 'brain');
  priorHome = process.env.HOME;
  priorGbrainHome = process.env.GBRAIN_HOME;
  process.env.HOME = home;
  process.env.GBRAIN_HOME = home;

  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: databasePath });
  try {
    await engine.initSchema();
    brainId = await getOrCreateDatabaseInstanceId(engine);
  } finally {
    await engine.disconnect();
  }
  mkdirSync(join(home, '.gbrain'), { recursive: true, mode: 0o700 });
  chmodSync(join(home, '.gbrain'), 0o700);
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'pglite',
    database_path: databasePath,
  }));
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = priorGbrainHome;
  rmSync(home, { recursive: true, force: true });
});

async function setRawFence(version: string, value: string): Promise<void> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: databasePath });
  try {
    await engine.executeRaw(
      `INSERT INTO config (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [`migration_inflight:${version}`, value],
    );
  } finally {
    await engine.disconnect();
  }
}

function snapshotStateTree(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = join(prefix, name);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        out.push(`d:${rel}:${stats.mode & 0o777}`);
        walk(path, rel);
      } else {
        out.push(`f:${rel}:${stats.mode & 0o777}:${readFileSync(path).toString('base64')}`);
      }
    }
  };
  walk(root, '');
  return out;
}

async function databaseConfigRows(): Promise<Array<{ key: string; value: string }>> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: databasePath });
  try {
    return await engine.executeRaw<{ key: string; value: string }>(
      'SELECT key, value FROM config ORDER BY key',
    );
  } finally {
    await engine.disconnect();
  }
}

describe('targeted migration recovery', () => {
  const transition = () => ({
    transitionId: '11111111-1111-4111-8111-111111111111',
    brainId,
    fromVersion: '0.42.58.0',
    toVersion: VERSION,
  });

  test('bound post-upgrade force-retry clears only the verified version', async () => {
    appendAmbiguousMigration({ version: '0.11.0', brain_id: brainId });

    await runPostUpgradeRecoveryAction(
      { kind: 'recover-migration', version: '0.11.0' },
      transition(),
    );

    expect(loadCompletedMigrations().filter(entry =>
      entry.brain_id === brainId && entry.version === '0.11.0').at(-1)?.status).toBe('retry');
  }, 60_000);

  test('bound recovery rejects wrong transition, release, or brain before mutation', async () => {
    appendAmbiguousMigration({ version: '0.11.0', brain_id: brainId });
    const before = loadCompletedMigrations();

    for (const authority of [
      undefined,
      { ...transition(), transitionId: 'not-a-transition' },
      { ...transition(), toVersion: '0.42.60.0' },
      { ...transition(), brainId: 'db:00000000-0000-4000-8000-000000000000' },
    ]) {
      await expect(runPostUpgradeRecoveryAction(
        { kind: 'recover-migration', version: '0.11.0' },
        authority,
      )).rejects.toThrow(/exact unresolved upgrade transition|was refused/);
      expect(loadCompletedMigrations()).toEqual(before);
    }
  }, 60_000);

  test('bound ownership repair rechecks database identity and changes only competing claims', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: databasePath });
    try {
      await engine.executeRaw('DROP INDEX pages_source_path_owner_uniq');
      await engine.executeRaw(
        `INSERT INTO pages
           (source_id, slug, source_path, type, title, compiled_truth, timeline, frontmatter)
         VALUES
           ('default', 'legacy/a', 'legacy/shared.md', 'note', 'A', 'A body', '', '{}'::jsonb),
           ('default', 'legacy/b', 'legacy/shared.md', 'note', 'B', 'B body', '', '{}'::jsonb)`,
      );
    } finally {
      await engine.disconnect();
    }

    await expect(runPostUpgradeRecoveryAction({
      kind: 'repair-ownership',
      sourceId: 'default',
      sourcePath: 'legacy/shared.md',
      keepSlug: 'legacy/a',
    }, {
      ...transition(),
      brainId: 'db:00000000-0000-4000-8000-000000000000',
    })).rejects.toThrow(/does not match pending upgrade brain/);

    await runPostUpgradeRecoveryAction({
      kind: 'repair-ownership',
      sourceId: 'default',
      sourcePath: 'legacy/shared.md',
      keepSlug: 'legacy/a',
    }, transition());

    const verify = new PGLiteEngine();
    await verify.connect({ engine: 'pglite', database_path: databasePath });
    try {
      expect(await verify.executeRaw<{ slug: string; source_path: string | null; compiled_truth: string }>(
        `SELECT slug, source_path, compiled_truth
           FROM pages
          WHERE slug IN ('legacy/a', 'legacy/b')
          ORDER BY slug`,
      )).toEqual([
        { slug: 'legacy/a', source_path: 'legacy/shared.md', compiled_truth: 'A body' },
        { slug: 'legacy/b', source_path: null, compiled_truth: 'B body' },
      ]);
    } finally {
      await verify.disconnect();
    }
  }, 60_000);

  test('list and dry-run reject loose state permissions without repairing metadata', async () => {
    const migrationsDir = join(home, '.gbrain', 'migrations');
    const ledger = join(migrationsDir, 'completed.jsonl');
    mkdirSync(migrationsDir, { recursive: true, mode: 0o755 });
    writeFileSync(ledger, `${JSON.stringify({ version: '0.11.0', status: 'complete' })}\n`, {
      mode: 0o644,
    });
    chmodSync(migrationsDir, 0o755);
    chmodSync(ledger, 0o644);
    const before = snapshotStateTree(join(home, '.gbrain'));

    for (const flag of ['--list', '--dry-run']) {
      const result = await runApplyMigrations([flag]);
      expect(result).toMatchObject({ exitCode: 1, reason: 'failed' });
      expect(result.message).toContain('permissions are not 0700');
      expect(snapshotStateTree(join(home, '.gbrain'))).toEqual(before);
    }
  }, 60_000);

  test('list and dry-run never create a missing configured PGLite store', async () => {
    rmSync(databasePath, { recursive: true, force: true });
    expect(existsSync(databasePath)).toBe(false);
    const beforeFs = snapshotStateTree(join(home, '.gbrain'));

    for (const flag of ['--list', '--dry-run']) {
      const result = await runApplyMigrations([flag]);
      expect(result).toMatchObject({ exitCode: 1, reason: 'failed' });
      expect(result.message).toContain('does not exist; read-only open will not create an empty store');
      expect(existsSync(databasePath)).toBe(false);
      expect(snapshotStateTree(join(home, '.gbrain'))).toEqual(beforeFs);
      expect(existsSync(join(home, '.gbrain', 'locks'))).toBe(false);
    }
  }, 60_000);

  test('upgrade-bound apply never creates or adopts a database identity before binding', async () => {
    const beforeWrongDb = await databaseConfigRows();
    const beforeWrongFs = snapshotStateTree(join(home, '.gbrain'));
    const wrong = await runApplyMigrations(['--yes'], { expectedBrainId: 'db:00000000-0000-4000-8000-000000000000' });
    expect(wrong).toMatchObject({ exitCode: 1, reason: 'failed' });
    expect(wrong.message).toContain('does not match pending upgrade brain');
    expect(await databaseConfigRows()).toEqual(beforeWrongDb);
    expect(snapshotStateTree(join(home, '.gbrain'))).toEqual(beforeWrongFs);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: databasePath });
    try {
      await engine.executeRaw('DELETE FROM config WHERE key = $1', [DATABASE_INSTANCE_ID_CONFIG_KEY]);
      expect(await readDatabaseInstanceId(engine)).toBeNull();
    } finally {
      await engine.disconnect();
    }
    const beforeMissingDb = await databaseConfigRows();
    const beforeMissingFs = snapshotStateTree(join(home, '.gbrain'));

    for (const expectedBrainId of [null, brainId]) {
      const result = await runApplyMigrations(['--yes'], { expectedBrainId });
      expect(result).toMatchObject({ exitCode: 1, reason: 'failed' });
      expect(result.message).toContain('Read-only migration inspection cannot create it');
      expect(await databaseConfigRows()).toEqual(beforeMissingDb);
      expect(snapshotStateTree(join(home, '.gbrain'))).toEqual(beforeMissingFs);
      expect(existsSync(join(home, '.gbrain', 'locks'))).toBe(false);
    }
  }, 60_000);

  test('list and dry-run never create a missing database identity or filesystem state', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: databasePath });
    try {
      await engine.executeRaw('DELETE FROM config WHERE key = $1', [DATABASE_INSTANCE_ID_CONFIG_KEY]);
      expect(await readDatabaseInstanceId(engine)).toBeNull();
    } finally {
      await engine.disconnect();
    }
    const beforeDb = await databaseConfigRows();
    const beforeFs = snapshotStateTree(join(home, '.gbrain'));

    for (const flag of ['--list', '--dry-run']) {
      const result = await runApplyMigrations([flag]);
      expect(result).toMatchObject({ exitCode: 1, reason: 'failed' });
      expect(result.message).toContain('Read-only migration inspection cannot create it');
      expect(await databaseConfigRows()).toEqual(beforeDb);
      expect(snapshotStateTree(join(home, '.gbrain'))).toEqual(beforeFs);
      expect(existsSync(join(home, '.gbrain', 'locks'))).toBe(false);
    }
  }, 60_000);

  test('list and dry-run preview legacy adoption without writing canonical state', async () => {
    const legacyPreferences = JSON.stringify({ minion_mode: 'off', custom: true });
    const legacyLedger = `${JSON.stringify({ version: '0.11.0', status: 'complete' })}\n`;
    writeFileSync(join(home, 'preferences.json'), legacyPreferences, { mode: 0o600 });
    mkdirSync(join(home, 'migrations'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, 'migrations', 'completed.jsonl'), legacyLedger, { mode: 0o600 });
    const beforeDb = await databaseConfigRows();
    const beforeCanonical = snapshotStateTree(join(home, '.gbrain'));

    for (const flag of ['--list', '--dry-run']) {
      const result = await runApplyMigrations([flag]);
      expect(result).toMatchObject({ exitCode: 1, reason: 'failed' });
      expect(result.message).toContain('No GBrain state files or logical database rows were created or updated');
      expect(result.message).toContain('PGLite store may still update engine-internal files');
      expect(await databaseConfigRows()).toEqual(beforeDb);
      expect(snapshotStateTree(join(home, '.gbrain'))).toEqual(beforeCanonical);
      expect(readFileSync(join(home, 'preferences.json'), 'utf8')).toBe(legacyPreferences);
      expect(readFileSync(join(home, 'migrations', 'completed.jsonl'), 'utf8')).toBe(legacyLedger);
      expect(existsSync(join(home, '.gbrain', 'legacy-state-adoption.json'))).toBe(false);
      expect(existsSync(join(home, '.gbrain', 'preferences.json'))).toBe(false);
      expect(existsSync(join(home, '.gbrain', 'migrations'))).toBe(false);
      expect(existsSync(join(home, '.gbrain', 'locks'))).toBe(false);
    }
  }, 60_000);

  test('clears a malformed residual DB fence for a complete migration without replaying it', async () => {
    appendCompletedMigration({ version: '0.11.0', brain_id: brainId, status: 'complete' });
    await setRawFence('0.11.0', '{malformed');

    const result = await runApplyMigrations(['--force-retry', '0.11.0']);
    expect(result).toMatchObject({ exitCode: 0, reason: 'force_retry_recorded' });
    const target = loadCompletedMigrations().filter(entry =>
      entry.brain_id === brainId && entry.version === '0.11.0');
    expect(target.at(-1)?.status).toBe('complete');
    expect(target.some(entry => entry.status === 'retry')).toBe(false);
  }, 60_000);

  test('refuses force-retry for complete or pending work when no DB fence exists', async () => {
    appendCompletedMigration({ version: '0.11.0', brain_id: brainId, status: 'complete' });
    expect(await runApplyMigrations(['--force-retry', '0.11.0']))
      .toMatchObject({ exitCode: 2, reason: 'invalid_arguments' });
    expect(await runApplyMigrations(['--force-retry', '0.12.0']))
      .toMatchObject({ exitCode: 2, reason: 'invalid_arguments' });
  }, 60_000);

  test('an unrelated malformed fence cannot dead-end exact recovery of a local ambiguity', async () => {
    appendAmbiguousMigration({ version: '0.11.0', brain_id: brainId });
    await setRawFence('0.12.0', '{malformed');

    expect(await runApplyMigrations(['--force-retry', '0.11.0']))
      .toMatchObject({ exitCode: 0, reason: 'force_retry_recorded' });
    expect(loadCompletedMigrations().filter(entry =>
      entry.brain_id === brainId && entry.version === '0.11.0').at(-1)?.status).toBe('retry');

    const normal = await runApplyMigrations(['--list']);
    expect(normal).toMatchObject({ exitCode: 1, reason: 'failed' });
    expect(normal.message).toContain('Cannot inspect database migration fences');
  }, 60_000);
});
