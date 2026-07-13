/**
 * v0.42.59.0 migration orchestrator — multi-source ownership hardening.
 *
 * Phase A inspects pre-migration state through a direct engine connection; it
 * must run before initSchema because schema migration v123 deliberately fails
 * on duplicate `(source_id, source_path)` owners. Phase B brings the schema to
 * head only after the preflight is green. Phase C verifies the two new unique
 * ownership indexes on both Postgres and PGLite.
 */

import type {
  Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult,
} from './types.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { verifyFileStorageIndex, verifySourcePathOwnerIndex } from '../../core/source-path-owner-index.ts';
import { escapeTerminalText, inspectSourcePathOwnership } from '../upgrade-preflight.ts';
import {
  runSnapshotMigrateOnly,
  snapshotFromOpts,
  withMigrationEngine,
  type MigrationBrainSnapshot,
} from './snapshot.ts';

async function resolveContext(opts: OrchestratorOpts): Promise<MigrationBrainSnapshot> {
  return snapshotFromOpts(opts);
}

export async function phaseAPreflight(
  engineOverride?: BrainEngine,
  opts?: OrchestratorOpts,
): Promise<OrchestratorPhaseResult> {
  try {
    const conflicts = engineOverride
      ? await inspectSourcePathOwnership(engineOverride)
      : opts
        ? await withMigrationEngine(opts, inspectSourcePathOwnership)
        : null;
    if (conflicts === null) {
      return { name: 'ownership_preflight', status: 'skipped', detail: 'no_brain_configured' };
    }
    if (conflicts.length > 0) {
      const first = conflicts[0]!;
      const repairCommand = opts?.upgradeTransition
        ? 'gbrain post-upgrade repair-ownership --source <id> --path <path> --keep <slug> --yes'
        : 'gbrain upgrade-preflight repair --source <id> --path <path> --keep <slug> --yes';
      return {
        name: 'ownership_preflight',
        status: 'failed',
        detail:
          `${conflicts.length} duplicate source-path ownership group(s); first: ` +
          `[${escapeTerminalText(first.source_id)}] ${escapeTerminalText(first.source_path)} -> ` +
          `${first.owners.map(escapeTerminalText).join(', ')}. ` +
          `Repair each group before retrying with: ${repairCommand}`,
      };
    }
    return { name: 'ownership_preflight', status: 'complete', detail: 'no duplicate owners' };
  } catch (error) {
    return {
      name: 'ownership_preflight',
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function phaseBSchema(
  opts: OrchestratorOpts,
): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'schema', status: 'skipped', detail: 'dry-run' };
  try {
    await runSnapshotMigrateOnly(opts);
    return { name: 'schema', status: 'complete', detail: 'schema brought to head' };
  } catch (error) {
    return {
      name: 'schema',
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function phaseCVerify(opts: OrchestratorOpts): Promise<OrchestratorPhaseResult> {
  try {
    const result = await withMigrationEngine(opts, async engine => {
      const pageIndexOk = await verifySourcePathOwnerIndex(engine);
      const fileIndexOk = await verifyFileStorageIndex(engine);
      return { pageIndexOk, fileIndexOk };
    });
    const missing = [
      ...(!result.pageIndexOk ? ['canonical pages_source_path_owner_uniq'] : []),
      ...(!result.fileIndexOk ? ['canonical idx_files_source_storage_path'] : []),
    ];
    if (missing.length > 0) {
      return { name: 'verify', status: 'failed', detail: `missing indexes: ${missing.join(', ')}` };
    }
    return {
      name: 'verify',
      status: 'complete',
      detail: 'idx_files_source_storage_path, pages_source_path_owner_uniq',
    };
  } catch (error) {
    return {
      name: 'verify',
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  const phases: OrchestratorPhaseResult[] = [];
  try {
    await resolveContext(opts);
  } catch (error) {
    return {
      version: '0.42.59.0',
      status: 'failed',
      phases: [{
        name: 'identity',
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      }],
      pending_host_work: 0,
    };
  }
  const preflight = await phaseAPreflight(undefined, opts);
  phases.push(preflight);
  if (preflight.status === 'failed') {
    console.error(preflight.detail);
    return { version: '0.42.59.0', status: 'failed', phases, pending_host_work: 0 };
  }

  const schema = await phaseBSchema(opts);
  phases.push(schema);
  if (schema.status === 'failed') {
    return { version: '0.42.59.0', status: 'failed', phases, pending_host_work: 0 };
  }

  if (!opts.dryRun) phases.push(await phaseCVerify(opts));
  const status: OrchestratorResult['status'] = phases.some(phase => phase.status === 'failed')
    ? 'failed'
    : 'complete';
  return { version: '0.42.59.0', status, phases, pending_host_work: 0 };
}

export const v0_42_59_0: Migration = {
  version: '0.42.59.0',
  featurePitch: {
    headline: 'Multi-source writes now converge atomically without cross-source ownership collisions',
    description:
      'Upgrade automation checks legacy page-path ownership before applying the new file and page identity constraints, ' +
      'then verifies both indexes on Postgres or PGLite. Conflicts fail closed with a supported repair command; no page content is deleted.',
  },
  orchestrator,
};

export const __testing = { phaseBSchema, phaseCVerify, orchestrator, resolveContext };
