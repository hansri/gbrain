/**
 * `gbrain apply-migrations` — migration runner CLI.
 *
 * Reads ~/.gbrain/migrations/completed.jsonl, diffs against the TS migration
 * registry, runs any pending orchestrators. Resumes `status: "partial"`
 * entries (stopgap bash script writes these). Idempotent: rerunning is
 * cheap when nothing is pending.
 *
 * Invoked from:
 *   - `gbrain upgrade` → runPostUpgrade() tail (Lane A-5)
 *   - package.json `postinstall` (Lane A-5)
 *   - explicit user / host-agent after registering new handlers (Lane C-1)
 */

import { randomUUID } from 'node:crypto';
import { VERSION } from '../version.ts';
import type { UpgradeChildTransition } from '../core/upgrade-child-capability.ts';
import { gbrainPath, loadConfig, toEngineConfig } from '../core/config.ts';
import type { GBrainConfig } from '../core/config.ts';
import {
  assertExistingPgliteDataDirForReadOnlyOpen,
  createEngine,
} from '../core/engine-factory.ts';
import type { EngineConfig } from '../core/types.ts';
import { getOrCreateDatabaseInstanceId, readDatabaseInstanceId } from '../core/database-instance-id.ts';
import {
  acquireDatabaseSessionLock,
  resolveDatabaseSessionLockUrl,
  type DatabaseSessionLockHandle,
} from '../core/db.ts';
import { deriveDirectUrl } from '../core/connection-manager.ts';
import { holdPackLock } from '../core/schema-pack/pack-lock.ts';
import { withOwnedStateReadPolicy } from '../core/owned-state-file.ts';
import {
  claimMigrationInflight,
  clearMigrationInflight,
  listMigrationInflight,
  migrationInflightExists,
  releaseMigrationInflight,
  type MigrationInflightRecord,
} from '../core/migration-inflight.ts';
import {
  loadCompletedMigrations,
  appendAmbiguousMigration,
  appendCompletedMigration,
  appendInflightMigration,
} from '../core/preferences.ts';
import {
  adoptLegacyMigrationState,
  previewLegacyMigrationStateAdoption,
} from '../core/legacy-state-adoption.ts';
import { migrations, compareVersions, type Migration, type OrchestratorOpts } from './migrations/index.ts';
import { isMigrateOnlyAmbiguousState } from './migrations/in-process.ts';
import {
  indexMigrationEntries as indexCompleted,
  migrationStatusForVersion as statusForVersion,
  MAX_CONSECUTIVE_MIGRATION_PARTIALS as MAX_CONSECUTIVE_PARTIALS,
  listUnresolvedMigrationStates,
  type MigrationEntryIndex as CompletedIndex,
} from '../core/migration-state.ts';

const MIGRATION_RUN_LOCK_KEY = 43;

export function migrationRunLockName(brainId: string): string {
  const portable = brainId.replace(/[^A-Za-z0-9._-]/g, '_');
  return `apply-migrations-${portable}`;
}

interface ApplyMigrationsArgs {
  list: boolean;
  dryRun: boolean;
  yes: boolean;
  nonInteractive: boolean;
  mode?: 'always' | 'pain_triggered' | 'off';
  specificMigration?: string;
  hostDir?: string;
  noAutopilotInstall: boolean;
  /** Bug 3 — explicit reset for a wedged migration. Writes a 'retry' marker. */
  forceRetry?: string;
  /**
   * v0.30.1 namespaced --force flags (codex T5):
   *   --force-orchestrator: write 'retry' markers for ALL wedged orchestrator migrations
   *   --force-schema:       reset schema-version drift (re-run runMigrations)
   *   --force-all:          both
   */
  forceOrchestrator?: boolean;
  forceSchema?: boolean;
  forceAll?: boolean;
  help: boolean;
}

export interface ApplyMigrationsOutcome {
  exitCode: 0 | 1 | 2;
  status: 'ok' | 'blocked' | 'invalid';
  reason:
    | 'help'
    | 'no_config'
    | 'listed'
    | 'dry_run'
    | 'force_retry_recorded'
    | 'force_orchestrator_recorded'
    | 'schema_verified'
    | 'up_to_date'
    | 'complete'
    | 'wedged'
    | 'partial'
    | 'ambiguous'
    | 'failed'
    | 'invalid_arguments';
  migrationsRun: number;
  blockedVersions?: string[];
  message?: string;
}

function outcome(
  exitCode: 0 | 1 | 2,
  reason: ApplyMigrationsOutcome['reason'],
  migrationsRun = 0,
  extra: Pick<ApplyMigrationsOutcome, 'blockedVersions' | 'message'> = {},
): ApplyMigrationsOutcome {
  return {
    exitCode,
    status: exitCode === 0 ? 'ok' : exitCode === 2 ? 'invalid' : 'blocked',
    reason,
    migrationsRun,
    ...extra,
  };
}

function targetedForceRetryCommand(version: string, boundUpgrade: boolean): string {
  return boundUpgrade
    ? `gbrain post-upgrade recover-migration --force-retry ${version}`
    : `gbrain apply-migrations --force-retry ${version}`;
}

class ApplyMigrationsUsageError extends Error {}

