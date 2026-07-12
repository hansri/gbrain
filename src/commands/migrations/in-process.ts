/**
 * In-process migration helpers (v0.41.37.0 #1605).
 *
 * Why this exists: migration schema phases used to shell out to a child
 * `gbrain init --migrate-only` via `execSync`. On Windows + bun + Supabase
 * pooler, the spawned CHILD process dies with `getaddrinfo ENOTFOUND` before it
 * can connect — even though the PARENT connects fine and `env: process.env` is
 * passed. It is a bun-on-Windows child-process DNS-resolution failure, not an
 * env-propagation bug. The only robust fix is to not spawn at all: run the
 * schema bring-up IN-PROCESS. The PGLite path at v0_11_0.ts already proved the
 * pattern; this generalizes it to every engine + every schema phase.
 *
 * `runMigrateOnlyCore` is the single source of truth for "bring schema to head"
 * — `init.ts:initMigrateOnly` (the `gbrain init --migrate-only` CLI path) and
 * the migration orchestrators both call it, so the configureGateway-before-
 * initSchema fix can't drift between them.
 *
 * `runGbrainSubprocess` is the diagnostic wrapper for the REMAINING (non-schema)
 * gbrain-subprocess spawns (extract/repair/stats). It executes the exact
 * running release with structured argv (never a PATH shim or shell), captures child stderr, and
 * folds it into the thrown error so a Windows failure shows the real
 * `getaddrinfo ENOTFOUND` line instead of the bare `Command failed: ...`.
 */

import { execFileSync } from 'child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import type { Dirent } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { loadConfig, toEngineConfig } from '../../core/config.ts';
import type { GBrainConfig } from '../../core/config.ts';
import type { EngineConfig } from '../../core/types.ts';
import { createEngine } from '../../core/engine-factory.ts';
import {
  getOrCreateDatabaseInstanceId,
  readDatabaseInstanceId,
} from '../../core/database-instance-id.ts';
import type { OrchestratorOpts } from './types.ts';
import { redactSecretsInText } from '../../core/minions/handlers/shell-redact.ts';
import { redactPgUrl } from '../../core/url-redact.ts';
import {
  mintUpgradeChildCapability,
  resolveUpgradeChildInvocation,
} from '../../core/upgrade-child-capability.ts';

/** First observation window for in-process initSchema. */
export const MIGRATE_ONLY_TIMEOUT_MS = 600_000;
/** Additional window after the first timeout before state is declared
 * ambiguous (never rolled back). Keeps a permanently wedged driver bounded. */
export const MIGRATE_ONLY_AMBIGUITY_GRACE_MS = 30_000;
const MIGRATE_ONLY_DISCONNECT_TIMEOUT_MS = 5_000;
const AMBIGUOUS_PREFIX = 'MIGRATION_STATE_AMBIGUOUS:';

/** Large stderr buffer for captured subprocess output. `execSync`'s default
 *  ~1MB maxBuffer overflows on long backfills (extract/repair) and turns a
 *  successful run into a spurious failure. */
const SUBPROCESS_MAX_BUFFER = 64 * 1024 * 1024;
const SUBPROCESS_ERROR_MAX_CHARS = 16_384;
const SUBPROCESS_ERROR_SCAN_MAX_CHARS = 256 * 1024;
const MIGRATION_SNAPSHOT_PREFIX = 'gbrain-migration-snapshot-';
const LEGACY_SNAPSHOT_STALE_MS = 24 * 60 * 60 * 1_000;

export interface MigrateOnlyResult {
  /** The engine kind that was brought to head ('pglite' | 'postgres'). */
  engine: string;
}

export class MigrateOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrateOnlyError';
  }
}

export class MigrateOnlyAmbiguousStateError extends MigrateOnlyError {
  constructor(message: string) {
    super(`${AMBIGUOUS_PREFIX} ${message}`);
    this.name = 'MigrateOnlyAmbiguousStateError';
  }
}

export interface CurrentReleaseRuntime {
  execPath: string;
  main: string;
}

