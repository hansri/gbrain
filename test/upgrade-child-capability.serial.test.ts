import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  consumeUpgradeChildCapability,
  mintUpgradeChildCapability,
  UPGRADE_CHILD_CAPABILITY_FILE_ENV,
  UPGRADE_CHILD_CAPABILITY_TOKEN_ENV,
  UPGRADE_CHILD_CAPABILITY_TTL_MS,
  UpgradeChildCapabilityError,
  type UpgradeChildRuntime,
  type UpgradeChildTransition,
} from '../src/core/upgrade-child-capability.ts';
import { VERSION } from '../src/version.ts';
import { withEnv } from './helpers/with-env.ts';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const BRAIN_ID = 'db:22222222-2222-4222-8222-222222222222';
const TRANSITION: UpgradeChildTransition = {
  transitionId: '11111111-1111-4111-8111-111111111111',
  brainId: BRAIN_ID,
  fromVersion: '0.42.58.0',
  toVersion: VERSION,
};
const RUNTIME: UpgradeChildRuntime = {
  execPath: '/opt/gbrain',
  main: '',
  parentPid: 1234,
};
const NOW = Date.parse('2026-07-12T10:00:00.000Z');

function fixture(): { root: string; configDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-child-cap-'));
  const configDir = join(root, '.gbrain');
  mkdirSync(configDir, { mode: 0o700 });
  chmodSync(configDir, 0o700);
  return { root, configDir };
}

function capabilityEnv(capability: { path: string; token: string }): NodeJS.ProcessEnv {
  return {
    [UPGRADE_CHILD_CAPABILITY_FILE_ENV]: capability.path,
    [UPGRADE_CHILD_CAPABILITY_TOKEN_ENV]: capability.token,
  };
}

async function mintIn(
  root: string,
  overrides: Partial<Parameters<typeof mintUpgradeChildCapability>[0]> = {},
) {
  return withEnv({ GBRAIN_HOME: root, HOME: root }, () => mintUpgradeChildCapability({
    configDir: join(root, '.gbrain'),
    rawArgs: ['schema'],
    invocation: ['/opt/gbrain', 'schema'],
    transition: TRANSITION,
    snapshotBrainId: BRAIN_ID,
    nowMs: NOW,
    parentPid: RUNTIME.parentPid,
    ...overrides,
  }));
}

