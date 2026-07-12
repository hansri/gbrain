/**
 * `gbrain upgrade-preflight` — fail-closed checks that must run before schema
 * migrations which tighten ownership invariants.
 *
 * v0.42.59.0 introduces migration v124, making `(source_id, source_path)` a
 * unique partial key. Older brains can contain more than one page claiming the
 * same repo-relative path. The schema migration deliberately refuses to guess
 * which page owns that file; this command gives both Postgres and PGLite users
 * a supported inspection and narrowly-scoped repair path before initSchema()
 * runs.
 */

import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, toEngineConfig } from '../core/config.ts';
import {
  assertExistingPgliteDataDirForReadOnlyOpen,
  createEngine,
} from '../core/engine-factory.ts';
import { readDatabaseInstanceId } from '../core/database-instance-id.ts';
import type { UpgradeChildTransition } from '../core/upgrade-child-capability.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { VERSION } from '../version.ts';
import { isPublicSchemaAuthority } from '../core/db.ts';

export interface SourcePathOwnerConflict {
  source_id: string;
  source_path: string;
  owners: string[];
}

export interface SourcePathRepairSpec {
  sourceId: string;
  sourcePath: string;
  keepSlug: string;
}

export interface SourcePathRepairReceipt extends SourcePathRepairSpec {
  cleared_slugs: string[];
  remaining_conflicts: number;
}

interface SourcePathOwnerRow {
  source_id: string;
  source_path: string;
  slug: string;
}

interface SchemaAuthorityRow {
  current_schema: string | null;
  explicit_schemas: string[] | string | null;
}

/** Escape terminal controls/bidi overrides while preserving exact JSON data. */
export function escapeTerminalText(value: string): string {
  return value.replace(
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
    char => `\\u{${char.codePointAt(0)!.toString(16)}}`,
  );
}

/**
 * Fail closed before the preflight reads or mutates upgrade-sensitive state.
 *
 * The command deliberately connects without initSchema(), so it cannot rely
 * on the normal schema-mutation bootstrap to validate search_path first. Keep
 * this probe on the BrainEngine surface so it runs identically on PGLite and
 * Postgres, including through withConfiguredEngine's direct lifecycle.
 */
export async function assertUpgradePreflightSchemaAuthority(
  engine: Pick<BrainEngine, 'executeRaw'>,
): Promise<void> {
  const rows = await engine.executeRaw<SchemaAuthorityRow>(
    `SELECT current_schema()::text AS current_schema,
            current_schemas(false)::text[] AS explicit_schemas`,
  );
  if (rows.length !== 1
    || !isPublicSchemaAuthority(rows[0]?.current_schema, rows[0]?.explicit_schemas)) {
    throw new Error(
      'Refusing upgrade preflight: incompatible search_path. ' +
      'GBrain schema authority is public; use an effective public-only path.',
    );
  }
}

/**
 * Return every conflicting ownership group in deterministic order.
 *
 * Keep the SQL row-shaped rather than using array_agg so Postgres and PGLite
 * return exactly the same wire shape. Grouping in TypeScript also makes the
 * result straightforward to render as stable JSON for upgrade automation.
 */
