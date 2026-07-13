/**
 * Immutable migration-brain helpers.
 *
 * `apply-migrations` resolves one database identity before it builds the
 * migration plan. Every phase must keep using that exact engine/config
 * snapshot; re-reading ~/.gbrain/config.json mid-run can otherwise execute a
 * phase against Brain B and persist a successful receipt for Brain A.
 */

import type { BrainEngine } from '../../core/engine.ts';
import { createEngine } from '../../core/engine-factory.ts';
import type { EngineConfig } from '../../core/types.ts';
import type { GBrainConfig } from '../../core/config.ts';
import type { OrchestratorOpts } from './types.ts';
import { readDatabaseInstanceId } from '../../core/database-instance-id.ts';

export interface MigrationBrainSnapshot {
  brainId: string;
  engineConfig: EngineConfig;
  gbrainConfig: GBrainConfig;
}

export interface OpenMigrationEngine {
  engine: BrainEngine;
  ownsEngine: boolean;
}

/** Runtime validation complements the required TypeScript fields for JS callers. */
export function snapshotFromOpts(opts: OrchestratorOpts): MigrationBrainSnapshot {
  if (!opts.brainId || !opts.engineConfig || !opts.gbrainConfig) {
    throw new Error('Migration orchestrator requires an immutable brain snapshot');
  }
  if (opts.engineConfig.engine !== opts.gbrainConfig.engine) {
    throw new Error('Migration engine/config snapshots disagree');
  }
  return {
    brainId: opts.brainId,
    engineConfig: { ...opts.engineConfig },
    gbrainConfig: { ...opts.gbrainConfig },
  };
}

export async function assertMigrationEngineIdentity(
  engine: Pick<BrainEngine, 'executeRaw'>,
  snapshot: Pick<MigrationBrainSnapshot, 'brainId'>,
): Promise<void> {
  const actual = await readDatabaseInstanceId(engine);
  if (actual !== snapshot.brainId) {
    throw new Error('Database identity changed between migration phases');
  }
}

/** Open the snapshotted engine and fail before a phase can read or mutate it. */
export async function openMigrationEngine(
  opts: OrchestratorOpts,
  testEngineOverride?: BrainEngine | null,
): Promise<OpenMigrationEngine> {
  const snapshot = snapshotFromOpts(opts);
  if (testEngineOverride) {
    // Explicit test overrides are already connected and caller-owned. They
    // intentionally bypass production engine construction so hermetic phase
    // tests do not need to forge the engine's private/random identity.
    return { engine: testEngineOverride, ownsEngine: false };
  }

  const engine = await createEngine(snapshot.engineConfig);
  try {
    await engine.connect(snapshot.engineConfig);
    await assertMigrationEngineIdentity(engine, snapshot);
    return { engine, ownsEngine: true };
  } catch (error) {
    try { await engine.disconnect(); } catch { /* best-effort */ }
    throw error;
  }
}

export async function withMigrationEngine<T>(
  opts: OrchestratorOpts,
  fn: (engine: BrainEngine) => Promise<T>,
  testEngineOverride?: BrainEngine | null,
): Promise<T> {
  const opened = await openMigrationEngine(opts, testEngineOverride);
  try {
    return await fn(opened.engine);
  } finally {
    if (opened.ownsEngine) {
      try { await opened.engine.disconnect(); } catch { /* best-effort */ }
    }
  }
}

/** Bring only the snapshotted brain to schema head. */
export async function runSnapshotMigrateOnly(opts: OrchestratorOpts): Promise<void> {
  const snapshot = snapshotFromOpts(opts);
  const { runMigrateOnlyCore } = await import('./in-process.ts');
  await runMigrateOnlyCore({
    config: snapshot.gbrainConfig,
    engineConfig: snapshot.engineConfig,
    expectedDatabaseIdentity: snapshot.brainId,
  });
}
