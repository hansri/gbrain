import type { BrainEngine } from './engine.ts';
import {
  LockOwnershipLostError,
  syncLockId,
  withRefreshingLock,
  type DbLockOwner,
  type WithRefreshingLockOpts,
} from './db-lock.ts';

declare const sourceWriterLeaseBrand: unique symbol;

/**
 * Runtime-issued proof that one exact engine/source writer lock is active.
 * The private unique-symbol member prevents structural construction in typed
 * callers; the WeakMap check rejects `as any` forgeries and expired tokens.
 */
export interface SourceWriterLease {
  readonly sourceId: string;
  readonly lockId: string;
  /** Aborted immediately when refresh can no longer prove DB ownership. */
  readonly signal: AbortSignal;
  readonly [sourceWriterLeaseBrand]: true;
}

interface LeaseState {
  engine: BrainEngine;
  databaseIdentity: string | null;
  sourceId: string;
  lockId: string;
  owner: DbLockOwner;
  active: boolean;
}

const activeLeases = new WeakMap<object, LeaseState>();

export async function withSourceWriterLease<T>(
  engine: BrainEngine,
  sourceId: string,
  fn: (lease: SourceWriterLease) => Promise<T>,
  lockOpts: WithRefreshingLockOpts = {},
): Promise<T> {
  const lockId = syncLockId(sourceId);
  let issuedLease: SourceWriterLease | undefined;
  const databaseIdentity = resolveEngineIdentity(engine);
  return withRefreshingLock(
    engine,
    lockId,
    async (signal, handle) => {
      const lease = Object.freeze({ sourceId, lockId, signal }) as SourceWriterLease;
      issuedLease = lease;
      activeLeases.set(lease, {
        engine,
        databaseIdentity,
        sourceId,
        lockId,
        owner: handle.owner,
        active: true,
      });
      try {
        return await fn(lease);
      } finally {
        const state = activeLeases.get(lease);
        if (state) state.active = false;
        activeLeases.delete(lease);
      }
    },
    {
      ...lockOpts,
      onLockLost: error => {
        if (!issuedLease) return;
        const state = activeLeases.get(issuedLease);
        if (state) state.active = false;
        // Delete immediately so every subsequent assertion fails closed while
        // the callback unwinds. The AbortSignal gives cooperative callers the
        // same immediate stop signal.
        activeLeases.delete(issuedLease);
        try { lockOpts.onLockLost?.(error); } catch { /* observer only */ }
      },
    },
  );
}

function resolveEngineIdentity(engine: BrainEngine): string | null {
  try {
    return engine.getDatabaseIdentity?.() ?? null;
  } catch {
    return null;
  }
}

/** Fail closed for forged, expired, cross-engine, or cross-source tokens. */
export function assertSourceWriterLease(
  lease: SourceWriterLease,
  engine: BrainEngine,
  sourceId: string,
): void {
  const state = activeLeases.get(lease as object);
  const expectedLockId = syncLockId(sourceId);
  if (
    !state ||
    !state.active ||
    (state.engine !== engine && (
      state.databaseIdentity === null ||
      resolveEngineIdentity(engine) !== state.databaseIdentity
    )) ||
    state.sourceId !== sourceId ||
    state.lockId !== expectedLockId ||
    lease.sourceId !== sourceId ||
    lease.lockId !== expectedLockId ||
    lease.signal.aborted
  ) {
    throw new Error(
      `Invalid or inactive source writer lease for ${sourceId}; ` +
      `call through withSourceWriterLease instead of bypassing the writer lock`,
    );
  }
}

/**
 * Database-backed commit fence for a source-writer transaction.
 *
 * The in-memory assertion above rejects forged/expired runtime objects, but it
 * cannot prove that the database lock row still belongs to this acquisition.
 * This variant matches the exact `(id, pid, host, holder_token)` tuple and
 * takes a row lock. Call it on the transaction-scoped engine immediately
 * before the transaction callback returns: a prior takeover yields zero rows
 * and rolls the transaction back, while a later takeover must wait until this
 * transaction commits.
 */
export async function assertSourceWriterLeaseAtCommit(
  lease: SourceWriterLease,
  engine: BrainEngine,
  sourceId: string,
): Promise<void> {
  assertSourceWriterLease(lease, engine, sourceId);
  const state = activeLeases.get(lease as object);
  if (!state) {
    throw new LockOwnershipLostError(syncLockId(sourceId), 'runtime source lease is inactive');
  }
  const owner = state.owner;
  const rows = await engine.executeRaw<{ id: string }>(
    `SELECT id
       FROM gbrain_cycle_locks
      WHERE id = $1
        AND holder_pid = $2
        AND holder_host = $3
        AND holder_token = $4
      FOR UPDATE`,
    [owner.id, owner.pid, owner.host, owner.holderToken],
  );
  if (rows.length !== 1) {
    state.active = false;
    activeLeases.delete(lease as object);
    throw new LockOwnershipLostError(owner.id, 'commit fence matched zero rows');
  }
  // Catch a concurrent heartbeat failure that invalidated the runtime lease
  // while the database assertion was waiting for its row lock.
  assertSourceWriterLease(lease, engine, sourceId);
}
