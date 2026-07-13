import { describe, expect, test } from 'bun:test';
import {
  getPostgresTestUrl,
  POSTGRES_TEST_DATABASE,
  requirePostgresTestUrl,
} from './helpers/postgres-test-authority.ts';

const SAFE_URL = 'postgresql://test-user:super-secret@db.internal:5432/gbrain_test';

describe('Postgres E2E authority guard', () => {
  test('treats an absent URL as an unavailable optional E2E dependency', () => {
    expect(getPostgresTestUrl('DATABASE_URL', { GBRAIN_TEST_DB: '1' })).toBeUndefined();
  });

  test('requires an explicit one-bit destructive-test opt-in', () => {
    expect(() => getPostgresTestUrl('DATABASE_URL', { DATABASE_URL: SAFE_URL }))
      .toThrow('GBRAIN_TEST_DB must equal "1"');
    expect(() => getPostgresTestUrl('DATABASE_URL', {
      DATABASE_URL: SAFE_URL,
      GBRAIN_TEST_DB: 'true',
    })).toThrow('GBRAIN_TEST_DB must equal "1"');
  });

  test('requires the exact canonical disposable database name', () => {
    for (const database of ['postgres', 'production', 'gbrain_test_backup', 'test_gbrain', 'gbrain_test/']) {
      const url = `postgresql://test-user:super-secret@db.internal:5432/${database}`;
      expect(() => getPostgresTestUrl('DATABASE_URL', {
        DATABASE_URL: url,
        GBRAIN_TEST_DB: '1',
      })).toThrow(`database name must be exactly ${POSTGRES_TEST_DATABASE}`);
    }
  });

  test('accepts postgres schemes and returns the original authorized URL', () => {
    for (const url of [
      SAFE_URL,
      'postgres://test-user:super-secret@127.0.0.1:5432/gbrain_test?sslmode=disable',
      'postgresql://test-user:super-secret@db.internal:5432/%67brain_test',
    ]) {
      expect(getPostgresTestUrl('DATABASE_URL', {
        DATABASE_URL: url,
        GBRAIN_TEST_DB: '1',
      })).toBe(url);
    }
  });

  test('validates dedicated PgBouncer authority variables with the same policy', () => {
    expect(getPostgresTestUrl('GBRAIN_PGBOUNCER_DIRECT_URL', {
      GBRAIN_PGBOUNCER_DIRECT_URL: SAFE_URL,
      GBRAIN_TEST_DB: '1',
    })).toBe(SAFE_URL);
  });

  test('never reflects credentials from invalid or unauthorized URLs', () => {
    const secret = 'credential-that-must-not-leak';
    for (const env of [
      { DATABASE_URL: `not-a-url-${secret}`, GBRAIN_TEST_DB: '1' },
      { DATABASE_URL: `postgresql://user:${secret}@db.internal/production`, GBRAIN_TEST_DB: '1' },
      { DATABASE_URL: `postgresql://user:${secret}@db.internal/gbrain_test` },
    ]) {
      let message = '';
      try {
        getPostgresTestUrl('DATABASE_URL', env);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toContain(secret);
      expect(message.length).toBeGreaterThan(0);
    }
  });

  test('required form rejects an absent URL without exposing a value', () => {
    expect(() => requirePostgresTestUrl('DATABASE_URL', { GBRAIN_TEST_DB: '1' }))
      .toThrow('URL is not configured');
  });
});
