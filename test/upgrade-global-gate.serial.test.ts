import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import {
  assertUpgradeStateAllowsCliCommand,
  isAutopilotDaemonStartInvocation,
  loadReconciledUpgradeState,
  parsePostUpgradeInvocation,
  recordParentPostUpgradeFailureIfMissing,
  runPostUpgradeStateTransition,
  saveUpgradeState,
  type ReconciledUpgradeState,
  type UpgradeCompletionStatus,
} from '../src/commands/upgrade.ts';
import { VERSION } from '../src/version.ts';
import { withEnv } from './helpers/with-env.ts';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const TRANSITION_ID = '11111111-1111-4111-8111-111111111111';

function writeOwnedText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function writeOwnedJson(path: string, value: unknown): void {
  writeOwnedText(path, `${JSON.stringify(value)}\n`);
}

function pendingState(
  status: Exclude<UpgradeCompletionStatus, 'complete'>,
): ReconciledUpgradeState {
  return {
    kind: 'pending',
    from: '0.0.0.0',
    to: VERSION,
    status,
    transitionId: TRANSITION_ID,
    brainId: null,
    legacy: false,
    tsMs: Date.parse('2026-07-12T00:00:00.000Z'),
  };
}

function rawPendingState(status: Exclude<UpgradeCompletionStatus, 'complete'>): unknown {
  return {
    last_upgrade: {
      from: '0.0.0.0',
      to: status === 'swap_running' ? '<unverified-replacement>' : VERSION,
      status,
      ts: '2026-07-12T00:00:00.000Z',
      transition_id: TRANSITION_ID,
      brain_id: null,
      brain_required: false,
    },
  };
}

