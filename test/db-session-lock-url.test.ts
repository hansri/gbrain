import { describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import {
  isPublicSchemaAuthority,
  resolveDatabaseSessionLockUrl,
} from '../src/core/db.ts';
import { ConnectionManager } from '../src/core/connection-manager.ts';
import { withEnv } from './helpers/with-env.ts';

describe('database session-lock URL authority', () => {
  test('accepts ordinary direct Postgres', () => {
    const url = 'postgresql://user:secret@db.internal:5432/brain';
    expect(resolveDatabaseSessionLockUrl(url)).toBe(url);
  });

  test('fails closed on transaction/unknown poolers without a direct override', () => {
    for (const url of [
      'postgresql://user:secret@pgbouncer.internal:6543/brain',
      'postgresql://user:secret@pooler.internal:5432/brain',
    ]) {
      expect(() => resolveDatabaseSessionLockUrl(url)).toThrow('GBRAIN_DIRECT_DATABASE_URL');
    }
  });

  test('accepts an explicitly supplied direct or session-mode authority', () => {
    const pooled = 'postgresql://user:secret@pgbouncer.internal:6543/brain';
    const direct = 'postgresql://user:secret@postgres.internal:5432/brain';
    expect(resolveDatabaseSessionLockUrl(pooled, direct)).toBe(direct);
  });

  test('rejects an explicit override that is still pooler-shaped', () => {
    const pooled = 'postgresql://user:secret@pooler.internal:6543/brain';
    for (const override of [
      'postgresql://user:secret@pgbouncer.internal:5432/brain',
      'postgresql://user:secret@db.internal:6543/brain',
    ]) {
      expect(() => resolveDatabaseSessionLockUrl(pooled, override))
        .toThrow('transaction-pooler direct override');
    }
  });

  test('prepare=false alone does not misclassify a direct endpoint as a pooler', () => {
    const direct = 'postgresql://user:secret@db.internal:5432/brain?prepare=false';
    expect(resolveDatabaseSessionLockUrl(direct)).toBe(direct);
  });

  test('rejects a direct override that names a different database', () => {
    expect(() => resolveDatabaseSessionLockUrl(
      'postgresql://user:secret@pooler.internal:6543/brain_a',
      'postgresql://user:secret@db.internal:5432/brain_b',
    )).toThrow('different database');
  });

  test('never includes the credential-bearing URL in validation errors', () => {
    const pooled = 'postgresql://alice:supersecret@pooler.internal:5432/brain';
    let message = '';
    try { resolveDatabaseSessionLockUrl(pooled); }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).not.toContain('supersecret');
    expect(message).not.toContain('alice');
  });
});

describe('Postgres public schema authority', () => {
  test('accepts only an effective public-only path', () => {
    expect(isPublicSchemaAuthority('public', ['public'])).toBe(true);
    // postgres.js may return text[] either decoded or as a literal depending
    // on the connection's type configuration.
    expect(isPublicSchemaAuthority('public', '{public}')).toBe(true);
  });

  test('rejects shadow, reordered, missing, and ambiguous paths', () => {
    for (const [current, schemas] of [
      ['shadow', ['shadow', 'public']],
      ['public', ['public', 'shadow']],
      ['pg_catalog', ['pg_catalog', 'public']],
      ['public', ['public', 'pg_catalog']],
      ['public', []],
      [null, ['public']],
      ['public', '{"custom,schema",public}'],
    ] as const) {
      expect(isPublicSchemaAuthority(current, schemas)).toBe(false);
    }
  });
});

describe('ConnectionManager schema-only direct authority', () => {
  test('honors an explicit direct URL for a non-Supabase pooler without changing general DDL routing', async () => {
    const manager = new ConnectionManager({
      url: 'postgresql://user:secret@pgbouncer.internal:6432/brain',
      directUrl: 'postgresql://user:secret@postgres.internal:5432/brain',
    });
    const readMarker = {} as ReturnType<typeof postgres>;
    const directMarker = {} as ReturnType<typeof postgres>;
    const internals = manager as unknown as {
      getReadPool: () => Promise<ReturnType<typeof postgres>>;
      getDirectPool: () => Promise<ReturnType<typeof postgres>>;
    };
    internals.getReadPool = async () => readMarker;
    internals.getDirectPool = async () => directMarker;

    expect(manager.isDualPoolActive()).toBe(false);
    expect(await manager.ddl()).toBe(readMarker);
    expect(await manager.bulk()).toBe(readMarker);
    expect(await manager.schemaDdl()).toBe(directMarker);
  });

  test('fails closed when the general direct-pool kill switch would route schema DDL through a pooler', async () => {
    await withEnv({ GBRAIN_DISABLE_DIRECT_POOL: '1' }, async () => {
      const manager = new ConnectionManager({
        url: 'postgresql://user:secret@pgbouncer.internal:6432/brain',
        directUrl: 'postgresql://user:secret@postgres.internal:5432/brain',
      });
      await expect(manager.schemaDdl()).rejects.toThrow('GBRAIN_DISABLE_DIRECT_POOL');
    });
  });

  test('preserves the kill switch on an already-direct primary route', async () => {
    await withEnv({ GBRAIN_DISABLE_DIRECT_POOL: '1' }, async () => {
      const manager = new ConnectionManager({
        url: 'postgresql://user:secret@postgres-primary.internal:5432/brain',
        directUrl: 'postgresql://user:secret@postgres-secondary.internal:5432/brain',
      });
      const readMarker = {} as ReturnType<typeof postgres>;
      const internals = manager as unknown as {
        getReadPool: () => Promise<ReturnType<typeof postgres>>;
        getDirectPool: () => Promise<ReturnType<typeof postgres>>;
      };
      internals.getReadPool = async () => readMarker;
      internals.getDirectPool = async () => {
        throw new Error('direct pool must remain disabled');
      };
      expect(await manager.schemaDdl()).toBe(readMarker);
    });
  });
});
