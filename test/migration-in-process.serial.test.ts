// v0.41.37.0 #1605 — migration schema phases run IN-PROCESS (was a
// `gbrain init --migrate-only` subprocess that died with getaddrinfo ENOTFOUND
// on Windows+bun+Supabase). runMigrateOnlyCore is the single in-process path;
// runGbrainSubprocess captures child stderr for the remaining backfill spawns.
import { afterAll, beforeAll, describe, test, expect } from 'bun:test';
import { tmpdir } from 'os';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'fs';
import { join } from 'path';
import { withEnv } from './helpers/with-env.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { getOrCreateDatabaseInstanceId } from '../src/core/database-instance-id.ts';
import {
  runMigrateOnlyCore,
  runGbrainSubprocess,
  resolveCurrentGbrainInvocation,
  sanitizeMigrationSubprocessError,
  MigrateOnlyError,
  MigrateOnlyAmbiguousStateError,
  awaitMigrationSettlement,
  buildPinnedMigrationChildConfig,
  reapStaleMigrationSnapshotDirs,
} from '../src/commands/migrations/in-process.ts';
import { migrationTestOpts } from './helpers/migration-opts.ts';

const MIGRATION_DIR = join(import.meta.dir, '..', 'src', 'commands', 'migrations');
const SCHEMA_PHASE_FILES = [
  'v0_11_0', 'v0_12_0', 'v0_12_2', 'v0_13_0', 'v0_16_0',
  'v0_18_0', 'v0_18_1', 'v0_21_0', 'v0_29_1',
];

let subprocessSnapshotRoot: string;
let subprocessSnapshotDb: string;
let subprocessSnapshotBrainId: string;

beforeAll(async () => {
  subprocessSnapshotRoot = mkdtempSync(join(tmpdir(), 'mip-subprocess-snapshot-'));
  subprocessSnapshotDb = join(subprocessSnapshotRoot, 'data');
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: subprocessSnapshotDb });
  try {
    await engine.initSchema();
    subprocessSnapshotBrainId = await getOrCreateDatabaseInstanceId(engine);
  } finally {
    await engine.disconnect();
  }
});

afterAll(() => {
  rmSync(subprocessSnapshotRoot, { recursive: true, force: true });
});

function subprocessSnapshot(overrides: Parameters<typeof migrationTestOpts>[0] = {}) {
  return migrationTestOpts(
    { brainId: subprocessSnapshotBrainId, ...overrides },
    { engine: 'pglite', database_path: subprocessSnapshotDb },
  );
}

