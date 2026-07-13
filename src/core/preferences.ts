/**
 * ~/.gbrain/preferences.json — user-facing agent-behavior flags (minion_mode, etc.).
 *
 * Separate from src/core/config.ts (engine config), written to its own file so
 * engine config and agent preferences can evolve independently. Atomic writes
 * via mktemp + rename; 0o600 perms; forward-compatible (preserves unknown keys).
 *
 * Also houses the ~/.gbrain/migrations/completed.jsonl ledger helpers.
 */

import { join } from 'path';
import { configDir } from './config.ts';
import {
  readOwnedStateFile,
  writeOwnedStateFileAtomic,
} from './owned-state-file.ts';
import {
  holdPackLock,
  PackLockBusyError,
  type HeldPackLock,
} from './schema-pack/pack-lock.ts';

const MAX_PREFERENCES_BYTES = 1 * 1024 * 1024;
const MAX_MIGRATION_LEDGER_BYTES = 16 * 1024 * 1024;
const MIGRATION_LEDGER_LOCK_WAIT_MS = 30_000;
const MIGRATION_LEDGER_LOCK_NAME = 'migration-ledger-write';
const ledgerWaitCell = new Int32Array(new SharedArrayBuffer(4));
let activeLedgerLock: { handle: HeldPackLock; depth: number } | null = null;

/**
 * Use the same canonical directory resolver as config and every other GBrain
 * state file. GBRAIN_HOME is a parent directory, so GBRAIN_HOME=/tmp/x means
 * /tmp/x/.gbrain/preferences.json and /tmp/x/.gbrain/migrations/....
 */
function gbrainDir(): string {
  return configDir();
}

export type MinionMode = 'always' | 'pain_triggered' | 'off';

export interface Preferences {
  minion_mode?: MinionMode;
  set_at?: string;
  set_in_version?: string;
  [key: string]: unknown;
}

export interface CompletedMigrationEntry {
  version: string;
  /** Credential-free database identity; migration completion is per brain. */
  brain_id?: string;
  ts?: string;
  /**
   * - `complete`  — orchestrator finished cleanly. Terminal state; future
   *   runs no-op this version unless `retry` is appended.
   * - `partial`   — orchestrator ran but reported missed phases; re-run is
   *   expected. Attempt cap (3 consecutive partials without a `complete`
   *   or `retry` between them) triggers the "wedged" skip in the runner.
   * - `retry`     — explicit reset marker written by `--force-retry`.
   *   Clears a wedge without faking success; the next upgrade treats the
   *   version as fresh again.
   */
  status: 'complete' | 'partial' | 'retry';
  /**
   * The transaction exceeded both observation windows and may still commit or
   * roll back. Stored on legacy-compatible `partial` rows so an older binary
   * sees a three-partial wedge instead of treating an unknown status as pending.
   */
  ambiguous_state?: boolean;
  ambiguity_fence_part?: number;
  /** Write-ahead fence published before an orchestrator can mutate state. */
  inflight_state?: boolean;
  /** UUID linking the write-ahead fence to its exact terminal receipt. */
  attempt_id?: string;
  /** True only after the runner durably observed a terminal outcome. */
  attempt_terminal?: boolean;
  mode?: MinionMode;
  files_rewritten?: number;
  autopilot_installed?: boolean;
  install_target?: string;
  apply_migrations_pending?: boolean;
  phases?: Array<{ name: string; status: string; detail?: string }>;
  [key: string]: unknown;
}

const VALID_MODES: ReadonlyArray<MinionMode> = ['always', 'pain_triggered', 'off'];
const SAFE_MIGRATION_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SAFE_BRAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,255}$/;

// Route preferences + migration ledger paths through configDir() so they use
// the exact same HOME/GBRAIN_HOME convention as config.json.
function prefsDir(): string { return gbrainDir(); }
function prefsPath(): string { return join(prefsDir(), 'preferences.json'); }
function migrationsDir(): string { return join(gbrainDir(), 'migrations'); }
function completedJsonlPath(): string { return join(migrationsDir(), 'completed.jsonl'); }