describe('single-use post-upgrade migration child capability', () => {
  test('mints owner-only state and consumes one exact invocation once', async () => {
    const { root, configDir } = fixture();
    try {
      const capability = await mintIn(root);
      expect(lstatSync(configDir).mode & 0o777).toBe(0o700);
      expect(lstatSync(capability.path).mode & 0o777).toBe(0o600);
      expect(readFileSync(capability.path, 'utf8')).not.toContain(capability.token);

      const env = capabilityEnv(capability);
      const replayEnv = { ...env };
      await withEnv({ GBRAIN_HOME: root, HOME: root }, () => {
        expect(consumeUpgradeChildCapability(['schema'], {
          env,
          runtime: RUNTIME,
          nowMs: NOW + 1,
        })).toBe(true);
        expect(env[UPGRADE_CHILD_CAPABILITY_FILE_ENV]).toBeUndefined();
        expect(env[UPGRADE_CHILD_CAPABILITY_TOKEN_ENV]).toBeUndefined();
        expect(() => consumeUpgradeChildCapability(['schema'], {
          env: replayEnv,
          runtime: RUNTIME,
          nowMs: NOW + 2,
        })).toThrow(UpgradeChildCapabilityError);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects exact-argv, parent, expiry, and token mismatches without leaking bearer data', async () => {
    const { root } = fixture();
    try {
      for (const mutate of [
        (env: NodeJS.ProcessEnv) => ({ args: ['schema', 'active'], env, runtime: RUNTIME, nowMs: NOW + 1 }),
        (env: NodeJS.ProcessEnv) => ({ args: ['schema'], env, runtime: { ...RUNTIME, parentPid: 1235 }, nowMs: NOW + 1 }),
        (env: NodeJS.ProcessEnv) => ({ args: ['schema'], env, runtime: RUNTIME, nowMs: NOW + UPGRADE_CHILD_CAPABILITY_TTL_MS }),
        (env: NodeJS.ProcessEnv) => {
          env[UPGRADE_CHILD_CAPABILITY_TOKEN_ENV] = 'A'.repeat(43);
          return { args: ['schema'], env, runtime: RUNTIME, nowMs: NOW + 1 };
        },
      ]) {
        const capability = await mintIn(root);
        const env = capabilityEnv(capability);
        const attempt = mutate(env);
        let message = '';
        await withEnv({ GBRAIN_HOME: root, HOME: root }, () => {
          try {
            consumeUpgradeChildCapability(attempt.args, {
              env: attempt.env,
              runtime: attempt.runtime,
              nowMs: attempt.nowMs,
            });
          } catch (error) {
            message = error instanceof Error ? error.message : String(error);
          }
        });
        expect(message).toBe('Invalid or expired post-upgrade child capability.');
        expect(message).not.toContain(capability.path);
        expect(message).not.toContain(capability.token);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('binds exact executable/main and HMAC-protects the transition record', async () => {
    const { root } = fixture();
    try {
      let capability = await mintIn(root, {
        invocation: ['/opt/bun', '/opt/release/src/cli.ts', 'schema'],
      });
      await withEnv({ GBRAIN_HOME: root, HOME: root }, () => {
        expect(() => consumeUpgradeChildCapability(['schema'], {
          env: capabilityEnv(capability),
          runtime: {
            execPath: '/opt/bun',
            main: '/opt/other-release/src/cli.ts',
            parentPid: RUNTIME.parentPid,
          },
          nowMs: NOW + 1,
        })).toThrow(UpgradeChildCapabilityError);
      });

      capability = await mintIn(root);
      await withEnv({ GBRAIN_HOME: root, HOME: root }, () => {
        expect(() => consumeUpgradeChildCapability(['schema'], {
          env: capabilityEnv(capability),
          runtime: { ...RUNTIME, execPath: '/opt/other-gbrain' },
          nowMs: NOW + 1,
        })).toThrow(UpgradeChildCapabilityError);
      });

      capability = await mintIn(root);
      const record = JSON.parse(readFileSync(capability.path, 'utf8'));
      record.transition_id = '44444444-4444-4444-8444-444444444444';
      writeFileSync(capability.path, `${JSON.stringify(record)}\n`);
      await withEnv({ GBRAIN_HOME: root, HOME: root }, () => {
        expect(() => consumeUpgradeChildCapability(['schema'], {
          env: capabilityEnv(capability), runtime: RUNTIME, nowMs: NOW + 1,
        })).toThrow(UpgradeChildCapabilityError);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects partial ambient capability state even without an upgrade-state file', async () => {
    const { root } = fixture();
    try {
      await withEnv({ GBRAIN_HOME: root, HOME: root }, () => {
        expect(() => consumeUpgradeChildCapability(['schema'], {
          env: { [UPGRADE_CHILD_CAPABILITY_TOKEN_ENV]: 'A'.repeat(43) },
          runtime: RUNTIME,
          nowMs: NOW,
        })).toThrow(UpgradeChildCapabilityError);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects loose mode, symlink, and hard-link capability files', async () => {
    const { root, configDir } = fixture();
    try {
      let capability = await mintIn(root);
      chmodSync(capability.path, 0o644);
      await withEnv({ GBRAIN_HOME: root, HOME: root }, () => {
        expect(() => consumeUpgradeChildCapability(['schema'], {
          env: capabilityEnv(capability), runtime: RUNTIME, nowMs: NOW + 1,
        })).toThrow(UpgradeChildCapabilityError);
      });

      capability = await mintIn(root);
      const target = join(configDir, 'capability-target.json');
      writeFileSync(target, '{}', { mode: 0o600 });
      unlinkSync(capability.path);
      symlinkSync(target, capability.path);
      await withEnv({ GBRAIN_HOME: root, HOME: root }, () => {
        expect(() => consumeUpgradeChildCapability(['schema'], {
          env: capabilityEnv(capability), runtime: RUNTIME, nowMs: NOW + 1,
        })).toThrow(UpgradeChildCapabilityError);
      });

      capability = await mintIn(root);
      const otherLink = join(configDir, 'capability-hardlink.json');
      linkSync(capability.path, otherLink);
      await withEnv({ GBRAIN_HOME: root, HOME: root }, () => {
        expect(() => consumeUpgradeChildCapability(['schema'], {
          env: capabilityEnv(capability), runtime: RUNTIME, nowMs: NOW + 1,
        })).toThrow(UpgradeChildCapabilityError);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a loose private directory instead of repairing it', async () => {
    const { root, configDir } = fixture();
    try {
      const capability = await mintIn(root);
      chmodSync(configDir, 0o755);
      await withEnv({ GBRAIN_HOME: root, HOME: root }, () => {
        expect(() => consumeUpgradeChildCapability(['schema'], {
          env: capabilityEnv(capability), runtime: RUNTIME, nowMs: NOW + 1,
        })).toThrow(UpgradeChildCapabilityError);
      });
      expect(lstatSync(configDir).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('minting is bound to the exact transition brain and running release', async () => {
    const { root } = fixture();
    try {
      await expect(mintIn(root, {
        snapshotBrainId: 'db:33333333-3333-4333-8333-333333333333',
      })).rejects.toThrow(UpgradeChildCapabilityError);
      await expect(mintIn(root, {
        transition: { ...TRANSITION, toVersion: '0.0.0.0' },
      })).rejects.toThrow(UpgradeChildCapabilityError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('real CLI child bypasses only the unresolved global gate and consumes its bearer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-child-cli-'));
    const originalHome = join(root, 'original');
    const childHome = join(root, 'child');
    const originalState = join(originalHome, '.gbrain', 'upgrade-state.json');
    const cliPath = join(REPO_ROOT, 'src', 'cli.ts');
    mkdirSync(dirname(originalState), { recursive: true, mode: 0o700 });
    chmodSync(dirname(originalState), 0o700);
    writeFileSync(originalState, `${JSON.stringify({
      last_upgrade: {
        from: TRANSITION.fromVersion,
        to: TRANSITION.toVersion,
        status: 'running',
        ts: new Date(NOW).toISOString(),
        transition_id: TRANSITION.transitionId,
        brain_id: TRANSITION.brainId,
        brain_required: true,
      },
    })}\n`, { mode: 0o600 });
    mkdirSync(join(childHome, '.gbrain'), { recursive: true, mode: 0o700 });
    chmodSync(join(childHome, '.gbrain'), 0o700);

    try {
      const blocked = Bun.spawn([process.execPath, 'run', cliPath, 'schema'], {
        cwd: REPO_ROOT,
        env: { ...process.env, GBRAIN_HOME: childHome, HOME: originalHome, NODE_ENV: 'test' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [blockedError, blockedExit] = await Promise.all([
        new Response(blocked.stderr).text(),
        blocked.exited,
      ]);
      expect(blockedExit).toBe(1);
      expect(blockedError).toContain('blocked before database connect');

      const capability = await withEnv(
        { GBRAIN_HOME: childHome, HOME: originalHome },
        () => mintUpgradeChildCapability({
          configDir: join(childHome, '.gbrain'),
          rawArgs: ['schema'],
          invocation: [process.execPath, cliPath, 'schema'],
          transition: TRANSITION,
          snapshotBrainId: BRAIN_ID,
          parentPid: process.pid,
        }),
      );
      const authorized = Bun.spawn([process.execPath, 'run', cliPath, 'schema'], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          GBRAIN_HOME: childHome,
          HOME: originalHome,
          NODE_ENV: 'test',
          ...capability.env,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(authorized.stdout).text(),
        new Response(authorized.stderr).text(),
        authorized.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toContain('gbrain schema');
      expect(() => lstatSync(capability.path)).toThrow();
      expect(JSON.parse(readFileSync(originalState, 'utf8')).last_upgrade.status).toBe('running');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
