import { randomUUID } from 'node:crypto';
import type { BrainEngine } from './engine.ts';

export const DATABASE_INSTANCE_ID_CONFIG_KEY = 'database_instance_id';

const UUID_V4_COMPAT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeDatabaseInstanceId(value: unknown): string {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!UUID_V4_COMPAT.test(raw)) {
    throw new Error(
      `Database instance identity is missing or malformed in config.${DATABASE_INSTANCE_ID_CONFIG_KEY}; ` +
      'stop migrations and repair the database identity before retrying.',
    );
  }
  return `db:${raw}`;
}

/** Read the durable database-owned identity without mutating the brain. */
export async function readDatabaseInstanceId(
  engine: Pick<BrainEngine, 'executeRaw'>,
): Promise<string | null> {
  const rows = await engine.executeRaw<{ value: string }>(
    'SELECT value FROM public.config WHERE key = $1',
    [DATABASE_INSTANCE_ID_CONFIG_KEY],
  );
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error('Database instance identity is not unique');
  return normalizeDatabaseInstanceId(rows[0]?.value);
}

/**
 * Return one stable physical/logical brain identity shared by every route,
 * role, host, and GBRAIN_HOME that reaches the same database.
 *
 * The UUID is generated locally but becomes authoritative only through the
 * database's unique config key. Concurrent first callers race safely via
 * ON CONFLICT DO NOTHING, then all read the winning value. No URL, role,
 * password, path, or other credential-shaped material enters durable ledgers.
 */
export async function getOrCreateDatabaseInstanceId(
  engine: Pick<BrainEngine, 'executeRaw'>,
): Promise<string> {
  const candidate = randomUUID();
  await engine.executeRaw(
    `INSERT INTO public.config (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO NOTHING`,
    [DATABASE_INSTANCE_ID_CONFIG_KEY, candidate],
  );
  const identity = await readDatabaseInstanceId(engine);
  if (!identity) {
    throw new Error('Database instance identity write completed without a readable authority row');
  }
  return identity;
}