function parseArgs(args: string[]): ApplyMigrationsArgs {
  const parsed: ApplyMigrationsArgs = {
    list: false,
    dryRun: false,
    yes: false,
    nonInteractive: false,
    noAutopilotInstall: false,
    forceOrchestrator: false,
    forceSchema: false,
    forceAll: false,
    help: args.includes('--help') || args.includes('-h'),
  };
  // Help is guaranteed read-only and should remain available even when a
  // copied command contains an obsolete/unknown flag.
  if (parsed.help) return parsed;

  if (args.includes('--skip-verify')) {
    throw new ApplyMigrationsUsageError(
      '--skip-verify has been removed because it could advance a known-bad schema. ' +
      'Run `gbrain upgrade-preflight` and repair the reported invariant instead.',
    );
  }

  const seenValueFlags = new Set<string>();
  const forceActions = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--list': parsed.list = true; break;
      case '--dry-run': parsed.dryRun = true; break;
      case '--yes': parsed.yes = true; break;
      case '--non-interactive': parsed.nonInteractive = true; break;
      case '--no-autopilot-install': parsed.noAutopilotInstall = true; break;
      case '--force-orchestrator':
        parsed.forceOrchestrator = true;
        forceActions.add(arg);
        break;
      case '--force-schema':
        parsed.forceSchema = true;
        forceActions.add(arg);
        break;
      case '--force-all':
      case '--force':
        parsed.forceAll = true;
        forceActions.add(arg);
        break;
      case '--mode':
      case '--migration':
      case '--host-dir':
      case '--force-retry': {
        if (seenValueFlags.has(arg)) {
          throw new ApplyMigrationsUsageError(`Option ${arg} may be provided only once.`);
        }
        const value = args[i + 1];
        if (!value || value.startsWith('-')) {
          throw new ApplyMigrationsUsageError(`Option ${arg} requires a value.`);
        }
        seenValueFlags.add(arg);
        i++;
        if (arg === '--mode') parsed.mode = value as ApplyMigrationsArgs['mode'];
        else if (arg === '--migration') parsed.specificMigration = value;
        else if (arg === '--host-dir') parsed.hostDir = value;
        else {
          parsed.forceRetry = value;
          forceActions.add(arg);
        }
        break;
      }
      default:
        throw new ApplyMigrationsUsageError(
          arg.startsWith('-') ? `Unknown option: ${arg}` : `Unexpected argument: ${arg}`,
        );
    }
  }

  if (parsed.mode && !['always', 'pain_triggered', 'off'].includes(parsed.mode)) {
    throw new ApplyMigrationsUsageError(`Invalid --mode "${parsed.mode}". Allowed: always, pain_triggered, off.`);
  }
  if (forceActions.size > 1) {
    throw new ApplyMigrationsUsageError(
      `Contradictory force actions: ${[...forceActions].join(', ')}. Choose exactly one.`,
    );
  }
  if (parsed.list && parsed.dryRun) {
    throw new ApplyMigrationsUsageError('Choose either --list or --dry-run, not both.');
  }
  const hasForceAction = forceActions.size === 1;
  if (hasForceAction && (parsed.list || parsed.dryRun)) {
    throw new ApplyMigrationsUsageError('Force actions cannot be combined with --list or --dry-run.');
  }
  if (hasForceAction && parsed.specificMigration) {
    throw new ApplyMigrationsUsageError('Use either --migration or a force action, not both.');
  }
  if (hasForceAction && (parsed.mode || parsed.hostDir || parsed.noAutopilotInstall)) {
    throw new ApplyMigrationsUsageError(
      'Force actions cannot be combined with orchestrator-only --mode, --host-dir, or --no-autopilot-install.',
    );
  }
  return parsed;
}

function printHelp(): void {
  console.log(`gbrain apply-migrations — run pending migration orchestrators.

Usage:
  gbrain apply-migrations                Run all pending migrations interactively.
  gbrain apply-migrations --yes          Non-interactive; uses default mode (pain_triggered).
  gbrain apply-migrations --dry-run      Print the plan; take no action.
  gbrain apply-migrations --list         Show applied + pending migrations.
  gbrain apply-migrations --migration vX.Y.Z
                                         Run only the specified pending/partial
                                         migration by version.
  gbrain apply-migrations --force-retry vX.Y.Z
                                         Clear a wedged migration (3+ consecutive
                                         partials). Writes a 'retry' marker so the
                                         next run treats it as fresh.
  gbrain apply-migrations --force-orchestrator
                                         Reset every wedged orchestrator migration
                                         in one shot (writes 'retry' for each).
  gbrain apply-migrations --force-schema
                                         Reset schema-version drift; re-runs
                                         runMigrations from current config.version.
  gbrain apply-migrations --force        (alias --force-all) Apply both
                                         --force-orchestrator and --force-schema.
Flags:
  --mode <always|pain_triggered|off>     Set minion_mode without prompting.
  --host-dir <path>                      Include this directory in host-file walk
                                         (default scope: \$HOME/.claude + \$HOME/.openclaw).
  --no-autopilot-install                 Skip the Phase F autopilot install step.
  --non-interactive                      Equivalent to --yes; never prompt.

Exit codes:
  0  Success (including "nothing to do").
  1  An orchestrator failed.
  2  Invalid arguments.
`);
}

interface Plan {
  applied: Migration[];
  partial: Migration[];
  pending: Migration[];
  skippedFuture: Migration[];
  wedged: Migration[];
  ambiguous: Migration[];
}

function ambiguousSchemaMutationFence(
  plan: Plan,
  brainId: string,
  boundUpgrade = false,
): ApplyMigrationsOutcome | null {
  if (plan.ambiguous.length === 0) return null;
  const blockedVersions = plan.ambiguous.map(migration => migration.version);
  const message =
    `Refusing schema mutation while migration state is ambiguous for brain ${brainId}: ` +
    `${blockedVersions.join(', ')}. Verify database state, then clear only the verified version with ` +
    `${targetedForceRetryCommand('<version>', boundUpgrade)}.`;
  return outcome(1, 'ambiguous', 0, { blockedVersions, message });
}

function ambiguousForcePathFence(
  cli: Pick<ApplyMigrationsArgs, 'forceRetry' | 'forceOrchestrator' | 'forceSchema' | 'forceAll'>,
  plan: Plan,
  brainId: string,
  boundUpgrade = false,
): ApplyMigrationsOutcome | null {
  // Targeted force-retry is the only force action allowed to clear a version
  // after the operator has independently verified that database. Every broad
  // force action remains fenced while any ambiguity exists.
  if (!cli.forceOrchestrator && !cli.forceSchema && !cli.forceAll) return null;
  return ambiguousSchemaMutationFence(plan, brainId, boundUpgrade);
}

/**
 * Build the run plan.
 *
 * - applied:  has a `status: "complete"` entry for its version.
 * - partial:  has only `status: "partial"` entries (stopgap wrote one) →
 *             orchestrator runs to finish missing phases.
 * - pending:  has no entries at all and migration.version ≤ installed VERSION.
 * - skippedFuture: migration.version > installed VERSION (binary is older
 *                  than the migration; wait for a newer install).
 *
 * Codex H9: we never compare against `current VERSION >` — that rule would
 * skip v0.11.0 when running v0.11.1. Compare against completed.jsonl.
 */
