import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { GBrainError, type EngineConfig } from './types.ts';
import { getConfiguredPostgresSchema } from './postgres-schema.ts';
import type { BrainEngine } from './engine.ts';
import { verifySchema } from './schema-verify.ts';
import { normalizeDatabaseInstanceId } from './database-instance-id.ts';

let sql: ReturnType<typeof postgres> | null = null;
let connectedUrl: string | null = null;

/**
 * #1972: hard upper bound (seconds) on a single pool `.end()` drain. postgres.js
 * accepts `{ timeout }` but applies it internally — against PgBouncer
 * transaction-mode the drain can still hang, and a stubbed `.end()` ignores it
 * entirely. So `endPoolBounded` ALSO wraps each end in a gbrain-owned
 * Promise.race and passes this value as the postgres.js hint so a healthy drain
 * still finishes fast.
 */
export const POOL_END_TIMEOUT_SECONDS = 2;

/**
 * #1972: end a postgres.js pool with a gbrain-owned hard bound. Resolves as soon
 * as `.end()` settles OR after POOL_END_TIMEOUT_SECONDS + a small slack — so
 * teardown never hangs (the prior bare `.end()` blocked until the CLI's 10s
 * force-exit fired, which `process.exit()`s and truncated pending stdout, e.g.
 * #1959's relational query came back empty). Never throws: a teardown that
 * rejects is worse than one that races past a stuck socket. The race timer is
 * the real guarantee; `{ timeout }` just lets a healthy drain return in ms.
 *
 * Note callers that close MULTIPLE pools should `Promise.all` them rather than
 * awaiting sequentially, so the per-pool bounds run concurrently instead of
 * stacking.
 */
