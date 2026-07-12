import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { hostname } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  LockOwnershipLostError,
  syncLockId,
  tryAcquireDbLock,
} from '../src/core/db-lock.ts';
import {
  assertSourceWriterLease,
  assertSourceWriterLeaseAtCommit,
  withSourceWriterLease,
} from '../src/core/source-writer-lease.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id LIKE 'gbrain-sync:p1-%'`);
});

describe('source writer fencing', () => {
  test('same PID on another host cannot refresh or release this acquisition', async () => {
    const lockId = syncLockId('p1-host');
    const handle = await tryAcquireDbLock(engine, lockId, 1);
    expect(handle).not.toBeNull();

    await engine.executeRaw(
      `UPDATE gbrain_cycle_locks
          SET holder_host = $1
        WHERE id = $2 AND holder_pid = $3`,
      [`${hostname()}-replacement`, lockId, process.pid],
    );

    await expect(handle!.refresh()).rejects.toBeInstanceOf(LockOwnershipLostError);
    await expect(handle!.release()).rejects.toBeInstanceOf(LockOwnershipLostError);
    const rows = await engine.executeRaw<{ holder_host: string }>(
      `SELECT holder_host FROM gbrain_cycle_locks WHERE id = $1`,
      [lockId],
    );
    expect(rows[0]?.holder_host).toBe(`${hostname()}-replacement`);
  });

  test('TTL takeover fences the stale acquisition even with the same PID and host', async () => {
    const lockId = syncLockId('p1-takeover');
    const stale = await tryAcquireDbLock(engine, lockId, 1);
    expect(stale).not.toBeNull();
    const before = await engine.executeRaw<{ holder_token: string }>(
      `SELECT holder_token FROM gbrain_cycle_locks WHERE id = $1`,
      [lockId],
    );

    await engine.executeRaw(
      `UPDATE gbrain_cycle_locks
          SET ttl_expires_at = NOW() - INTERVAL '2 hours',
              last_refreshed_at = NOW() - INTERVAL '2 hours'
        WHERE id = $1`,
      [lockId],
    );
    const successor = await tryAcquireDbLock(engine, lockId, 1);
    expect(successor).not.toBeNull();
    const after = await engine.executeRaw<{
      holder_pid: number;
      holder_host: string;
      holder_token: string;
    }>(
      `SELECT holder_pid, holder_host, holder_token
         FROM gbrain_cycle_locks WHERE id = $1`,
      [lockId],
    );
    expect(after[0]?.holder_pid).toBe(process.pid);
    expect(after[0]?.holder_host).toBe(hostname());
    expect(after[0]?.holder_token).not.toBe(before[0]?.holder_token);

    await expect(stale!.refresh()).rejects.toBeInstanceOf(LockOwnershipLostError);
    await expect(stale!.release()).rejects.toBeInstanceOf(LockOwnershipLostError);
    await expect(successor!.refresh()).resolves.toBeUndefined();
    await expect(successor!.release()).resolves.toBeUndefined();
  });

  test('failed exactly-one refresh aborts and invalidates the runtime source token', async () => {
    const sourceId = 'p1-loss';
    let callbackObservedInvalidation = false;
    const run = withSourceWriterLease(
      engine,
      sourceId,
      async lease => {
        await engine.executeRaw(
          `UPDATE gbrain_cycle_locks SET holder_token = 'successor-token'
            WHERE id = $1`,
          [syncLockId(sourceId)],
        );
        await new Promise(resolve => setTimeout(resolve, 40));
        expect(lease.signal.aborted).toBe(true);
        expect(() => assertSourceWriterLease(lease, engine, sourceId))
          .toThrow(/Invalid or inactive source writer lease/);
        callbackObservedInvalidation = true;
      },
      { _refreshIntervalMs: 5, heartbeatTimeoutMs: 100 },
    );

    await expect(run).rejects.toBeInstanceOf(LockOwnershipLostError);
    expect(callbackObservedInvalidation).toBe(true);
  });

  test('commit fence rejects a holder_token replaced immediately before assertion', async () => {
    const sourceId = 'p1-commit-boundary';
    let boundaryRejected = false;

    await expect(withSourceWriterLease(engine, sourceId, async lease => {
      await engine.executeRaw(
        `UPDATE gbrain_cycle_locks
            SET holder_token = 'reviewer-replacement-token'
          WHERE id = $1`,
        [syncLockId(sourceId)],
      );
      await engine.transaction(async tx => {
        await tx.setConfig('test.commit_fence', 'must-rollback');
        try {
          await assertSourceWriterLeaseAtCommit(lease, tx, sourceId);
        } catch (error) {
          boundaryRejected = error instanceof LockOwnershipLostError;
          throw error;
        }
      });
    })).rejects.toBeInstanceOf(LockOwnershipLostError);

    expect(boundaryRejected).toBe(true);
    expect(await engine.getConfig('test.commit_fence')).not.toBe('must-rollback');
  });

});