function acquireMigrationLedgerLock(): HeldPackLock {
  const deadline = Date.now() + MIGRATION_LEDGER_LOCK_WAIT_MS;
  while (true) {
    try {
      return holdPackLock(MIGRATION_LEDGER_LOCK_NAME, {
        lockDir: join(gbrainDir(), 'locks'),
        ttlMs: MIGRATION_LEDGER_LOCK_WAIT_MS,
      });
    } catch (error) {
      if (!(error instanceof PackLockBusyError)) throw error;
      const transient = error.heldBy > 0
        || error.message.includes('still being published')
        || error.message.includes('changed repeatedly');
      if (!transient || Date.now() >= deadline) {
        throw new Error(
          `Migration ledger is busy or unsafe to update: ${error.message}`,
          { cause: error },
        );
      }
      Atomics.wait(ledgerWaitCell, 0, 0, Math.min(25, deadline - Date.now()));
    }
  }
}

/** Serialize every ledger read-modify-replace and legacy adoption per home. */
export function withMigrationLedgerLock<T>(fn: () => T): T {
  if (activeLedgerLock) {
    activeLedgerLock.depth += 1;
    try { return fn(); }
    finally { activeLedgerLock.depth -= 1; }
  }
  const handle = acquireMigrationLedgerLock();
  activeLedgerLock = { handle, depth: 1 };
  try {
    return fn();
  } finally {
    const held = activeLedgerLock;
    activeLedgerLock = null;
    held?.handle.release();
  }
}

function isMissingStateFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

export class MigrationLedgerCorruptionError extends Error {
  constructor(public readonly lineNumber: number, detail: string) {
    super(`Migration ledger is corrupt at line ${lineNumber}: ${detail}`);
    this.name = 'MigrationLedgerCorruptionError';
  }
}

/** Validate that a value is a recognized minion mode. Throws with the allowed list. */
export function validateMinionMode(value: unknown): asserts value is MinionMode {
  if (typeof value !== 'string' || !VALID_MODES.includes(value as MinionMode)) {
    throw new Error(`Invalid minion_mode "${String(value)}". Allowed: ${VALID_MODES.join(', ')}.`);
  }
}

/**
 * Load preferences. Returns {} when the file is missing (not null — callers
 * can always treat the result as a Preferences object).
 *
 * Malformed JSON throws; caller can catch if they want graceful fallback.
 */
export function loadPreferences(): Preferences {
  const path = prefsPath();
  let raw: string;
  try {
    raw = readOwnedStateFile(path, MAX_PREFERENCES_BYTES, gbrainDir());
  } catch (error) {
    if (isMissingStateFile(error)) return {};
    throw error;
  }
  const parsed = JSON.parse(raw) as Preferences;
  return parsed;
}

/**
 * Save preferences atomically (mktemp on same filesystem + rename). Preserves
 * any unknown keys passed in. Chmods 0o600 after write.
 */
export function savePreferences(prefs: Preferences): void {
  if (prefs.minion_mode !== undefined) validateMinionMode(prefs.minion_mode);
  writeOwnedStateFileAtomic(
    prefsPath(),
    JSON.stringify(prefs, null, 2) + '\n',
    MAX_PREFERENCES_BYTES,
    gbrainDir(),
  );
}

/**
 * Append one line to ~/.gbrain/migrations/completed.jsonl. Creates the
 * directory if missing. Complete writes read the existing ledger only for the
 * per-brain duplicate-complete guard; other statuses remain append-only.
 *
 * Writes `ts` as the current ISO timestamp if not provided.
 */
