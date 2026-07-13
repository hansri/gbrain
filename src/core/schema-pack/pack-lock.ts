// v0.40.6.0 Schema Cathedral v3 — per-pack directory lock primitive.
//
// `withPackLock(packName, opts, fn)` serializes concurrent mutations of the
// same pack across processes. The lock name remains
// `~/.gbrain/schema-packs/.locks/<packName>.lock`, but that path is now a
// directory containing one immutable, uniquely named owner sentinel:
//
//   <packName>.lock/owner-<uuid>.json
//
// Why a directory + unique sentinel instead of the former JSON lock file:
//   - `mkdir` is the atomic acquisition boundary.
//   - Release/recovery first unlinks the exact owner's unique sentinel and may
//     remove the directory only if that unlink succeeded. A delayed release
//     therefore cannot delete a replacement owner.
//   - A provably dead holder may be recovered. A live holder is never stolen,
//     even when its TTL has elapsed or `force` is supplied. PID reuse therefore
//     fails closed instead of permitting two live callbacks.
//   - Empty/publishing, malformed, symlink, and legacy file locks fail closed.
//     They are diagnosed separately, but are never removed via an unsafe
//     inspect-then-unlink sequence.
//
// Nested `withPackLock` calls reuse ownership only inside the descendant async
// context that acquired it. Unrelated top-level work in the same process still
// contends normally and receives LOCK_BUSY.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gbrainPath } from '../config.ts';

export const DEFAULT_LOCK_TTL_MS = 60_000;
export const REFRESH_INTERVAL_MS = 10_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 0; // reserved; acquisition is fail-fast
/** Grace used to distinguish a just-created directory from abandoned state. */
export const LOCK_PUBLISH_GRACE_MS = 1_000;

/** `forced` is retained in the public type for source compatibility only. */
export type LockOutcome = 'acquired' | 'stolen_stale' | 'forced';

export interface PackLockOpts {
  /** Holder freshness/diagnostic TTL. It never overrides a live PID. */
  ttlMs?: number;
  /** Request stale recovery. A live holder is never stolen. */
  force?: boolean;
  /** Override the lock directory for tests. */
  lockDir?: string;
  /** Inject a clock for tests (ms since epoch). */
  now?: () => number;
  /** Inject a PID-liveness probe for tests. */
  isPidAlive?: (pid: number) => boolean;
}

export interface LockFileRecord {
  /** Per-acquisition owner/fencing token. Required by the directory protocol. */
  owner?: string;
  pid: number;
  hostname: string;
  /** Last refresh timestamp (ms since epoch). */
  ts: number;
  /** Holder's declared diagnostic TTL in ms. */
  ttlMs: number;
}

export class PackLockBusyError extends Error {
  readonly code = 'LOCK_BUSY' as const;
  readonly heldBy: number;
  readonly ageMs: number;
  readonly ttlMs: number;
  constructor(message: string, opts: { heldBy: number; ageMs: number; ttlMs: number }) {
    super(message);
    this.name = 'PackLockBusyError';
    this.heldBy = opts.heldBy;
    this.ageMs = opts.ageMs;
    this.ttlMs = opts.ttlMs;
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function resolveLockPath(packName: string, lockDir?: string): string {
  const dir = lockDir ?? gbrainPath('schema-packs', '.locks');
  const canonicalDir = resolve(dir);
  if (
    packName.length === 0 ||
    packName.includes('/') ||
    packName.includes('\\') ||
    packName.includes('\0') ||
    packName === '.' ||
    packName === '..'
  ) {
    throw new Error(`invalid pack lock name: ${JSON.stringify(packName)}`);
  }
  const candidate = resolve(join(canonicalDir, `${packName}.lock`));
  if (dirname(candidate) !== canonicalDir) {
    throw new Error(`pack lock path escapes lock directory: ${JSON.stringify(packName)}`);
  }
  return candidate;
}

function ownerSentinelName(owner: string): string {
  return `owner-${owner}.json`;
}

function ownerSentinelPath(lockPath: string, owner: string): string {
  return join(lockPath, ownerSentinelName(owner));
}

function parseLockRecord(raw: string): LockFileRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LockFileRecord>;
    if (
      typeof parsed.owner === 'string' && parsed.owner.length > 0 &&
      typeof parsed.pid === 'number' && Number.isSafeInteger(parsed.pid) && parsed.pid > 0 &&
      typeof parsed.ts === 'number' && Number.isFinite(parsed.ts) &&
      typeof parsed.ttlMs === 'number' && Number.isFinite(parsed.ttlMs) && parsed.ttlMs > 0 &&
      typeof parsed.hostname === 'string'
    ) {
      return parsed as LockFileRecord;
    }
    return null;
  } catch {
    return null;
  }
}

