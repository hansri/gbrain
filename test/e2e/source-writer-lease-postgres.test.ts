import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import {
  LockOwnershipLostError,
  syncLockId,
} from '../../src/core/db-lock.ts';
import {
  assertSourceWriterLeaseAtCommit,
  withSourceWriterLease,
} from '../../src/core/source-writer-lease.ts';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('Postgres source-writer commit fencing', () => {
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    await engine?.disconnect();
  });

  test('exact DB owner replacement fails before the fenced transaction commits', async () => {
    const sourceId = `e2e-lease-${Date.now()}`;
    const configKey = `test.${sourceId}`;
    let rejectedAtBoundary = false;

    await expect(withSourceWriterLease(engine, sourceId, async lease => {
      await engine.executeRaw(
        `UPDATE gbrain_cycle_locks
            SET holder_token = 'postgres-reviewer-replacement'
          WHERE id = $1`,
        [syncLockId(sourceId)],
      );
      await engine.transaction(async tx => {
        await tx.setConfig(configKey, 'must-rollback');
        try {
          await assertSourceWriterLeaseAtCommit(lease, tx, sourceId);
        } catch (error) {
          rejectedAtBoundary = error instanceof LockOwnershipLostError;
          throw error;
        }
      });
    })).rejects.toBeInstanceOf(LockOwnershipLostError);

    expect(rejectedAtBoundary).toBe(true);
    expect(await engine.getConfig(configKey)).not.toBe('must-rollback');
    await engine.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id = $1`, [syncLockId(sourceId)]);
  });
});