function buildPlan(idx: CompletedIndex, installed: string, filterVersion?: string): Plan {
  const plan: Plan = { applied: [], partial: [], pending: [], skippedFuture: [], wedged: [], ambiguous: [] };
  for (const m of migrations) {
    if (filterVersion && m.version !== filterVersion) continue;
    if (compareVersions(m.version, installed) > 0) {
      plan.skippedFuture.push(m);
      continue;
    }
    const status = statusForVersion(m.version, idx);
    if (status === 'complete') plan.applied.push(m);
    else if (status === 'partial') plan.partial.push(m);
    else if (status === 'wedged') plan.wedged.push(m);
    else if (status === 'ambiguous') plan.ambiguous.push(m);
    else plan.pending.push(m);
  }
  return plan;
}

function selectRunnableMigrations(plan: Plan): Migration[] {
  const runnable = new Set([...plan.partial, ...plan.pending].map(migration => migration.version));
  return migrations.filter(migration => runnable.has(migration.version));
}

function earlierUnresolvedVersions(fullPlan: Plan, targetVersion: string): string[] {
  const targetIndex = migrations.findIndex(migration => migration.version === targetVersion);
  if (targetIndex < 0) return [];
  const incomplete = new Set([
    ...fullPlan.pending,
    ...fullPlan.partial,
    ...fullPlan.wedged,
    ...fullPlan.ambiguous,
  ].map(migration => migration.version));
  return migrations.slice(0, targetIndex)
    .map(migration => migration.version)
    .filter(version => incomplete.has(version));
}

function forceRetryAction(
  localStatus: ReturnType<typeof statusForVersion>,
  hasDatabaseFence: boolean,
): 'refuse' | 'clear_only' | 'retry' {
  if (localStatus === 'complete') return hasDatabaseFence ? 'clear_only' : 'refuse';
  if (hasDatabaseFence || ['partial', 'wedged', 'ambiguous'].includes(localStatus)) return 'retry';
  return 'refuse';
}

function printList(plan: Plan, installed: string): void {
  console.log(`Installed gbrain version: ${installed}\n`);
  console.log('  Status   Version   Headline');
  console.log('  -------  --------  -----------------------------------------');
  const rows: Array<{ status: string; m: Migration }> = [
    ...plan.applied.map(m => ({ status: 'applied', m })),
    ...plan.partial.map(m => ({ status: 'partial', m })),
    ...plan.wedged.map(m => ({ status: 'wedged', m })),
    ...plan.ambiguous.map(m => ({ status: 'ambiguous', m })),
    ...plan.pending.map(m => ({ status: 'pending', m })),
    ...plan.skippedFuture.map(m => ({ status: 'future', m })),
  ];
  for (const r of rows) {
    const ver = r.m.version.padEnd(8);
    const status = r.status.padEnd(7);
    console.log(`  ${status}  ${ver}  ${r.m.featurePitch.headline}`);
  }
  if (rows.length === 0) console.log('  (no migrations registered)');
  console.log('');
  const needsWork = plan.pending.length + plan.partial.length;
  if (needsWork === 0) {
    console.log('All migrations up to date.');
  } else {
    console.log(`${needsWork} migration(s) need action. Run \`gbrain apply-migrations --yes\` to apply.`);
  }
}

function printDryRun(plan: Plan, installed: string): void {
  console.log(`Dry run — installed gbrain version: ${installed}`);
  console.log('');
  if (plan.applied.length) {
    console.log('Already applied:');
    for (const m of plan.applied) console.log(`  ✓ v${m.version} — ${m.featurePitch.headline}`);
    console.log('');
  }
  if (plan.partial.length) {
    console.log('Would RESUME (previously partial):');
    for (const m of plan.partial) console.log(`  ⟳ v${m.version} — ${m.featurePitch.headline}`);
    console.log('');
  }
  if (plan.pending.length) {
    console.log('Would APPLY:');
    for (const m of plan.pending) console.log(`  → v${m.version} — ${m.featurePitch.headline}`);
    console.log('');
  }
  if (plan.skippedFuture.length) {
    console.log('Skipped (newer than installed binary):');
    for (const m of plan.skippedFuture) console.log(`  ⧗ v${m.version}`);
    console.log('');
  }
  if (plan.pending.length + plan.partial.length === 0) {
    console.log('Nothing to do.');
  } else {
    console.log('Re-run without --dry-run to apply. Use --yes to skip prompts.');
  }
}

interface ConfiguredBrainSnapshot {
  brainId: string;
  engineConfig: EngineConfig;
  gbrainConfig: GBrainConfig;
}

async function assertSnapshotIdentity(
  engine: Pick<import('../core/engine.ts').BrainEngine, 'executeRaw'>,
  snapshot: ConfiguredBrainSnapshot,
): Promise<void> {
  const actual = await readDatabaseInstanceId(engine);
  if (actual !== snapshot.brainId) {
    throw new Error('Configured database identity changed during migration execution');
  }
}

async function configuredBrainSnapshot(
  createIdentity: boolean,
): Promise<ConfiguredBrainSnapshot | null> {
  const config = loadConfig();
  if (!config) return null;
  const engineConfig = toEngineConfig(config);
  const pgliteReadOnlyAuthority = createIdentity
    ? undefined
    : assertExistingPgliteDataDirForReadOnlyOpen(engineConfig);
  const engine = await createEngine(engineConfig, { pgliteReadOnlyAuthority });
  try {
    await engine.connect(engineConfig);
    const brainId = createIdentity
      ? await getOrCreateDatabaseInstanceId(engine)
      : await readDatabaseInstanceId(engine);
    if (!brainId) {
      throw new Error(
        'This legacy brain has no durable database identity. ' +
        'Read-only migration inspection cannot create it; run `gbrain apply-migrations --yes` ' +
        'after taking the required backup.',
      );
    }
    return { brainId, engineConfig: { ...engineConfig }, gbrainConfig: { ...config } };
  } finally {
    try { await engine.disconnect(); } catch { /* best-effort */ }
  }
}