export function appendCompletedMigration(entry: CompletedMigrationEntry): void {
  if (typeof entry.version !== 'string' || !SAFE_MIGRATION_VERSION.test(entry.version)) {
    throw new Error('appendCompletedMigration: version must be a safe semver-like token of at most 64 characters');
  }
  if (entry.brain_id !== undefined
    && (typeof entry.brain_id !== 'string' || !SAFE_BRAIN_ID.test(entry.brain_id))) {
    throw new Error('appendCompletedMigration: brain_id must be a credential-free safe token of at most 256 characters');
  }
  if (entry.status !== 'complete' && entry.status !== 'partial' && entry.status !== 'retry') {
    throw new Error(`appendCompletedMigration: status must be 'complete', 'partial', or 'retry', got "${entry.status}"`);
  }
  const full = parseMigrationLedgerEntry({
    ts: new Date().toISOString(),
    ...entry,
  }, 1);
  // Migration receipts can include database identity and operational details.
  // Do not let the process umask make either the directory or ledger readable
  // by other local users. chmod also tightens permissions on installs created
  // by older versions before this invariant existed.
  withMigrationLedgerLock(() => {
    // Keep the duplicate-complete check in the same critical section as the
    // replacement write so two brains/processes cannot race this decision.
    if (entry.status === 'complete') {
      const prior = loadCompletedMigrations().filter(e =>
        e.version === entry.version && e.brain_id === entry.brain_id,
      );
      if (prior.at(-1)?.status === 'complete') return;
    }
    appendMigrationEntriesAtomicallyUnlocked([full]);
  });
}

/**
 * Persist an ambiguity as three `partial` receipts. Current binaries inspect
 * `ambiguous_state`; pre-upgrade binaries ignore the extra field but their
 * existing three-consecutive-partials guard still wedges the migration. This
 * compatibility fence stops an older runner from advancing past a transaction
 * that may commit late. It does not make binary-only rollback safe: recovery
 * from unresolved migration state requires the matching database and state-file
 * backup.
 */
export function appendAmbiguousMigration(
  entry: Omit<CompletedMigrationEntry, 'status' | 'ambiguous_state' | 'ambiguity_fence_part'> & { version: string },
): void {
  if (typeof entry.version !== 'string' || !SAFE_MIGRATION_VERSION.test(entry.version)) {
    throw new Error('appendAmbiguousMigration: version must be a safe semver-like token of at most 64 characters');
  }
  if (entry.brain_id !== undefined
    && (typeof entry.brain_id !== 'string' || !SAFE_BRAIN_ID.test(entry.brain_id))) {
    throw new Error('appendAmbiguousMigration: brain_id must be a credential-free safe token of at most 256 characters');
  }
  const entries: CompletedMigrationEntry[] = [];
  for (let part = 1; part <= 3; part++) {
    entries.push(parseMigrationLedgerEntry({
      ts: new Date().toISOString(),
      ...entry,
      version: entry.version,
      status: 'partial',
      ambiguous_state: true,
      ambiguity_fence_part: part,
    } satisfies CompletedMigrationEntry, part));
  }
  // Replace the whole ledger atomically so a crash exposes either the prior
  // image or every fence row, never a torn 0/1/2-row compatibility record.
  appendMigrationEntriesAtomically(entries);
}

/**
 * Persist an older-runner-visible write-ahead fence before an orchestrator.
 * Three partial rows keep the immediately previous runner wedged after a crash;
 * current runners additionally require a matching attempt_terminal receipt.
 * The rows prevent unsafe forward progress; they are not a replacement for a
 * matched database and state-file backup.
 */
export function appendInflightMigration(
  entry: Omit<CompletedMigrationEntry, 'status' | 'inflight_state' | 'ambiguity_fence_part'>
    & { version: string; attempt_id: string },
): void {
  if (typeof entry.version !== 'string' || !SAFE_MIGRATION_VERSION.test(entry.version)) {
    throw new Error('appendInflightMigration: version must be a safe semver-like token of at most 64 characters');
  }
  if (entry.brain_id !== undefined
    && (typeof entry.brain_id !== 'string' || !SAFE_BRAIN_ID.test(entry.brain_id))) {
    throw new Error('appendInflightMigration: brain_id must be a credential-free safe token of at most 256 characters');
  }
  if (!/^[0-9a-f-]{36}$/i.test(entry.attempt_id)) {
    throw new Error('appendInflightMigration: attempt_id must be a UUID');
  }
  const entries: CompletedMigrationEntry[] = [];
  for (let part = 1; part <= 3; part++) {
    entries.push(parseMigrationLedgerEntry({
      ts: new Date().toISOString(),
      ...entry,
      version: entry.version,
      status: 'partial',
      inflight_state: true,
      ambiguity_fence_part: part,
    } satisfies CompletedMigrationEntry, part));
  }
  appendMigrationEntriesAtomically(entries);
}

