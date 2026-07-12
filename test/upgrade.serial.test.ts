import { describe, test, expect } from 'bun:test';
import {
  chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, statSync, readdirSync, symlinkSync, writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import {
  recordUpgradeError,
  recordParentPostUpgradeFailureIfMissing,
  loadReconciledUpgradeState,
  publishUpgradeSwapWriteAhead,
  parseUpgradeInvocation,
  assertInlineUpgradeTargetAllowed,
  resolveBunGlobalRoot,
  resolveUpgradeInvocation,
  runPostUpgradeMigrationGate,
  runPostUpgradeSetupBoundary,
  runPostUpgradeStateTransition,
  resumeDeferredPostUpgradeAtBoot,
  sanitizeUpgradeEvidenceError,
  saveUpgradeState,
  verifyUpgrade,
} from '../src/commands/upgrade.ts';
import { buildUpgradeErrorEvidenceCheck, buildUpgradeStateCheck } from '../src/commands/doctor.ts';
import { VERSION } from '../src/version.ts';

// We can't easily mock process.execPath in bun, so we test the upgrade
// command's --help output and the detection logic via subprocess

describe('upgrade command', () => {
  test('--help prints usage and exits 0', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'upgrade', '--help'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: gbrain upgrade');
    expect(stdout).toContain('Detects install method');
    expect(exitCode).toBe(0);
  });

  test('-h also prints usage', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'upgrade', '-h'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: gbrain upgrade');
    expect(exitCode).toBe(0);
  });

  test('parses only an exact target and swap-only flag', () => {
    expect(parseUpgradeInvocation(['--target', 'v0.42.58.0', '--swap-only']))
      .toEqual({ target: '0.42.58.0', swapOnly: true });
    expect(() => parseUpgradeInvocation(['--target'])).toThrow(/requires one exact/);
    expect(() => parseUpgradeInvocation(['--target', '0.42.58.0', '--target', '0.42.58.1']))
      .toThrow(/duplicate --target/i);
    expect(() => parseUpgradeInvocation(['--latest'])).toThrow(/unknown upgrade option/i);
  });

  test('local policy allows only one exact forward inline target', () => {
    expect(assertInlineUpgradeTargetAllowed('0.42.58.0', '0.42.57.0')).toBe('0.42.58.0');
    expect(() => assertInlineUpgradeTargetAllowed('0.42.57.0', '0.42.57.0'))
      .toThrow(/exact forward release/i);
    expect(() => assertInlineUpgradeTargetAllowed('0.42.59.0', '0.42.58.0'))
      .toThrow(/inline upgrade .* denied/i);
    expect(() => assertInlineUpgradeTargetAllowed('future', '0.42.58.0'))
      .toThrow(/not an exact supported release/i);
  });
});

