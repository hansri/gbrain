/**
 * Durability cron generators (v0.42.44, D2 + D12): pure-string renderers.
 * Asserts the cron is DB-free (gbrain sources pull --path, NOT `pull <id>`),
 * secret-free, self-disabling, and that the launchd plist is periodic.
 */
import { describe, test, expect } from 'bun:test';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
  symlinkSync, existsSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import {
  renderCronWrapper, generateBrainPullPlist, __durabilityTesting,
  type DurabilityCronRuntime,
} from '../src/core/brain-repo-durability.ts';
import { withEnv } from './helpers/with-env.ts';

const TOKEN = 'ghp_SHOULD_NEVER_APPEAR';

describe('renderCronWrapper (D2 DB-free)', () => {
  const w = renderCronWrapper(
    'wiki', '/data/clones/wiki', 'main', 'https://github.com/acme/wiki.git',
    '/usr/local/bin/gbrain', '/home/u/.gbrain/brain-push.log',
  );

  test('calls the DB-free path command, not the engine-opening one', () => {
    expect(w).toContain("sources pull --path '/data/clones/wiki'");
    expect(w).toContain("--branch 'main'");
    expect(w).toContain("--expected-remote 'https://github.com/acme/wiki.git'");
    expect(w).not.toMatch(/sources pull '?wiki'?(\s|$)/); // never `sources pull wiki`
  });

  test('self-disables when the captured checkout is gone', () => {
    expect(w).toContain("if [ ! -d '/data/clones/wiki/.git' ]");
    expect(w).toContain('path gone, skipping');
  });

  test('never sources shell profiles and never bakes a token', () => {
    expect(w).not.toMatch(/(?:source|\.)\s+~\/(?:\.zshenv|\.zshrc|\.bashrc)/);
    expect(w).toContain('export PATH=');
    expect(w.includes(TOKEN)).toBe(false);
  });

  test('runs with an empty environment using only the captured CLI path', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-cron-'));
    try {
      const repo = join(root, 'repo');
      const capture = join(root, 'argv');
      const cli = join(root, 'gbrain');
      const wrapper = join(root, 'pull.sh');
      mkdirSync(join(repo, '.git'), { recursive: true });
      writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' "$@" > '${capture}'\n`);
      chmodSync(cli, 0o755);
      writeFileSync(wrapper, renderCronWrapper(
        'wiki', repo, 'main', 'https://github.com/acme/wiki.git', cli, join(root, 'pull.log'),
      ));
      chmodSync(wrapper, 0o755);

      execFileSync('/usr/bin/env', ['-i', wrapper], { stdio: 'ignore' });

      expect(readFileSync(capture, 'utf8').trim().split('\n')).toEqual([
        'sources', 'pull', '--path', repo, '--branch', 'main',
        '--expected-remote', 'https://github.com/acme/wiki.git',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('shell-shaped captured paths remain inert when the checkout is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-cron-quote-'));
    try {
      const sentinel = join(root, 'command-substitution-ran');
      const hostileRepo = join(root, `missing-$(touch$IFS${sentinel})`);
      const wrapper = join(root, 'pull.sh');
      const log = join(root, 'pull.log');
      writeFileSync(wrapper, renderCronWrapper(
        'wiki', hostileRepo, 'main', 'https://github.com/acme/wiki.git',
        '/usr/local/bin/gbrain', log,
      ));
      chmodSync(wrapper, 0o755);

      execFileSync('/usr/bin/env', ['-i', wrapper], { stdio: 'ignore' });

      expect(existsSync(sentinel)).toBe(false);
      expect(readFileSync(log, 'utf8')).toContain(hostileRepo);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('generateBrainPullPlist (D12 launchd)', () => {
  const plist = generateBrainPullPlist('com.gbrain.brain-pull.wiki', '/home/u/.gbrain/brain-pull-wiki.sh', '/home/u', 1800);

  test('is periodic (StartInterval), not a KeepAlive daemon', () => {
    expect(plist).toContain('<key>StartInterval</key><integer>1800</integer>');
    expect(plist).not.toContain('<key>KeepAlive</key>');
  });

  test('carries the per-source label and the wrapper path only (no secret)', () => {
    expect(plist).toContain('<string>com.gbrain.brain-pull.wiki</string>');
    expect(plist).toContain('/home/u/.gbrain/brain-pull-wiki.sh');
    expect(plist.includes(TOKEN)).toBe(false);
  });

  test.serial('launchctl load failure is reported as needs_attention', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-launchd-fail-'));
    const home = join(root, 'home');
    const gbrainHome = join(home, '.gbrain');
    const calls: string[][] = [];
    const runtime: DurabilityCronRuntime = {
      platform: 'darwin',
      execFile(command, args) {
        calls.push([command, ...args]);
        if (args[0] === 'load') throw new Error('synthetic launchctl failure');
      },
    };
    try {
      await withEnv({ HOME: home, GBRAIN_HOME: gbrainHome }, async () => {
        const result = __durabilityTesting.installDurabilityCron(
          'wiki', join(root, 'repo'), 'main', 'https://github.com/acme/wiki.git',
          1800, false, runtime,
        );
        expect(result.status).toBe('needs_attention');
        expect(result.detail).toContain('synthetic launchctl failure');
        expect(calls.map(call => call.slice(0, 2))).toEqual([
          ['launchctl', 'unload'],
          ['launchctl', 'load'],
        ]);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.serial('atomic cron artifacts refuse symlink targets without changing outside files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-cron-symlink-'));
    const home = join(root, 'home');
    const gbrainHome = join(home, '.gbrain');
    const sentinel = join(root, 'outside-sentinel');
    writeFileSync(sentinel, 'outside cron sentinel\n', { mode: 0o600 });
    mkdirSync(gbrainHome, { recursive: true, mode: 0o700 });
    symlinkSync(sentinel, join(gbrainHome, 'brain-pull-wiki.sh'));
    try {
      await withEnv({ HOME: home, GBRAIN_HOME: gbrainHome }, async () => {
        expect(() => __durabilityTesting.writeCronWrapper(
          'wiki', join(root, 'repo'), 'main', 'https://github.com/acme/wiki.git',
        )).toThrow(/cron wrapper/);
        expect(readFileSync(sentinel, 'utf8')).toBe('outside cron sentinel\n');
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.serial('atomic launchd plist write refuses a symlink target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-plist-symlink-'));
    const home = join(root, 'home');
    const gbrainHome = join(home, '.gbrain');
    const launchAgents = join(home, 'Library', 'LaunchAgents');
    mkdirSync(launchAgents, { recursive: true, mode: 0o700 });
    const sentinel = join(root, 'outside-plist-sentinel');
    writeFileSync(sentinel, 'outside plist sentinel\n', { mode: 0o600 });
    symlinkSync(sentinel, join(launchAgents, 'com.gbrain.brain-pull.wiki.plist'));
    const runtime: DurabilityCronRuntime = {
      platform: 'darwin',
      execFile() { throw new Error('launchctl must not run for an unsafe plist'); },
    };
    try {
      await withEnv({ HOME: home, GBRAIN_HOME: gbrainHome }, async () => {
        expect(() => __durabilityTesting.installDurabilityCron(
          'wiki', join(root, 'repo'), 'main', 'https://github.com/acme/wiki.git',
          1800, false, runtime,
        )).toThrow(/launchd plist/);
        expect(readFileSync(sentinel, 'utf8')).toBe('outside plist sentinel\n');
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.serial('Linux crontab quotes a wrapper path containing spaces and apostrophes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-crontab-quote-'));
    const home = join(root, 'home');
    const gbrainHome = join(home, "gbrain home with ' quote");
    let installed = '';
    const runtime: DurabilityCronRuntime = {
      platform: 'linux',
      execFile(command, args, options) {
        expect(command).toBe('crontab');
        if (args[0] === '-l') return '';
        installed = String(options.input ?? '');
      },
    };
    try {
      await withEnv({ HOME: home, GBRAIN_HOME: gbrainHome }, async () => {
        const result = __durabilityTesting.installDurabilityCron(
          'wiki', join(root, 'repo'), 'main', 'https://github.com/acme/wiki.git',
          1800, false, runtime,
        );
        const wrapper = join(gbrainHome, 'brain-pull-wiki.sh');
        const quotedWrapper = `'${wrapper.replace(/'/g, `'"'"'`)}'`;
        expect(result.status).toBe('fixed');
        expect(installed).toContain(`*/30 * * * * ${quotedWrapper} # com.gbrain.brain-pull.wiki`);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
