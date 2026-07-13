/**
 * E2E test for PostgresEngine forward-reference bootstrap.
 *
 * Codex caught that `test/e2e/helpers.ts:74` uses the standalone
 * `db.initSchema()` from `src/core/db.ts`, which only runs SCHEMA_SQL and
 * never calls runMigrations(). A test using that helper would NOT exercise
 * `PostgresEngine.initSchema()`'s reordered path, producing false-positive
 * coverage. This test deliberately bypasses the standard helper and
 * instantiates `PostgresEngine` directly, calling `engine.initSchema()` so
 * the bootstrap → SCHEMA_SQL → runMigrations sequence runs end-to-end.
 *
 * Covers issues #366, #375, #378 — Postgres-side wedges where pre-v0.18
 * brains crashed on `column "source_id" does not exist`.
 *
 * NOTE: snapshot-based historical state simulation is out of scope for this
 * wave (would require maintaining historical schema dumps). The test
 * mutates a fresh-LATEST brain to a pre-v0.18 shape; codex flagged this as
 * approximate. Acceptable here because the bootstrap's contract is narrow:
 * "given a brain that lacks the specific forward-references, initSchema
 * produces a brain at LATEST." The test exercises exactly that contract.
 *
 * Run: DATABASE_URL=postgresql://... bun run test:e2e test/e2e/postgres-bootstrap.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import * as db from '../../src/core/db.ts';
import { getOrCreateDatabaseInstanceId } from '../../src/core/database-instance-id.ts';
import { runMigrateOnlyCore } from '../../src/commands/migrations/in-process.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';
import { getPostgresTestUrl } from '../helpers/postgres-test-authority.ts';

const DATABASE_URL = getPostgresTestUrl();
const skip = !DATABASE_URL;

const GRANTED_SCHEMA_LOCK_COUNT_SQL = `
  SELECT count(*)::int AS n
    FROM pg_locks
   WHERE locktype = 'advisory'
     AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
     AND classid = 0
     AND objid = $1::oid
     AND objsubid = 1
     AND granted
`;

async function grantedSchemaLockCount(engine: PostgresEngine): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(GRANTED_SCHEMA_LOCK_COUNT_SQL, [
    db.SCHEMA_MIGRATION_LOCK_KEY,
  ]);
  return Number(rows[0]?.n ?? 0);
}

async function completesWithin<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe.skipIf(skip)('PostgresEngine forward-reference bootstrap (E2E)', () => {
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
  }, 30_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('PostgresEngine.initSchema applies bootstrap → SCHEMA_SQL → migrations on pre-v0.18 brain', async () => {
    // First call: bring the test DB to LATEST shape so we have something to mutate.
    await engine.initSchema();

    // Clear data from prior tests in the suite. Adding a UNIQUE(slug)
    // constraint below would fail if multi-source fixtures left rows with
    // duplicate slugs across sources (which is valid under the composite
    // UNIQUE this test is undoing).
    const conn = (engine as any).sql;
    await conn.unsafe(`TRUNCATE pages, content_chunks, links, tags, raw_data, timeline_entries, page_versions, ingest_log RESTART IDENTITY CASCADE`);

    // Mutate to pre-v0.18 shape: drop source_id and the sources table.
    // The advisory lock is released between initSchema calls, so this
    // direct DDL won't deadlock.
    await conn.unsafe(`
      ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_source_slug_key;
      ALTER TABLE pages ADD CONSTRAINT pages_slug_key UNIQUE (slug);
      DROP INDEX IF EXISTS idx_pages_source_id;
      ALTER TABLE pages DROP COLUMN IF EXISTS source_id CASCADE;
      DROP TABLE IF EXISTS sources CASCADE;
    `);
    await engine.setConfig('version', '20');

    // The path under test: full PostgresEngine.initSchema() including the
    // bootstrap call, SCHEMA_SQL replay, and runMigrations chain.
    await engine.initSchema();

    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));

    // Verify the forward-referenced column exists after upgrade.
    const colCheck = await conn`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'pages'
        AND column_name = 'source_id'
    `;
    expect(colCheck).toHaveLength(1);

    // Verify the default source row was seeded.
    const srcCheck = await conn`SELECT id FROM sources WHERE id = 'default'`;
    expect(srcCheck).toHaveLength(1);
  });

  test('PostgresEngine.initSchema is idempotent on a brain already at LATEST', async () => {
    // Fresh-LATEST brain. Calling initSchema again must not error and must
    // not regress the version.
    await engine.initSchema();
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
  });

  test('legacy v125 timeline table upgrades before managed_by index replay', async () => {
    await engine.initSchema();
    const conn = (engine as any).sql;
    await engine.putPage('migration/timeline-owner', {
      type: 'concept', title: 'Timeline owner', compiled_truth: '', timeline: '', frontmatter: {},
    });
    await conn.unsafe(`
      INSERT INTO timeline_entries (page_id, date, source, summary, detail, managed_by)
      SELECT id, '2026-07-10', 'gbrain-markdown:Meeting', 'legacy generated', '', NULL
        FROM pages WHERE source_id = 'default' AND slug = 'migration/timeline-owner';
      INSERT INTO timeline_entries (page_id, date, source, summary, detail, managed_by)
      SELECT id, '2026-07-11', 'Meeting', 'manual evidence', '', NULL
        FROM pages WHERE source_id = 'default' AND slug = 'migration/timeline-owner';
    `);
    await conn.unsafe(`
      DROP INDEX IF EXISTS idx_timeline_managed_page;
      ALTER TABLE timeline_entries DROP COLUMN IF EXISTS managed_by;
    `);
    await engine.setConfig('version', '125');

    await engine.initSchema();

    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
    const columns = await conn`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'timeline_entries'
         AND column_name = 'managed_by'
    `;
    expect(columns).toHaveLength(1);
    const indexes = await conn`
      SELECT indexname
        FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename = 'timeline_entries'
         AND indexname = 'idx_timeline_managed_page'
    `;
    expect(indexes).toHaveLength(1);
    const ownership = await conn`
      SELECT source, managed_by
        FROM timeline_entries te JOIN pages p ON p.id = te.page_id
       WHERE p.source_id = 'default' AND p.slug = 'migration/timeline-owner'
       ORDER BY source
    `;
    expect(ownership.find((r: any) => r.source === 'gbrain-markdown:Meeting')?.managed_by)
      .toBe('gbrain:markdown-timeline:v1');
    expect(ownership.find((r: any) => r.source === 'Meeting')?.managed_by).toBeNull();

    await engine.initSchema();
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
  });

  // Migration v120 — schema-lint hardening (#1647 / #171). Postgres-only
  // assertions (security_invoker has no surface on embedded PGLite).
  test('v120: page_links view runs with security_invoker=on (#1647b)', async () => {
    await engine.initSchema();
    const rows = await engine.executeRaw<{ reloptions: string[] | null }>(
      `SELECT c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'page_links' AND c.relkind = 'v'`,
    );
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows[0].reloptions ?? [])).toContain('security_invoker=on');
  });

  test('v120: trigger + event-trigger functions pin search_path, incl auto_enable_rls (#1647a/#171)', async () => {
    await engine.initSchema();
    const rows = await engine.executeRaw<{ proname: string; proconfig: unknown }>(
      `SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('bump_page_generation_fn','bump_page_generation_clock_fn',
                            'update_chunk_search_vector','update_page_search_vector',
                            'notify_minion_job_change','auto_enable_rls')`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const r of rows) {
      expect(JSON.stringify(r.proconfig ?? [])).toContain('search_path=');
    }
  });
});

describe.skipIf(skip)('Postgres schema migration lock lifecycle (E2E)', () => {
  test('conflicting shadow search_path is rejected before GBrain DDL', async () => {
    const shadowSchema = 'gbrain_shadow_authority_e2e';
    const shadowDatabase = 'gbrain_shadow_authority_e2e_db';
    const admin = postgres(DATABASE_URL!, { max: 1 });
    const engine = new PostgresEngine();
    const priorDirect = process.env.GBRAIN_DIRECT_DATABASE_URL;
    try {
      delete process.env.GBRAIN_DIRECT_DATABASE_URL;
      await admin.unsafe(`DROP DATABASE IF EXISTS ${shadowDatabase} WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE ${shadowDatabase}`);

      const targetUrl = new URL(DATABASE_URL!);
      targetUrl.pathname = `/${shadowDatabase}`;
      const prep = postgres(targetUrl.toString(), { max: 1 });
      try {
        await prep.unsafe(`CREATE SCHEMA ${shadowSchema}`);
      } finally {
        await prep.end({ timeout: 5 });
      }

      const shadowUrl = new URL(targetUrl);
      shadowUrl.searchParams.set('options', `-csearch_path=${shadowSchema},public`);
      await engine.connect({ database_url: shadowUrl.toString(), poolSize: 1 });

      await expect(engine.initSchema()).rejects.toThrow('incompatible search_path');

      // Setup created only the empty shadow schema. initSchema must reject
      // before bootstrap, extension creation, SCHEMA_SQL, config identity, and
      // every migration in either the shadow target or public work schema.
      const inspector = postgres(targetUrl.toString(), { max: 1 });
      try {
        const rows = await inspector<{ n: number }[]>`
          SELECT count(*)::int AS n
            FROM information_schema.tables
           WHERE table_schema IN ('public', ${shadowSchema})
        `;
        expect(Number(rows[0]?.n ?? -1)).toBe(0);
        const extensions = await inspector<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'vector'
        `;
        expect(Number(extensions[0]?.n ?? -1)).toBe(0);
      } finally {
        await inspector.end({ timeout: 5 });
      }
    } finally {
      await engine.disconnect().catch(() => {});
      if (priorDirect === undefined) delete process.env.GBRAIN_DIRECT_DATABASE_URL;
      else process.env.GBRAIN_DIRECT_DATABASE_URL = priorDirect;
      await admin.unsafe(`DROP DATABASE IF EXISTS ${shadowDatabase} WITH (FORCE)`).catch(() => {});
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  test('database instance identity is shared across independent connection pools', async () => {
    const first = new PostgresEngine();
    const second = new PostgresEngine();
    try {
      await first.connect({ database_url: DATABASE_URL!, poolSize: 1 });
      await second.connect({ database_url: DATABASE_URL!, poolSize: 3 });
      expect(await getOrCreateDatabaseInstanceId(first))
        .toBe(await getOrCreateDatabaseInstanceId(second));
    } finally {
      await second.disconnect();
      await first.disconnect();
    }
  }, 30_000);

  test('snapshotted schema phase accepts only the database-owned Postgres identity', async () => {
    const probe = new PostgresEngine();
    try {
      await probe.connect({ database_url: DATABASE_URL!, poolSize: 1 });
      await probe.initSchema();
      const brainId = await getOrCreateDatabaseInstanceId(probe);
      const config = { engine: 'postgres' as const, database_url: DATABASE_URL! };

      expect((await runMigrateOnlyCore({
        config,
        engineConfig: config,
        expectedDatabaseIdentity: brainId,
      })).engine).toBe('postgres');
      await expect(runMigrateOnlyCore({
        config,
        engineConfig: config,
        expectedDatabaseIdentity: 'db:00000000-0000-4000-8000-000000000000',
      })).rejects.toThrow('Configured database identity changed');
    } finally {
      await probe.disconnect();
    }
  }, 60_000);

  test('PostgresEngine.initSchema leaves no granted key-42 lock on a primed pool', async () => {
    const engine = new PostgresEngine();
    try {
      await engine.connect({ database_url: DATABASE_URL!, poolSize: 5 });

      // Force postgres.js to open multiple backends. The pre-fix pooled
      // session lock leaked only after lock/work/unlock rotated across them.
      const probes = await Promise.all(
        Array.from({ length: 5 }, () =>
          engine.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid, pg_sleep(0.02)'),
        ),
      );
      expect(new Set(probes.map(rows => rows[0]?.pid)).size).toBeGreaterThan(1);

      await engine.initSchema();

      // Keep the engine and all of its pooled sessions alive while checking.
      // Closing the pool would hide a leaked session lock by releasing it.
      expect(await grantedSchemaLockCount(engine)).toBe(0);
      expect((await engine.executeRaw<{ one: number }>('SELECT 1 AS one'))[0]?.one).toBe(1);
    } finally {
      await engine.disconnect();
    }
  }, 30_000);

  test('db.initSchema leaves no granted key-42 lock on a primed module pool', async () => {
    const priorPoolSize = process.env.GBRAIN_POOL_SIZE;
    process.env.GBRAIN_POOL_SIZE = '5';
    await db.disconnect();
    try {
      await db.connect({ database_url: DATABASE_URL! });
      const conn = db.getConnection();
      const probes = await Promise.all(
        Array.from({ length: 5 }, () =>
          conn.unsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid, pg_sleep(0.02)'),
        ),
      );
      expect(new Set(probes.map(rows => rows[0]?.pid)).size).toBeGreaterThan(1);

      await db.initSchema();

      const rows = await conn.unsafe<{ n: number }[]>(GRANTED_SCHEMA_LOCK_COUNT_SQL, [
        db.SCHEMA_MIGRATION_LOCK_KEY,
      ]);
      expect(Number(rows[0]?.n ?? 0)).toBe(0);
      expect((await conn.unsafe<{ one: number }[]>('SELECT 1 AS one'))[0]?.one).toBe(1);
    } finally {
      await db.disconnect();
      if (priorPoolSize === undefined) delete process.env.GBRAIN_POOL_SIZE;
      else process.env.GBRAIN_POOL_SIZE = priorPoolSize;
    }
  }, 30_000);

  test('a poolSize=1 peer init completes while the first engine stays connected', async () => {
    const first = new PostgresEngine();
    const peer = new PostgresEngine();
    try {
      await first.connect({ database_url: DATABASE_URL!, poolSize: 1 });
      await completesWithin(first.initSchema(), 10_000, 'first poolSize=1 initSchema');
      expect(await grantedSchemaLockCount(first)).toBe(0);

      await peer.connect({ database_url: DATABASE_URL!, poolSize: 1 });
      await completesWithin(peer.initSchema(), 10_000, 'peer poolSize=1 initSchema');

      expect(await grantedSchemaLockCount(first)).toBe(0);
      expect(await grantedSchemaLockCount(peer)).toBe(0);
      expect((await first.executeRaw<{ one: number }>('SELECT 1 AS one'))[0]?.one).toBe(1);
      expect((await peer.executeRaw<{ one: number }>('SELECT 1 AS one'))[0]?.one).toBe(1);
    } finally {
      await peer.disconnect();
      await first.disconnect();
    }
  }, 30_000);

  test('withSchemaMigrationLock rolls back and releases after a thrown callback', async () => {
    const probe = new PostgresEngine();
    const marker = new Error('schema-lock-test-callback-failed');
    try {
      await probe.connect({ database_url: DATABASE_URL!, poolSize: 1 });

      let observed: unknown;
      try {
        const handle = await db.acquireDatabaseSessionLock(DATABASE_URL!, db.SCHEMA_MIGRATION_LOCK_KEY);
        await handle.assertOwned();
        await handle.release();
        await db.withSchemaMigrationLock(DATABASE_URL!, async () => {
          throw marker;
        });
      } catch (error) {
        observed = error;
      }
      expect(observed).toBe(marker);
      expect(await grantedSchemaLockCount(probe)).toBe(0);

      const reacquired = await completesWithin(
        db.withSchemaMigrationLock(DATABASE_URL!, async () => 'reacquired'),
        5_000,
        'schema lock reacquire after rollback',
      );
      expect(reacquired).toBe('reacquired');
      expect(await grantedSchemaLockCount(probe)).toBe(0);
    } finally {
      await probe.disconnect();
    }
  }, 30_000);
});