describe('global unresolved-upgrade CLI gate', () => {
  test('runtime gate repairs an owned loose state dir, while diagnostics remain metadata-preserving', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-runtime-permissions-'));
    const stateDir = join(root, '.gbrain');
    mkdirSync(stateDir, { mode: 0o755 });
    chmodSync(stateDir, 0o755);
    try {
      await withEnv({ GBRAIN_HOME: root, HOME: root }, () => {
        expect(loadReconciledUpgradeState()).toMatchObject({ kind: 'invalid' });
        expect(statSync(stateDir).mode & 0o777).toBe(0o755);

        expect(() => assertUpgradeStateAllowsCliCommand('sync', [])).not.toThrow();
        expect(statSync(stateDir).mode & 0o777).toBe(0o700);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed for every unsafe handoff status and ordinary command', () => {
    for (const status of [
      'post_upgrade_pending',
      'deferred',
      'incomplete',
      'running',
      'swap_running',
    ] as const) {
      for (const command of ['sync', 'serve', 'import']) {
        expect(() => assertUpgradeStateAllowsCliCommand(command, [], pendingState(status)))
          .toThrow(/blocked before database connect/);
      }
    }
  });

  test('allows only daemon-start autopilot to resume deferred/running handoffs', () => {
    for (const status of ['deferred', 'running'] as const) {
      const state = pendingState(status);
      expect(() => assertUpgradeStateAllowsCliCommand('autopilot', [], state)).not.toThrow();
      expect(() => assertUpgradeStateAllowsCliCommand('autopilot', ['--repo', '/tmp/brain'], state))
        .not.toThrow();
      for (const args of [['--install'], ['--uninstall'], ['--status']]) {
        expect(() => assertUpgradeStateAllowsCliCommand('autopilot', args, state)).toThrow();
      }
    }
    expect(isAutopilotDaemonStartInvocation([])).toBe(true);
    expect(isAutopilotDaemonStartInvocation(['--repo', '/tmp/brain'])).toBe(true);
    expect(isAutopilotDaemonStartInvocation(['--install', '--yes'])).toBe(false);
  });

  test('keeps only explicit diagnostics and recovery commands available', () => {
    const invalid: ReconciledUpgradeState = { kind: 'invalid', message: 'authorities disagree' };
    for (const [command, args] of [
      ['doctor', ['--fast']],
      ['upgrade', []],
      ['upgrade', ['--help']],
      ['upgrade-preflight', []],
      ['upgrade-preflight', ['--json']],
      ['post-upgrade', []],
      ['post-upgrade', ['--help']],
      ['post-upgrade', ['recover-migration', '--force-retry', '0.42.59.0']],
      ['post-upgrade', [
        'repair-ownership', '--source', 'wiki', '--path', 'a.md', '--keep', 'a', '--yes',
      ]],
      ['apply-migrations', ['--list']],
      ['apply-migrations', ['--dry-run']],
      ['check-update', []],
    ] as const) {
      expect(() => assertUpgradeStateAllowsCliCommand(command, args, invalid)).not.toThrow();
    }
    expect(() => assertUpgradeStateAllowsCliCommand('anything', ['--help'], invalid)).toThrow();
    expect(() => assertUpgradeStateAllowsCliCommand('import', ['--help'], invalid)).toThrow();
    expect(() => assertUpgradeStateAllowsCliCommand('doctor', ['--fix'], invalid)).toThrow();
    expect(() => assertUpgradeStateAllowsCliCommand('doctor', ['--remediate'], invalid)).toThrow();
    expect(() => assertUpgradeStateAllowsCliCommand('doctor', [], invalid)).toThrow();
    expect(() => assertUpgradeStateAllowsCliCommand('doctor', ['--remediation-plan'], invalid)).toThrow();
    expect(() => assertUpgradeStateAllowsCliCommand('apply-migrations', [], invalid)).toThrow();
    expect(() => assertUpgradeStateAllowsCliCommand('apply-migrations', ['--yes'], invalid)).toThrow();
    expect(() => assertUpgradeStateAllowsCliCommand(
      'apply-migrations', ['--force-retry', '0.42.59.0'], invalid,
    )).toThrow();
    expect(() => assertUpgradeStateAllowsCliCommand(
      'upgrade-preflight', ['repair', '--source', 'wiki', '--path', 'a.md', '--keep', 'a', '--yes'], invalid,
    )).toThrow();
    expect(() => assertUpgradeStateAllowsCliCommand(
      'post-upgrade', ['recover-migration', '--force-retry', '0.42.59.0', '--force-all'], invalid,
    )).toThrow();
    expect(() => assertUpgradeStateAllowsCliCommand(
      'post-upgrade', ['repair-ownership', '--source', 'wiki', '--path', 'a.md', '--keep', 'a'], invalid,
    )).toThrow();
    expect(() => assertUpgradeStateAllowsCliCommand('init', ['--migrate-only'], invalid)).toThrow();
    expect(() => assertUpgradeStateAllowsCliCommand('init', [], invalid)).toThrow();

    const healthy: ReconciledUpgradeState = { kind: 'missing' };
    expect(() => assertUpgradeStateAllowsCliCommand('apply-migrations', ['--yes'], healthy)).not.toThrow();
    expect(() => assertUpgradeStateAllowsCliCommand(
      'upgrade-preflight', ['repair', '--source', 'wiki', '--path', 'a.md', '--keep', 'a', '--yes'], healthy,
    )).not.toThrow();
  });

  test('completed newer target blocks a rolled-back binary across canonical and legacy state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-completed-future-gate-'));
    const canonicalRoot = join(root, 'canonical');
    const legacyRoot = join(root, 'legacy');
    const emptyCanonicalRoot = join(root, 'empty-canonical');
    const completedFuture = {
      last_upgrade: {
        from: VERSION,
        to: '999.999.999.999',
        status: 'complete',
        ts: '2026-07-12T00:00:00.000Z',
        transition_id: '22222222-2222-4222-8222-222222222222',
        brain_id: null,
        brain_required: false,
      },
    };
    try {
      writeOwnedJson(join(canonicalRoot, '.gbrain', 'upgrade-state.json'), completedFuture);
      await withEnv({ GBRAIN_HOME: canonicalRoot, HOME: canonicalRoot }, () => {
        expect(loadReconciledUpgradeState()).toMatchObject({
          kind: 'invalid',
          message: expect.stringMatching(/targets newer .*restore the matched database and file state/i),
        });
        expect(() => assertUpgradeStateAllowsCliCommand('sync', []))
          .toThrow(/upgrade authority is invalid or contradictory/i);
      });

      writeOwnedJson(join(legacyRoot, '.gbrain', 'upgrade-state.json'), completedFuture);
      await withEnv({ GBRAIN_HOME: emptyCanonicalRoot, HOME: legacyRoot }, () => {
        expect(loadReconciledUpgradeState()).toMatchObject({
          kind: 'invalid',
          message: expect.stringMatching(/targets newer .*restore the matched database and file state/i),
        });
        expect(() => assertUpgradeStateAllowsCliCommand('sync', []))
          .toThrow(/upgrade authority is invalid or contradictory/i);
      });

      writeOwnedJson(join(canonicalRoot, '.gbrain', 'upgrade-state.json'), {
        last_upgrade: {
          ...completedFuture.last_upgrade,
          from: '0.42.57.0',
          to: '0.42.58.0',
        },
      });
      await withEnv({ GBRAIN_HOME: canonicalRoot, HOME: canonicalRoot }, () => {
        expect(loadReconciledUpgradeState()).toMatchObject({
          kind: 'complete',
          from: '0.42.57.0',
          to: '0.42.58.0',
        });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('post-upgrade recovery parser accepts only the two fixed command shapes', () => {
    expect(parsePostUpgradeInvocation([
      'recover-migration', '--force-retry', '0.42.59.0',
    ])).toEqual({ kind: 'recover-migration', version: '0.42.59.0' });
    expect(parsePostUpgradeInvocation([
      'repair-ownership', '--source', 'wiki', '--path', 'a.md', '--keep', 'a', '--yes',
    ])).toEqual({
      kind: 'repair-ownership',
      sourceId: 'wiki',
      sourcePath: 'a.md',
      keepSlug: 'a',
    });

    for (const args of [
      ['recover-migration', '--force-retry', 'not-a-version'],
      ['recover-migration', '--force-all', '0.42.59.0'],
      ['recover-migration', '--force-retry', '0.42.59.0', '--yes'],
      ['repair-ownership', '--source', 'wiki', '--path', 'a.md', '--keep', 'a'],
      ['repair-ownership', '--source', 'wiki', '--path', 'a.md', '--keep', 'a', '--yes', '--json'],
      ['anything-else'],
    ]) {
      expect(() => parsePostUpgradeInvocation(args)).toThrow(/arbitrary migration/);
    }
  });

  test('normal commands and ambient migration/repair mutations stop before config, connect, or side effects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-global-gate-'));
    const statePath = join(root, 'state', '.gbrain', 'upgrade-state.json');
    const configPath = join(root, 'state', '.gbrain', 'config.json');
    const legacyHome = join(root, 'legacy-home');
    mkdirSync(legacyHome, { recursive: true, mode: 0o700 });
    writeOwnedText(configPath, '{deliberately-invalid-config\n');
    const configBefore = readFileSync(configPath, 'utf8');
    const importTarget = join(root, 'must-not-be-read.md');

    try {
      for (const status of [
        'post_upgrade_pending',
        'deferred',
        'incomplete',
        'running',
        'swap_running',
      ] as const) {
        writeOwnedJson(statePath, rawPendingState(status));
        for (const invocation of [
          ['sync'],
          ['serve'],
          ['import', importTarget],
          ['import', '--help'],
          ['unknown-command', '--help'],
          ['doctor'],
          ['apply-migrations', '--yes'],
          ['init', '--migrate-only'],
          ['upgrade-preflight', 'repair', '--source', 'wiki', '--path', 'a.md', '--keep', 'a', '--yes'],
          ['autopilot', '--status'],
          ['autopilot', '--install', '--yes'],
        ]) {
          const proc = Bun.spawn(
            [process.execPath, 'run', join(REPO_ROOT, 'src/cli.ts'), ...invocation],
            {
              cwd: REPO_ROOT,
              env: {
                ...process.env,
                NODE_ENV: 'test',
                GBRAIN_HOME: join(root, 'state'),
                HOME: legacyHome,
              },
              stdout: 'pipe',
              stderr: 'pipe',
            },
          );
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          expect(exitCode).toBe(1);
          expect(stdout).toBe('');
          expect(stderr).toContain('blocked before database connect');
          expect(stderr).not.toContain('deliberately_invalid_config_shape');
          expect(readFileSync(configPath, 'utf8')).toBe(configBefore);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('real daemon-start autopilot consumes running handoff before ordinary connect', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-upgrade-resume-'));
    const statePath = join(root, '.gbrain', 'upgrade-state.json');
    writeOwnedJson(statePath, rawPendingState('running'));
    try {
      const proc = Bun.spawn(
        [process.execPath, 'run', join(REPO_ROOT, 'src/cli.ts'), 'autopilot'],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            NODE_ENV: 'test',
            GBRAIN_HOME: root,
            HOME: root,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('No brain configured');
      expect(JSON.parse(readFileSync(statePath, 'utf8')).last_upgrade.status).toBe('complete');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('late parent upgrade failure', () => {
  test('cannot downgrade an exact completed child transition or attach a mismatched error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-late-parent-'));
    const context = {
      transitionId: '33333333-3333-4333-8333-333333333333',
      brainId: null,
    };
    try {
      await withEnv({ GBRAIN_HOME: root, HOME: root }, async () => {
        saveUpgradeState('0.42.58.0', VERSION, 'post_upgrade_pending', undefined, context);
        await runPostUpgradeStateTransition(async () => {}, async () => null);

        expect(await recordParentPostUpgradeFailureIfMissing(
          '0.42.58.0', VERSION, 'late parent timeout', context,
        )).toBe(false);
        const statePath = join(root, '.gbrain', 'upgrade-state.json');
        const errorPath = join(root, '.gbrain', 'upgrade-errors.jsonl');
        expect(JSON.parse(readFileSync(statePath, 'utf8')).last_upgrade.status).toBe('complete');
        expect(existsSync(errorPath)).toBe(false);

        await expect(recordParentPostUpgradeFailureIfMissing(
          '0.42.58.0',
          VERSION,
          'wrong parent timeout',
          { transitionId: '44444444-4444-4444-8444-444444444444', brainId: null },
        )).rejects.toThrow(/mismatched parent failure/);
        expect(JSON.parse(readFileSync(statePath, 'utf8')).last_upgrade.status).toBe('complete');
        expect(existsSync(errorPath)).toBe(false);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