type LockPathSnapshot =
  | { kind: 'missing' }
  | { kind: 'legacy_file'; mtimeMs: number; record: LockFileRecord | null }
  | { kind: 'empty_directory'; mtimeMs: number }
  | { kind: 'invalid_directory'; mtimeMs: number }
  | { kind: 'owned_directory'; mtimeMs: number; record: LockFileRecord; ownerPath: string };

function inspectLockPath(lockPath: string): LockPathSnapshot {
  let rootStats: ReturnType<typeof lstatSync>;
  try {
    rootStats = lstatSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw err;
  }

  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    let record: LockFileRecord | null = null;
    if (rootStats.isFile()) {
      try { record = parseLockRecord(readFileSync(lockPath, 'utf-8')); } catch { /* fail closed */ }
    }
    return { kind: 'legacy_file', mtimeMs: rootStats.mtimeMs, record };
  }

  let entries: string[];
  try {
    entries = readdirSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw err;
  }
  if (entries.length === 0) return { kind: 'empty_directory', mtimeMs: rootStats.mtimeMs };
  if (entries.length !== 1) return { kind: 'invalid_directory', mtimeMs: rootStats.mtimeMs };

  const match = /^owner-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i.exec(entries[0]!);
  if (!match) return { kind: 'invalid_directory', mtimeMs: rootStats.mtimeMs };
  const ownerPath = join(lockPath, entries[0]!);
  try {
    const ownerStats = lstatSync(ownerPath);
    if (!ownerStats.isFile() || ownerStats.isSymbolicLink()) {
      return { kind: 'invalid_directory', mtimeMs: rootStats.mtimeMs };
    }
    const record = parseLockRecord(readFileSync(ownerPath, 'utf-8'));
    if (!record || record.owner !== match[1]) {
      return { kind: 'invalid_directory', mtimeMs: rootStats.mtimeMs };
    }
    return { kind: 'owned_directory', mtimeMs: rootStats.mtimeMs, record, ownerPath };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return inspectLockPath(lockPath);
    throw err;
  }
}

