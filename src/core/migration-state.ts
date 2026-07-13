import type { CompletedMigrationEntry } from './preferences.ts';

export const MAX_CONSECUTIVE_MIGRATION_PARTIALS = 3;

export type MigrationVersionStatus =
  | 'complete'
  | 'partial'
  | 'pending'
  | 'wedged'
  | 'ambiguous';

export interface MigrationEntryIndex {
  /** Undefined denotes only the legacy, unscoped ledger partition. */
  brainId?: string;
  byVersion: Map<string, CompletedMigrationEntry[]>;
}

export interface UnresolvedMigrationState {
  brain_id?: string;
  version: string;
  status: Exclude<MigrationVersionStatus, 'complete' | 'pending'>;
}

/**
 * Build one ledger partition. A database-scoped receipt is authoritative only
 * for the database identity that produced it; legacy unscoped receipts form
 * their own partition and are never merged with a configured brain.
 */
export function indexMigrationEntries(
  entries: CompletedMigrationEntry[],
  brainId?: string,
): MigrationEntryIndex {
  const byVersion = new Map<string, CompletedMigrationEntry[]>();
  for (const entry of entries) {
    if (entry.brain_id !== brainId) continue;
    const versionEntries = byVersion.get(entry.version) ?? [];
    versionEntries.push(entry);
    byVersion.set(entry.version, versionEntries);
  }
  return { brainId, byVersion };
}

/**
 * Canonical migration-ledger state machine shared by apply-migrations and
 * doctor. Wedges count trailing consecutive partial attempts only; an explicit
 * retry resets the count. Ambiguity remains a stronger fail-closed state until
 * such a retry marker is appended.
 */
export function migrationStatusForVersion(
  version: string,
  index: MigrationEntryIndex,
): MigrationVersionStatus {
  const entries = index.byVersion.get(version) ?? [];
  if (entries.length === 0) return 'pending';
  // Retry starts a fresh, operator-authorized attempt. Nothing before the
  // latest retry may complete, wedge, or otherwise resolve that new attempt.
  const lastRetry = entries.findLastIndex(entry => entry.status === 'retry');
  const activeEntries = entries.slice(lastRetry + 1);
  if (activeEntries.length === 0) return 'pending';

  // Ambiguity is a mutation fence, not an ordinary failed attempt. A complete
  // receipt written by a concurrent/late runner cannot prove that the
  // ambiguous transaction settled, so only an explicit later retry clears it.
  if (activeEntries.some(entry => entry.ambiguous_state === true)) return 'ambiguous';

  // A write-ahead inflight fence is unresolved until the exact attempt writes
  // a terminal receipt. A complete from another concurrent/older attempt cannot
  // clear it. This also makes process death after side effects fail closed.
  const inflightAttempts = new Map<string, number>();
  for (let index = 0; index < activeEntries.length; index++) {
    const entry = activeEntries[index]!;
    if (entry.inflight_state !== true) continue;
    if (!entry.attempt_id) return 'ambiguous';
    const firstIndex = inflightAttempts.get(entry.attempt_id);
    if (firstIndex === undefined || index < firstIndex) {
      inflightAttempts.set(entry.attempt_id, index);
    }
  }
  for (const [attemptId, firstInflightIndex] of inflightAttempts) {
    const terminal = activeEntries.slice(firstInflightIndex + 1).some(entry =>
      entry.attempt_id === attemptId && entry.attempt_terminal === true);
    if (!terminal) return 'ambiguous';
  }

  const settledEntries = activeEntries.filter(entry => entry.inflight_state !== true);

  // Preserve the historical terminal-complete invariant for ordinary stray
  // partials within the current attempt. Ambiguity above is the sole stronger
  // state and deliberately wins until the operator appends retry.
  if (settledEntries.some(entry => entry.status === 'complete')) return 'complete';

  let trailingPartials = 0;
  for (let i = settledEntries.length - 1; i >= 0; i--) {
    if (settledEntries[i]!.status !== 'partial') break;
    trailingPartials++;
  }
  if (trailingPartials >= MAX_CONSECUTIVE_MIGRATION_PARTIALS) return 'wedged';
  if (settledEntries.some(entry => entry.status === 'partial')) return 'partial';
  return 'pending';
}

/**
 * Return unresolved states without ever combining database identities. When a
 * brainId is supplied only that exact partition is inspected. Without one,
 * each scoped brain plus the legacy-unscoped partition is evaluated
 * independently for filesystem-only doctor diagnostics.
 */
export function listUnresolvedMigrationStates(
  entries: CompletedMigrationEntry[],
  brainId?: string,
): UnresolvedMigrationState[] {
  const partitions: Array<string | undefined> = brainId !== undefined
    ? [brainId]
    : [...new Set(entries.map(entry => entry.brain_id))];
  const unresolved: UnresolvedMigrationState[] = [];

  for (const partition of partitions) {
    const index = indexMigrationEntries(entries, partition);
    for (const version of index.byVersion.keys()) {
      const status = migrationStatusForVersion(version, index);
      if (status === 'partial' || status === 'wedged' || status === 'ambiguous') {
        unresolved.push({ brain_id: partition, version, status });
      }
    }
  }

  return unresolved.sort((a, b) =>
    (a.brain_id ?? '').localeCompare(b.brain_id ?? '') || a.version.localeCompare(b.version),
  );
}