export async function endPoolBounded(
  pool: { end: (opts?: { timeout?: number }) => Promise<void> },
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, POOL_END_TIMEOUT_SECONDS * 1000 + 500);
    timer.unref?.();
  });
  try {
    await Promise.race([
      pool.end({ timeout: POOL_END_TIMEOUT_SECONDS }).catch(() => { /* idempotent / already-closed */ }),
      guard,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Default pool size for Postgres connections. Users on the Supabase transaction
 * pooler (port 6543) or any multi-tenant pooler can lower this to avoid
 * MaxClients errors when `gbrain upgrade` spawns subprocesses that each open
 * their own pool. Set `GBRAIN_POOL_SIZE=2` (or similar) before the command.
 */
const DEFAULT_POOL_SIZE_FALLBACK = 10;

/**
 * Supabase PgBouncer transaction-mode convention: port 6543 routes through
 * PgBouncer, which recycles the backend connection between queries and
 * invalidates per-client prepared-statement caches. On that port postgres.js
 * defaults (prepare=true) surface as `prepared statement "..." does not exist`
 * under sustained load and silently drop rows during sync.
 *
 * This is a heuristic, not a protocol guarantee. A direct-Postgres server
 * deliberately bound to 6543 will also get `prepare: false`; the
 * `GBRAIN_PREPARE=true` env var (or `?prepare=true` on the URL) is the
 * documented escape hatch.
 */
const AUTO_DETECT_PORTS = new Set(['6543']);

/**
 * Decide whether to force `prepare: true`/`false` on the postgres.js client.
 *
 * Precedence:
 *   1. `GBRAIN_PREPARE` env var (`true`/`1` or `false`/`0`)
 *   2. `?prepare=true|false` query param on the URL
 *   3. Auto-detect: port 6543 → `false`
 *   4. Default: `undefined` (caller omits the option; postgres.js default stands)
 *
 * Returns `boolean | undefined`. `undefined` is meaningful — callers MUST
 * omit the `prepare` key entirely in that case rather than passing
 * `undefined` through to `postgres(url, {prepare: undefined})`.
 */
export function resolvePrepare(url: string): boolean | undefined {
  const envPrepare = process.env.GBRAIN_PREPARE;
  if (envPrepare === 'false' || envPrepare === '0') return false;
  if (envPrepare === 'true' || envPrepare === '1') return true;

  try {
    const parsed = new URL(url.replace(/^postgres(ql)?:\/\//, 'http://'));
    const urlPrepare = parsed.searchParams.get('prepare');
    if (urlPrepare === 'false') return false;
    if (urlPrepare === 'true') return true;

    if (AUTO_DETECT_PORTS.has(parsed.port)) {
      return false;
    }
  } catch {
    // URL parse failure — fall through to default
  }

  return undefined;
}

export function resolvePoolSize(explicit?: number): number {
  if (typeof explicit === 'number' && explicit > 0) return explicit;
  const raw = process.env.GBRAIN_POOL_SIZE;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_POOL_SIZE_FALLBACK;
}

/**
 * Session-level GUCs applied to every new backend connection. Prevents
 * orphan pgbouncer sessions from holding locks or running queries
 * indefinitely when the postgres.js client disconnects mid-transaction
 * (typical cause: autopilot SIGKILL'd by launchd, worker crash-loop,
 * or transient network drop).
 *
 * Observed failure mode these prevent: a single autopilot UPDATE on
 * `minion_jobs.lock_until` left a pooler backend in `state='active'`
 * / `wait_event='ClientRead'` for 24h+, holding a RowExclusiveLock
 * that blocked every subsequent `ALTER TABLE minion_jobs ...`.
 *
 * Defaults are conservative (chosen not to interfere with bulk work
 * like long-running embed passes or CREATE INDEX on large tables):
 *   - statement_timeout = '5min'
 *   - idle_in_transaction_session_timeout = '5min' (matches v0.18.0
 *     posture; #363's original 2min default was tightened to 5min on
 *     merge with v0.21.0's setSessionDefaults to avoid regressing
 *     long-running embed passes)
 *
 * Override per-GUC with env vars:
 *   - GBRAIN_STATEMENT_TIMEOUT
 *   - GBRAIN_IDLE_TX_TIMEOUT
 *   - GBRAIN_CLIENT_CHECK_INTERVAL (Postgres 14+; empty default - opt-in
 *     only since older self-hosted Postgres rejects this startup param)
 *
 * Set any env var to '0' or 'off' to disable that GUC entirely.
 *
 * Delivered via postgres.js's `connection` option, which sends these as
 * startup parameters in the initial connection packet. Works correctly
 * with PgBouncer session mode AND transaction mode: startup parameters
 * pass through to the backend on connection creation and persist for the
 * backend's lifetime (unlike `SET` commands which transaction-mode
 * PgBouncer strips between transactions).
 *
 * Supersedes the v0.21.0 `setSessionDefaults(sql)` helper, which used
 * a post-pool `SET` command. That approach is unreliable in PgBouncer
 * transaction mode (transaction-mode poolers strip session-state SETs
 * between transactions); startup parameters are durable.
 */
const DEFAULT_STATEMENT_TIMEOUT = '5min';
const DEFAULT_IDLE_TX_TIMEOUT = '5min';

export function resolveSessionTimeouts(): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (envKey: string, gucKey: string, defaultVal: string) => {
    const raw = process.env[envKey];
    if (raw === '0' || raw === 'off') return; // explicitly disabled
    const val = raw ?? defaultVal;
    if (val) out[gucKey] = val;
  };
  add('GBRAIN_STATEMENT_TIMEOUT', 'statement_timeout', DEFAULT_STATEMENT_TIMEOUT);
  add('GBRAIN_IDLE_TX_TIMEOUT', 'idle_in_transaction_session_timeout', DEFAULT_IDLE_TX_TIMEOUT);
  // client_connection_check_interval is opt-in: Postgres 14+ only, and some
  // managed pooler tiers reject unknown startup parameters. Users can enable
  // it explicitly once they know their Postgres version supports it.
  add('GBRAIN_CLIENT_CHECK_INTERVAL', 'client_connection_check_interval', '');
  return out;
}

/**
 * Backward-compat shim for v0.21.0's `setSessionDefaults` callers.
 * The current implementation no-ops because session timeouts are now
 * applied at connection-startup time via `resolveSessionTimeouts()` +
 * postgres.js's `connection` option (more durable across PgBouncer
 * transaction mode).
 *
 * Kept as a callable function so existing call sites in `connect()` and
 * `PostgresEngine.connect()` don't need to be touched on the merge —
 * the work has already happened by the time this function would run.
 */
export async function setSessionDefaults(_sql: ReturnType<typeof postgres>): Promise<void> {
  // No-op: timeouts are now applied as startup parameters in resolveSessionTimeouts().
}

/**
 * Serialize schema replay and migrations without relying on a pooled session.
 *
 * A plain `pg_advisory_lock()` is session-scoped. Calling lock and unlock on a
 * postgres.js pool can therefore use different backends and leak the lock
 * indefinitely. A dedicated one-connection session avoids that class of bug:
 * lock and verified unlock execute on one reserved backend, while schema work
 * uses the normal work pool. Keeping the lock client separate also means
 * GBRAIN_POOL_SIZE=1 cannot self-deadlock.
 *
 * A transaction-scoped advisory lock is deliberately not used here: long-lived
 * lock transactions block CREATE INDEX CONCURRENTLY from completing. Callers
 * must provide a direct/session-mode URL. No URL or credential is included in
 * errors emitted by this helper.
 */
export const SCHEMA_MIGRATION_LOCK_KEY = 42;
// With pg_catalog omitted, Postgres searches it implicitly before public for
// name resolution while keeping public as current_schema()/the CREATE target.
// Explicit `pg_catalog, public` is unsafe for schema replay: unqualified CREATE
// TABLE would target pg_catalog and fail (or require forbidden catalog writes).
export const PUBLIC_SCHEMA_SEARCH_PATH_SQL = 'SET search_path = public';

type PostgresPool = ReturnType<typeof postgres>;

function normalizeSchemaArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => String(item));
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return [];
  const inner = trimmed.slice(1, -1);
  if (!inner) return [];
  // Only the two canonical unquoted identifiers can be accepted. Any quoted,
  // escaped, or comma-bearing custom name deliberately fails closed.
  return inner.split(',').map(item => item.trim());
}

/**
 * GBrain's Postgres schema is public-owned. The default "$user", public path
 * remains compatible only while the role schema does not exist, in which case
 * Postgres reports the effective explicit path as exactly [public]. Every
 * other effective path is a shadowing or wrong-CREATE-target risk for the many
 * historical unqualified migration statements.
 */
export function isPublicSchemaAuthority(
  currentSchema: unknown,
  explicitSchemas: unknown,
): boolean {
  if (currentSchema !== 'public') return false;
  const schemas = normalizeSchemaArray(explicitSchemas);
  return schemas.length === 1 && schemas[0] === 'public';
}

/** Read-only, pre-DDL validation of one concrete Postgres work/DDL pool. */
export async function assertPublicSchemaAuthority(
  conn: PostgresPool,
  label: 'configured work database' | 'DDL database',
): Promise<void> {
  const rows = await conn.unsafe<{
    current_schema: string | null;
    explicit_schemas: string[] | string | null;
  }[]>(`
    SELECT current_schema()::text AS current_schema,
           current_schemas(false)::text[] AS explicit_schemas
  `);
  if (rows.length !== 1
    || !isPublicSchemaAuthority(rows[0]?.current_schema, rows[0]?.explicit_schemas)) {
    throw new Error(
      `Refusing schema mutation: ${label} has an incompatible search_path. ` +
      'GBrain schema authority is public; use an effective public-only path.',
    );
  }
}

export interface DatabaseSessionLockHandle {
  assertOwned(): Promise<void>;
  /**
   * Prove a work pool reaches the exact database/cluster holding this reserved
   * session. Uses a collision-resistant per-attempt advisory challenge, not a
   * URL/database-name comparison (two clusters may host the same db name).
   */
  assertSameDatabase(workPool: PostgresPool): Promise<void>;
  /** Prove the reserved lock session is connected to the intended brain. */
  assertDatabaseIdentity(expectedBrainId: string): Promise<void>;
  release(): Promise<void>;
}

interface DatabaseUrlAuthority {
  database: string;
  looksPooled: boolean;
}

function inspectDatabaseUrlAuthority(url: string): DatabaseUrlAuthority {
  if (!/^postgres(?:ql)?:\/\//i.test(url)) {
    throw new Error('Database session lock requires a valid Postgres URL');
  }
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { throw new Error('Database session lock requires a valid Postgres URL'); }
  const host = parsed.hostname.toLowerCase();
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!database) throw new Error('Database session lock URL must name a database');
  return {
    database,
    looksPooled: parsed.port === '6543'
      || /(pooler|pooling|pgbouncer|supavisor)/i.test(host),
  };
}

/** Conservative topology check shared by lock and schema-route guards. */
export function isLikelyTransactionPoolerUrl(url: string): boolean {
  try {
    return inspectDatabaseUrlAuthority(url).looksPooled;
  } catch {
    // An invalid authority is never safe to treat as a direct/session route.
    return true;
  }
}

/**
 * Resolve a URL on which session-scoped advisory locks are trustworthy.
 * Known/likely pooler URLs fail closed unless a distinct explicit or safely
 * derived session/direct authority is supplied.
 */
export function resolveDatabaseSessionLockUrl(
  configuredUrl: string,
  directUrl?: string | null,
): string {
  const configured = inspectDatabaseUrlAuthority(configuredUrl);
  const explicit = directUrl?.trim();
  if (explicit) {
    const direct = inspectDatabaseUrlAuthority(explicit);
    if (direct.looksPooled) {
      throw new Error(
        'Database session lock refuses a likely transaction-pooler direct override; configure GBRAIN_DIRECT_DATABASE_URL to a direct or session-mode endpoint.',
      );
    }
    if (direct.database !== configured.database) {
      throw new Error('Database session lock direct override names a different database');
    }
    return explicit;
  }
  if (configured.looksPooled) {
    throw new Error(
      'Database session lock refuses a likely transaction-pooler URL; configure GBRAIN_DIRECT_DATABASE_URL to a direct or session-mode endpoint.',
    );
  }
  return configuredUrl;
}

export async function acquireDatabaseSessionLock(
  url: string,
  key: number,
): Promise<DatabaseSessionLockHandle> {
  if (!Number.isSafeInteger(key)) throw new Error('Database session lock key must be a safe integer');
  let proofKey: string;
  do {
    const random63 = BigInt(`0x${randomUUID().replace(/-/g, '').slice(0, 16)}`)
      & ((1n << 63n) - 1n);
    proofKey = random63.toString();
  } while (proofKey === '0' || proofKey === String(key));
  const lockPool = postgres(url, {
    max: 1,
    idle_timeout: 0,
    // postgres.js otherwise retires even reserved connections after a random
    // 30–60 minutes, silently releasing a lock during supported 2h runs.
    max_lifetime: null,
    connect_timeout: 10,
    prepare: false,
    types: { bigint: postgres.BigInt },
    onnotice: process.env.GBRAIN_PG_NOTICES === '1' ? undefined : () => {},
  });
  let reserved: Awaited<ReturnType<typeof lockPool.reserve>> | null = null;
  try {
    reserved = await lockPool.reserve();
    await reserved.unsafe("SET statement_timeout = '30min'");
    await reserved`SELECT pg_advisory_lock(${key}::bigint)`;
    await reserved`SELECT pg_advisory_lock(${proofKey}::bigint)`;
    let released = false;
    const owned = reserved;
    const assertOwned = async (): Promise<void> => {
      const rows = await owned<{ held: boolean }[]>`
        SELECT EXISTS (
          SELECT 1
            FROM pg_locks
           WHERE locktype = 'advisory'
             AND pid = pg_backend_pid()
             AND classid = 0
             AND objid = ${key}::oid
             AND objsubid = 1
             AND granted
        ) AS held
      `;
      if (rows[0]?.held !== true) {
        throw new Error('Database session lock is no longer owned by its reserved backend');
      }
    };
    return {
      assertOwned,
      async assertSameDatabase(workPool: PostgresPool): Promise<void> {
        await assertOwned();
        // The random proof lock exists only on the reserved authority. A
        // transaction on the same database must therefore fail to acquire it;
        // a different cluster/database succeeds and auto-releases on commit.
        const rows = await workPool.begin(async tx =>
          tx<{ acquired: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(${proofKey}::bigint) AS acquired
          `,
        );
        if (rows.length !== 1 || rows[0]?.acquired !== false) {
          throw new Error(
            'Database session lock authority does not cover the configured work database',
          );
        }
      },
      async assertDatabaseIdentity(expectedBrainId: string): Promise<void> {
        const rows = await owned<{ value: string }[]>`
          SELECT value FROM public.config WHERE key = 'database_instance_id'
        `;
        if (rows.length !== 1
          || normalizeDatabaseInstanceId(rows[0]?.value) !== expectedBrainId) {
          throw new Error(
            'Database session lock authority does not match the configured brain identity',
          );
        }
      },
      async release(): Promise<void> {
        if (released) return;
        released = true;
        let proofUnlocked = false;
        let primaryUnlocked = false;
        try {
          const rows = await owned<{ unlocked: boolean }[]>`
            SELECT pg_advisory_unlock(${proofKey}::bigint) AS unlocked
          `;
          proofUnlocked = rows[0]?.unlocked === true;
        } finally {
          try {
            const rows = await owned<{ unlocked: boolean }[]>`
              SELECT pg_advisory_unlock(${key}::bigint) AS unlocked
            `;
            primaryUnlocked = rows[0]?.unlocked === true;
          } finally {
            owned.release();
            reserved = null;
            await endPoolBounded(lockPool);
          }
        }
        if (!proofUnlocked || !primaryUnlocked) {
          throw new Error('Database session lock release was not acknowledged by its owning session');
        }
      }
    };
  } catch (error) {
    reserved?.release();
    await endPoolBounded(lockPool);
    throw error;
  }
}

export async function withDatabaseSessionLock<T>(
  url: string,
  key: number,
  fn: (handle: DatabaseSessionLockHandle) => Promise<T>,
): Promise<T> {
  const handle = await acquireDatabaseSessionLock(url, key);
  try {
    return await fn(handle);
  } finally {
    await handle.release();
  }
}

export async function withSchemaMigrationLock<T>(
  url: string,
  fn: (handle: DatabaseSessionLockHandle) => Promise<T>,
): Promise<T> {
  return withDatabaseSessionLock(url, SCHEMA_MIGRATION_LOCK_KEY, fn);
}

export function getConnection(): ReturnType<typeof postgres> {
  if (!sql) {
    throw new GBrainError(
      'No database connection',
      'connect() has not been called',
      'Run gbrain init --supabase or gbrain init --url <connection_string>',
    );
  }
  return sql;
}

/**
 * Connect the module-level singleton. Returns `true` iff THIS call created the
 * singleton, `false` if it joined an existing one.
 *
 * #1471 ownership: the create-vs-join decision is made HERE, atomically. There
 * is no `await` between the `if (sql)` null-check below and the synchronous
 * `sql = postgres(url, opts)` assignment, so two concurrent module connects
 * cannot both observe `sql === null` and both create. Callers store the return
 * as their ownership token (`PostgresEngine._ownsModuleSingleton`); only the
 * creator may later tear the singleton down. Borrowers (probe engines created
 * while the singleton already exists) get `false` and must NOT disconnect it.
 *
 * Back-compat: callers that ignore the return value are unaffected.
 */
export async function connect(config: EngineConfig): Promise<boolean> {
  if (sql) {
    // Warn if a different URL is passed — the old connection is still in use
    if (config.database_url && connectedUrl && config.database_url !== connectedUrl) {
      console.warn('[gbrain] connect() called with a different database_url but a connection already exists. Using existing connection.');
    }
    return false; // joined an existing singleton — caller is a borrower
  }

  const url = config.database_url;
  if (!url) {
    throw new GBrainError(
      'No database URL',
      'database_url is missing from config',
      'Run gbrain init --supabase or gbrain init --url <connection_string>',
    );
  }

  try {
    const prepare = resolvePrepare(url);
    const timeouts = resolveSessionTimeouts();
    const opts: Record<string, unknown> = {
      max: resolvePoolSize(),
      idle_timeout: 20,
      connect_timeout: 10,
      types: {
        // Register pgvector type
        bigint: postgres.BigInt,
      },
      // Silence postgres NOTICE-level messages by default ("relation already
      // exists, skipping" floods stdout under idempotent CREATE statements
      // during migrations + initSchema, and breaks stdout-parsing callers like
      // `gbrain jobs submit --json | ...`). Opt back in with GBRAIN_PG_NOTICES=1.
      onnotice: process.env.GBRAIN_PG_NOTICES === '1' ? undefined : () => {},
    };
    if (Object.keys(timeouts).length > 0) {
      opts.connection = timeouts;
    }
    if (typeof prepare === 'boolean') {
      opts.prepare = prepare;
      if (!prepare) {
        console.warn(
          '[gbrain] Prepared statements disabled (PgBouncer transaction-mode convention on port 6543). Override with GBRAIN_PREPARE=true if your pooler runs in session mode.',
        );
      }
    }
    sql = postgres(url, opts);

    // Test connection
    await sql`SELECT 1`;
    connectedUrl = url;

    await setSessionDefaults(sql);
    return true; // we created the singleton — caller is the owner
  } catch (e: unknown) {
    sql = null;
    connectedUrl = null;
    const msg = e instanceof Error ? e.message : String(e);
    throw new GBrainError(
      'Cannot connect to database',
      msg,
      'Check your connection URL in ~/.gbrain/config.json',
    );
  }
}

export async function disconnect(): Promise<void> {
  // v0.41.25.0 (#1570) — instrument every disconnect call site so v0.41.26
  // can identify the caller that's nulling the module singleton mid-cycle.
  // Best-effort: audit failure must never block the actual disconnect.
  // The audit module is lazy-imported to keep db.ts cold-path-free for
  // tools that import db without ever calling disconnect.
  try {
    const { logDbDisconnect } = await import('./audit/db-disconnect-audit.ts');
    // db.ts is always the module-singleton path by construction; no
    // instance-pool callers go through here.
    logDbDisconnect('postgres', 'module');
  } catch { /* best-effort; never block disconnect on audit failure */ }
  // #1471 (codex #6): snapshot + null the singleton BEFORE awaiting end(), so a
  // concurrent module connect() can't observe a non-null `sql` mid-teardown and
  // join a pool that's already closing. Mirrors the v0.41.8.0 PGLite-disconnect
  // snapshot+early-null pattern.
  const s = sql;
  sql = null;
  connectedUrl = null;
  if (s) await endPoolBounded(s);
}

export async function initSchema(): Promise<void> {
  const conn = getConnection();
  const url = connectedUrl;
  if (!url) {
    throw new GBrainError(
      'No database connection',
      'connected database URL is unavailable',
      'Reconnect with gbrain init --url <connection_string>',
    );
  }
  // A session advisory lock cannot be trusted through transaction-mode
  // PgBouncer. Prefer the same explicit/derived direct URL used by the
  // connection manager; non-pooler URLs fall back to themselves.
  const directPoolDisabled = process.env.GBRAIN_DISABLE_DIRECT_POOL === '1'
    || process.env.GBRAIN_DISABLE_DIRECT_POOL === 'true';
  if (directPoolDisabled && isLikelyTransactionPoolerUrl(url)) {
    throw new Error(
      'Refusing schema mutation through a transaction pooler while ' +
      'GBRAIN_DISABLE_DIRECT_POOL is active. Unset the kill switch for the ' +
      'schema phase, or configure the primary database URL as a direct/session endpoint.',
    );
  }
  const configuredDirect = directPoolDisabled
    ? undefined
    : process.env.GBRAIN_DIRECT_DATABASE_URL?.trim();
  const { deriveDirectUrl } = await import('./connection-manager.ts');
  const schemaLockUrl = resolveDatabaseSessionLockUrl(
    url,
    configuredDirect || deriveDirectUrl(url),
  );
  await withSchemaMigrationLock(schemaLockUrl, async lock => {
    // This standalone path has one work/DDL pool. Prove it reaches the same
    // database as the reserved session and resolves unqualified legacy schema
    // statements only to public before any DDL is attempted.
    await assertPublicSchemaAuthority(conn, 'configured work database');
    await lock.assertSameDatabase(conn);

    const establishAndAssertIdentity = async (): Promise<void> => {
      await conn`
        INSERT INTO public.config (key, value)
        VALUES ('database_instance_id', ${randomUUID()})
        ON CONFLICT (key) DO NOTHING
      `;
      const rows = await conn<{ value: string }[]>`
        SELECT value FROM public.config WHERE key = 'database_instance_id'
      `;
      if (rows.length !== 1) {
        throw new Error('Database instance identity is not unique or readable');
      }
      await lock.assertDatabaseIdentity(normalizeDatabaseInstanceId(rows[0]?.value));
    };

    const table = await conn<{ present: string | null }[]>`
      SELECT to_regclass('public.config')::text AS present
    `;
    if (table[0]?.present) {
      await establishAndAssertIdentity();
    }
    const schemaSql = await getConfiguredPostgresSchema();
    await conn.unsafe(`${PUBLIC_SCHEMA_SEARCH_PATH_SQL};\n${schemaSql}`);
    await establishAndAssertIdentity();
  });
}

export { verifySchema } from './schema-verify.ts';

export async function withTransaction<T>(fn: (tx: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  const conn = getConnection();
  return conn.begin(async (tx) => {
    return fn(tx as unknown as ReturnType<typeof postgres>);
  }) as Promise<T>;
}

const RETRYABLE_DB_CONNECT_PATTERNS = [
  /password authentication failed/i,
  /connection refused/i,
  /the database system is starting up/i,
  /Connection terminated unexpectedly/i,
  /ECONNRESET/i,
];

export function isRetryableDbConnectError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg) return false;
  return RETRYABLE_DB_CONNECT_PATTERNS.some(p => p.test(msg));
}

export interface ConnectWithRetryOpts {
  attempts?: number;
  baseDelayMs?: number;
  noRetry?: boolean;
  log?: (line: string) => void;
}

export async function connectWithRetry(
  engine: BrainEngine,
  config: EngineConfig & { poolSize?: number },
  opts: ConnectWithRetryOpts = {},
): Promise<void> {
  const noRetry = opts.noRetry ?? (process.env.GBRAIN_NO_RETRY_CONNECT === '1');
  const attempts = noRetry ? 1 : (opts.attempts ?? 3);
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const log = opts.log ?? ((line) => console.warn(line));

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await engine.connect(config);
      return;
    } catch (e: unknown) {
      lastErr = e;
      const retryable = isRetryableDbConnectError(e);
      const isLast = i === attempts - 1;
      if (!retryable || isLast) {
        throw e;
      }
      const delay = baseDelayMs * Math.pow(2, i);
      const msg = e instanceof Error ? e.message : String(e);
      log(`[connect] attempt ${i + 1} failed (${msg.slice(0, 80)}), retrying in ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  // Unreachable, but TS needs the throw.
  throw lastErr;
}