function fsyncDirectory(path: string): void {
  try {
    const fd = openSync(path, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch {
    // Some filesystems/platforms do not support directory fsync.
  }
}

function atomicAcquireDirectory(lockPath: string): boolean {
  try {
    mkdirSync(lockPath, { mode: 0o700 });
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
      try {
        mkdirSync(lockPath, { mode: 0o700 });
        return true;
      } catch (retryErr) {
        if ((retryErr as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw retryErr;
      }
    }
    if (code === 'EEXIST') return false;
    throw err;
  }
}

function publishOwner(lockPath: string, record: LockFileRecord): void {
  const owner = record.owner!;
  const ownerPath = ownerSentinelPath(lockPath, owner);
  const fd = openSync(ownerPath, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(record), 'utf-8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(lockPath);
  fsyncDirectory(dirname(lockPath));
}

/**
 * Remove only `owner`'s directory generation. The unique sentinel unlink is
 * the ownership claim: if it is missing, this function never calls rmdir and
 * therefore cannot remove a replacement generation.
 */
function removeOwnedDirectory(lockPath: string, owner: string): boolean {
  const ownerPath = ownerSentinelPath(lockPath, owner);
  try {
    unlinkSync(ownerPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }

  try {
    rmdirSync(lockPath);
    fsyncDirectory(dirname(lockPath));
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return true;
    // ENOTEMPTY means another/unknown sentinel appeared. Never remove it.
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * A live PID always owns the lock, even beyond TTL. TTL now classifies a dead
 * holder for diagnostics; it is never sufficient by itself to steal.
 */
export function isLockStale(
  record: LockFileRecord,
  now: number,
  isPidAlive: (pid: number) => boolean,
): { stale: boolean; reason: 'ttl_expired' | 'pid_dead' | 'live' } {
  if (isPidAlive(record.pid)) return { stale: false, reason: 'live' };
  return {
    stale: true,
    reason: now - record.ts > record.ttlMs ? 'ttl_expired' : 'pid_dead',
  };
}

/**
 * Acquire the lock or throw `PackLockBusyError`. `force` is deliberately not a
 * live-lock bypass: only a valid owner record whose PID is confirmed dead may
 * be recovered automatically.
 */
export function acquirePackLock(
  packName: string,
  opts: PackLockOpts = {},
): { lockPath: string; outcome: LockOutcome; record: LockFileRecord } {
  const ttlMs = opts.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  const now = opts.now ?? Date.now;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const lockPath = resolveLockPath(packName, opts.lockDir);
  let nextOutcome: LockOutcome = 'acquired';

  for (let attempt = 0; attempt < 8; attempt++) {
    if (atomicAcquireDirectory(lockPath)) {
      const record: LockFileRecord = {
        owner: randomUUID(),
        pid: process.pid,
        hostname: process.env.HOSTNAME ?? 'unknown',
        ts: now(),
        ttlMs,
      };
      try {
        publishOwner(lockPath, record);
      } catch (err) {
        // We created the directory and no conforming contender can enter it.
        // Clean up only our unique sentinel (if published), then the empty dir.
        if (!removeOwnedDirectory(lockPath, record.owner!)) {
          try { rmdirSync(lockPath); } catch { /* leave ambiguous state fail-closed */ }
        }
        throw err;
      }
      return { lockPath, outcome: nextOutcome, record };
    }

    const snapshot = inspectLockPath(lockPath);
    if (snapshot.kind === 'missing') continue;
    const observedNow = now();

    if (snapshot.kind === 'legacy_file') {
      const ageMs = Math.max(0, observedNow - snapshot.mtimeMs);
      throw new PackLockBusyError(
        `pack ${packName} has a legacy/unsupported lock file; refusing unsafe automatic removal (manual recovery requires first verifying no old holder is running)`,
        {
          heldBy: snapshot.record?.pid ?? -1,
          ageMs,
          ttlMs: snapshot.record?.ttlMs ?? ttlMs,
        },
      );
    }

    if (snapshot.kind === 'empty_directory') {
      const ageMs = Math.max(0, observedNow - snapshot.mtimeMs);
      const publishing = ageMs <= LOCK_PUBLISH_GRACE_MS;
      throw new PackLockBusyError(
        publishing
          ? `pack ${packName} lock owner is still being published (${Math.round(ageMs)}ms old)`
          : `pack ${packName} lock has no owner sentinel; refusing unsafe automatic recovery`,
        { heldBy: -1, ageMs, ttlMs: LOCK_PUBLISH_GRACE_MS },
      );
    }

    if (snapshot.kind === 'invalid_directory') {
      const ageMs = Math.max(0, observedNow - snapshot.mtimeMs);
      throw new PackLockBusyError(
        `pack ${packName} lock has malformed or multiple owner sentinels; refusing unsafe automatic recovery`,
        { heldBy: -1, ageMs, ttlMs },
      );
    }

    const staleness = isLockStale(snapshot.record, observedNow, isPidAlive);
    if (staleness.stale) {
      if (!removeOwnedDirectory(lockPath, snapshot.record.owner!)) continue;
      nextOutcome = 'stolen_stale';
      continue;
    }

    const ageMs = Math.max(0, observedNow - snapshot.record.ts);
    throw new PackLockBusyError(
      `pack ${packName} is locked by live pid=${snapshot.record.pid} (held ${Math.round(ageMs / 1000)}s, ttl=${Math.round(snapshot.record.ttlMs / 1000)}s; force cannot steal a live holder)`,
      { heldBy: snapshot.record.pid, ageMs, ttlMs: snapshot.record.ttlMs },
    );
  }

  const current = inspectLockPath(lockPath);
  const record = current.kind === 'owned_directory' ? current.record : null;
  throw new PackLockBusyError(
    `pack ${packName} lock changed repeatedly during acquisition`,
    {
      heldBy: record?.pid ?? -1,
      ageMs: record ? Math.max(0, now() - record.ts) : 0,
      ttlMs: record?.ttlMs ?? ttlMs,
    },
  );
}

function refreshLock(lockPath: string, record: LockFileRecord, now: number): boolean {
  if (!record.owner) return false;
  const path = ownerSentinelPath(lockPath, record.owner);
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r+');
    const current = parseLockRecord(readFileSync(fd, 'utf-8'));
    if (current?.owner !== record.owner) return false;
    const next: LockFileRecord = { ...record, ts: now };
    const bytes = Buffer.from(JSON.stringify(next), 'utf-8');
    writeSync(fd, bytes, 0, bytes.length, 0);
    ftruncateSync(fd, bytes.length);
    fsyncSync(fd);
    // A replacement directory cannot contain this cryptographically unique
    // sentinel name, so successful re-read is an owner fence.
    return parseLockRecord(readFileSync(path, 'utf-8'))?.owner === record.owner;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function releasePackLock(lockPath: string, owner: string | undefined): void {
  if (!owner) return;
  try {
    removeOwnedDirectory(lockPath, owner);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`[pack-lock] release failed for ${lockPath}: ${(err as Error).message}\n`);
    }
  }
}

/** Opaque, owner-aware handle. Callers cannot release by pathname. */
export interface HeldPackLock {
  /** Refresh immediately. Returns false once ownership has been lost. */
  refresh(): boolean;
  /** Idempotently release this exact owner generation. */
  release(): void;
}

/** Acquire a long-lived lock handle for callers whose control flow has returns. */
export function holdPackLock(packName: string, opts: PackLockOpts = {}): HeldPackLock {
  const acquired = acquirePackLock(packName, opts);
  const now = opts.now ?? Date.now;
  let currentRecord = acquired.record;
  let released = false;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  const held: HeldPackLock = {
    refresh(): boolean {
      if (released) return false;
      const refreshedAt = now();
      const ok = refreshLock(acquired.lockPath, currentRecord, refreshedAt);
      if (ok) currentRecord = { ...currentRecord, ts: refreshedAt };
      return ok;
    },
    release(): void {
      if (released) return;
      released = true;
      if (refreshTimer) clearInterval(refreshTimer);
      releasePackLock(acquired.lockPath, currentRecord.owner);
    },
  };
  refreshTimer = setInterval(() => {
    if (!held.refresh() && refreshTimer) clearInterval(refreshTimer);
  }, REFRESH_INTERVAL_MS);
  if (typeof (refreshTimer as NodeJS.Timeout).unref === 'function') refreshTimer.unref();
  return held;
}

interface ContextLock {
  held: HeldPackLock;
  refs: number;
  active: boolean;
}

const packLockContext = new AsyncLocalStorage<Map<string, ContextLock>>();

function releaseContextRef(entry: ContextLock): void {
  entry.refs -= 1;
  if (entry.refs === 0) {
    entry.active = false;
    entry.held.release();
  }
}

/**
 * Run `fn()` with exclusive access to `packName`. Descendant async calls for
 * the same canonical lock path reuse the exact owner and increment a refcount;
 * unrelated top-level calls never inherit that authority.
 */
export async function withPackLock<T>(
  packName: string,
  opts: PackLockOpts,
  fn: () => Promise<T> | T,
): Promise<T> {
  const canonicalPath = resolveLockPath(packName, opts.lockDir);
  const inherited = packLockContext.getStore();
  const existing = inherited?.get(canonicalPath);
  if (existing?.active) {
    existing.refs += 1;
    try {
      return await fn();
    } finally {
      releaseContextRef(existing);
    }
  }

  const entry: ContextLock = { held: holdPackLock(packName, opts), refs: 1, active: true };
  const context = new Map(inherited ?? []);
  context.set(canonicalPath, entry);
  try {
    return await packLockContext.run(context, async () => await fn());
  } finally {
    releaseContextRef(entry);
  }
}