async function runReadOnlyInspection(
  cli: ApplyMigrationsArgs,
  snapshot: ConfiguredBrainSnapshot,
  installed: string,
): Promise<ApplyMigrationsOutcome> {
  let adoptionPreview: ReturnType<typeof previewLegacyMigrationStateAdoption>;
  try {
    adoptionPreview = previewLegacyMigrationStateAdoption(snapshot.brainId);
  } catch (error) {
    const message = `Cannot inspect legacy migration state: ${error instanceof Error ? error.message : String(error)}`;
    console.error(message);
    return outcome(1, 'failed', 0, { message });
  }
  const adoptionRequired = adoptionPreview.preferences === 'adopted'
    || adoptionPreview.ledgerVersionsAdopted.length > 0
    || adoptionPreview.unresolvedVersionsFenced.length > 0;
  if (adoptionRequired) {
    const versions = [
      ...adoptionPreview.ledgerVersionsAdopted,
      ...adoptionPreview.unresolvedVersionsFenced,
    ];
    const message =
      'Read-only migration inspection is blocked because legacy state still requires one-time adoption' +
      (versions.length > 0 ? ` (${[...new Set(versions)].join(', ')})` : '') +
      '. No GBrain state files or logical database rows were created or updated. ' +
      'Opening a persistent PGLite store may still update engine-internal files. ' +
      'After the required backup, run ' +
      '`gbrain apply-migrations --yes` to adopt and migrate under the single-flight locks.';
    console.error(message);
    return outcome(1, 'failed', 0, { message, blockedVersions: [...new Set(versions)] });
  }

  let completed: ReturnType<typeof loadCompletedMigrations>;
  try {
    completed = loadCompletedMigrations();
  } catch (error) {
    const message = `Migration ledger is unreadable or corrupt: ${error instanceof Error ? error.message : String(error)}`;
    console.error(message);
    return outcome(1, 'failed', 0, { message });
  }
  const idx = indexCompleted(completed, snapshot.brainId);
  const fullPlan = buildPlan(idx, installed);

  let databaseInflight: MigrationInflightRecord[];
  try {
    databaseInflight = await withSnapshotEngine(snapshot, listMigrationInflight);
  } catch (error) {
    const message = `Cannot inspect database migration fences: ${error instanceof Error ? error.message : String(error)}`;
    console.error(message);
    return outcome(1, 'failed', 0, { message });
  }
  if (databaseInflight.length > 0) {
    const blockedVersions = [...new Set(databaseInflight.map(entry => entry.version))];
    const message = `Database has unresolved migration inflight fence(s): ${blockedVersions.join(', ')}.`;
    console.error(message);
    return outcome(1, 'ambiguous', 0, { blockedVersions, message });
  }

  const registeredVersions = new Set(migrations.map(migration => migration.version));
  const ledgerOnlyUnresolved = listUnresolvedMigrationStates(completed, snapshot.brainId)
    .filter(state => !registeredVersions.has(state.version));
  if (ledgerOnlyUnresolved.length > 0) {
    const blockedVersions = ledgerOnlyUnresolved.map(state => state.version);
    const message = `Migration ledger has unresolved state for unregistered version(s): ${blockedVersions.join(', ')}.`;
    console.error(message);
    return outcome(1, ledgerOnlyUnresolved.some(state => state.status === 'ambiguous') ? 'ambiguous' : 'failed', 0, {
      blockedVersions,
      message,
    });
  }

  if (fullPlan.wedged.length > 0 || fullPlan.ambiguous.length > 0) {
    const blocked = [...fullPlan.wedged, ...fullPlan.ambiguous];
    const blockedVersions = blocked.map(migration => migration.version);
    const reason = fullPlan.ambiguous.length > 0 ? 'ambiguous' : 'wedged';
    const message = `Migration inspection found blocked state: ${blockedVersions.join(', ')}.`;
    console.error(message);
    return outcome(1, reason, 0, { blockedVersions, message });
  }

  const plan = cli.specificMigration
    ? buildPlan(idx, installed, cli.specificMigration)
    : fullPlan;
  if (cli.specificMigration) {
    const earlier = earlierUnresolvedVersions(fullPlan, cli.specificMigration);
    if (earlier.length > 0) {
      const message = `Earlier migration(s) remain unresolved: ${earlier.join(', ')}.`;
      console.error(message);
      return outcome(1, 'failed', 0, { blockedVersions: earlier, message });
    }
    if (plan.applied.length + plan.partial.length + plan.pending.length
      + plan.skippedFuture.length + plan.ambiguous.length === 0) {
      const message = `No migration registered with version "${cli.specificMigration}".`;
      console.error(message);
      return outcome(2, 'invalid_arguments', 0, { message });
    }
  }

  if (cli.list) {
    printList(plan, installed);
    return outcome(0, 'listed');
  }
  printDryRun(plan, installed);
  return outcome(0, 'dry_run');
}

async function withSnapshotEngine<T>(
  snapshot: ConfiguredBrainSnapshot,
  fn: (engine: import('../core/engine.ts').BrainEngine) => Promise<T>,
): Promise<T> {
  const engine = await createEngine(snapshot.engineConfig);
  try {
    await engine.connect(snapshot.engineConfig);
    await assertSnapshotIdentity(engine, snapshot);
    return await fn(engine);
  } finally {
    try { await engine.disconnect(); } catch { /* best-effort */ }
  }
}

function orchestratorOptsFrom(
  cli: ApplyMigrationsArgs,
  snapshot: ConfiguredBrainSnapshot,
  upgradeTransition?: UpgradeChildTransition,
): OrchestratorOpts {
  return {
    yes: cli.yes || cli.nonInteractive,
    mode: cli.mode,
    dryRun: cli.dryRun,
    hostDir: cli.hostDir,
    noAutopilotInstall: cli.noAutopilotInstall,
    brainId: snapshot.brainId,
    engineConfig: snapshot.engineConfig,
    gbrainConfig: snapshot.gbrainConfig,
    upgradeTransition,
  };
}

/**
 * Entry point. Does not call connectEngine — each phase inside an
 * orchestrator manages its own engine / subprocess lifecycle.
 */
export interface RunApplyMigrationsOptions {
  /** Internal upgrade fence: undefined means ordinary CLI invocation. */
  expectedBrainId?: string | null;
  /** Internal authority propagated only by a bound post-upgrade transition. */
  upgradeTransition?: UpgradeChildTransition;
  /** @internal Recursion guard for metadata-preserving inspection policy. */
  readOnlyPolicyApplied?: boolean;
}