describe('#1605 runMigrateOnlyCore (in-process schema)', () => {
  test('brings a fresh PGLite brain to head without spawning', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mip-'));
    const dataDir = join(home, 'data');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(
      join(home, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'pglite', database_path: dataDir }),
    );

    const result = await withEnv(
      { GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
      () => runMigrateOnlyCore(),
    );
    expect(result.engine).toBe('pglite');

    // Verify schema landed: reconnect a fresh engine to the same data dir and
    // confirm a core table exists (proves initSchema ran in-process).
    const verify = new PGLiteEngine();
    await verify.connect({ database_path: dataDir });
    try {
      const rows = await verify.executeRaw<{ t: string | null }>(
        "SELECT to_regclass('public.pages')::text AS t",
      );
      expect(rows[0]?.t).toBe('pages');
    } finally {
      await verify.disconnect();
    }
  }, 60_000);

  test('accepts the database-owned snapshot identity and rejects a different PGLite brain', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mip-owned-id-'));
    const dataDir = join(home, 'data');
    const seed = new PGLiteEngine();
    await seed.connect({ engine: 'pglite', database_path: dataDir });
    let brainId: string;
    try {
      await seed.initSchema();
      brainId = await getOrCreateDatabaseInstanceId(seed);
    } finally {
      await seed.disconnect();
    }

    const config = { engine: 'pglite' as const, database_path: dataDir };
    expect((await runMigrateOnlyCore({
      config,
      engineConfig: config,
      expectedDatabaseIdentity: brainId,
    })).engine).toBe('pglite');

    await expect(runMigrateOnlyCore({
      config,
      engineConfig: config,
      expectedDatabaseIdentity: 'db:00000000-0000-4000-8000-000000000000',
    })).rejects.toThrow('Configured database identity changed');
    rmSync(home, { recursive: true, force: true });
  }, 60_000);

  test('throws MigrateOnlyError when no brain is configured', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mip-noconf-'));
    await expect(
      withEnv(
        { GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
        () => runMigrateOnlyCore(),
      ),
    ).rejects.toBeInstanceOf(MigrateOnlyError);
  });

  test('does not report failure before a timed-out migration settles', async () => {
    let committed = false;
    const deferred = new Promise<string>(resolve => setTimeout(() => {
      committed = true;
      resolve('committed');
    }, 25));

    const result = await awaitMigrationSettlement(deferred, 5, 'test migration timed out', 50);

    expect(result).toBe('committed');
    expect(committed).toBe(true);
  });

  test('never-settling migration fails bounded with explicitly ambiguous state', async () => {
    const started = Date.now();
    const never = new Promise<string>(() => {});

    await expect(
      awaitMigrationSettlement(never, 5, 'test migration never settled', 5),
    ).rejects.toBeInstanceOf(MigrateOnlyAmbiguousStateError);

    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('#1605 runGbrainSubprocess (stderr capture)', () => {
  const shellInvocation = (args: readonly string[]) => ['sh', ...args];

  test('retains the migration fence when a timed-out mutating child may commit late', async () => {
    const marker = join(subprocessSnapshotRoot, 'late-subprocess-commit');
    const previous = process.env.GBRAIN_TEST_LATE_MARKER;
    process.env.GBRAIN_TEST_LATE_MARKER = marker;
    try {
      await expect(runGbrainSubprocess(
        ['-c', '(sleep 0.05; printf committed > "$GBRAIN_TEST_LATE_MARKER") >/dev/null 2>&1 & sleep 5'],
        { snapshot: subprocessSnapshot(), effect: 'mutating', timeoutMs: 10 },
        { resolveInvocation: shellInvocation },
      )).rejects.toBeInstanceOf(MigrateOnlyAmbiguousStateError);
      await Bun.sleep(150);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, 'utf8')).toBe('committed');
    } finally {
      if (previous === undefined) delete process.env.GBRAIN_TEST_LATE_MARKER;
      else process.env.GBRAIN_TEST_LATE_MARKER = previous;
      rmSync(marker, { force: true });
    }
  });

  test('folds child stderr into the thrown error', async () => {
    let msg = '';
    try {
      await runGbrainSubprocess(['-c', 'echo BOOM_STDERR 1>&2; exit 1'], {
        snapshot: subprocessSnapshot(), effect: 'read_only',
      }, { resolveInvocation: shellInvocation });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain('BOOM_STDERR');
  });

  test('redacts snapshotted secrets and Postgres credentials before phase evidence', async () => {
    const base = subprocessSnapshot();
    const apiKey = 'migration-secret-api-key';
    const snapshot = subprocessSnapshot({
      gbrainConfig: { ...base.gbrainConfig, openai_api_key: apiKey },
    });
    let message = '';
    try {
      await runGbrainSubprocess(
        ['-c', 'echo "$OPENAI_API_KEY" 1>&2; echo "postgresql://alice:child-password@db.example/brain" 1>&2; exit 1'],
        { snapshot, effect: 'read_only' },
        { resolveInvocation: shellInvocation },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('<REDACTED:CONFIG_OPENAI_API_KEY>');
    expect(message).not.toContain(apiKey);
    expect(message).not.toContain('child-password');
    expect(message).toContain('postgresql://***@db.example/brain');
    expect(message.length).toBeLessThanOrEqual(16_384);
  });

  test('bounds redaction work even for a one-character secret in huge output', () => {
    const base = migrationTestOpts();
    const snapshot = migrationTestOpts({
      gbrainConfig: { ...base.gbrainConfig, openai_api_key: 'q' },
    }, base.engineConfig);
    const sanitized = sanitizeMigrationSubprocessError('q'.repeat(1_000_000), snapshot);
    expect(sanitized).not.toContain('q');
    expect(sanitized.length).toBeLessThanOrEqual(16_384);
  });

  test('returns child stdout on success', async () => {
    const out = await runGbrainSubprocess(['-c', 'echo hello-stdout'], {
      snapshot: subprocessSnapshot(), effect: 'read_only',
    }, { resolveInvocation: shellInvocation });
    expect(out).toContain('hello-stdout');
  });

  test('mints capability env only for a bound post-upgrade migration child', async () => {
    const transition = {
      transitionId: '11111111-1111-4111-8111-111111111111',
      brainId: subprocessSnapshotBrainId,
      fromVersion: '0.42.58.0',
      toVersion: (await import('../src/version.ts')).VERSION,
    };
    const out = await runGbrainSubprocess(
      [
        '-c',
        'test -n "$GBRAIN_UPGRADE_CHILD_CAPABILITY_FILE" && ' +
        'test -n "$GBRAIN_UPGRADE_CHILD_CAPABILITY_TOKEN" && ' +
        'test -f "$GBRAIN_UPGRADE_CHILD_CAPABILITY_FILE" && printf authorized',
      ],
      {
        snapshot: subprocessSnapshot({ upgradeTransition: transition }),
        effect: 'read_only',
      },
      { resolveInvocation: shellInvocation },
    );
    expect(out).toBe('authorized');

    const ordinary = await runGbrainSubprocess(
      ['-c', 'test -z "$GBRAIN_UPGRADE_CHILD_CAPABILITY_FILE" && test -z "$GBRAIN_UPGRADE_CHILD_CAPABILITY_TOKEN" && printf ordinary'],
      { snapshot: subprocessSnapshot(), effect: 'read_only' },
      { resolveInvocation: shellInvocation },
    );
    expect(ordinary).toBe('ordinary');
  });

  test('staged release execution ignores an older gbrain shim on PATH', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'gbrain-staged-release-'));
    const oldBinDir = join(fixture, 'old-bin');
    const staged = join(fixture, 'staged-gbrain');
    const stagedMarker = join(fixture, 'staged-called');
    const oldMarker = join(fixture, 'old-called');
    mkdirSync(oldBinDir, { recursive: true });
    writeFileSync(staged, '#!/usr/bin/env bash\nprintf staged > "$GBRAIN_STAGED_MARKER"\n', { mode: 0o700 });
    writeFileSync(
      join(oldBinDir, 'gbrain'),
      '#!/usr/bin/env bash\nprintf old > "$GBRAIN_OLD_MARKER"\n',
      { mode: 0o700 },
    );
    try {
      await withEnv({
        PATH: `${oldBinDir}:${process.env.PATH ?? ''}`,
        GBRAIN_STAGED_MARKER: stagedMarker,
        GBRAIN_OLD_MARKER: oldMarker,
      }, async () => {
        await runGbrainSubprocess(
          ['probe'],
          { snapshot: subprocessSnapshot(), effect: 'read_only' },
          {
            resolveInvocation: args => resolveCurrentGbrainInvocation(args, {
              execPath: staged,
              main: staged,
            }),
          },
        );
      });
      expect(readFileSync(stagedMarker, 'utf8')).toBe('staged');
      expect(existsSync(oldMarker)).toBe(false);
      expect(resolveCurrentGbrainInvocation(['probe'], {
        execPath: '/opt/staged/bun',
        main: '/opt/staged/src/cli.ts',
      })).toEqual(['/opt/staged/bun', '/opt/staged/src/cli.ts', 'probe']);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test('writes only minimal non-secret 0700/0600 child config and cleans it', async () => {
    const base = subprocessSnapshot();
    const snapshot = subprocessSnapshot({
      gbrainConfig: {
        ...base.gbrainConfig,
        openai_api_key: 'openai-file-secret',
        anthropic_api_key: 'anthropic-file-secret',
        zeroentropy_api_key: 'ze-file-secret',
        embedding_model: 'openai:text-embedding-3-large',
        chat_model: 'anthropic:claude-sonnet-4-6',
        storage: { secret_access_key: 'storage-file-secret' },
      },
    });

    const pinned = buildPinnedMigrationChildConfig(snapshot);
    const pinnedRecord = pinned as unknown as Record<string, unknown>;
    expect(pinned.embedding_model).toBe('openai:text-embedding-3-large');
    expect(pinned.chat_model).toBe('anthropic:claude-sonnet-4-6');
    for (const forbidden of [
      'database_url', 'openai_api_key', 'anthropic_api_key', 'zeroentropy_api_key', 'storage',
    ]) {
      expect(pinnedRecord[forbidden]).toBeUndefined();
    }

    const content = await runGbrainSubprocess(
      ['-c', 'cat "$GBRAIN_HOME/.gbrain/config.json"'],
      { snapshot, effect: 'read_only' },
      { resolveInvocation: shellInvocation },
    );
    expect(content).not.toContain('file-secret');
    expect(content).not.toContain('secret_access_key');

    const modes = await runGbrainSubprocess(
      ['-c', 'ls -ld "$GBRAIN_HOME/.gbrain" "$GBRAIN_HOME/.gbrain/config.json"'],
      { snapshot, effect: 'read_only' },
      { resolveInvocation: shellInvocation },
    );
    expect(modes).toContain('drwx------');
    expect(modes).toContain('-rw-------');
    expect(
      readdirSync(tmpdir()).filter(name =>
        name.startsWith(`gbrain-migration-snapshot-${process.pid}-`)),
    ).toEqual([]);
  });

  test('reaps only owner-only stale snapshot directories', async () => {
    const child = Bun.spawn(['sh', '-c', 'exit 0']);
    await child.exited;
    const stale = join(tmpdir(), `gbrain-migration-snapshot-${child.pid}-stale`);
    const loose = join(tmpdir(), `gbrain-migration-snapshot-${child.pid}-loose`);
    mkdirSync(stale, { mode: 0o700 });
    mkdirSync(loose, { mode: 0o755 });
    chmodSync(loose, 0o755);
    try {
      expect(reapStaleMigrationSnapshotDirs()).toBeGreaterThanOrEqual(1);
      expect(readdirSync(tmpdir())).not.toContain(stale.split('/').at(-1)!);
      expect(readdirSync(tmpdir())).toContain(loose.split('/').at(-1)!);
    } finally {
      rmSync(stale, { recursive: true, force: true });
      rmSync(loose, { recursive: true, force: true });
    }
  });
});

describe('#1605 structural guard: schema phases are in-process', () => {
  test('no schema phase still execSyncs `gbrain init --migrate-only`', () => {
    for (const f of SCHEMA_PHASE_FILES) {
      const src = readFileSync(join(MIGRATION_DIR, `${f}.ts`), 'utf-8');
      expect(src).not.toContain("execSync('gbrain init --migrate-only'");
    }
  });

  test('every schema phase calls the snapshotted migrate helper + is awaited', () => {
    for (const f of SCHEMA_PHASE_FILES) {
      const src = readFileSync(join(MIGRATION_DIR, `${f}.ts`), 'utf-8');
      expect(src).toContain('runSnapshotMigrateOnly(opts)');
      // phaseASchema must be async + awaited at its call site.
      expect(src).toContain('async function phaseASchema');
      const awaited = src.includes('await phaseASchema(opts)') ||
        src.includes('push(await phaseASchema(opts))');
      expect(awaited).toBe(true);
    }
  });

  test('every v0 orchestrator is snapshot-only and leaves receipts to the runner', () => {
    const files = readdirSync(MIGRATION_DIR).filter(name => /^v0_.*\.ts$/.test(name));
    for (const file of files) {
      const src = readFileSync(join(MIGRATION_DIR, file), 'utf-8');
      expect(src).not.toMatch(/\bloadConfig\s*\(/);
      expect(src).not.toMatch(/\btoEngineConfig\s*\(/);
      expect(src).not.toMatch(/\bcreateEngine\s*\(/);
      expect(src).not.toContain('runMigrateOnlyCore()');
      expect(src).not.toMatch(/\bappendCompletedMigration\s*\(/);
    }
  });

  test('NO migration orchestrator anywhere spawns `gbrain init --migrate-only`', () => {
    // All-files invariant (not just the 9): the subprocess spawn is the
    // Windows-ENOTFOUND bug class. Other files (v0_22_4, v0_28_0, v0_31_0,
    // v0_14_0, v0_32_2) define an in-process phaseASchema that never spawned —
    // those are fine. We only ban the spawn literal.
    const files = readdirSync(MIGRATION_DIR).filter(n => /^v\d/.test(n) && n.endsWith('.ts'));
    for (const n of files) {
      const src = readFileSync(join(MIGRATION_DIR, n), 'utf-8');
      expect(src).not.toContain("execSync('gbrain init --migrate-only'");
    }
  });
});
