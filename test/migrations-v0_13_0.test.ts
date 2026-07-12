/**
 * Tests for the v0.13.0 frontmatter relationship indexing migration.
 *
 * Iron rule: phase handlers pass structured subcommand argv to the shared
 * wrapper. The wrapper binds Bun source runs as `bun <current cli entry>` and
 * compiled runs to the current executable, so neither PATH's old shim nor a
 * bare `bun extract` can cross release boundaries during staged upgrades.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { migrationTestOpts } from './helpers/migration-opts.ts';

const SRC_PATH = join(__dirname, '..', 'src', 'commands', 'migrations', 'v0_13_0.ts');

describe('v0.13.0 — Frontmatter relationship indexing migration', () => {
  test('registered in the TS migration registry', async () => {
    const { migrations, getMigration } = await import('../src/commands/migrations/index.ts');
    const versions = migrations.map(m => m.version);
    expect(versions).toContain('0.13.0');
    const m = getMigration('0.13.0');
    expect(m).not.toBeNull();
    expect(typeof m!.orchestrator).toBe('function');
  });

  test('phase functions exported for unit testing', async () => {
    const { __testing } = await import('../src/commands/migrations/v0_13_0.ts');
    expect(typeof __testing.phaseASchema).toBe('function');
    expect(typeof __testing.phaseBBackfill).toBe('function');
    expect(typeof __testing.phaseCVerify).toBe('function');
  });

  test('dry-run skips all side-effect phases', async () => {
    const { v0_13_0 } = await import('../src/commands/migrations/v0_13_0.ts');
    const result = await v0_13_0.orchestrator(migrationTestOpts({ yes: true, dryRun: true, noAutopilotInstall: true }));
    expect(result.version).toBe('0.13.0');
    for (const phase of result.phases) {
      expect(phase.status).toBe('skipped');
      expect(phase.detail).toBe('dry-run');
    }
  });

  // ── Regression guards (Bug 1) ──────────────────────────────

  test('source does NOT reference process.execPath (Bug 1 regression)', () => {
    // process.execPath on a bun install is the bun runtime itself, so
    // `${process.execPath} extract` becomes `bun run extract` and dies.
    // See v0.14.0 upgrade-night postmortem.
    const src = readFileSync(SRC_PATH, 'utf-8');
    expect(src).not.toContain('process.execPath');
  });

  test('source does NOT build commands from a GBRAIN constant (Bug 1 regression)', () => {
    // Earlier revisions used `const GBRAIN = process.execPath` and built
    // commands as `${GBRAIN} extract ...`. The constant was the vector.
    const src = readFileSync(SRC_PATH, 'utf-8');
    expect(src).not.toMatch(/const\s+GBRAIN\s*=/);
    expect(src).not.toMatch(/\$\{GBRAIN\}/);
  });

  test('phases use in-process schema + structured same-release subprocess', () => {
    const src = readFileSync(SRC_PATH, 'utf-8');
    // Schema bring-up is now IN-PROCESS (was execSync('gbrain init
    // --migrate-only'), which died with getaddrinfo ENOTFOUND on Windows).
    expect(src).toContain('runSnapshotMigrateOnly(opts)');
    expect(src).not.toContain("execSync('gbrain init --migrate-only'");
    // Backfill extract goes through the stderr-capturing wrapper as argv.
    expect(src).toContain("runGbrainSubprocess(['extract', 'links', '--source', 'db', '--include-frontmatter']");
    // Stats readback uses the same snapshot-pinned child wrapper.
    expect(src).toContain("runGbrainSubprocess(['call', 'get_stats']");
  });

  test('phase commands never embed a PATH shim or shell control syntax', () => {
    const src = readFileSync(SRC_PATH, 'utf-8');
    expect(src).not.toContain("runGbrainSubprocess('gbrain ");
    expect(src).not.toContain('2>/dev/null');
    expect(src).not.toContain(' || gbrain ');
  });
});