/**
 * Resolve the exact binary/source entrypoint currently running this migration.
 * Never consult PATH: during a staged upgrade it commonly still points at the
 * old production shim, which must not execute new-release migration phases.
 */
export function resolveCurrentGbrainInvocation(
  args: readonly string[],
  runtime: CurrentReleaseRuntime = { execPath: process.execPath, main: Bun.main },
): string[] {
  return resolveUpgradeChildInvocation(args, runtime);
}

/** Survives orchestrators that serialize phase errors into detail strings. */
export function isMigrateOnlyAmbiguousState(error: unknown): boolean {
  return error instanceof MigrateOnlyAmbiguousStateError
    || (error instanceof Error && error.message.includes(AMBIGUOUS_PREFIX))
    || (typeof error === 'string' && error.includes(AMBIGUOUS_PREFIX));
}

/**
 * Bring the configured brain's schema to head, in-process. Mirrors what
 * `gbrain init --migrate-only` did via subprocess: configureGateway →
 * createEngine → connect → initSchema → disconnect. Idempotent (initSchema is
 * a no-op when already at head). Throws `MigrateOnlyError` on no-config or
 * timeout so callers report a failed phase rather than hanging.
 */
export interface RunMigrateOnlyOpts {
  timeoutMs?: number;
  ambiguityGraceMs?: number;
  /** Immutable snapshots from apply-migrations; avoids ambient config drift. */
  config?: GBrainConfig;
  engineConfig?: EngineConfig;
  expectedDatabaseIdentity?: string;
}

export async function runMigrateOnlyCore(opts?: RunMigrateOnlyOpts): Promise<MigrateOnlyResult> {
  const config = opts?.config ?? loadConfig();
  if (!config) {
    throw new MigrateOnlyError(
      'No brain configured. Run `gbrain init` (interactive) or `gbrain init --pglite` / `gbrain init --supabase` first.',
    );
  }

  // configureGateway BEFORE initSchema (init.ts B.3): a schema bump on a brain
  // whose file config is missing embedding fields must not fall through to
  // stale hardcoded fallbacks. loadConfig already merged env; propagate it.
  const { configureGateway } = await import('../../core/ai/gateway.ts');
  configureGateway({
    embedding_model: config.embedding_model,
    embedding_dimensions: config.embedding_dimensions,
    expansion_model: config.expansion_model,
    chat_model: config.chat_model,
    env: { ...process.env },
  });

  const timeoutMs = opts?.timeoutMs ?? MIGRATE_ONLY_TIMEOUT_MS;
  const engineConfig = opts?.engineConfig ?? toEngineConfig(config);
  const engine = await createEngine(engineConfig);
  try {
    await engine.connect(engineConfig);
    if (opts?.expectedDatabaseIdentity) {
      // Orchestrator snapshots are bound to the database-owned UUID, not the
      // legacy route/path hash returned by getDatabaseIdentity(). Credentials,
      // pooler routes, and release homes may change without changing the brain.
      const actual = await readDatabaseInstanceId(engine);
      if (actual !== opts.expectedDatabaseIdentity) {
        throw new MigrateOnlyError('Configured database identity changed before schema migration');
      }
    }
    await awaitMigrationSettlement(
      engine.initSchema(),
      timeoutMs,
      `schema init timed out after ${Math.round(timeoutMs / 1000)}s`,
      opts?.ambiguityGraceMs ?? MIGRATE_ONLY_AMBIGUITY_GRACE_MS,
    );
    if (opts?.expectedDatabaseIdentity) {
      const settledIdentity = await readDatabaseInstanceId(engine);
      if (settledIdentity !== opts.expectedDatabaseIdentity) {
        throw new MigrateOnlyError('Configured database identity changed during schema migration');
      }
    } else {
      // The standalone `init --migrate-only` path may be the first new binary
      // to touch a legacy brain. Establish its durable identity only after the
      // schema is available and the migration has settled successfully.
      await getOrCreateDatabaseInstanceId(engine);
    }
  } finally {
    // A driver wedged deeply enough to make schema state ambiguous may also
    // wedge disconnect. Keep the command bounded; the original promise has a
    // rejection handler installed by awaitMigrationSettlement, so a late
    // failure cannot become an unhandled rejection.
    try {
      await Promise.race([
        engine.disconnect(),
        new Promise<void>(resolve => setTimeout(resolve, MIGRATE_ONLY_DISCONNECT_TIMEOUT_MS)),
      ]);
    } catch { /* best-effort */ }
  }

  return { engine: config.engine };
}

