import type { BrainEngine } from './engine.ts';

export const MIGRATION_INFLIGHT_KEY_PREFIX = 'migration_inflight:';
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SAFE_ATTEMPT = /^[0-9a-f-]{36}$/i;

export interface MigrationInflightRecord {
  version: string;
  brain_id: string;
  attempt_id: string;
  started_at: string;
}

function keyFor(version: string): string {
  if (!SAFE_VERSION.test(version)) throw new Error('Invalid migration version for inflight fence');
  return `${MIGRATION_INFLIGHT_KEY_PREFIX}${version}`;
}

function encode(record: MigrationInflightRecord): string {
  if (!SAFE_ATTEMPT.test(record.attempt_id)) throw new Error('Invalid migration attempt id');
  return JSON.stringify(record);
}

function decode(value: string): MigrationInflightRecord {
  let parsed: Partial<MigrationInflightRecord>;
  try { parsed = JSON.parse(value) as Partial<MigrationInflightRecord>; }
  catch { throw new Error('Database migration inflight fence is malformed'); }
  if (typeof parsed.version !== 'string'
    || typeof parsed.brain_id !== 'string'
    || typeof parsed.attempt_id !== 'string'
    || typeof parsed.started_at !== 'string'
    || !SAFE_VERSION.test(parsed.version)
    || !SAFE_ATTEMPT.test(parsed.attempt_id)
    || !Number.isFinite(Date.parse(parsed.started_at))) {
    throw new Error('Database migration inflight fence is malformed');
  }
  return parsed as MigrationInflightRecord;
}

/** Atomically publish the DB-visible fence before any orchestrator mutation. */
export async function claimMigrationInflight(
  engine: Pick<BrainEngine, 'executeRaw'>,
  record: MigrationInflightRecord,
): Promise<void> {
  const key = keyFor(record.version);
  const encoded = encode(record);
  const inserted = await engine.executeRaw<{ value: string }>(
    `INSERT INTO public.config (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO NOTHING
     RETURNING value`,
    [key, encoded],
  );
  if (inserted.length === 1 && inserted[0]?.value === encoded) return;
  const existing = await engine.executeRaw<{ value: string }>(
    'SELECT value FROM public.config WHERE key = $1',
    [key],
  );
  const owner = existing[0]?.value ? decode(existing[0].value) : null;
  throw new Error(
    owner
      ? `Migration ${record.version} has unresolved inflight attempt ${owner.attempt_id} for ${owner.brain_id}`
      : `Migration ${record.version} inflight claim did not become authoritative`,
  );
}

/** Clear only the exact attempt after its terminal local receipt is fsynced. */
export async function releaseMigrationInflight(
  engine: Pick<BrainEngine, 'executeRaw'>,
  record: MigrationInflightRecord,
): Promise<void> {
  const removed = await engine.executeRaw<{ value: string }>(
    'DELETE FROM public.config WHERE key = $1 AND value = $2 RETURNING value',
    [keyFor(record.version), encode(record)],
  );
  if (removed.length !== 1) {
    throw new Error(`Migration ${record.version} inflight fence changed before exact release`);
  }
}

export async function listMigrationInflight(
  engine: Pick<BrainEngine, 'executeRaw'>,
): Promise<MigrationInflightRecord[]> {
  const rows = await engine.executeRaw<{ key: string; value: string }>(
    `SELECT key, value
       FROM public.config
      WHERE LEFT(key, LENGTH($1)) = $1
      ORDER BY key`,
    [MIGRATION_INFLIGHT_KEY_PREFIX],
  );
  return rows.map(row => {
    const record = decode(row.value);
    if (row.key !== keyFor(record.version)) {
      throw new Error(`Database migration inflight fence key does not match payload version ${record.version}`);
    }
    return record;
  });
}

/** Explicit operator recovery after independent database verification. */
export async function clearMigrationInflight(
  engine: Pick<BrainEngine, 'executeRaw'>,
  version: string,
): Promise<number> {
  const rows = await engine.executeRaw<{ value: string }>(
    'DELETE FROM public.config WHERE key = $1 RETURNING value',
    [keyFor(version)],
  );
  return rows.length;
}

/** Exact-key existence check used by targeted recovery even if value is torn. */
export async function migrationInflightExists(
  engine: Pick<BrainEngine, 'executeRaw'>,
  version: string,
): Promise<boolean> {
  const rows = await engine.executeRaw<{ present: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM public.config WHERE key = $1) AS present',
    [keyFor(version)],
  );
  return rows[0]?.present === true;
}