function parseMigrationLedgerEntry(value: unknown, lineNumber: number): CompletedMigrationEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MigrationLedgerCorruptionError(lineNumber, 'expected a JSON object');
  }
  const entry = value as Partial<CompletedMigrationEntry>;
  if (typeof entry.version !== 'string' || !SAFE_MIGRATION_VERSION.test(entry.version)) {
    throw new MigrationLedgerCorruptionError(
      lineNumber,
      'version must be a safe semver-like token of at most 64 characters',
    );
  }
  if (entry.status !== 'complete' && entry.status !== 'partial' && entry.status !== 'retry') {
    throw new MigrationLedgerCorruptionError(lineNumber, 'status is not complete, partial, or retry');
  }
  if (entry.brain_id !== undefined && (typeof entry.brain_id !== 'string'
    || !SAFE_BRAIN_ID.test(entry.brain_id))) {
    throw new MigrationLedgerCorruptionError(
      lineNumber,
      'brain_id must be a credential-free safe token of at most 256 characters',
    );
  }
  if (entry.attempt_id !== undefined && !/^[0-9a-f-]{36}$/i.test(entry.attempt_id)) {
    throw new MigrationLedgerCorruptionError(lineNumber, 'attempt_id must be a UUID');
  }
  if (entry.inflight_state !== undefined && typeof entry.inflight_state !== 'boolean') {
    throw new MigrationLedgerCorruptionError(lineNumber, 'inflight_state must be boolean');
  }
  if (entry.attempt_terminal !== undefined && typeof entry.attempt_terminal !== 'boolean') {
    throw new MigrationLedgerCorruptionError(lineNumber, 'attempt_terminal must be boolean');
  }
  return entry as CompletedMigrationEntry;
}

/**
 * Read the completed.jsonl file. Any non-empty malformed/torn record is a
 * hard error: silently skipping a receipt can make an unresolved migration
 * appear complete and let later schema mutations cross a safety fence.
 */
export function parseCompletedMigrationsText(raw: string): CompletedMigrationEntry[] {
  const out: CompletedMigrationEntry[] = [];
  const lines = raw.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      // A single empty final element is the normal result of a JSONL file
      // ending in '\n'. Empty records anywhere else are corruption.
      if (index === lines.length - 1) continue;
      throw new MigrationLedgerCorruptionError(index + 1, 'empty record before end of file');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new MigrationLedgerCorruptionError(index + 1, 'invalid or torn JSON');
    }
    out.push(parseMigrationLedgerEntry(parsed, index + 1));
  }
  return out;
}

export function loadCompletedMigrations(): CompletedMigrationEntry[] {
  const path = completedJsonlPath();
  let raw: string;
  try {
    raw = readOwnedStateFile(path, MAX_MIGRATION_LEDGER_BYTES, gbrainDir());
  } catch (error) {
    if (isMissingStateFile(error)) return [];
    throw error;
  }
  return parseCompletedMigrationsText(raw);
}

/**
 * Append a validated batch by atomically replacing the complete ledger image.
 * Runtime callers hold the migration single-flight lock, so this provides
 * crash atomicity without introducing a second append authority.
 */
export function appendMigrationEntriesAtomically(entries: CompletedMigrationEntry[]): void {
  if (entries.length === 0) return;
  const validated = entries.map((entry, index) =>
    parseMigrationLedgerEntry(entry, index + 1));
  withMigrationLedgerLock(() => appendMigrationEntriesAtomicallyUnlocked(validated));
}

function appendMigrationEntriesAtomicallyUnlocked(entries: CompletedMigrationEntry[]): void {
  const current = loadCompletedMigrations();
  const body = [...current, ...entries].map(entry => JSON.stringify(entry)).join('\n') + '\n';
  writeOwnedStateFileAtomic(
    completedJsonlPath(),
    body,
    MAX_MIGRATION_LEDGER_BYTES,
    gbrainDir(),
  );
}

/** Paths — exported for tests and rare consumers. */
export const preferencesPaths = {
  dir: prefsDir,
  file: prefsPath,
  migrationsDir,
  completedJsonl: completedJsonlPath,
};
