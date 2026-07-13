import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';

import { configDir } from './config.ts';
import {
  appendMigrationEntriesAtomically,
  loadCompletedMigrations,
  loadPreferences,
  parseCompletedMigrationsText,
  preferencesPaths,
  savePreferences,
  validateMinionMode,
  withMigrationLedgerLock,
  type CompletedMigrationEntry,
  type Preferences,
} from './preferences.ts';
import {
  indexMigrationEntries,
  migrationStatusForVersion,
} from './migration-state.ts';
import {
  readOwnedStateFile,
  writeOwnedStateFileAtomic,
} from './owned-state-file.ts';

const MAX_LEGACY_PREFERENCES_BYTES = 1 * 1024 * 1024;
const MAX_LEGACY_LEDGER_BYTES = 16 * 1024 * 1024;
const MAX_ADOPTION_MANIFEST_BYTES = 64 * 1024;
const ADOPTION_MANIFEST_VERSION = 1;

interface PreferenceAdoptionManifest {
  version: typeof ADOPTION_MANIFEST_VERSION;
  legacy_preferences_sha256: string;
  adopted_at: string;
}

export interface LegacyStateAdoptionResult {
  preferences: 'not_applicable' | 'already_adopted' | 'adopted';
  ledgerVersionsAdopted: string[];
  unresolvedVersionsFenced: string[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

function readOptionalOwned(path: string, maxBytes: number, root: string): string | null {
  try { return readOwnedStateFile(path, maxBytes, root); }
  catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function parsePreferences(raw: string, label: string): Preferences {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error(`${label} preferences are malformed JSON`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} preferences must be a JSON object`);
  }
  const preferences = value as Preferences;
  if (preferences.minion_mode !== undefined) validateMinionMode(preferences.minion_mode);
  return preferences;
}

function directLegacyRoot(): string | null {
  const override = process.env.GBRAIN_HOME?.trim();
  if (!override) return null;
  // configDir performs the canonical absolute/no-`..` validation for us.
  configDir();
  return override;
}

function manifestPath(): string {
  return join(configDir(), 'legacy-state-adoption.json');
}

function adoptLegacyPreferences(
  root: string | null,
  persist: boolean,
): LegacyStateAdoptionResult['preferences'] {
  if (!root) return 'not_applicable';
  const legacyPath = join(root, 'preferences.json');
  const raw = readOptionalOwned(legacyPath, MAX_LEGACY_PREFERENCES_BYTES, root);
  if (raw === null) return 'not_applicable';

  const sourceHash = sha256(raw);
  const existingManifestRaw = readOptionalOwned(
    manifestPath(),
    MAX_ADOPTION_MANIFEST_BYTES,
    configDir(),
  );
  if (existingManifestRaw !== null) {
    let manifest: Partial<PreferenceAdoptionManifest>;
    try { manifest = JSON.parse(existingManifestRaw) as Partial<PreferenceAdoptionManifest>; }
    catch { throw new Error('Legacy state adoption manifest is malformed'); }
    if (manifest.version !== ADOPTION_MANIFEST_VERSION
      || typeof manifest.legacy_preferences_sha256 !== 'string') {
      throw new Error('Legacy state adoption manifest has an unsupported shape');
    }
    if (manifest.legacy_preferences_sha256 !== sourceHash) {
      throw new Error(
        'Legacy preferences changed after adoption; reconcile the canonical and rollback copies before migrating.',
      );
    }
    return 'already_adopted';
  }

  const legacy = parsePreferences(raw, 'Legacy');
  const canonicalRaw = readOptionalOwned(
    preferencesPaths.file(),
    MAX_LEGACY_PREFERENCES_BYTES,
    configDir(),
  );
  if (canonicalRaw === null) {
    if (persist) savePreferences(legacy);
  } else {
    const canonical = parsePreferences(canonicalRaw, 'Canonical');
    if (!isDeepStrictEqual(canonical, legacy)) {
      throw new Error(
        'Legacy and canonical preferences both exist and differ; refusing to choose an authority automatically.',
      );
    }
  }

  const manifest: PreferenceAdoptionManifest = {
    version: ADOPTION_MANIFEST_VERSION,
    legacy_preferences_sha256: sourceHash,
    adopted_at: new Date().toISOString(),
  };
  if (persist) {
    writeOwnedStateFileAtomic(
      manifestPath(),
      JSON.stringify(manifest, null, 2) + '\n',
      MAX_ADOPTION_MANIFEST_BYTES,
      configDir(),
    );
  }
  return 'adopted';
}

interface LegacyPartition {
  source: 'canonical-unscoped' | 'legacy-gbrain-home';
  entries: CompletedMigrationEntry[];
}

function adoptionHash(version: string, partitions: LegacyPartition[]): string {
  return sha256(JSON.stringify({
    version,
    partitions: partitions.map(partition => ({
      source: partition.source,
      entries: partition.entries,
    })),
  }));
}

function adoptLegacyLedger(brainId: string, root: string | null, persist: boolean): {
  adopted: string[];
  fenced: string[];
} {
  const canonical = loadCompletedMigrations();
  const directRaw = root
    ? readOptionalOwned(join(root, 'migrations', 'completed.jsonl'), MAX_LEGACY_LEDGER_BYTES, root)
    : null;
  const direct = directRaw === null ? [] : parseCompletedMigrationsText(directRaw);
  if (direct.some(entry => entry.brain_id !== undefined)) {
    throw new Error('Legacy GBRAIN_HOME ledger unexpectedly contains scoped brain receipts');
  }

  const versions = new Set<string>([
    ...canonical.filter(entry => entry.brain_id === undefined).map(entry => entry.version),
    ...direct.map(entry => entry.version),
  ]);
  const additions: CompletedMigrationEntry[] = [];
  const adopted: string[] = [];
  const fenced: string[] = [];

  for (const version of [...versions].sort()) {
    const partitions: LegacyPartition[] = [];
    const canonicalEntries = canonical.filter(entry =>
      entry.brain_id === undefined && entry.version === version);
    const directEntries = direct.filter(entry => entry.version === version);
    if (canonicalEntries.length > 0) {
      partitions.push({ source: 'canonical-unscoped', entries: canonicalEntries });
    }
    if (directEntries.length > 0) {
      partitions.push({ source: 'legacy-gbrain-home', entries: directEntries });
    }
    const sourceHash = adoptionHash(version, partitions);
    const scoped = canonical.filter(entry => entry.brain_id === brainId && entry.version === version);
    const everyPartitionComplete = partitions.every(partition =>
      migrationStatusForVersion(
        version,
        indexMigrationEntries(partition.entries),
      ) === 'complete');
    const priorHashes = new Set(scoped
      .map(entry => entry.legacy_adoption_hash)
      .filter((value): value is string => typeof value === 'string'));
    if (priorHashes.has(sourceHash)) continue;
    if (priorHashes.size > 0) {
      throw new Error(
        `Legacy migration history for ${version} changed after adoption; supervised reconciliation is required.`,
      );
    }
    // A rollback-era unscoped ledger must never append a scoped `complete`
    // over a newer unresolved attempt. Pre-existing scoped history without an
    // adoption hash is an independent authority: coexistence is safe to bind
    // automatically only when both it and every legacy partition are already
    // terminal complete. Any other combination requires human reconciliation.
    if (scoped.length > 0) {
      const scopedStatus = migrationStatusForVersion(
        version,
        indexMigrationEntries(scoped, brainId),
      );
      if (scopedStatus !== 'complete' || !everyPartitionComplete) {
        throw new Error(
          `Legacy migration history for ${version} coexists with unresolved scoped migration history; ` +
          'refusing to append a completion that could hide the current attempt.',
        );
      }
    }
    const now = new Date().toISOString();
    if (everyPartitionComplete) {
      additions.push({
        version,
        brain_id: brainId,
        status: 'complete',
        ts: now,
        legacy_adoption_hash: sourceHash,
        legacy_adoption_sources: partitions.map(partition => partition.source),
      });
      adopted.push(version);
    } else {
      for (let part = 1; part <= 3; part++) {
        additions.push({
          version,
          brain_id: brainId,
          status: 'partial',
          ts: now,
          ambiguous_state: true,
          ambiguity_fence_part: part,
          legacy_adoption_hash: sourceHash,
          legacy_adoption_sources: partitions.map(partition => partition.source),
        });
      }
      fenced.push(version);
    }
  }

  if (persist) appendMigrationEntriesAtomically(additions);
  return { adopted, fenced };
}

/**
 * One-time old-to-new state bridge. Call only while holding both migration
 * single-flight locks, before building a migration plan. Legacy files remain
 * intact for the supervised rollback window; canonical state is sole runtime
 * authority after adoption.
 */
export function adoptLegacyMigrationState(brainId: string): LegacyStateAdoptionResult {
  return withMigrationLedgerLock(() => {
    const root = directLegacyRoot();
    const preferences = adoptLegacyPreferences(root, true);
    const ledger = adoptLegacyLedger(brainId, root, true);
    return {
      preferences,
      ledgerVersionsAdopted: ledger.adopted,
      unresolvedVersionsFenced: ledger.fenced,
    };
  });
}

/**
 * Read-only adoption preview for `apply-migrations --list/--dry-run`.
 * It performs the same validation and hash comparison as live adoption but
 * creates no identity, manifest, preference, or ledger record.
 */
export function previewLegacyMigrationStateAdoption(
  brainId: string,
): LegacyStateAdoptionResult {
  const root = directLegacyRoot();
  const preferences = adoptLegacyPreferences(root, false);
  const ledger = adoptLegacyLedger(brainId, root, false);
  return {
    preferences,
    ledgerVersionsAdopted: ledger.adopted,
    unresolvedVersionsFenced: ledger.fenced,
  };
}