describe('upgrade completion state', () => {
  test('records a fail-closed incomplete state with one recovery command', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-state-'));
    const priorGbrainHome = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = home;
    try {
      saveUpgradeState('0.42.58.0', VERSION, 'incomplete', 'preflight blocked');
      const path = join(home, '.gbrain', 'upgrade-state.json');
      const state = JSON.parse(readFileSync(path, 'utf-8'));
      expect(state.last_upgrade).toMatchObject({
        from: '0.42.58.0',
        to: VERSION,
        status: 'incomplete',
        safety_mode: 'migration_gate_blocked',
        recovery: 'gbrain post-upgrade',
        error: 'preflight blocked',
        brain_id: null,
        brain_required: false,
      });
      expect(state.last_upgrade.transition_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(statSync(join(home, '.gbrain')).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(join(home, '.gbrain')).filter(name => name.includes('.tmp-'))).toEqual([]);
    } finally {
      if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = priorGbrainHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('reconciled health loader never repairs permissions while inspecting', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-readonly-loader-'));
    const priorGbrainHome = process.env.GBRAIN_HOME;
    const priorHome = process.env.HOME;
    process.env.GBRAIN_HOME = home;
    process.env.HOME = home;
    try {
      saveUpgradeState('0.42.58.0', VERSION, 'incomplete', 'blocked');
      const path = join(home, '.gbrain', 'upgrade-state.json');
      chmodSync(path, 0o644);
      expect(loadReconciledUpgradeState()).toMatchObject({ kind: 'invalid' });
      expect(statSync(path).mode & 0o777).toBe(0o644);
    } finally {
      if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = priorGbrainHome;
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('sanitizes, bounds, and owner-protects upgrade error evidence', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-errors-'));
    const priorGbrainHome = process.env.GBRAIN_HOME;
    const priorHome = process.env.HOME;
    process.env.GBRAIN_HOME = home;
    process.env.HOME = home;
    try {
      const raw = `failed at ${join(home, '.gbrain', 'private.json')} and ${join(home, 'Documents')}\n` +
        `postgresql://alice:supersecret@db.example/test token=abc123 ${'x'.repeat(10_000)}`;
      recordUpgradeError({
        phase: 'post-upgrade',
        fromVersion: '1',
        toVersion: '2',
        error: raw,
        hint: 'repair',
      });
      const path = join(home, '.gbrain', 'upgrade-errors.jsonl');
      const record = JSON.parse(readFileSync(path, 'utf-8').trim());
      expect(record.error).not.toContain('supersecret');
      expect(record.error).not.toContain('abc123');
      expect(record.error).not.toContain(home);
      expect(record.error).toContain('<gbrain-home>');
      expect(record.error).toContain('<home>');
      expect(record.error).not.toContain('\n');
      expect(record.error.length).toBeLessThanOrEqual(4_096);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(sanitizeUpgradeEvidenceError(raw)).toBe(record.error);
    } finally {
      if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = priorGbrainHome;
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  for (const kind of ['symlink', 'hardlink'] as const) {
    test(`atomically resets a ${kind} upgrade-state path without changing its target`, () => {
      const home = mkdtempSync(join(tmpdir(), `gbrain-upgrade-state-${kind}-`));
      const priorGbrainHome = process.env.GBRAIN_HOME;
      process.env.GBRAIN_HOME = home;
      try {
        const dir = join(home, '.gbrain');
        const path = join(dir, 'upgrade-state.json');
        const victim = join(home, 'state-victim.json');
        const original = '{"private":true}\n';
        mkdirSync(dir, { recursive: true });
        writeFileSync(victim, original, { mode: 0o600 });
        if (kind === 'symlink') symlinkSync(victim, path);
        else linkSync(victim, path);

        saveUpgradeState('1', '2', 'complete');

        expect(readFileSync(victim, 'utf8')).toBe(original);
        expect(lstatSync(path).isSymbolicLink()).toBe(false);
        expect(lstatSync(path).nlink).toBe(1);
        expect(JSON.parse(readFileSync(path, 'utf8')).last_upgrade.status).toBe('complete');
      } finally {
        if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
        else process.env.GBRAIN_HOME = priorGbrainHome;
        rmSync(home, { recursive: true, force: true });
      }
    });

    test(`atomically resets a ${kind} upgrade-error path without changing its target`, () => {
      const home = mkdtempSync(join(tmpdir(), `gbrain-upgrade-error-${kind}-`));
      const priorGbrainHome = process.env.GBRAIN_HOME;
      process.env.GBRAIN_HOME = home;
      try {
        const dir = join(home, '.gbrain');
        const path = join(dir, 'upgrade-errors.jsonl');
        const victim = join(home, 'error-victim.jsonl');
        const original = '{"private":true}\n';
        mkdirSync(dir, { recursive: true });
        writeFileSync(victim, original, { mode: 0o600 });
        if (kind === 'symlink') symlinkSync(victim, path);
        else linkSync(victim, path);

        recordUpgradeError({ phase: 'test', fromVersion: '1', toVersion: '2', error: 'boom', hint: 'repair' });

        expect(readFileSync(victim, 'utf8')).toBe(original);
        expect(lstatSync(path).isSymbolicLink()).toBe(false);
        expect(lstatSync(path).nlink).toBe(1);
        expect(JSON.parse(readFileSync(path, 'utf8').trim()).error).toBe('boom');
      } finally {
        if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
        else process.env.GBRAIN_HOME = priorGbrainHome;
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  test('direct post-upgrade failure remains red, then same-target success clears noise without deleting audit', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-post-upgrade-transition-'));
    const priorGbrainHome = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = home;
    try {
      saveUpgradeState('1.0.0', VERSION, 'post_upgrade_pending');
      await expect(
        runPostUpgradeStateTransition(async () => { throw new Error('migration gate failed'); }),
      ).rejects.toThrow('migration gate failed');

      const statePath = join(home, '.gbrain', 'upgrade-state.json');
      const errorPath = join(home, '.gbrain', 'upgrade-errors.jsonl');
      expect(JSON.parse(readFileSync(statePath, 'utf8')).last_upgrade).toMatchObject({
        from: '1.0.0',
        to: VERSION,
        status: 'incomplete',
        recovery: 'gbrain post-upgrade',
      });
      expect(buildUpgradeErrorEvidenceCheck()).toMatchObject({ status: 'warn' });
      const auditBefore = readFileSync(errorPath, 'utf8');
      expect(await recordParentPostUpgradeFailureIfMissing(
        '1.0.0', VERSION, 'parent saw child exit',
      )).toBe(false);
      expect(readFileSync(errorPath, 'utf8')).toBe(auditBefore);

      await new Promise(resolve => setTimeout(resolve, 5));
      await runPostUpgradeStateTransition(async () => {});

      expect(JSON.parse(readFileSync(statePath, 'utf8')).last_upgrade).toMatchObject({
        from: '1.0.0',
        to: VERSION,
        status: 'complete',
      });
      expect(buildUpgradeErrorEvidenceCheck()).toBeNull();
      expect(readFileSync(errorPath, 'utf8')).toBe(auditBefore);
    } finally {
      if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = priorGbrainHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('refuses a pending transition when the active brain changed before any migration runs', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-cross-brain-'));
    const priorGbrainHome = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = home;
    const brainA = 'db:11111111-1111-4111-8111-111111111111';
    const brainB = 'db:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const context = { transitionId: '11111111-1111-4111-8111-111111111111', brainId: brainA };
    let ran = false;
    let identityWrites = 0;
    try {
      saveUpgradeState('1', VERSION, 'post_upgrade_pending', undefined, context);
      await expect(runPostUpgradeStateTransition(
        async () => { ran = true; },
        async () => brainB,
        { establishBrainId: async () => { identityWrites++; return brainB; } },
      )).rejects.toThrow(/does not match|bound to db:11111111/);
      expect(ran).toBe(false);
      expect(identityWrites).toBe(0);
      expect(JSON.parse(readFileSync(join(home, '.gbrain', 'upgrade-state.json'), 'utf8')).last_upgrade)
        .toMatchObject({ status: 'incomplete', transition_id: context.transitionId, brain_id: context.brainId });
      expect(buildUpgradeStateCheck()).toMatchObject({ status: 'fail' });

      saveUpgradeState('1', VERSION, 'post_upgrade_pending', undefined, context);
      await expect(runPostUpgradeStateTransition(
        async () => { ran = true; },
        async () => null,
        { establishBrainId: async () => { identityWrites++; return brainB; } },
      )).rejects.toThrow(/bound to db:11111111/);
      expect(ran).toBe(false);
      expect(identityWrites).toBe(0);
    } finally {
      if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = priorGbrainHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('same-target completion from another transition is rejected and never clears failure evidence', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-transition-isolation-'));
    const priorGbrainHome = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = home;
    const failed = {
      transitionId: '22222222-2222-4222-8222-222222222222',
      brainId: 'db:11111111-1111-4111-8111-111111111111',
    };
    const unrelated = {
      transitionId: '33333333-3333-4333-8333-333333333333',
      brainId: 'db:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    };
    try {
      saveUpgradeState('1', VERSION, 'post_upgrade_pending', undefined, failed);
      await expect(runPostUpgradeStateTransition(
        async () => { throw new Error('failed transition'); },
        async () => failed.brainId,
      )).rejects.toThrow('failed transition');
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(() => saveUpgradeState('1', VERSION, 'complete', undefined, unrelated))
        .toThrow(/CAS mismatch/);
      expect(buildUpgradeErrorEvidenceCheck()).toMatchObject({ status: 'warn' });
    } finally {
      if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = priorGbrainHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('swap-only deferred handoff is single-flight and reaches complete before normal boot', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-deferred-'));
    const priorGbrainHome = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = home;
    const context = { transitionId: '44444444-4444-4444-8444-444444444444', brainId: null };
    let calls = 0;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    try {
      saveUpgradeState('1', VERSION, 'deferred', undefined, context);
      const first = resumeDeferredPostUpgradeAtBoot({
        run: async () => { calls++; await blocked; },
        resolveBrainId: async () => null,
        lockDir: join(home, '.gbrain', 'test-locks'),
      });
      while (calls === 0) await new Promise(resolve => setTimeout(resolve, 1));
      await expect(resumeDeferredPostUpgradeAtBoot({
        run: async () => { calls++; },
        resolveBrainId: async () => null,
        lockDir: join(home, '.gbrain', 'test-locks'),
      })).rejects.toThrow(/locked|LOCK_BUSY/i);
      release();
      expect(await first).toBe('complete');
      expect(calls).toBe(1);
      expect(JSON.parse(readFileSync(join(home, '.gbrain', 'upgrade-state.json'), 'utf8')).last_upgrade.status)
        .toBe('complete');
      expect(buildUpgradeStateCheck()).toBeNull();
    } finally {
      release?.();
      if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = priorGbrainHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a crash-visible running handoff replays idempotently, while incomplete remains fail-closed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-running-'));
    const priorGbrainHome = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = home;
    const context = { transitionId: '55555555-5555-4555-8555-555555555555', brainId: null };
    try {
      saveUpgradeState('1', VERSION, 'running', undefined, context);
      expect(await resumeDeferredPostUpgradeAtBoot({
        run: async () => {},
        resolveBrainId: async () => null,
        lockDir: join(home, '.gbrain', 'test-locks'),
      })).toBe('complete');

      saveUpgradeState('1', VERSION, 'incomplete', 'blocked', context);
      await expect(resumeDeferredPostUpgradeAtBoot({
        run: async () => { throw new Error('must not run'); },
        resolveBrainId: async () => null,
        lockDir: join(home, '.gbrain', 'test-locks'),
      })).rejects.toThrow('run `gbrain post-upgrade`');
      expect(buildUpgradeStateCheck()).toMatchObject({ status: 'fail' });
    } finally {
      if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = priorGbrainHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('adopts the exact previous-binary HOME handoff into a bound canonical transition before work', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-legacy-home-'));
    const stateParent = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-canonical-home-'));
    const priorHome = process.env.HOME;
    const priorGbrainHome = process.env.GBRAIN_HOME;
    process.env.HOME = home;
    process.env.GBRAIN_HOME = stateParent;
    const legacyDir = join(home, '.gbrain');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'upgrade-state.json'), JSON.stringify({
      last_upgrade: { from: '0.42.58.0', to: VERSION, ts: new Date().toISOString() },
    }));
    let ran = false;
    try {
      await runPostUpgradeStateTransition(async transition => {
        ran = true;
        expect(transition?.context?.brainId).toBe('db:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
        const during = JSON.parse(readFileSync(
          join(stateParent, '.gbrain', 'upgrade-state.json'),
          'utf8',
        )).last_upgrade;
        expect(during).toMatchObject({
          from: '0.42.58.0',
          to: VERSION,
          status: 'deferred',
          brain_id: 'db:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          brain_required: true,
        });
      }, async () => 'db:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      expect(ran).toBe(true);
      expect(JSON.parse(readFileSync(
        join(stateParent, '.gbrain', 'upgrade-state.json'),
        'utf8',
      )).last_upgrade.status).toBe('complete');
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = priorGbrainHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(stateParent, { recursive: true, force: true });
    }
  });

  test('old swap-only handoff is consumed exactly once before normal boot', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-legacy-boot-'));
    const stateParent = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-legacy-boot-state-'));
    const priorHome = process.env.HOME;
    const priorGbrainHome = process.env.GBRAIN_HOME;
    process.env.HOME = home;
    process.env.GBRAIN_HOME = stateParent;
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'upgrade-state.json'), JSON.stringify({
      last_upgrade: { from: '0.42.58.0', to: VERSION, ts: new Date().toISOString() },
    }));
    let calls = 0;
    try {
      expect(await resumeDeferredPostUpgradeAtBoot({
        run: async () => { calls++; },
        resolveBrainId: async () => null,
        lockDir: join(stateParent, '.gbrain', 'test-locks'),
      })).toBe('complete');
      expect(await resumeDeferredPostUpgradeAtBoot({
        run: async () => { calls++; },
        resolveBrainId: async () => null,
        lockDir: join(stateParent, '.gbrain', 'test-locks'),
      })).toBe('none');
      expect(calls).toBe(1);
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = priorGbrainHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(stateParent, { recursive: true, force: true });
    }
  });

  test('malformed, unknown, or unbound canonical state blocks before callback', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-invalid-state-'));
    const priorGbrainHome = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = home;
    const dir = join(home, '.gbrain');
    const path = join(dir, 'upgrade-state.json');
    mkdirSync(dir, { recursive: true });
    let calls = 0;
    try {
      for (const raw of [
        '{not-json',
        JSON.stringify({ last_upgrade: { from: '1', to: VERSION, status: 'mystery' } }),
        JSON.stringify({ last_upgrade: { from: '1', to: VERSION, status: 'complete' } }),
      ]) {
        writeFileSync(path, raw);
        await expect(runPostUpgradeStateTransition(async () => { calls++; }))
          .rejects.toThrow(/malformed|unknown status|not bound/i);
        expect(buildUpgradeStateCheck()).toMatchObject({ status: 'fail' });
      }
      expect(calls).toBe(0);
    } finally {
      if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = priorGbrainHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('rejects every unresolved state whose target is empty, stale, or future', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-wrong-target-'));
    const priorGbrainHome = process.env.GBRAIN_HOME;
    const priorHome = process.env.HOME;
    process.env.GBRAIN_HOME = home;
    process.env.HOME = home;
    const dir = join(home, '.gbrain');
    const path = join(dir, 'upgrade-state.json');
    const context = {
      transition_id: '66666666-6666-4666-8666-666666666666',
      brain_id: null,
      brain_required: false,
    };
    mkdirSync(dir, { recursive: true });
    let calls = 0;
    try {
      for (const status of ['post_upgrade_pending', 'deferred', 'running', 'incomplete']) {
        for (const target of ['', '0.0.1', '999.999.999.999']) {
          writeFileSync(path, JSON.stringify({
            last_upgrade: {
              from: '0.0.0', to: target, status, ts: new Date().toISOString(), ...context,
            },
          }));
          await expect(runPostUpgradeStateTransition(async () => { calls++; }))
            .rejects.toThrow(/targets .*not this/i);
        }
      }
      expect(calls).toBe(0);
    } finally {
      if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = priorGbrainHome;
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('write-ahead swap crash is durable and recoverable only by the runnable new binary', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-swap-wal-'));
    const priorGbrainHome = process.env.GBRAIN_HOME;
    const priorHome = process.env.HOME;
    process.env.GBRAIN_HOME = home;
    process.env.HOME = home;
    const context = { transitionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', brainId: null };
    let ran = false;
    try {
      // Simulate process death immediately after replacement: only the
      // pre-swap WAL exists when the new VERSION starts.
      publishUpgradeSwapWriteAhead('0.42.58.0', context);
      expect(JSON.parse(readFileSync(
        join(home, '.gbrain', 'upgrade-state.json'), 'utf8',
      )).last_upgrade).toMatchObject({
        from: '0.42.58.0',
        to: '<unverified-replacement>',
        status: 'swap_running',
        transition_id: context.transitionId,
      });
      expect(loadReconciledUpgradeState()).toMatchObject({
        kind: 'pending', from: '0.42.58.0', to: VERSION,
        status: 'post_upgrade_pending', transitionId: context.transitionId,
      });

      await runPostUpgradeStateTransition(async transition => {
        ran = true;
        expect(transition).toMatchObject({
          from: '0.42.58.0', to: VERSION, status: 'post_upgrade_pending',
        });
      }, async () => null);
      expect(ran).toBe(true);
      expect(loadReconciledUpgradeState()).toMatchObject({
        kind: 'complete', from: '0.42.58.0', to: VERSION,
        transitionId: context.transitionId,
      });
    } finally {
      if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = priorGbrainHome;
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('write-ahead state blocks the unchanged old binary instead of guessing a target', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-swap-old-binary-'));
    const priorGbrainHome = process.env.GBRAIN_HOME;
    const priorHome = process.env.HOME;
    process.env.GBRAIN_HOME = home;
    process.env.HOME = home;
    const context = { transitionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', brainId: null };
    try {
      publishUpgradeSwapWriteAhead(VERSION, context);
      expect(loadReconciledUpgradeState()).toMatchObject({ kind: 'invalid' });
      await expect(runPostUpgradeStateTransition(async () => {
        throw new Error('must not run');
      })).rejects.toThrow(/without a verified forward target/i);
    } finally {
      if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = priorGbrainHome;
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('write-ahead recovery cannot bypass downgrade verification', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-swap-downgrade-'));
    const priorGbrainHome = process.env.GBRAIN_HOME;
    const priorHome = process.env.HOME;
    process.env.GBRAIN_HOME = home;
    process.env.HOME = home;
    const context = { transitionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', brainId: null };
    try {
      publishUpgradeSwapWriteAhead('999.999.999.998', context);
      expect(loadReconciledUpgradeState()).toMatchObject({ kind: 'invalid' });
      await expect(runPostUpgradeStateTransition(async () => {
        throw new Error('must not run');
      })).rejects.toThrow(/without a verified forward target/i);
    } finally {
      if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = priorGbrainHome;
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('fresh current-target legacy handoff supersedes stale canonical completion after rollback', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-rollback-home-'));
    const stateParent = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-rollback-state-'));
    const priorHome = process.env.HOME;
    const priorGbrainHome = process.env.GBRAIN_HOME;
    process.env.HOME = home;
    process.env.GBRAIN_HOME = stateParent;
    const canonicalDir = join(stateParent, '.gbrain');
    const legacyDir = join(home, '.gbrain');
    mkdirSync(canonicalDir, { recursive: true });
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(canonicalDir, 'upgrade-state.json'), JSON.stringify({
      last_upgrade: {
        from: '0.42.57.0', to: VERSION, status: 'complete',
        ts: '2026-07-10T00:00:00.000Z',
        transition_id: '77777777-7777-4777-8777-777777777777',
        brain_id: null, brain_required: false,
      },
    }));
    writeFileSync(join(legacyDir, 'upgrade-state.json'), JSON.stringify({
      last_upgrade: {
        from: '0.42.58.0', to: VERSION, ts: '2026-07-11T00:00:00.000Z',
      },
    }));
    let calls = 0;
    try {
      await runPostUpgradeStateTransition(async transition => {
        calls++;
        expect(transition).toMatchObject({
          from: '0.42.58.0', to: VERSION, status: 'deferred', legacy: false,
        });
      }, async () => null);
      expect(calls).toBe(1);
      expect(JSON.parse(readFileSync(
        join(canonicalDir, 'upgrade-state.json'), 'utf8',
      )).last_upgrade).toMatchObject({
        from: '0.42.58.0', to: VERSION, status: 'complete',
      });

      // The now-newer canonical completion suppresses the stale legacy
      // breadcrumb instead of replaying it forever.
      await runPostUpgradeStateTransition(async transition => {
        expect(transition).toBeNull();
      }, async () => null);
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = priorGbrainHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(stateParent, { recursive: true, force: true });
    }
  });

  test('a retained prior-version HOME breadcrumb cannot block the next canonical upgrade', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-prior-home-'));
    const stateParent = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-next-state-'));
    const priorHome = process.env.HOME;
    const priorGbrainHome = process.env.GBRAIN_HOME;
    process.env.HOME = home;
    process.env.GBRAIN_HOME = stateParent;
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    mkdirSync(join(stateParent, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'upgrade-state.json'), JSON.stringify({
      last_upgrade: {
        from: '0.42.56.0', to: '0.42.57.0', status: 'complete',
        ts: '2026-07-09T00:00:00.000Z',
        transition_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        brain_id: null, brain_required: false,
      },
    }));
    writeFileSync(join(stateParent, '.gbrain', 'upgrade-state.json'), JSON.stringify({
      last_upgrade: {
        from: '0.42.58.0', to: VERSION, status: 'post_upgrade_pending',
        ts: '2026-07-11T00:00:00.000Z',
        transition_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        brain_id: null, brain_required: false,
      },
    }));
    let calls = 0;
    try {
      await runPostUpgradeStateTransition(async transition => {
        calls++;
        expect(transition).toMatchObject({
          from: '0.42.58.0', to: VERSION, status: 'post_upgrade_pending',
        });
      }, async () => null);
      expect(calls).toBe(1);
      expect(JSON.parse(readFileSync(
        join(stateParent, '.gbrain', 'upgrade-state.json'), 'utf8',
      )).last_upgrade.status).toBe('complete');
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = priorGbrainHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(stateParent, { recursive: true, force: true });
    }
  });

  test('canonical and legacy pending disagreement fails closed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-disagree-home-'));
    const stateParent = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-disagree-state-'));
    const priorHome = process.env.HOME;
    const priorGbrainHome = process.env.GBRAIN_HOME;
    process.env.HOME = home;
    process.env.GBRAIN_HOME = stateParent;
    const record = (transitionId: string) => ({
      last_upgrade: {
        from: '0.42.58.0', to: VERSION, status: 'deferred',
        ts: '2026-07-11T00:00:00.000Z', transition_id: transitionId,
        brain_id: null, brain_required: false,
      },
    });
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    mkdirSync(join(stateParent, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'upgrade-state.json'), JSON.stringify(
      record('88888888-8888-4888-8888-888888888888'),
    ));
    writeFileSync(join(stateParent, '.gbrain', 'upgrade-state.json'), JSON.stringify(
      record('99999999-9999-4999-8999-999999999999'),
    ));
    let ran = false;
    try {
      await expect(runPostUpgradeStateTransition(async () => { ran = true; }))
        .rejects.toThrow(/states disagree/i);
      expect(ran).toBe(false);
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = priorGbrainHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(stateParent, { recursive: true, force: true });
    }
  });

  test('direct recovery and boot recovery serialize on the same owner lock', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-direct-boot-race-'));
    const priorGbrainHome = process.env.GBRAIN_HOME;
    const priorHome = process.env.HOME;
    process.env.GBRAIN_HOME = home;
    process.env.HOME = home;
    const context = { transitionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', brainId: null };
    let entered = false;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    try {
      saveUpgradeState('1', VERSION, 'deferred', undefined, context);
      const direct = runPostUpgradeStateTransition(async () => {
        entered = true;
        await blocked;
      }, async () => null);
      while (!entered) await new Promise(resolve => setTimeout(resolve, 1));
      await expect(resumeDeferredPostUpgradeAtBoot({
        run: async () => { throw new Error('must not run concurrently'); },
        resolveBrainId: async () => null,
      })).rejects.toThrow(/locked|LOCK_BUSY/i);
      release();
      await direct;
      expect(JSON.parse(readFileSync(join(home, '.gbrain', 'upgrade-state.json'), 'utf8'))
        .last_upgrade.status).toBe('complete');
    } finally {
      release?.();
      if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = priorGbrainHome;
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('detectInstallMethod heuristic (source analysis)', () => {
  // Read the source and verify the detection order is correct
  const source = readFileSync(
    new URL('../src/commands/upgrade.ts', import.meta.url),
    'utf-8',
  );

  test('checks node_modules before binary', () => {
    const nodeModulesIdx = source.indexOf('node_modules');
    const binaryIdx = source.indexOf("endsWith('/gbrain')");
    expect(nodeModulesIdx).toBeLessThan(binaryIdx);
  });

  test('checks binary before clawhub', () => {
    const binaryIdx = source.indexOf("endsWith('/gbrain')");
    const clawhubIdx = source.indexOf("clawhub --version");
    expect(binaryIdx).toBeLessThan(clawhubIdx);
  });

  test('uses clawhub --version, not which clawhub', () => {
    expect(source).toContain("clawhub --version");
    expect(source).not.toContain('which clawhub');
  });

  test('has timeout on upgrade execSync calls', () => {
    // Count timeout occurrences in execSync calls
    const timeoutMatches = source.match(/timeout:\s*\d+/g) || [];
    expect(timeoutMatches.length).toBeGreaterThanOrEqual(2); // bun + clawhub detection at minimum
  });

  test('return type includes bun-link variant (v0.28.5 cluster D)', () => {
    expect(source).toContain("'bun' | 'bun-link' | 'binary' | 'clawhub' | 'unknown'");
  });

  test('does not reference npm in case labels or messages', () => {
    // Should not have case 'npm' or 'Upgrading via npm'
    expect(source).not.toContain("case 'npm'");
    expect(source).not.toContain('via npm');
    expect(source).not.toContain('npm upgrade');
  });

  // v0.28.5 cluster D: 3-signal layered detection.
  test('bun-link signal walks .git/config for garrytan/gbrain match', () => {
    expect(source).toContain('function detectBunLink');
    expect(source).toContain('GBRAIN_GITHUB_REPO');
    expect(source).toContain('toLowerCase()');
  });

  test('detectBunLink does not gate on isSymbolicLink (bun resolves argv[1])', () => {
    // v0.28.5 gated on lstatSync(argv1).isSymbolicLink() which always
    // returned false because bun resolves symlinks before setting argv[1].
    // The function body between "function detectBunLink" and the next
    // top-level function must not contain isSymbolicLink.
    const fnStart = source.indexOf('function detectBunLink');
    const fnEnd = source.indexOf('\nfunction ', fnStart + 1);
    const fnBody = source.slice(fnStart, fnEnd > -1 ? fnEnd : undefined);
    expect(fnBody).not.toContain('isSymbolicLink');
    expect(fnBody).not.toContain('lstatSync');
  });

  test('detectBunLink returns repoRoot, not a string literal', () => {
    expect(source).toContain("{ repoRoot: string } | null");
    expect(source).toContain('repoRoot: dir');
  });

  test('bun-link upgrade uses execFileSync for shell-injection safety', () => {
    // execFileSync with array args bypasses the shell (same pattern as
    // dry-fix.ts:172). execSync with template strings is vulnerable to
    // paths containing shell metacharacters.
    expect(source).toContain("['-C', linkInfo.repoRoot, 'fetch', '--force', 'origin'");
    expect(source).toContain("['-C', linkInfo.repoRoot, 'checkout', '--detach', tagRef]");
    expect(source).toContain("'bun', ['install', '--frozen-lockfile']");
  });

  test('publishes the bound write-ahead fence before every updater can mutate the install', () => {
    const walIdx = source.indexOf('publishUpgradeSwapWriteAhead(oldVersion, transitionContext)');
    expect(walIdx).toBeGreaterThan(-1);
    expect(walIdx).toBeLessThan(source.indexOf("'git',\n            ['-C', linkInfo.repoRoot, 'fetch'"));
    expect(walIdx).toBeLessThan(source.indexOf("'bun', ['add', '--exact'"));
    expect(walIdx).toBeLessThan(source.indexOf('await runBinarySelfUpdate(process.execPath'));
    expect(source).not.toContain("execSync('clawhub update gbrain'");
  });

  test('bun global upgrade pins the exact package target in the global root', () => {
    expect(source).toContain('const bunGlobalRoot = resolveBunGlobalRoot()');
    expect(source).toContain("'bun', ['add', '--exact', `github:${GBRAIN_GITHUB_REPO}#v${targetVersion}`]");
    expect(source).toContain('{ cwd: bunGlobalRoot, stdio:');
  });

  test('classifyBunInstall checks repository.url AND src/cli.ts marker', () => {
    // Codex feedback: repository.url alone is spoofable by future squatter
    // updates; the source-marker fallback (src/cli.ts presence) is
    // belt-and-suspenders.
    expect(source).toContain('function classifyBunInstall');
    expect(source).toContain('pkg.repository');
    expect(source).toContain("'src', 'cli.ts'");
  });

  test('squatter recovery message names both source-clone AND release-binary paths', () => {
    expect(source).toContain('printSquatterRecovery');
    expect(source).toContain('git clone');
    expect(source).toContain('releases');
    expect(source).toContain('#658');
  });
});

describe('resolveBunGlobalRoot', () => {
  const originalBunInstall = process.env.BUN_INSTALL;
  const originalHome = process.env.HOME;
  const originalArgv1 = process.argv[1];

  function restoreEnv() {
    if (originalBunInstall === undefined) delete process.env.BUN_INSTALL;
    else process.env.BUN_INSTALL = originalBunInstall;

    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;

    process.argv[1] = originalArgv1;
  }

  test('honors BUN_INSTALL override', () => {
    try {
      process.env.BUN_INSTALL = '/custom/bun';
      process.env.HOME = '/ignored/home';
      expect(resolveBunGlobalRoot()).toBe('/custom/bun/install/global');
    } finally {
      restoreEnv();
    }
  });

  test('uses canonical ~/.bun/install/global when present', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-home-'));
    try {
      delete process.env.BUN_INSTALL;
      process.env.HOME = home;
      const globalRoot = join(home, '.bun', 'install', 'global');
      mkdirSync(join(globalRoot, 'node_modules'), { recursive: true });
      writeFileSync(join(globalRoot, 'package.json'), '{}');

      expect(resolveBunGlobalRoot()).toBe(globalRoot);
    } finally {
      restoreEnv();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('falls back to the package root above node_modules/gbrain', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-home-'));
    const globalRoot = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-global-'));
    try {
      delete process.env.BUN_INSTALL;
      process.env.HOME = home;
      const cliPath = join(globalRoot, 'node_modules', 'gbrain', 'src', 'cli.ts');
      mkdirSync(dirname(cliPath), { recursive: true });
      mkdirSync(join(globalRoot, 'node_modules'), { recursive: true });
      writeFileSync(join(globalRoot, 'package.json'), '{}');
      writeFileSync(cliPath, '');
      process.argv[1] = cliPath;

      expect(resolveBunGlobalRoot()).toBe(realpathSync(globalRoot));
    } finally {
      restoreEnv();
      rmSync(home, { recursive: true, force: true });
      rmSync(globalRoot, { recursive: true, force: true });
    }
  });
});

describe('post-upgrade behavior (post v0.12.0 merge)', () => {
  // The earlier --execute / --yes / auto_execute tests were removed when the
  // master merge replaced the markdown-driven runPostUpgrade with the TS
  // migration registry + apply-migrations orchestrator. The new contract:
  //   - Prints feature pitches for migrations newer than the prior binary
  //     (via the TS registry, not skills/migrations/*.md).
  //   - Always invokes `apply-migrations --yes` (idempotent; no-op when
  //     nothing is pending).
  //   - --help still prints usage.

  test('--help prints usage', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'post-upgrade', '--help'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: gbrain post-upgrade');
  });

  test('binary verification rejects empty or unreachable target before handoff publication', () => {
    expect(() => verifyUpgrade(() => '')).toThrow(/could not be verified/i);
    expect(() => verifyUpgrade(() => { throw new Error('missing binary'); }))
      .toThrow(/could not be verified/i);
    expect(() => verifyUpgrade(() => 'gbrain definitely-new'))
      .toThrow(/could not be verified/i);
    expect(() => verifyUpgrade(() => `gbrain ${VERSION}\nextra-line`))
      .toThrow(/could not be verified/i);
    expect(() => verifyUpgrade(() => 'gbrain 0.42.57.0', '0.42.58.0'))
      .toThrow(/could not be verified/i);
    expect(() => verifyUpgrade(() => 'gbrain 0.42.58.0', '0.42.58.0'))
      .toThrow(/could not be verified/i);
    expect(() => verifyUpgrade(
      () => 'gbrain 0.42.60.0', '0.42.58.0', '0.42.59.0',
    )).toThrow(/could not be verified/i);
    expect(verifyUpgrade(
      () => 'gbrain 0.42.59.0', '0.42.58.0', '0.42.59.0',
    )).toBe('0.42.59.0');
    expect(verifyUpgrade(() => `gbrain ${VERSION}\n`, '0.42.58.0')).toBe(VERSION);
  });

  test('verification and child phases resolve the updated install, never a PATH shim', () => {
    expect(resolveUpgradeInvocation(['--version'], {
      execPath: '/opt/gbrain/bin/gbrain', main: '/ignored/entry.ts',
    })).toEqual(['/opt/gbrain/bin/gbrain', '--version']);
    expect(resolveUpgradeInvocation(['post-upgrade'], {
      execPath: '/opt/bun/bin/bun', main: '/opt/gbrain/src/cli.ts',
    })).toEqual(['/opt/bun/bin/bun', '/opt/gbrain/src/cli.ts', 'post-upgrade']);
  });

  test('migration gate failure prevents every setup side effect', async () => {
    let setupCalls = 0;
    let schemaCalls = 0;
    await expect(runPostUpgradeSetupBoundary(
      async () => { throw new Error('preflight blocked'); },
      async () => { schemaCalls++; },
      async () => { setupCalls++; },
    )).rejects.toThrow('preflight blocked');
    expect(schemaCalls).toBe(0);
    expect(setupCalls).toBe(0);

    await expect(runPostUpgradeSetupBoundary(
      async () => {},
      async () => { throw new Error('schema migration blocked'); },
      async () => { setupCalls++; },
    )).rejects.toThrow('schema migration blocked');
    expect(setupCalls).toBe(0);
  });

  test('continues past an empty migration plan instead of exiting the process', async () => {
    let called = false;
    const result = await runPostUpgradeMigrationGate(async () => {
      called = true;
      return { exitCode: 0, status: 'ok', reason: 'up_to_date', migrationsRun: 0 };
    });

    expect(called).toBe(true);
    expect(result.reason).toBe('up_to_date');
  });

  test('propagates one bound transition authority into the migration runner', async () => {
    const brainId = 'db:22222222-2222-4222-8222-222222222222';
    const transition = {
      transitionId: '11111111-1111-4111-8111-111111111111',
      brainId,
      fromVersion: '0.42.58.0',
      toVersion: VERSION,
    };
    let received: unknown;
    await runPostUpgradeMigrationGate(async (_args, authority) => {
      received = authority;
      return { exitCode: 0, status: 'ok', reason: 'up_to_date', migrationsRun: 0 };
    }, brainId, transition);

    expect(received).toEqual({ expectedBrainId: brainId, upgradeTransition: transition });
  });

  test('fails closed on partial migration outcome', async () => {
    await expect(runPostUpgradeMigrationGate(async () => ({
      exitCode: 1,
      status: 'blocked',
      reason: 'partial',
      migrationsRun: 1,
      blockedVersions: ['0.42.59.0'],
    }))).rejects.toThrow(/partial.*0\.42\.59\.0/);
  });
});