export async function runApplyMigrations(
  args: string[],
  options: RunApplyMigrationsOptions = {},
): Promise<ApplyMigrationsOutcome> {
  let cli: ApplyMigrationsArgs;
  try {
    cli = parseArgs(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return outcome(2, 'invalid_arguments', 0, { message });
  }
  if (cli.help) { printHelp(); return outcome(0, 'help'); }
  if ((cli.list || cli.dryRun) && !options.readOnlyPolicyApplied) {
    return withOwnedStateReadPolicy(false, () => runApplyMigrations(args, {
      ...options,
      readOnlyPolicyApplied: true,
    }));
  }

  const installed = VERSION.replace(/^v/, '').trim() || '0.0.0';
  const boundUpgrade = options.upgradeTransition !== undefined;

  if (options.upgradeTransition) {
    const transition = options.upgradeTransition;
    const validAuthority = options.expectedBrainId !== undefined
      && options.expectedBrainId === transition.brainId
      && transition.toVersion === VERSION;
    if (!validAuthority) {
      const message = 'Invalid bound post-upgrade migration authority; no migration was started.';
      console.error(message);
      return outcome(1, 'failed', 0, { message });
    }
  }

  // Fail closed on corruption even when no brain is currently configured.
  // This is validation only: the value is deliberately discarded and loaded
  // again after both locks before it can influence a migration plan.
  try {
    loadCompletedMigrations();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message =
      `Migration ledger is unreadable or corrupt: ${detail}. ` +
      'Repair ~/.gbrain/migrations/completed.jsonl before retrying.';
    console.error(message);
    return outcome(1, 'failed', 0, { message });
  }

  // First-install guard (postinstall hook calls us even on `bun add gbrain`
  // before the user has run `gbrain init`). No config = no brain = nothing
  // to migrate. Exit silently for --yes / --non-interactive so postinstall
  // stays quiet; mention the init step when invoked interactively.
  let snapshot: ConfiguredBrainSnapshot | null;
  try {
    // Upgrade handoffs are already bound to the database identity observed by
    // the parent binary. Never create/adopt an identity before enforcing that
    // binding: a newly configured or mis-routed legacy brain must receive no
    // logical GBrain-state mutation when the expected authority is absent/wrong.
    const mayCreateIdentity = options.expectedBrainId === undefined
      && !(cli.list || cli.dryRun);
    snapshot = await configuredBrainSnapshot(mayCreateIdentity);
  } catch (error) {
    const message = `Cannot identify configured brain: ${error instanceof Error ? error.message : String(error)}`;
    console.error(message);
    return outcome(1, 'failed', 0, { message });
  }
  if (!snapshot) {
    if (options.expectedBrainId !== undefined && options.expectedBrainId !== null) {
      const message =
        `Configured brain disappeared before migration execution; expected ${options.expectedBrainId}. ` +
        'No migration was started.';
      console.error(message);
      return outcome(1, 'failed', 0, { message });
    }
    if (cli.list) console.log('No brain configured. Run `gbrain init` to set one up.');
    else if (cli.dryRun) console.log('No brain configured (run `gbrain init` first). Nothing to migrate.');
    return outcome(0, 'no_config');
  }
  if (options.expectedBrainId !== undefined
    && (options.expectedBrainId === null || snapshot.brainId !== options.expectedBrainId)) {
    const message = options.expectedBrainId === null
      ? `A brain became configured during a binary-only upgrade handoff (${snapshot.brainId}); no migration was started.`
      : `Configured brain ${snapshot.brainId} does not match pending upgrade brain ${options.expectedBrainId}; no migration was started.`;
    console.error(message);
    return outcome(1, 'failed', 0, { message });
  }

  // These modes promise inspection only. Do not create a database identity,
  // acquire mutable lock files, adopt legacy state, or write scoped receipts.
  if (cli.list || cli.dryRun) {
    return runReadOnlyInspection(cli, snapshot, installed);
  }

  let localRunLock: ReturnType<typeof holdPackLock>;
  try {
    // Database identities contain a `db:` prefix. Keep the filename portable
    // to Windows while preserving one deterministic lock per brain.
    localRunLock = holdPackLock(migrationRunLockName(snapshot.brainId), {
      lockDir: gbrainPath('locks'),
      ttlMs: 2 * 60 * 60 * 1000,
    });
  } catch (error) {
    const message = `Another migration runner is active for ${snapshot.brainId}: ${error instanceof Error ? error.message : String(error)}`;
    console.error(message);
    return outcome(1, 'failed', 0, { message });
  }
  let databaseRunLock: DatabaseSessionLockHandle | null = null;
  try {
    if (snapshot.engineConfig.engine === 'postgres') {
      const configuredUrl = snapshot.engineConfig.database_url;
      if (!configuredUrl) throw new Error('Postgres migration snapshot has no database URL');
      const lockUrl = resolveDatabaseSessionLockUrl(
        configuredUrl,
        process.env.GBRAIN_DIRECT_DATABASE_URL?.trim() || deriveDirectUrl(configuredUrl),
      );
      databaseRunLock = await acquireDatabaseSessionLock(lockUrl, MIGRATION_RUN_LOCK_KEY);
      await databaseRunLock.assertDatabaseIdentity(snapshot.brainId);
    }
  } catch (error) {
    try { await databaseRunLock?.release(); } catch { /* preserve acquire/identity error */ }
    databaseRunLock = null;
    localRunLock.release();
    const message = `Could not acquire the migration single-flight lock: ${error instanceof Error ? error.message : String(error)}`;
    console.error(message);
    return outcome(1, 'failed', 0, { message });
  }

  try {

  // Every state authority read happens only after both single-flight locks are
  // held. A runner that waited behind another process must plan from the
  // winner's durable receipts, never from a pre-lock stale snapshot.
  try {
    adoptLegacyMigrationState(snapshot.brainId);
  } catch (error) {
    const message = `Cannot adopt legacy migration state: ${error instanceof Error ? error.message : String(error)}`;
    console.error(message);
    return outcome(1, 'failed', 0, { message });
  }

  let completed: ReturnType<typeof loadCompletedMigrations>;
  try {
    completed = loadCompletedMigrations();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message =
      `Migration ledger is unreadable or corrupt: ${detail}. ` +
      'Repair ~/.gbrain/migrations/completed.jsonl before retrying.';
    console.error(message);
    return outcome(1, 'failed', 0, { message });
  }

  const idx = indexCompleted(completed, snapshot.brainId);

  // Bug 3 — --force-retry: write an explicit reset marker for a wedged
  // migration, then return. User re-runs `gbrain apply-migrations --yes`
  // to actually re-attempt.
  if (cli.forceRetry) {
    const target = migrations.find(m => m.version === cli.forceRetry);
    if (!target) {
      console.error(`No migration registered with version "${cli.forceRetry}". Run \`gbrain apply-migrations --list\`.`);
      return outcome(2, 'invalid_arguments', 0, { message: `Unknown migration ${cli.forceRetry}` });
    }
    let hasDatabaseFence: boolean;
    try {
      hasDatabaseFence = await withSnapshotEngine(
        snapshot,
        engine => migrationInflightExists(engine, cli.forceRetry!),
      );
    } catch (error) {
      const message = `Cannot inspect migration ${cli.forceRetry} recovery fence: ${error instanceof Error ? error.message : String(error)}`;
      console.error(message);
      return outcome(1, 'failed', 0, { message });
    }
    const localStatus = statusForVersion(cli.forceRetry, idx);
    const recoveryAction = forceRetryAction(localStatus, hasDatabaseFence);
    if (recoveryAction === 'refuse') {
      const message =
        `Refusing --force-retry for ${cli.forceRetry}: local state is ${localStatus} and no database fence exists. ` +
        'This command only recovers verified unresolved attempts.';
      console.error(message);
      return outcome(2, 'invalid_arguments', 0, { message });
    }
    await withSnapshotEngine(snapshot, engine => clearMigrationInflight(engine, cli.forceRetry!));
    if (recoveryAction === 'clear_only') {
      console.log(`Cleared residual database fence for already-complete migration v${cli.forceRetry}; no replay was scheduled.`);
      return outcome(0, 'force_retry_recorded');
    }
    appendCompletedMigration({ version: cli.forceRetry, brain_id: snapshot.brainId, status: 'retry' });
    console.log(
      boundUpgrade
        ? `Wrote 'retry' marker for v${cli.forceRetry}; the bound post-upgrade invocation will resume it.`
        : `Wrote 'retry' marker for v${cli.forceRetry}. Run \`gbrain apply-migrations --yes\` to re-attempt.`,
    );
    return outcome(0, 'force_retry_recorded');
  }

  let databaseInflight: MigrationInflightRecord[];
  try {
    databaseInflight = await withSnapshotEngine(snapshot, listMigrationInflight);
  } catch (error) {
    const message = `Cannot inspect database migration fences: ${error instanceof Error ? error.message : String(error)}`;
    console.error(message);
    return outcome(1, 'failed', 0, { message });
  }

  const fullPlan = buildPlan(idx, installed);

  if (databaseInflight.length > 0) {
    const blockedVersions = [...new Set(databaseInflight.map(entry => entry.version))];
    const message =
      `Database has unresolved migration inflight fence(s): ${blockedVersions.join(', ')}. ` +
      'Verify the database, then clear only the verified version with ' +
      `${targetedForceRetryCommand('<version>', boundUpgrade)}.`;
    console.error(message);
    return outcome(1, 'ambiguous', 0, { blockedVersions, message });
  }

  // Unknown/retired registry versions still carry authority in the ledger.
  // Never let filtering the current registry hide their unresolved state.
  const registeredVersions = new Set(migrations.map(migration => migration.version));
  const ledgerOnlyUnresolved = listUnresolvedMigrationStates(completed, snapshot.brainId)
    .filter(state => !registeredVersions.has(state.version));
  if (ledgerOnlyUnresolved.length > 0) {
    const blockedVersions = ledgerOnlyUnresolved.map(state => state.version);
    const message =
      `Migration ledger has unresolved state for unregistered version(s): ${blockedVersions.join(', ')}. ` +
      'Restore the matching release or reconcile these receipts before mutation.';
    console.error(message);
    return outcome(1, ledgerOnlyUnresolved.some(state => state.status === 'ambiguous') ? 'ambiguous' : 'failed', 0, {
      blockedVersions,
      message,
    });
  }

  // A schema transaction whose commit/rollback never became observable is a
  // hard mutation fence. --force-schema/--force-all used to return before the
  // normal plan check and could start a second transaction. Only the explicit,
  // brain-scoped --force-retry path above may clear this state after an operator
  // has verified the database.
  if (cli.forceOrchestrator || cli.forceSchema || cli.forceAll) {
    const fence = ambiguousForcePathFence(cli, fullPlan, snapshot.brainId, boundUpgrade);
    if (fence) {
      console.error(fence.message);
      return fence;
    }
  }

  // v0.30.1 (codex T5): --force-orchestrator OR --force-all writes a 'retry'
  // marker for EVERY wedged orchestrator migration in one shot. User re-runs
  // `gbrain apply-migrations --yes` to actually re-attempt.
  if (cli.forceOrchestrator || cli.forceAll) {
    let resetCount = 0;
    for (const m of migrations) {
      const status = statusForVersion(m.version, idx);
      if (status === 'wedged') {
        appendCompletedMigration({ version: m.version, brain_id: snapshot.brainId, status: 'retry' });
        console.log(`Wrote 'retry' marker for v${m.version} (${m.featurePitch.headline.slice(0, 60)})`);
        resetCount++;
      }
    }
    if (resetCount === 0) {
      console.log('No wedged orchestrator migrations found.');
    } else {
      console.log(`\nReset ${resetCount} wedged orchestrator migration(s). Run \`gbrain apply-migrations --yes\` to re-attempt.`);
    }
    if (!cli.forceAll) return outcome(0, 'force_orchestrator_recorded'); // --force-schema continues below if --force-all is set
  }

  // v0.30.1 (codex T5): --force-schema OR --force-all resets schema-version
  // drift by re-running runMigrations(). When the actual DDL state diverges
  // from config.version (the brain_config incident), this is the manual
  // recovery path.
  if (cli.forceSchema || cli.forceAll) {
    try {
      const eng = await createEngine(snapshot.engineConfig);
      try {
        await eng.connect(snapshot.engineConfig);
        await assertSnapshotIdentity(eng, snapshot);
        console.log('Running the canonical schema bootstrap, migration, and verification path...');
        await eng.initSchema();
        console.log('Schema initialization and verification completed.');
      } finally {
        await eng.disconnect().catch(() => {});
      }
    } catch (err) {
      const message = `--force-schema failed: ${(err as Error).message}`;
      console.error(message);
      return outcome(1, 'failed', 0, { message });
    }
    if (cli.forceSchema && !cli.forceAll) return outcome(0, 'schema_verified');
    if (cli.forceAll) return outcome(0, 'schema_verified'); // both surfaces flushed
  }

  // Pre-flight: warn if schema migrations (migrate.ts) are behind.
  // apply-migrations runs orchestrator migrations only; schema migrations
  // run via connectEngine() / initSchema(). Users often expect this CLI
  // to handle everything (Issue 1 from v0.18.0 field report).
  try {
    const { LATEST_VERSION } = await import('../core/migrate.ts');
    // v0.36.x #1100: skip this warning-only extra connection on PGLite.
    if (snapshot.engineConfig.engine !== 'pglite') {
      const eng = await createEngine(snapshot.engineConfig);
      try {
        await eng.connect(snapshot.engineConfig);
        await assertSnapshotIdentity(eng, snapshot);
        const verStr = await eng.getConfig('version');
        const schemaVer = parseInt(verStr || '1', 10);
        if (schemaVer < LATEST_VERSION) {
          console.warn(
            `\n⚠️  Schema version ${schemaVer} is behind latest ${LATEST_VERSION}.\n` +
            `   Schema migrations run automatically on next connectEngine() / initSchema().\n` +
            `   To run them now: gbrain init --migrate-only\n`,
          );
        }
      } finally {
        await eng.disconnect().catch(() => {});
      }
    }
  } catch {
    // Non-fatal: if DB is unreachable, orchestrator migrations can still
    // run their filesystem-only phases.
  }

  const plan = cli.specificMigration
    ? buildPlan(idx, installed, cli.specificMigration)
    : fullPlan;

  // Global chain fence: a selective --migration must never hide a blocked
  // earlier/other version from the same brain.
  if (fullPlan.wedged.length > 0 || fullPlan.ambiguous.length > 0) {
    const globallyBlocked = [...fullPlan.wedged, ...fullPlan.ambiguous];
    const blockedVersions = globallyBlocked.map(migration => migration.version);
    for (const migration of fullPlan.wedged) {
      console.error(
        `\nMigration v${migration.version} is WEDGED; after verification run ` +
        targetedForceRetryCommand(migration.version, boundUpgrade) + '.',
      );
    }
    for (const migration of fullPlan.ambiguous) {
      console.error(
        `\nMigration v${migration.version} has AMBIGUOUS state; after database verification run ` +
        targetedForceRetryCommand(migration.version, boundUpgrade) + '.',
      );
    }
    return outcome(1, fullPlan.ambiguous.length > 0 ? 'ambiguous' : 'wedged', 0, { blockedVersions });
  }

  if (cli.specificMigration) {
    const earlier = earlierUnresolvedVersions(fullPlan, cli.specificMigration);
    if (earlier.length > 0) {
      const message =
        `Refusing selective migration ${cli.specificMigration}: earlier migration(s) remain unresolved: ${earlier.join(', ')}.`;
      console.error(message);
      return outcome(1, 'failed', 0, { blockedVersions: earlier, message });
    }
  }

  // Bug 3 — surface wedged migrations as a loud, actionable error.
  if (plan.wedged.length > 0) {
    for (const m of plan.wedged) {
      console.error(
        `\nMigration v${m.version} is WEDGED (${MAX_CONSECUTIVE_PARTIALS}+ consecutive partials with no completion). ` +
        `Check ~/.gbrain/upgrade-errors.jsonl for the last failure reasons, fix the underlying issue, then run:\n` +
        `  ${targetedForceRetryCommand(m.version, boundUpgrade)}\n` +
        (boundUpgrade
          ? 'The same bound post-upgrade invocation resumes automatically after the repair.'
          : 'Then re-run `gbrain apply-migrations --yes`.'),
      );
    }
  }
  if (plan.ambiguous.length > 0) {
    for (const m of plan.ambiguous) {
      console.error(
        `\nMigration v${m.version} has AMBIGUOUS schema state: its prior transaction did not settle ` +
        `within the bounded observation window. Do not retry automatically. Verify the database state, ` +
        `then run ${targetedForceRetryCommand(m.version, boundUpgrade)} only when safe.`,
      );
    }
  }
  if (plan.wedged.length > 0 || plan.ambiguous.length > 0) {
    const blockedVersions = [...plan.wedged, ...plan.ambiguous].map(m => m.version);
    // Orchestrators are ordered and may depend on earlier migrations. Never
    // skip a blocked version and run later pending work.
    return outcome(1, plan.ambiguous.length > 0 ? 'ambiguous' : 'wedged', 0, { blockedVersions });
  }

  if (cli.specificMigration && plan.applied.length + plan.partial.length + plan.pending.length + plan.skippedFuture.length + plan.ambiguous.length === 0) {
    console.error(`No migration registered with version "${cli.specificMigration}". Run \`gbrain apply-migrations --list\` to see registered versions.`);
    return outcome(2, 'invalid_arguments', 0, { message: `Unknown migration ${cli.specificMigration}` });
  }

  if (cli.list) { printList(plan, installed); return outcome(0, 'listed'); }
  if (cli.dryRun) { printDryRun(plan, installed); return outcome(0, 'dry_run'); }

  const toRun = selectRunnableMigrations(plan);
  if (toRun.length === 0) {
    console.log('All migrations up to date.');
    return outcome(0, 'up_to_date');
  }

  // Run each orchestrator in registry order. An orchestrator failure aborts
  // the rest of the chain; fixing the failure and re-running picks up where
  // we left off (per-phase idempotency markers + resume from "partial").
  //
  // Bug 3 — the RUNNER owns the ledger write now. Orchestrators return their
  // result; we persist it here with a canonical shape. If the write fails,
  // surface the error and DO NOT proceed to the next migration (a silent
  // ledger drop was the root cause of the original infinite-retry symptom).
  let migrationsRun = 0;
  for (const m of toRun) {
    try {
      await databaseRunLock?.assertOwned();
    } catch (error) {
      const message = `Migration single-flight lock was lost before ${m.version}: ${error instanceof Error ? error.message : String(error)}`;
      console.error(message);
      return outcome(1, 'failed', migrationsRun, { blockedVersions: [m.version], message });
    }
    console.log(`\n=== Applying migration v${m.version}: ${m.featurePitch.headline} ===`);
    const inflight: MigrationInflightRecord = {
      version: m.version,
      brain_id: snapshot.brainId,
      attempt_id: randomUUID(),
      started_at: new Date().toISOString(),
    };
    try {
      // DB-visible claim first. If the local fsynced ledger write then fails,
      // keep the DB fence in place so another host cannot retry unseen work.
      await withSnapshotEngine(snapshot, engine => claimMigrationInflight(engine, inflight));
      appendInflightMigration({
        version: m.version,
        brain_id: snapshot.brainId,
        attempt_id: inflight.attempt_id,
      });
    } catch (error) {
      const message = `Could not publish migration ${m.version} inflight fence: ${error instanceof Error ? error.message : String(error)}`;
      console.error(message);
      return outcome(1, 'ambiguous', migrationsRun, { blockedVersions: [m.version], message });
    }

    let result: Awaited<ReturnType<Migration['orchestrator']>>;
    try {
      result = await m.orchestrator(orchestratorOptsFrom(cli, snapshot, options.upgradeTransition));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Migration v${m.version} threw: ${msg}`);
      // A timed-out in-process transaction is not known rolled back. Record a
      // terminal ambiguity so subsequent runs cannot race the original work.
      const ambiguous = isMigrateOnlyAmbiguousState(e);
      try {
        const receipt = {
          version: m.version,
          brain_id: snapshot.brainId,
          attempt_id: inflight.attempt_id,
          attempt_terminal: true,
        };
        if (ambiguous) appendAmbiguousMigration(receipt);
        else appendCompletedMigration({ ...receipt, status: 'partial' });
      } catch (receiptError) {
        const message = `Could not persist terminal failure receipt for ${m.version}: ${receiptError instanceof Error ? receiptError.message : String(receiptError)}. Database inflight fence retained.`;
        console.error(message);
        return outcome(1, 'ambiguous', migrationsRun, { blockedVersions: [m.version], message });
      }
      if (!ambiguous) {
        try {
          await withSnapshotEngine(snapshot, engine => releaseMigrationInflight(engine, inflight));
        } catch (releaseError) {
          const message = `Terminal receipt is durable but database inflight release failed for ${m.version}: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`;
          console.error(message);
          return outcome(1, 'ambiguous', migrationsRun, { blockedVersions: [m.version], message });
        }
      }
      return outcome(
        1,
        ambiguous ? 'ambiguous' : 'failed',
        migrationsRun,
        { blockedVersions: [m.version], message: msg },
      );
    }

    const hasFailedPhase = result.phases.some(phase => phase.status === 'failed');
    const failedOutcome = result.status === 'failed' || hasFailedPhase;
    const ambiguous = failedOutcome
      && result.phases.some(phase => isMigrateOnlyAmbiguousState(phase.detail));
    const receipt = {
      version: m.version,
      brain_id: snapshot.brainId,
      attempt_id: inflight.attempt_id,
      attempt_terminal: true,
      phases: result.phases,
      files_rewritten: result.files_rewritten,
      autopilot_installed: result.autopilot_installed,
      install_target: result.install_target,
      apply_migrations_pending: result.pending_host_work ? result.pending_host_work > 0 : undefined,
    };
    try {
      if (ambiguous) appendAmbiguousMigration(receipt);
      else appendCompletedMigration({
        ...receipt,
        status: result.status === 'complete' && !hasFailedPhase ? 'complete' : 'partial',
      });
    } catch (receiptError) {
      const message = `Failed to persist terminal ledger entry for v${m.version}: ${receiptError instanceof Error ? receiptError.message : String(receiptError)}. Database inflight fence retained.`;
      console.error(message);
      return outcome(1, 'ambiguous', migrationsRun, { blockedVersions: [m.version], message });
    }

    if (!ambiguous) {
      try {
        await withSnapshotEngine(snapshot, engine => releaseMigrationInflight(engine, inflight));
      } catch (releaseError) {
        const message = `Terminal receipt is durable but database inflight release failed for ${m.version}: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`;
        console.error(message);
        return outcome(1, 'ambiguous', migrationsRun, { blockedVersions: [m.version], message });
      }
    }

    if (failedOutcome) {
      const failedPhase = result.phases.find(phase => phase.status === 'failed');
      console.error(
        hasFailedPhase && result.status === 'complete'
          ? `Migration v${m.version} reported complete with a failed critical phase; treating it as failed.`
          : `Migration v${m.version} reported status=failed${failedPhase?.name ? ` in phase ${failedPhase.name}` : ''}${failedPhase?.detail ? `: ${failedPhase.detail}` : ''}.`,
      );
      return outcome(1, ambiguous ? 'ambiguous' : 'failed', migrationsRun, { blockedVersions: [m.version] });
    }
    if (result.status === 'partial') {
      console.log(`Migration v${m.version} finished as PARTIAL. Re-run \`gbrain apply-migrations --yes\` after resolving any pending host-work items.`);
      return outcome(1, 'partial', migrationsRun + 1, { blockedVersions: [m.version] });
    }
    console.log(`Migration v${m.version} complete.`);
    migrationsRun++;
  }

  return outcome(0, 'complete', migrationsRun);
  } finally {
    try { await databaseRunLock?.release(); }
    finally { localRunLock.release(); }
  }
}

/** Exported for unit tests only. Do not use from production code. */
export const __testing = {
  parseArgs,
  buildPlan,
  indexCompleted,
  statusForVersion,
  ambiguousSchemaMutationFence,
  ambiguousForcePathFence,
  selectRunnableMigrations,
  earlierUnresolvedVersions,
  forceRetryAction,
};
