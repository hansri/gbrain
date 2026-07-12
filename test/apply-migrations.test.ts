/**
 * Tests for `gbrain apply-migrations` — the migration runner CLI.
 *
 * Unit-scope: exercises the pure helpers (parseArgs, indexCompleted, buildPlan,
 * statusForVersion). End-to-end integration against real orchestrators is
 * covered by test/e2e/migration-flow.test.ts (Lane C-5).
 */

import { describe, test, expect } from 'bun:test';
import { __testing, migrationRunLockName } from '../src/commands/apply-migrations.ts';
import type { CompletedMigrationEntry } from '../src/core/preferences.ts';

const {
  parseArgs, indexCompleted, buildPlan, statusForVersion, ambiguousSchemaMutationFence,
  ambiguousForcePathFence,
  selectRunnableMigrations, earlierUnresolvedVersions, forceRetryAction,
} = __testing;

describe('parseArgs', () => {
  test('default flags', () => {
    const a = parseArgs([]);
    expect(a.list).toBe(false);
    expect(a.dryRun).toBe(false);
    expect(a.yes).toBe(false);
    expect(a.nonInteractive).toBe(false);
    expect(a.mode).toBeUndefined();
    expect(a.specificMigration).toBeUndefined();
    expect(a.hostDir).toBeUndefined();
    expect(a.noAutopilotInstall).toBe(false);
  });

  test('--list / --dry-run / --yes / --non-interactive', () => {
    expect(parseArgs(['--list']).list).toBe(true);
    expect(parseArgs(['--dry-run']).dryRun).toBe(true);
    expect(parseArgs(['--yes']).yes).toBe(true);
    expect(parseArgs(['--non-interactive']).nonInteractive).toBe(true);
  });

  test('--mode accepts valid values', () => {
    expect(parseArgs(['--mode', 'always']).mode).toBe('always');
    expect(parseArgs(['--mode', 'pain_triggered']).mode).toBe('pain_triggered');
    expect(parseArgs(['--mode', 'off']).mode).toBe('off');
  });

  test('--migration and --host-dir parse values', () => {
    const a = parseArgs(['--migration', '0.11.0', '--host-dir', '/tmp/abc']);
    expect(a.specificMigration).toBe('0.11.0');
    expect(a.hostDir).toBe('/tmp/abc');
  });

  test('--no-autopilot-install flips flag', () => {
    expect(parseArgs(['--no-autopilot-install']).noAutopilotInstall).toBe(true);
  });

  test('--help sets help flag', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  test('rejects the removed --skip-verify escape hatch with a repair path', () => {
    expect(() => parseArgs(['--skip-verify'])).toThrow(/removed.*upgrade-preflight/i);
  });

  test('rejects unknown options and unexpected positional arguments', () => {
    expect(() => parseArgs(['--mdoe', 'always'])).toThrow(/unknown option.*--mdoe/i);
    expect(() => parseArgs(['surprise'])).toThrow(/unexpected argument/i);
  });

  test('requires an explicit value for every value-bearing option', () => {
    for (const flag of ['--force-retry', '--migration', '--mode', '--host-dir']) {
      expect(() => parseArgs([flag])).toThrow(new RegExp(`${flag} requires a value`, 'i'));
      expect(() => parseArgs([flag, '--yes'])).toThrow(new RegExp(`${flag} requires a value`, 'i'));
    }
  });

  test('rejects repeated value flags and contradictory action modes', () => {
    expect(() => parseArgs(['--mode', 'always', '--mode', 'off'])).toThrow(/only once/i);
    expect(() => parseArgs(['--force-retry', '0.11.0', '--force-all'])).toThrow(/contradictory force/i);
    expect(() => parseArgs(['--force-schema', '--force-orchestrator'])).toThrow(/contradictory force/i);
    expect(() => parseArgs(['--force', '--force-all'])).toThrow(/contradictory force/i);
    expect(() => parseArgs(['--force-all', '--dry-run'])).toThrow(/cannot be combined/i);
    expect(() => parseArgs(['--force-orchestrator', '--list'])).toThrow(/cannot be combined/i);
    expect(() => parseArgs(['--list', '--dry-run'])).toThrow(/either --list or --dry-run/i);
    expect(() => parseArgs(['--force-all', '--migration', '0.11.0'])).toThrow(/either --migration/i);
  });

  test('help remains safe and available even beside an obsolete option', () => {
    expect(parseArgs(['--help', '--unknown']).help).toBe(true);
    expect(parseArgs(['--skip-verify', '--help']).help).toBe(true);
  });
});

describe('indexCompleted + statusForVersion', () => {
  test('no entries → pending', () => {
    const idx = indexCompleted([]);
    expect(statusForVersion('0.11.0', idx)).toBe('pending');
  });

  test('one complete entry → complete', () => {
    const entries: CompletedMigrationEntry[] = [
      { version: '0.11.0', status: 'complete', mode: 'always' },
    ];
    const idx = indexCompleted(entries);
    expect(statusForVersion('0.11.0', idx)).toBe('complete');
  });

  test('only partial entries → partial', () => {
    const entries: CompletedMigrationEntry[] = [
      { version: '0.11.0', status: 'partial', apply_migrations_pending: true },
    ];
    const idx = indexCompleted(entries);
    expect(statusForVersion('0.11.0', idx)).toBe('partial');
  });

  test('partial then complete → complete (stopgap then v0.11.1 apply-migrations)', () => {
    const entries: CompletedMigrationEntry[] = [
      { version: '0.11.0', status: 'partial', apply_migrations_pending: true },
      { version: '0.11.0', status: 'complete', mode: 'always' },
    ];
    const idx = indexCompleted(entries);
    expect(statusForVersion('0.11.0', idx)).toBe('complete');
  });

  test('only looks at the queried version', () => {
    const entries: CompletedMigrationEntry[] = [
      { version: '0.10.0', status: 'complete' },
    ];
    const idx = indexCompleted(entries);
    expect(statusForVersion('0.11.0', idx)).toBe('pending');
    expect(statusForVersion('0.10.0', idx)).toBe('complete');
  });

  test('legacy unscoped completion cannot suppress work for either of two brains', () => {
    const legacyOnly: CompletedMigrationEntry[] = [
      { version: '0.11.0', status: 'complete' },
    ];
    expect(statusForVersion('0.11.0', indexCompleted(legacyOnly, 'brain-a'))).toBe('pending');
    expect(statusForVersion('0.11.0', indexCompleted(legacyOnly, 'brain-b'))).toBe('pending');

    const entries: CompletedMigrationEntry[] = [
      ...legacyOnly,
      { version: '0.11.0', brain_id: 'brain-a', status: 'complete' },
    ];
    expect(statusForVersion('0.11.0', indexCompleted(entries, 'brain-a'))).toBe('complete');
    expect(statusForVersion('0.11.0', indexCompleted(entries, 'brain-b'))).toBe('pending');
  });

  test('ambiguous state stays blocked until an explicit retry marker', () => {
    const entries: CompletedMigrationEntry[] = [
      { version: '0.11.0', brain_id: 'brain-a', status: 'partial', ambiguous_state: true },
    ];
    expect(statusForVersion('0.11.0', indexCompleted(entries, 'brain-a'))).toBe('ambiguous');
    entries.push({ version: '0.11.0', brain_id: 'brain-a', status: 'retry' });
    expect(statusForVersion('0.11.0', indexCompleted(entries, 'brain-a'))).toBe('pending');
  });
});

describe('buildPlan — diff against completed + installed VERSION', () => {
  test('fresh install (no entries) — v0.11.0 is pending when installed ≥ 0.11.0', () => {
    const idx = indexCompleted([]);
    const plan = buildPlan(idx, '0.11.1');
    expect(plan.applied).toEqual([]);
    expect(plan.partial).toEqual([]);
    expect(plan.pending.map(m => m.version)).toContain('0.11.0');
    // Future migrations (registered but newer than installed VERSION) land in
    // skippedFuture until the binary catches up. v0.13.0 = frontmatter graph,
    // v0.13.1 = Knowledge Runtime grandfather, v0.14.0 = shell jobs +
    // autopilot cooperative, v0.16.0 = subagent runtime, v0.18.0 = multi-
    // source brains, v0.18.1 = RLS hardening, v0.21.0 = Cathedral II
    // (renumbered from v0.20.0 after master shipped v0.20.x in parallel).
    expect(plan.skippedFuture.map(m => m.version)).toEqual(['0.12.0', '0.12.2', '0.13.0', '0.13.1', '0.14.0', '0.16.0', '0.18.0', '0.18.1', '0.21.0', '0.22.4', '0.28.0', '0.29.1', '0.31.0', '0.32.2', '0.42.59.0']);
  });

  test('already applied → v0.11.0 lands in `applied` bucket, not pending', () => {
    const idx = indexCompleted([{ version: '0.11.0', status: 'complete' }]);
    const plan = buildPlan(idx, '0.11.1');
    expect(plan.applied.map(m => m.version)).toContain('0.11.0');
    expect(plan.pending).toEqual([]);
  });

  test('stopgap wrote partial → v0.11.0 lands in `partial` bucket (resumable)', () => {
    const idx = indexCompleted([
      { version: '0.11.0', status: 'partial', apply_migrations_pending: true },
    ]);
    const plan = buildPlan(idx, '0.11.1');
    expect(plan.partial.map(m => m.version)).toContain('0.11.0');
    expect(plan.applied).toEqual([]);
    expect(plan.pending).toEqual([]);
  });

  test('Codex H9 regression: installed older than migration → skippedFuture, not skipped silently', () => {
    // Running a v0.10.x binary that somehow loaded a v0.11.0 migration registry:
    // migration is skippedFuture (wait for a newer install), NOT ignored.
    const idx = indexCompleted([]);
    const plan = buildPlan(idx, '0.10.5');
    expect(plan.skippedFuture.map(m => m.version)).toContain('0.11.0');
    expect(plan.pending).toEqual([]);
  });

  test('Codex H9 regression: installed > migration version → still runs (not skipped)', () => {
    // This is the critical bug Codex caught: the plan was "apply when version >
    // installed", which would SKIP v0.11.0 when running v0.11.1. The correct
    // rule is "apply when not in completed.jsonl AND version ≤ installed".
    const idx = indexCompleted([]);
    const plan = buildPlan(idx, '0.12.0');
    expect(plan.pending.map(m => m.version)).toContain('0.11.0');
    // v0.12.2, v0.13.0, v0.13.1, v0.14.0, v0.16.0, v0.18.0, v0.18.1, v0.21.0,
    // v0.22.4, v0.28.0, v0.29.1, v0.31.0 were added later; installed=0.12.0
    // means they belong in skippedFuture, not pending. v0.11.0 and v0.12.0
    // stay pending despite being ≤ installed — that is the H9 invariant.
    expect(plan.skippedFuture.map(m => m.version)).toEqual(['0.12.2', '0.13.0', '0.13.1', '0.14.0', '0.16.0', '0.18.0', '0.18.1', '0.21.0', '0.22.4', '0.28.0', '0.29.1', '0.31.0', '0.32.2', '0.42.59.0']);
  });

  test('--migration filter narrows to one version', () => {
    const idx = indexCompleted([]);
    const plan = buildPlan(idx, '0.11.1', '0.11.0');
    expect(plan.pending.map(m => m.version)).toEqual(['0.11.0']);
  });

  test('--migration filter for unknown version → empty plan', () => {
    const idx = indexCompleted([]);
    const plan = buildPlan(idx, '0.11.1', '99.99.99');
    expect(plan.applied).toEqual([]);
    expect(plan.pending).toEqual([]);
    expect(plan.partial).toEqual([]);
    expect(plan.skippedFuture).toEqual([]);
  });

  test('ambiguous state fences force-schema and force-all before mutation', () => {
    const plan = buildPlan(indexCompleted([
      { version: '0.11.0', brain_id: 'brain-a', status: 'partial', ambiguous_state: true },
    ], 'brain-a'), '0.42.59.0');
    const fence = ambiguousSchemaMutationFence(plan, 'brain-a');
    expect(fence).toMatchObject({
      exitCode: 1,
      reason: 'ambiguous',
      blockedVersions: ['0.11.0'],
    });
    expect(fence?.message).toContain('--force-retry <version>');
  });

  test('every broad force path stays blocked by ambiguity; only targeted retry can clear it', () => {
    const plan = buildPlan(indexCompleted([
      { version: '0.11.0', brain_id: 'brain-a', status: 'partial', ambiguous_state: true },
    ], 'brain-a'), '0.42.59.0');

    for (const args of [['--force-orchestrator'], ['--force-schema'], ['--force-all']]) {
      expect(ambiguousForcePathFence(parseArgs(args), plan, 'brain-a')).toMatchObject({
        exitCode: 1,
        reason: 'ambiguous',
      });
    }
    expect(ambiguousForcePathFence(parseArgs(['--force-retry', '0.11.0']), plan, 'brain-a')).toBeNull();
  });

  test('runnable migrations always preserve registry order across pending and partial buckets', () => {
    const plan = buildPlan(indexCompleted([
      { version: '0.12.0', status: 'partial' },
    ]), '0.12.0');
    expect(selectRunnableMigrations(plan).map(migration => migration.version).slice(0, 2))
      .toEqual(['0.11.0', '0.12.0']);
    expect(earlierUnresolvedVersions(plan, '0.12.0')).toEqual(['0.11.0']);
  });

  test('targeted retry never replays a completed or genuinely pending migration', () => {
    expect(forceRetryAction('complete', false)).toBe('refuse');
    expect(forceRetryAction('pending', false)).toBe('refuse');
    expect(forceRetryAction('complete', true)).toBe('clear_only');
    expect(forceRetryAction('pending', true)).toBe('retry');
    expect(forceRetryAction('ambiguous', false)).toBe('retry');
  });

  test('database-owned IDs produce a portable local lock filename', () => {
    const name = migrationRunLockName('db:11111111-1111-4111-8111-111111111111');
    expect(name).toBe('apply-migrations-db_11111111-1111-4111-8111-111111111111');
    expect(name).not.toMatch(/[:\\/]/);
  });
});

// v0.36.1.x (cherry-pick #1062): list, dry-run, and "all migrations up to
// date" paths must exit 0 so shell scripts gating on the exit code work.
// Pre-fix, these `return` statements left the CLI dispatcher's implicit
// non-zero exit code in place when callers checked $?.
describe('runApplyMigrations library/CLI boundary', () => {
  test('reusable runner never exits the process and CLI owns the exit verdict', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/commands/apply-migrations.ts', 'utf8');
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(src).not.toContain('process.exit(');
    expect(src).toContain("return outcome(0, 'listed')");
    expect(src).toContain("return outcome(0, 'dry_run')");
    expect(src).toContain("return outcome(0, 'up_to_date')");
    expect(cli).toContain('setCliExitVerdict(result.exitCode)');
  });
});