/**
 * Run a gbrain subcommand as a same-release subprocess, capturing child stderr so a
 * failure surfaces the real reason. Used for the non-schema backfill phases
 * (extract/repair/stats) that aren't yet in-process. On Windows these may still
 * fail with `getaddrinfo ENOTFOUND`, but the operator now sees WHY instead of a
 * bare `Command failed`. Returns captured stdout (utf-8) on success.
 *
 * Note: stderr is piped (captured), so gbrain progress lines (which go to
 * stderr) are not shown live during these phases — acceptable for a one-shot
 * `apply-migrations` run; the failure reason matters more than live progress.
 */
export async function runGbrainSubprocess(
  args: readonly string[],
  opts: {
    timeoutMs?: number;
    snapshot: OrchestratorOpts;
    /** Required effect classification controls fail-closed timeout handling. */
    effect: 'read_only' | 'mutating';
  },
  deps: {
    /** Test seam; production callers always execute the current release. */
    resolveInvocation?: (args: readonly string[]) => string[];
  } = {},
): Promise<string> {
  // Verify the captured database identity before crossing the child-process
  // boundary. The private config below then keeps the child on that target.
  const { withMigrationEngine } = await import('./snapshot.ts');
  await withMigrationEngine(opts.snapshot, async () => undefined);

  // A child CLI normally re-reads the ambient config. Give it a private,
  // owner-only config home containing the already-resolved snapshot instead,
  // replace ambient DB/key overrides with the captured values so a concurrent
  // config/env switch cannot redirect the command to another brain.
  reapStaleMigrationSnapshotDirs();
  const root = mkdtempSync(join(tmpdir(), `${MIGRATION_SNAPSHOT_PREFIX}${process.pid}-`));
  const { registerCleanup } = await import('../../core/process-cleanup.ts');
  const unregisterCleanup = registerCleanup(
    `migration-snapshot-${process.pid}`,
    async () => { rmSync(root, { recursive: true, force: true }); },
  );
  const configDir = join(root, '.gbrain');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const pinnedConfig = buildPinnedMigrationChildConfig(opts.snapshot);
  writeFileSync(join(configDir, 'config.json'), JSON.stringify(pinnedConfig), { mode: 0o600 });
  const childEnv: NodeJS.ProcessEnv = { ...process.env, GBRAIN_HOME: root };
  childEnv.GBRAIN_SKIP_STARTUP_HOOKS = '1';
  delete childEnv.GBRAIN_DATABASE_URL;
  delete childEnv.DATABASE_URL;
  delete childEnv.OPENAI_API_KEY;
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.ZEROENTROPY_API_KEY;
  if (opts.snapshot.engineConfig.database_url) {
    // Keep the credential-bearing URL in the child environment only. A crash
    // can orphan the temp directory, never this secret.
    childEnv.GBRAIN_DATABASE_URL = opts.snapshot.engineConfig.database_url;
  }
  if (opts.snapshot.gbrainConfig.openai_api_key) {
    childEnv.OPENAI_API_KEY = opts.snapshot.gbrainConfig.openai_api_key;
  }
  if (opts.snapshot.gbrainConfig.anthropic_api_key) {
    childEnv.ANTHROPIC_API_KEY = opts.snapshot.gbrainConfig.anthropic_api_key;
  }
  if (opts.snapshot.gbrainConfig.zeroentropy_api_key) {
    childEnv.ZEROENTROPY_API_KEY = opts.snapshot.gbrainConfig.zeroentropy_api_key;
  }
  try {
    const invocation = (deps.resolveInvocation ?? resolveCurrentGbrainInvocation)(args);
    const executable = invocation[0];
    if (!executable) throw new Error('Resolved migration subprocess invocation is empty');
    if (opts.snapshot.upgradeTransition) {
      const capability = mintUpgradeChildCapability({
        configDir,
        rawArgs: args,
        invocation,
        transition: opts.snapshot.upgradeTransition,
        snapshotBrainId: opts.snapshot.brainId,
      });
      Object.assign(childEnv, capability.env);
    }
    const out = execFileSync(executable, invocation.slice(1), {
      stdio: ['inherit', 'pipe', 'pipe'],
      timeout: opts.timeoutMs ?? MIGRATE_ONLY_TIMEOUT_MS,
      env: childEnv,
      maxBuffer: SUBPROCESS_MAX_BUFFER,
      encoding: 'utf-8',
    });
    return typeof out === 'string' ? out : '';
  } catch (e: unknown) {
    const err = e as {
      message?: string;
      stderr?: Buffer | string;
      code?: string;
      signal?: string | null;
      status?: number | null;
      killed?: boolean;
    };
    const stderrRaw = err?.stderr
      ? (Buffer.isBuffer(err.stderr) ? err.stderr.toString('utf-8') : String(err.stderr))
      : '';
    const tail = stderrRaw.split('\n').filter(Boolean).slice(-10).join('\n');
    const base = err?.message ?? String(e);
    const combined = tail ? `${base}\n--- child stderr (tail) ---\n${tail}` : base;
    const sanitized = sanitizeMigrationSubprocessError(combined, opts.snapshot);
    const indeterminateTermination = err.code === 'ETIMEDOUT'
      || err.killed === true
      || typeof err.signal === 'string'
      || err.status === null;
    if (opts.effect === 'mutating' && indeterminateTermination) {
      throw new MigrateOnlyAmbiguousStateError(
        'A mutating migration subprocess ended without a definitive exit status and may have committed late. ' +
        `Keep the migration fence and inspect the target before retrying. ${sanitized}`,
      );
    }
    throw new Error(sanitized);
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
      unregisterCleanup();
    } catch {
      // Keep the process-cleanup registration alive if normal removal fails.
    }
  }
}

