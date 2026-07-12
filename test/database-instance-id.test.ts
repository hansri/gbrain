import { describe, expect, test } from 'bun:test';
import {
  DATABASE_INSTANCE_ID_CONFIG_KEY,
  getOrCreateDatabaseInstanceId,
  readDatabaseInstanceId,
} from '../src/core/database-instance-id.ts';

class IdentityEngine {
  readonly values = new Map<string, string>();

  async executeRaw<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (sql.startsWith('INSERT INTO public.config')) {
      const key = String(params[0]);
      if (!this.values.has(key)) this.values.set(key, String(params[1]));
      return [];
    }
    if (sql.startsWith('SELECT value FROM public.config')) {
      const value = this.values.get(String(params[0]));
      return (value === undefined ? [] : [{ value }]) as T[];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
}

describe('database instance identity', () => {
  test('creates once and remains stable across callers', async () => {
    const engine = new IdentityEngine();
    const first = await getOrCreateDatabaseInstanceId(engine as never);
    const second = await getOrCreateDatabaseInstanceId(engine as never);

    expect(first).toMatch(/^db:[0-9a-f-]{36}$/);
    expect(second).toBe(first);
    expect(await readDatabaseInstanceId(engine as never)).toBe(first);
    expect(engine.values.has(DATABASE_INSTANCE_ID_CONFIG_KEY)).toBe(true);
  });

  test('read is non-mutating when no identity exists', async () => {
    const engine = new IdentityEngine();
    expect(await readDatabaseInstanceId(engine as never)).toBeNull();
    expect(engine.values.size).toBe(0);
  });

  test('fails closed on a malformed stored authority', async () => {
    const engine = new IdentityEngine();
    engine.values.set(DATABASE_INSTANCE_ID_CONFIG_KEY, 'not-a-uuid');
    await expect(getOrCreateDatabaseInstanceId(engine as never)).rejects.toThrow('missing or malformed');
  });
});
