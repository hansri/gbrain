import type { BrainEngine } from './engine.ts';

export interface SourcePathOwnerIndexState {
  indisunique: boolean;
  indisvalid: boolean;
  indisready: boolean;
  indimmediate: boolean;
  definition: string;
  predicate: string | null;
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[\s"]/g, '');
}

/** Exact post-condition shared by migrations, upgrade automation, and tests. */
export function isCanonicalSourcePathOwnerIndex(
  state: SourcePathOwnerIndexState | null,
): boolean {
  if (!state?.indisunique || !state.indisvalid || !state.indisready || !state.indimmediate) return false;
  const definition = compact(state.definition);
  const predicate = compact(state.predicate ?? '').replace(/[()]/g, '');
  return definition.includes('onpublic.pages')
    && definition.includes('(source_id,source_path)')
    && predicate === 'source_pathisnotnull';
}

export function isCanonicalFileStorageIndex(
  state: SourcePathOwnerIndexState | null,
): boolean {
  if (!state?.indisunique || !state.indisvalid || !state.indisready || !state.indimmediate) return false;
  const definition = compact(state.definition);
  const predicate = compact(state.predicate ?? '').replace(/[()]/g, '');
  return definition.includes('onpublic.files')
    && definition.includes('(source_id,storage_path)')
    && predicate === '';
}

async function readIndex(
  engine: BrainEngine,
  indexName: string,
  tableName: string,
): Promise<SourcePathOwnerIndexState | null> {
  const rows = await engine.executeRaw<SourcePathOwnerIndexState>(
    `SELECT i.indisunique,
            i.indisvalid,
            i.indisready,
            i.indimmediate,
            pg_get_indexdef(i.indexrelid) AS definition,
            pg_get_expr(i.indpred, i.indrelid) AS predicate
       FROM pg_index i
       JOIN pg_class idx ON idx.oid = i.indexrelid
       JOIN pg_class tbl ON tbl.oid = i.indrelid
       JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
      WHERE idx.relname = $1
        AND tbl.relname = $2
        AND ns.nspname = 'public'`,
    [indexName, tableName],
  );
  return rows.length === 1 ? rows[0]! : null;
}

export async function readSourcePathOwnerIndex(
  engine: BrainEngine,
): Promise<SourcePathOwnerIndexState | null> {
  return readIndex(engine, 'pages_source_path_owner_uniq', 'pages');
}

export async function readFileStorageIndex(
  engine: BrainEngine,
): Promise<SourcePathOwnerIndexState | null> {
  return readIndex(engine, 'idx_files_source_storage_path', 'files');
}

export async function verifySourcePathOwnerIndex(engine: BrainEngine): Promise<boolean> {
  return isCanonicalSourcePathOwnerIndex(await readSourcePathOwnerIndex(engine));
}

export async function verifyFileStorageIndex(engine: BrainEngine): Promise<boolean> {
  return isCanonicalFileStorageIndex(await readFileStorageIndex(engine));
}

export class CriticalOwnershipIndexError extends Error {
  constructor(public readonly invalidIndexes: string[]) {
    super(
      `Critical multi-source ownership index drift: ${invalidIndexes.join(', ')}. ` +
      'Stop writers and run `gbrain upgrade-preflight`; do not resume ingestion until the canonical index shapes are restored.',
    );
    this.name = 'CriticalOwnershipIndexError';
  }
}

/**
 * Always-on invariant gate for schema-head brains. Version counters and
 * migration receipts cannot prove a critical index still exists: an operator
 * can drop it later, or replace it with a weaker same-name index. This probe
 * validates uniqueness, readiness, immediacy, exact table/key order, and the
 * exact partial predicate on every init/force path.
 */
export async function assertCriticalOwnershipIndexes(engine: BrainEngine): Promise<void> {
  const [pageOk, fileOk] = await Promise.all([
    verifySourcePathOwnerIndex(engine),
    verifyFileStorageIndex(engine),
  ]);
  const invalid = [
    ...(!pageOk ? ['pages_source_path_owner_uniq'] : []),
    ...(!fileOk ? ['idx_files_source_storage_path'] : []),
  ];
  if (invalid.length > 0) throw new CriticalOwnershipIndexError(invalid);
}

/**
 * Version-aware invariant gate for a partially advanced schema. v123 owns the
 * file identity index; v124 owns the page-path index. Keeping those thresholds
 * distinct lets a database that committed v123 and stopped cleanly resume into
 * v124 instead of failing before the pending migration can run.
 */
export async function assertCriticalOwnershipIndexesForVersion(
  engine: BrainEngine,
  schemaVersion: number,
): Promise<void> {
  if (schemaVersion < 123) return;
  const [pageOk, fileOk] = await Promise.all([
    schemaVersion >= 124 ? verifySourcePathOwnerIndex(engine) : Promise.resolve(true),
    verifyFileStorageIndex(engine),
  ]);
  const invalid = [
    ...(!pageOk ? ['pages_source_path_owner_uniq'] : []),
    ...(!fileOk ? ['idx_files_source_storage_path'] : []),
  ];
  if (invalid.length > 0) throw new CriticalOwnershipIndexError(invalid);
}