function snapshotSecrets(snapshot: OrchestratorOpts): ReadonlyMap<string, string> {
  const secrets = new Map<string, string>();
  const visit = (value: unknown, path: string): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}_${key}` : key;
      if (typeof child === 'string'
        && /(password|passwd|secret|token|api[_-]?key|database_url)/i.test(key)) {
        secrets.set(childPath.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase(), child);
      } else if (child && typeof child === 'object') {
        visit(child, childPath);
      }
    }
  };
  visit(snapshot.gbrainConfig, 'CONFIG');
  visit(snapshot.engineConfig, 'ENGINE');

  const databaseUrl = snapshot.engineConfig.database_url;
  if (databaseUrl) {
    secrets.set('DATABASE_URL', databaseUrl);
    try {
      const parsed = new URL(databaseUrl);
      if (parsed.username) secrets.set('DATABASE_USERNAME', decodeURIComponent(parsed.username));
      if (parsed.password) secrets.set('DATABASE_PASSWORD', decodeURIComponent(parsed.password));
    } catch { /* exact URL replacement above still applies */ }
  }
  return secrets;
}

export function sanitizeMigrationSubprocessError(
  text: string,
  snapshot: OrchestratorOpts,
): string {
  // Bound redaction work before replaceAll: a one-character configured secret
  // echoed across a maxBuffer-sized line must not expand into hundreds of MB.
  const scanInput = text.length <= SUBPROCESS_ERROR_SCAN_MAX_CHARS
    ? text
    : `${text.slice(0, SUBPROCESS_ERROR_SCAN_MAX_CHARS / 2)}\n` +
      `[...subprocess evidence truncated before redaction...]\n` +
      text.slice(-SUBPROCESS_ERROR_SCAN_MAX_CHARS / 2);
  const secretRedacted = redactSecretsInText(scanInput, snapshotSecrets(snapshot));
  const pgRedacted = secretRedacted.replace(
    /postgres(?:ql)?:\/\/[^\s"'<>]+/gi,
    value => redactPgUrl(value),
  );
  return pgRedacted.slice(0, SUBPROCESS_ERROR_MAX_CHARS);
}

/**
 * The child needs connection shape and non-secret model selection only. API
 * keys and Postgres credentials are passed in its private environment so a
 * SIGKILL/power-loss orphan never leaves secrets in /tmp.
 */
export function buildPinnedMigrationChildConfig(snapshot: OrchestratorOpts): GBrainConfig {
  const cfg = snapshot.gbrainConfig;
  return {
    engine: cfg.engine,
    ...(snapshot.engineConfig.database_path
      ? { database_path: snapshot.engineConfig.database_path }
      : {}),
    ...(cfg.embedding_model !== undefined ? { embedding_model: cfg.embedding_model } : {}),
    ...(cfg.embedding_dimensions !== undefined ? { embedding_dimensions: cfg.embedding_dimensions } : {}),
    ...(cfg.embedding_disabled !== undefined ? { embedding_disabled: cfg.embedding_disabled } : {}),
    ...(cfg.expansion_model !== undefined ? { expansion_model: cfg.expansion_model } : {}),
    ...(cfg.chat_model !== undefined ? { chat_model: cfg.chat_model } : {}),
    ...(cfg.chat_fallback_chain !== undefined ? { chat_fallback_chain: [...cfg.chat_fallback_chain] } : {}),
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: unknown }).code === 'ESRCH');
  }
}

/** Reap only real, current-owner, 0700 snapshot directories proven stale. */
export function reapStaleMigrationSnapshotDirs(nowMs = Date.now()): number {
  if (typeof process.getuid !== 'function') return 0;
  let removed = 0;
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(tmpdir(), { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.name.startsWith(MIGRATION_SNAPSHOT_PREFIX) || !entry.isDirectory()) continue;
    const path = join(tmpdir(), entry.name);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      if (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) continue;
      const pidMatch = entry.name.match(/^gbrain-migration-snapshot-(\d+)-/);
      const stale = pidMatch
        ? !processIsAlive(Number(pidMatch[1]))
        : nowMs - stat.mtimeMs >= LEGACY_SNAPSHOT_STALE_MS;
      if (!stale) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch {
      // Races and permission changes are safe to ignore; never broaden scope.
    }
  }
  return removed;
}

/**
 * Observe a schema transaction through two bounded windows. A transaction
 * that settles in the grace window returns its real result, so we never claim
 * rollback merely because the first deadline elapsed. If it remains pending,
 * throw an explicitly AMBIGUOUS error: callers must fail closed and must not
 * auto-retry because the original transaction may still commit.
 */
export async function awaitMigrationSettlement<T>(
  p: Promise<T>,
  ms: number,
  message: string,
  ambiguityGraceMs = MIGRATE_ONLY_AMBIGUITY_GRACE_MS,
): Promise<T> {
  type Observed =
    | { settled: true; ok: true; value: T }
    | { settled: true; ok: false; error: unknown }
    | { settled: false };

  const observed: Promise<Observed> = p.then(
    value => ({ settled: true, ok: true, value }),
    error => ({ settled: true, ok: false, error }),
  );
  const wait = async (durationMs: number): Promise<Observed> => {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return observed;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<Observed>(resolve => {
      timer = setTimeout(() => resolve({ settled: false }), durationMs);
    });
    try {
      return await Promise.race([observed, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const unwrap = (result: Exclude<Observed, { settled: false }>): T => {
    if (result.ok) return result.value;
    throw result.error;
  };

  const first = await wait(ms);
  if (first.settled) return unwrap(first);

  process.stderr.write(
    `[gbrain] ${message}; waiting ${Math.round(ambiguityGraceMs / 1000)}s for definitive transaction settlement\n`,
  );
  const final = await wait(ambiguityGraceMs);
  if (final.settled) return unwrap(final);

  throw new MigrateOnlyAmbiguousStateError(
    `${message}; transaction still has no definitive commit/rollback result after an additional ` +
    `${Math.round(ambiguityGraceMs / 1000)}s. Do not retry until database state is verified.`,
  );
}
