/**
 * v0.43 (#2084 / eng-review TD1) — PgBouncer transaction-mode teardown E2E.
 *
 * Three consecutive waves (#1972 → #2015 → #2084) fixed pooler-teardown bugs
 * that were verified only against one production deployment, because CI had
 * no transaction-mode pooler. This file pins the bug CLASS, not exact
 * timings: a CLI op against a txn-mode pooled URL must
 *
 *   1. exit zero with intact stdout, and
 *   2. NOT ride the 10s hard-deadline backstop (the
 *      "[cli] engine.disconnect() did not return within 10000ms" banner is
 *      the smoking gun — pre-#2084 it printed on 100% of query-shaped ops).
 *
 * Topology: docker-compose.ci.yml runs `pgbouncer` (transaction mode) in
 * front of postgres-1. The test uses a DEDICATED database
 * (`gbrain_pgbouncer`) created via the direct URL, so it never races the
 * TRUNCATE-based fixtures any shard runs against `gbrain_test`.
 *
 * Gated by GBRAIN_PGBOUNCER_URL + GBRAIN_PGBOUNCER_DIRECT_URL — skips
 * gracefully outside the docker CI gate. Run manually:
 *
 *   GBRAIN_TEST_DB=1 \
 *   GBRAIN_PGBOUNCER_URL=postgresql://postgres:postgres@localhost:6543/gbrain_test \
 *   GBRAIN_PGBOUNCER_DIRECT_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test \
 *   GBRAIN_PGBOUNCER_WRONG_DIRECT_URL=postgresql://postgres:postgres@localhost:5435/gbrain_test \
 *   bun test test/e2e/pgbouncer-teardown.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import postgres from 'postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import {
  acquireDatabaseSessionLock,
  resolveDatabaseSessionLockUrl,
  SCHEMA_MIGRATION_LOCK_KEY,
} from '../../src/core/db.ts';
import { ConnectionManager } from '../../src/core/connection-manager.ts';
import { getOrCreateDatabaseInstanceId } from '../../src/core/database-instance-id.ts';
import { getPostgresTestUrl } from '../helpers/postgres-test-authority.ts';

const POOLED_URL = getPostgresTestUrl('GBRAIN_PGBOUNCER_URL');
const DIRECT_ADMIN_URL = getPostgresTestUrl('GBRAIN_PGBOUNCER_DIRECT_URL');
const WRONG_DIRECT_ADMIN_URL = getPostgresTestUrl('GBRAIN_PGBOUNCER_WRONG_DIRECT_URL');
const SKIP = !POOLED_URL || !DIRECT_ADMIN_URL;
const describePooled = SKIP ? describe.skip : describe;
const testWrongDirect = WRONG_DIRECT_ADMIN_URL ? test : test.skip;

const REPO = resolve(import.meta.dir, '..', '..');
const TEST_DB = 'gbrain_pgbouncer';
const SAME_NAME_AUTHORITY_DB = 'gbrain_authority_same_name';
const KILL_SWITCH_AUTHORITY_DB = 'gbrain_authority_kill_switch';
const SLUG = 'test/pgbouncer-teardown-fixture';
const MARKER = 'pgbouncer-teardown-marker-content-7c4f';

/** Direct URL pointing at the dedicated test database (same server). */
function directTestDbUrl(): string {
  const u = new URL(DIRECT_ADMIN_URL!);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

function pooledTestDbUrl(): string {
  const u = new URL(POOLED_URL!);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

function databaseUrl(baseUrl: string, database: string): string {
  const u = new URL(baseUrl);
  u.pathname = `/${database}`;
  return u.toString();
}

async function recreateDatabase(admin: ReturnType<typeof postgres>, database: string): Promise<void> {
  const quoted = `"${database.replace(/"/g, '""')}"`;
  await admin.unsafe(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${quoted}`);
}

async function publicTableCount(url: string): Promise<number> {
  const conn = postgres(url, { max: 1 });
  try {
    const rows = await conn<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    return Number(rows[0]?.n ?? -1);
  } finally {
    await conn.end({ timeout: 5 });
  }
}

async function runCli(
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string; wallMs: number }> {
  const t0 = Date.now();
  const childEnv = { ...process.env };
  // The outer E2E runner supplies its shard DATABASE_URL. This test must prove
  // the dedicated pooled brain selected by its private config, so ambient
  // database authority may not override that file in the CLI child.
  delete childEnv.DATABASE_URL;
  delete childEnv.GBRAIN_DATABASE_URL;
  Object.assign(childEnv, env, {
    GBRAIN_DIRECT_DATABASE_URL: directTestDbUrl(),
    GBRAIN_SKIP_STARTUP_HOOKS: '1',
  });
  const proc = Bun.spawn(['bun', 'run', join(REPO, 'src', 'cli.ts'), ...args], {
    cwd: REPO,
    env: childEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const killer = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr, wallMs: Date.now() - t0 };
  } finally {
    clearTimeout(killer);
  }
}

describePooled('pgbouncer txn-mode teardown (#2084 / TD1)', () => {
  let home: string;
  let legacyHome: string;
  let pooledBrainId: string;

  beforeAll(async () => {
    // Dedicated database on the same server, created via the DIRECT url
    // (CREATE DATABASE cannot run through a transaction-mode pooler).
    const admin = postgres(DIRECT_ADMIN_URL!, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    } finally {
      await admin.end({ timeout: 5 });
    }

    // Schema + fixture via the direct connection (DDL stays off the pooler,
    // matching the production split-pool discipline).
    const eng = new PostgresEngine();
    await eng.connect({ engine: 'postgres', database_url: directTestDbUrl() });
    await eng.initSchema();
    pooledBrainId = await getOrCreateDatabaseInstanceId(eng);
    await eng.putPage(SLUG, {
      type: 'note',
      title: 'PgBouncer teardown fixture',
      compiled_truth: MARKER,
      timeline: '',
    });
    await eng.disconnect();

    // Brain config pointing the CLI at the POOLED url.
    home = mkdtempSync(join(tmpdir(), 'gbrain-pgbouncer-'));
    legacyHome = mkdtempSync(join(tmpdir(), 'gbrain-pgbouncer-legacy-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true, mode: 0o700 });
    mkdirSync(join(legacyHome, '.gbrain'), { recursive: true, mode: 0o700 });
    chmodSync(join(home, '.gbrain'), 0o700);
    chmodSync(join(legacyHome, '.gbrain'), 0o700);
    const pooled = new URL(POOLED_URL!);
    pooled.pathname = `/${TEST_DB}`;
    writeFileSync(
      join(home, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'postgres', database_url: pooled.toString() }) + '\n',
      { mode: 0o600 },
    );
  }, 240_000);

  afterAll(() => {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(legacyHome, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('op against the pooled URL exits clean — output intact, no force-exit banner', async () => {
    const env = { HOME: legacyHome, GBRAIN_HOME: home };
    const res = await runCli(['get', SLUG], env, 90_000);

    if (res.exitCode !== 0 || /force-exiting/.test(res.stderr)) {
      console.error('--- stdout ---\n' + res.stdout);
      console.error('--- stderr ---\n' + res.stderr);
    }
    expect(res.exitCode).toBe(0);
    // Output is complete — the #1959 truncation class.
    expect(res.stdout).toContain(MARKER);
    // The smoking gun: pre-#2084 the hard-deadline banner printed every time
    // a query-shaped op ran against a txn-mode pooler.
    expect(res.stderr).not.toMatch(/force-exiting/);
    expect(res.stderr).not.toMatch(/did not return within/);
    // Generous CLASS bound (cold bun parse on CI is 10-20s): the op itself is
    // milliseconds; anything that ALSO waited out a 10s teardown backstop
    // lands well past this.
    expect(res.wallMs).toBeLessThan(60_000);
  }, 120_000);

  test('second run (warm schema probe) also exits clean through the pooler', async () => {
    const env = { HOME: legacyHome, GBRAIN_HOME: home };
    const res = await runCli(['get', SLUG], env, 90_000);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(MARKER);
    expect(res.stderr).not.toMatch(/force-exiting/);
  }, 120_000);

  test('schema and whole-run advisory locks use the direct authority, never transaction pooling', async () => {
    const pooledUrl = pooledTestDbUrl();
    const directUrl = directTestDbUrl();
    expect(() => resolveDatabaseSessionLockUrl(pooledUrl)).toThrow('GBRAIN_DIRECT_DATABASE_URL');
    expect(resolveDatabaseSessionLockUrl(pooledUrl, directUrl)).toBe(directUrl);

    const pooled = postgres(pooledUrl, { max: 1, prepare: false });
    try {
      for (const key of [SCHEMA_MIGRATION_LOCK_KEY, 43]) {
        const handle = await acquireDatabaseSessionLock(directUrl, key);
        try {
          await handle.assertOwned();
          await handle.assertSameDatabase(pooled);
          await handle.assertDatabaseIdentity(pooledBrainId);
          const blocked = await pooled.begin(async tx =>
            tx<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(${key}::bigint) AS acquired`);
          expect(blocked[0]?.acquired).toBe(false);
        } finally {
          await handle.release();
        }
        const released = await pooled.begin(async tx =>
          tx<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(${key}::bigint) AS acquired`);
        expect(released[0]?.acquired).toBe(true);
      }
    } finally {
      await pooled.end({ timeout: 5 });
    }
  }, 60_000);

  test('schema DDL uses the direct pool while normal reads remain on local PgBouncer', async () => {
    const manager = new ConnectionManager({
      url: pooledTestDbUrl(),
      directUrl: directTestDbUrl(),
      readPoolSize: 1,
      directPoolSize: 1,
    });
    try {
      const read = await manager.getReadPool();
      const schema = await manager.schemaDdl();
      expect(manager.read()).toBe(read);
      expect(schema).not.toBe(read);

      const [readDb] = await read<{ database: string }[]>`
        SELECT current_database()::text AS database
      `;
      const [schemaDb] = await schema<{ database: string }[]>`
        SELECT current_database()::text AS database
      `;
      expect(readDb?.database).toBe(TEST_DB);
      expect(schemaDb?.database).toBe(TEST_DB);
    } finally {
      await manager.disconnect();
    }
  }, 30_000);

  test('a reserved session on the wrong database cannot authorize migration work', async () => {
    const main = new PostgresEngine();
    await main.connect({ engine: 'postgres', database_url: DIRECT_ADMIN_URL! });
    let mainBrainId: string;
    try {
      await main.initSchema();
      mainBrainId = await getOrCreateDatabaseInstanceId(main);
    } finally {
      await main.disconnect();
    }
    expect(mainBrainId).not.toBe(pooledBrainId);

    const wrong = await acquireDatabaseSessionLock(directTestDbUrl(), 43);
    try {
      await expect(wrong.assertDatabaseIdentity(mainBrainId))
        .rejects.toThrow('does not match the configured brain identity');
      await wrong.assertDatabaseIdentity(pooledBrainId);
    } finally {
      await wrong.release();
    }
  }, 60_000);

  test('direct-pool kill switch cannot downgrade schema DDL to transaction pooling', async () => {
    const primaryAdmin = postgres(DIRECT_ADMIN_URL!, { max: 1 });
    const workUrl = databaseUrl(POOLED_URL!, KILL_SWITCH_AUTHORITY_DB);
    const directUrl = databaseUrl(DIRECT_ADMIN_URL!, KILL_SWITCH_AUTHORITY_DB);
    const priorDirect = process.env.GBRAIN_DIRECT_DATABASE_URL;
    const priorKillSwitch = process.env.GBRAIN_DISABLE_DIRECT_POOL;
    const engine = new PostgresEngine();
    try {
      await recreateDatabase(primaryAdmin, KILL_SWITCH_AUTHORITY_DB);
      process.env.GBRAIN_DIRECT_DATABASE_URL = directUrl;
      process.env.GBRAIN_DISABLE_DIRECT_POOL = '1';

      await engine.connect({ engine: 'postgres', database_url: workUrl, poolSize: 1 });
      await expect(engine.initSchema()).rejects.toThrow('GBRAIN_DISABLE_DIRECT_POOL');
      await engine.disconnect();
      expect(await publicTableCount(directUrl)).toBe(0);
    } finally {
      await engine.disconnect().catch(() => {});
      if (priorDirect === undefined) delete process.env.GBRAIN_DIRECT_DATABASE_URL;
      else process.env.GBRAIN_DIRECT_DATABASE_URL = priorDirect;
      if (priorKillSwitch === undefined) delete process.env.GBRAIN_DISABLE_DIRECT_POOL;
      else process.env.GBRAIN_DISABLE_DIRECT_POOL = priorKillSwitch;
      await primaryAdmin.unsafe(
        `DROP DATABASE IF EXISTS "${KILL_SWITCH_AUTHORITY_DB}" WITH (FORCE)`,
      ).catch(() => {});
      await primaryAdmin.end({ timeout: 5 });
    }
  }, 60_000);

  testWrongDirect('same-named databases on different servers reject a wrong direct URL before any DDL', async () => {
    const primaryAdmin = postgres(DIRECT_ADMIN_URL!, { max: 1 });
    const secondaryAdmin = postgres(WRONG_DIRECT_ADMIN_URL!, { max: 1 });
    const workUrl = databaseUrl(POOLED_URL!, SAME_NAME_AUTHORITY_DB);
    const workDirectUrl = databaseUrl(DIRECT_ADMIN_URL!, SAME_NAME_AUTHORITY_DB);
    const wrongDirectUrl = databaseUrl(WRONG_DIRECT_ADMIN_URL!, SAME_NAME_AUTHORITY_DB);
    const priorDirect = process.env.GBRAIN_DIRECT_DATABASE_URL;
    const engine = new PostgresEngine();
    try {
      await recreateDatabase(primaryAdmin, SAME_NAME_AUTHORITY_DB);
      await recreateDatabase(secondaryAdmin, SAME_NAME_AUTHORITY_DB);
      process.env.GBRAIN_DIRECT_DATABASE_URL = wrongDirectUrl;

      await engine.connect({ engine: 'postgres', database_url: workUrl, poolSize: 1 });
      await expect(engine.initSchema())
        .rejects.toThrow('does not cover the configured work database');
      await engine.disconnect();

      // Both databases started empty. A failed route proof must precede
      // bootstrap, extension creation, SCHEMA_SQL, config identity, and every
      // numbered migration on both the configured work DB and wrong direct DB.
      expect(await publicTableCount(workDirectUrl)).toBe(0);
      expect(await publicTableCount(wrongDirectUrl)).toBe(0);
    } finally {
      await engine.disconnect().catch(() => {});
      if (priorDirect === undefined) delete process.env.GBRAIN_DIRECT_DATABASE_URL;
      else process.env.GBRAIN_DIRECT_DATABASE_URL = priorDirect;
      await primaryAdmin.unsafe(`DROP DATABASE IF EXISTS "${SAME_NAME_AUTHORITY_DB}" WITH (FORCE)`).catch(() => {});
      await secondaryAdmin.unsafe(`DROP DATABASE IF EXISTS "${SAME_NAME_AUTHORITY_DB}" WITH (FORCE)`).catch(() => {});
      await primaryAdmin.end({ timeout: 5 });
      await secondaryAdmin.end({ timeout: 5 });
    }
  }, 90_000);
});
