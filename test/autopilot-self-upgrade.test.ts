import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  generateSystemdUnit,
  resolveAutopilotUpgradeInvocation,
} from '../src/commands/autopilot.ts';
import { withEnv } from './helpers/with-env.ts';

const AUTOPILOT_SRC = readFileSync(join(import.meta.dir, '../src/commands/autopilot.ts'), 'utf8');

describe('generateSystemdUnit', () => {
  const unit = generateSystemdUnit('/home/u/.gbrain/autopilot-run.sh');

  test('uses Restart=always (NOT on-failure) so a clean exit-for-relaunch respawns', () => {
    expect(unit).toContain('Restart=always');
    expect(unit).not.toContain('Restart=on-failure');
  });
  test('caps a clean-exit respawn storm with StartLimit*', () => {
    expect(unit).toContain('StartLimitIntervalSec=');
    expect(unit).toContain('StartLimitBurst=');
  });
  test('runs the given wrapper path', () => {
    expect(unit).toContain('ExecStart=/home/u/.gbrain/autopilot-run.sh');
  });
});

describe('autopilot self-upgrade static-shape regressions', () => {
  test('supervisor-relaunch, NOT in-process re-exec (Bun has no execve) — no exec*-call', () => {
    // Match call-shape, not the word (the comments legitimately say "no execve").
    expect(AUTOPILOT_SRC).not.toMatch(/execve\s*\(/);
    expect(AUTOPILOT_SRC).not.toMatch(/execvp\s*\(/);
  });
  test('the silent channel does swap-only, never a blocking full post-upgrade in the tick', () => {
    expect(AUTOPILOT_SRC).toContain('resolveAutopilotUpgradeInvocation(latestVersion)');
    expect(AUTOPILOT_SRC).not.toContain("execSync('gbrain upgrade --swap-only'");
    // The tick must not invoke the (up-to-30-min) post-upgrade inline.
    expect(AUTOPILOT_SRC).not.toContain("execSync('gbrain post-upgrade'");
  });
  test('hostile PATH cannot replace the exact current-release upgrade argv', async () => {
    await withEnv({ PATH: '/tmp/hostile-path-only' }, () => {
      expect(resolveAutopilotUpgradeInvocation('0.42.58.0', {
        execPath: '/trusted/release/gbrain',
        main: '/ignored/source.ts',
      })).toEqual([
        '/trusted/release/gbrain', 'upgrade', '--swap-only', '--target', '0.42.58.0',
      ]);
      expect(resolveAutopilotUpgradeInvocation('0.42.58.0', {
        execPath: '/trusted/runtime/bun',
        main: '/trusted/release/src/cli.ts',
      })).toEqual([
        '/trusted/runtime/bun', '/trusted/release/src/cli.ts',
        'upgrade', '--swap-only', '--target', '0.42.58.0',
      ]);
    });
  });
  test('silent channel consults the local supervised-release policy', () => {
    expect(AUTOPILOT_SRC).toContain('resolveUpgradeReleasePolicy(latestVersion)');
    expect(AUTOPILOT_SRC).toContain('releaseAllowsSilentUpgrade: releasePolicy.inlineAllowed');
  });
  test('boot reconciles the breadcrumb and the tick attempts the channel', () => {
    expect(AUTOPILOT_SRC).toContain('reconcileSelfUpgradeAtBoot()');
    expect(AUTOPILOT_SRC).toContain('attemptAutopilotSelfUpgrade(engine, engineType, lockPath)');
  });
  test('apply path unlinks the lock before exit so the relaunched binary does not self-exit on a stale lock', () => {
    // The exit-for-relaunch block unlinks lockPath then process.exit(0).
    expect(AUTOPILOT_SRC).toMatch(/unlinkSync\(lockPath\)[\s\S]{0,120}process\.exit\(0\)/);
  });
});
