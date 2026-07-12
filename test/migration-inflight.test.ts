import { describe, expect, test } from 'bun:test';
import {
  claimMigrationInflight,
  clearMigrationInflight,
  listMigrationInflight,
  migrationInflightExists,
  releaseMigrationInflight,
  type MigrationInflightRecord,
} from '../src/core/migration-inflight.ts';

class FenceEngine {
  values = new Map<string, string>();

  async executeRaw<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const key = String(params[0]);
    if (sql.startsWith('INSERT INTO public.config')) {
      if (this.values.has(key)) return [];
      this.values.set(key, String(params[1]));
      return [{ value: String(params[1]) }] as T[];
    }
    if (sql.startsWith('SELECT value FROM public.config WHERE key =')) {
      const value = this.values.get(key);
      return (value ? [{ value }] : []) as T[];
    }
    if (sql.startsWith('SELECT key, value')) {
      return [...this.values.entries()]
        .filter(([candidate]) => candidate.startsWith('migration_inflight:'))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([candidate, value]) => ({ key: candidate, value })) as T[];
    }
    if (sql.startsWith('DELETE FROM public.config WHERE key = $1 AND value = $2')) {
      if (this.values.get(key) !== String(params[1])) return [];
      const value = this.values.get(key)!;
      this.values.delete(key);
      return [{ value }] as T[];
    }
    if (sql.startsWith('DELETE FROM public.config WHERE key = $1')) {
      const value = this.values.get(key);
      if (!value) return [];
      this.values.delete(key);
      return [{ value }] as T[];
    }
    if (sql.startsWith('SELECT EXISTS')) {
      return [{ present: this.values.has(key) }] as T[];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
}

const record: MigrationInflightRecord = {
  version: '0.42.59.0',
  brain_id: 'db:11111111-1111-4111-8111-111111111111',
  attempt_id: '22222222-2222-4222-8222-222222222222',
  started_at: '2026-07-12T00:00:00.000Z',
};

describe('database-visible migration inflight fence', () => {
  test('claims once, blocks a second runner, and releases only the exact attempt', async () => {
    const engine = new FenceEngine();
    await claimMigrationInflight(engine as never, record);
    await expect(claimMigrationInflight(engine as never, {
      ...record,
      attempt_id: '33333333-3333-4333-8333-333333333333',
    })).rejects.toThrow('unresolved inflight attempt');
    expect(await listMigrationInflight(engine as never)).toEqual([record]);
    await expect(releaseMigrationInflight(engine as never, {
      ...record,
      attempt_id: '33333333-3333-4333-8333-333333333333',
    })).rejects.toThrow('changed before exact release');
    await releaseMigrationInflight(engine as never, record);
    expect(await listMigrationInflight(engine as never)).toEqual([]);
  });

  test('targeted operator recovery clears the named fence only', async () => {
    const engine = new FenceEngine();
    await claimMigrationInflight(engine as never, record);
    expect(await migrationInflightExists(engine as never, record.version)).toBe(true);
    expect(await clearMigrationInflight(engine as never, record.version)).toBe(1);
    expect(await migrationInflightExists(engine as never, record.version)).toBe(false);
    expect(await clearMigrationInflight(engine as never, record.version)).toBe(0);
  });

  test('enumeration binds the config key to the payload version', async () => {
    const engine = new FenceEngine();
    engine.values.set('migration_inflight:0.42.58.0', JSON.stringify(record));
    await expect(listMigrationInflight(engine as never)).rejects.toThrow('key does not match payload');
  });

  test('a wildcard-shaped unrelated key is never selected', async () => {
    const engine = new FenceEngine();
    engine.values.set('migrationXinflighZ:0.42.59.0', JSON.stringify(record));
    expect(await listMigrationInflight(engine as never)).toEqual([]);
  });
});