export async function inspectSourcePathOwnership(
  engine: BrainEngine,
): Promise<SourcePathOwnerConflict[]> {
  const rows = await engine.transaction(async tx => {
    // Keep the authority proof and inspection on one transaction-scoped
    // connection. Every relation is still public-qualified so a transaction
    // pooler cannot redirect a later statement even if backend GUCs differ.
    await assertUpgradePreflightSchemaAuthority(tx);
    const columns = await tx.executeRaw<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'pages'
          AND column_name IN ('id', 'source_id', 'source_path', 'slug')`,
    );
    if (new Set(columns.map(row => row.column_name)).size < 4) {
      // Ownership is introduced only after these columns exist. Older/partial
      // brains are safe to advance through the additive migrations that create
      // them; v123 performs the same check again before its compatibility break.
      return [];
    }
    return tx.executeRaw<SourcePathOwnerRow>(
      `SELECT p.source_id, p.source_path, p.slug
         FROM public.pages p
        WHERE p.source_path IS NOT NULL
          AND EXISTS (
            SELECT 1
              FROM public.pages other
             WHERE other.source_id = p.source_id
               AND other.source_path = p.source_path
               AND other.id <> p.id
          )
        ORDER BY p.source_id, p.source_path, p.slug`,
    );
  });

  const grouped = new Map<string, SourcePathOwnerConflict>();
  for (const row of rows) {
    const key = `${row.source_id}\0${row.source_path}`;
    const conflict = grouped.get(key) ?? {
      source_id: row.source_id,
      source_path: row.source_path,
      owners: [],
    };
    conflict.owners.push(row.slug);
    grouped.set(key, conflict);
  }
  return [...grouped.values()];
}

/**
 * Keep one explicitly named owner and clear only the competing source_path
 * claims. Page content, slugs, versions, and audit history are preserved.
 */
export async function repairSourcePathOwnership(
  engine: BrainEngine,
  spec: SourcePathRepairSpec,
): Promise<SourcePathRepairReceipt> {
  if (!spec.sourceId || spec.sourcePath === undefined || !spec.keepSlug) {
    throw new Error('repair requires non-empty sourceId and keepSlug plus an explicit sourcePath');
  }

  const cleared = await engine.transaction(async tx => {
    // This check must run on the exact transaction connection that performs
    // the repair; validating an arbitrary pooled connection would not protect
    // a transaction-mode deployment with heterogeneous backend GUC state.
    await assertUpgradePreflightSchemaAuthority(tx);
    // Serialize with import/sync and with migration v124's own preflight.
    await tx.executeRaw('LOCK TABLE public.pages IN SHARE ROW EXCLUSIVE MODE');

    const owners = await tx.executeRaw<{ slug: string }>(
      `SELECT slug
         FROM public.pages
        WHERE source_id = $1 AND source_path = $2
        ORDER BY slug`,
      [spec.sourceId, spec.sourcePath],
    );
    const slugs = owners.map(row => row.slug);
    if (slugs.length < 2) {
      throw new Error(
        `no duplicate ownership group exists for source=${escapeTerminalText(spec.sourceId)} ` +
        `path=${escapeTerminalText(spec.sourcePath)}`,
      );
    }
    if (!slugs.includes(spec.keepSlug)) {
      throw new Error(
        `keep slug "${escapeTerminalText(spec.keepSlug)}" is not an owner; current owners: ` +
        slugs.map(escapeTerminalText).join(', '),
      );
    }

    const updated = await tx.executeRaw<{ slug: string }>(
      `UPDATE public.pages
          SET source_path = NULL
        WHERE source_id = $1
          AND source_path = $2
          AND slug <> $3
      RETURNING slug`,
      [spec.sourceId, spec.sourcePath, spec.keepSlug],
    );
    return updated.map(row => row.slug).sort();
  });

  const remaining = await inspectSourcePathOwnership(engine);
  return {
    ...spec,
    cleared_slugs: cleared,
    remaining_conflicts: remaining.length,
  };
}

async function withConfiguredEngine<T>(
  fn: (engine: BrainEngine) => Promise<T>,
  expectedBrainId?: string,
): Promise<T> {
  const config = loadConfig();
  if (!config) {
    throw new Error('No brain configured. Run `gbrain init` first.');
  }
  const engineConfig = toEngineConfig(config);
  // Preflight/repair must operate on the already-configured store. A missing
  // or redirected PGLite path is an authority failure, never permission to
  // create a new empty database.
  const pgliteReadOnlyAuthority = assertExistingPgliteDataDirForReadOnlyOpen(engineConfig);
  const engine = await createEngine(engineConfig, { pgliteReadOnlyAuthority });
  try {
    // Connect directly. Do NOT call initSchema/connectEngine here: the entire
    // point is to inspect and repair pre-v124 state before migrations run.
    await engine.connect(engineConfig);
    if (expectedBrainId !== undefined) {
      const actualBrainId = await readDatabaseInstanceId(engine);
      if (actualBrainId !== expectedBrainId) {
        throw new Error(
          `Configured brain ${actualBrainId ?? '<missing>'} does not match pending upgrade brain ` +
          `${expectedBrainId}; ownership repair was not started.`,
        );
      }
    }
    return await fn(engine);
  } finally {
    try { await engine.disconnect(); } catch { /* best-effort */ }
  }
}

export interface UpgradeOwnershipRepairAuthority {
  expectedBrainId: string;
  upgradeTransition: UpgradeChildTransition;
}

const UPGRADE_TRANSITION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UPGRADE_DATABASE_ID_RE =
  /^db:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Database mutation boundary for an unresolved-upgrade ownership repair.
 * Only upgrade.ts can reach this through the fixed post-upgrade recovery
 * command; the transition and current database are both revalidated here.
 */
export async function repairSourcePathOwnershipForUpgrade(
  spec: SourcePathRepairSpec,
  authority: UpgradeOwnershipRepairAuthority,
): Promise<SourcePathRepairReceipt> {
  const transition = authority.upgradeTransition;
  if (
    !UPGRADE_TRANSITION_ID_RE.test(transition.transitionId)
    || !UPGRADE_DATABASE_ID_RE.test(authority.expectedBrainId)
    || transition.brainId !== authority.expectedBrainId
    || transition.toVersion !== VERSION
  ) {
    throw new Error(
      'Invalid bound post-upgrade ownership-repair authority; no repair ran.',
    );
  }
  return withConfiguredEngine(
    engine => repairSourcePathOwnership(engine, spec),
    authority.expectedBrainId,
  );
}

interface ParsedArgs {
  repair: boolean;
  json: boolean;
  yes: boolean;
  sourceId?: string;
  sourcePath?: string;
  keepSlug?: string;
  help: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const value = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  return {
    repair: args[0] === 'repair',
    json: args.includes('--json'),
    yes: args.includes('--yes'),
    sourceId: value('--source'),
    sourcePath: value('--path'),
    keepSlug: value('--keep'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

function printHelp(): void {
  console.log(`gbrain upgrade-preflight — inspect upgrade-blocking ownership conflicts.

Usage:
  gbrain upgrade-preflight [--json]
  gbrain upgrade-preflight repair --source <id> --path <path> --keep <slug> --yes [--json]

The repair keeps the explicitly named page as the file owner and clears
source_path only on the competing page rows. It never deletes page content.

Exit codes:
  0  No conflicts remain, or the requested repair completed.
  1  Conflicts remain or the operation failed.
  2  Invalid arguments or missing --yes confirmation.
`);
}

export async function runUpgradePreflight(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.help) {
    printHelp();
    return;
  }

  if (parsed.repair) {
    if (!parsed.sourceId || parsed.sourcePath === undefined || !parsed.keepSlug) {
      console.error('Usage: gbrain upgrade-preflight repair --source <id> --path <path> --keep <slug> --yes');
      setCliExitVerdict(2);
      return;
    }
    if (!parsed.yes) {
      console.error('Refusing repair without --yes. Review the owners, then name the page to keep explicitly.');
      setCliExitVerdict(2);
      return;
    }
    try {
      const receipt = await withConfiguredEngine(engine => repairSourcePathOwnership(engine, {
        sourceId: parsed.sourceId!,
        sourcePath: parsed.sourcePath!,
        keepSlug: parsed.keepSlug!,
      }));
      if (parsed.json) {
        console.log(JSON.stringify({ status: 'repaired', ...receipt }));
      } else {
        console.log(
          `Kept [${escapeTerminalText(receipt.sourceId)}:${escapeTerminalText(receipt.keepSlug)}] ` +
          `as owner of ${escapeTerminalText(receipt.sourcePath)}.`,
        );
        console.log(
          `Cleared source_path on: ${receipt.cleared_slugs.map(escapeTerminalText).join(', ') || '(none)'}.`,
        );
        console.log(`Remaining ownership conflicts: ${receipt.remaining_conflicts}.`);
      }
      if (receipt.remaining_conflicts > 0) setCliExitVerdict(1);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      setCliExitVerdict(1);
    }
    return;
  }

  if (args[0] && !args[0].startsWith('-')) {
    console.error(`Unknown upgrade-preflight subcommand: ${args[0]}`);
    setCliExitVerdict(2);
    return;
  }

  try {
    const conflicts = await withConfiguredEngine(inspectSourcePathOwnership);
    if (parsed.json) {
      console.log(JSON.stringify({
        status: conflicts.length === 0 ? 'ok' : 'blocked',
        conflict_count: conflicts.length,
        conflicts,
      }));
    } else if (conflicts.length === 0) {
      console.log('Upgrade preflight passed: no duplicate source-path owners.');
    } else {
      console.error(`Upgrade blocked: ${conflicts.length} duplicate source-path ownership group(s).`);
      for (const conflict of conflicts) {
        console.error(
          `  [${escapeTerminalText(conflict.source_id)}] ${escapeTerminalText(conflict.source_path)}: ` +
          conflict.owners.map(escapeTerminalText).join(', '),
        );
      }
      console.error('Choose the legitimate owner for each group, then run:');
      console.error('  gbrain upgrade-preflight repair --source <id> --path <path> --keep <slug> --yes');
    }
    if (conflicts.length > 0) setCliExitVerdict(1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    setCliExitVerdict(1);
  }
}

export const __testing = { parseArgs, withConfiguredEngine };
