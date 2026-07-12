/**
 * git-remote durability helpers (v0.42.44): divergenceSafePull, detectDefaultBranch,
 * pushProbe, isWorkingTreeDirty. Real git against local bare remotes.
 *
 * Local file transport is enabled via GBRAIN_GIT_ALLOW_FILE_TRANSPORT=1 (the
 * documented escape hatch the durability paths honor).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import {
  divergenceSafePull, detectDefaultBranch, pushProbe, isWorkingTreeDirty,
} from '../src/core/git-remote.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8',
  }).trim();
}
function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' }).trim();
}

let root: string;
let bare: string;

/** A bare origin + a working clone with one commit on `main`. */
function makePair(): { bare: string; work: string } {
  const b = mkdtempSync(join(root, 'origin-')) + '.git';
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', b], { stdio: 'ignore' });
  const w = mkdtempSync(join(root, 'work-'));
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', b, w], { stdio: 'ignore' });
  git(w, 'config', 'user.email', 't@t.t');
  git(w, 'config', 'user.name', 'tester');
  writeFileSync(join(w, 'README.md'), 'init\n');
  git(w, 'add', 'README.md');
  git(w, 'commit', '-qm', 'init');
  git(w, 'push', '-q', 'origin', 'main');
  // Set origin/HEAD so detectDefaultBranch can resolve it.
  try { git(w, 'remote', 'set-head', 'origin', 'main'); } catch { /* */ }
  return { bare: b, work: w };
}

function secondClone(b: string): string {
  const w = mkdtempSync(join(root, 'work2-'));
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', b, w], { stdio: 'ignore' });
  git(w, 'config', 'user.email', 'u@u.u');
  git(w, 'config', 'user.name', 'tester2');
  return w;
}

beforeAll(() => { process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1'; });
afterAll(() => { delete process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT; });
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gd-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('detectDefaultBranch', () => {
  test('resolves origin/HEAD', () => {
    const { work } = makePair();
    expect(detectDefaultBranch(work)).toBe('main');
  });
  test('falls back to main when nothing resolves', () => {
    const empty = mkdtempSync(join(root, 'bare-')); // not a git repo
    expect(detectDefaultBranch(empty)).toBe('main');
  });
});

describe('isWorkingTreeDirty', () => {
  test('false when clean, true after an edit', () => {
    const { work } = makePair();
    expect(isWorkingTreeDirty(work)).toBe(false);
    writeFileSync(join(work, 'README.md'), 'changed\n');
    expect(isWorkingTreeDirty(work)).toBe(true);
  });
});

describe('divergenceSafePull', () => {
  test('up_to_date when already current', () => {
    const { work } = makePair();
    expect(divergenceSafePull(work, 'main').status).toBe('up_to_date');
  });

  test('advanced when origin has a new commit', () => {
    const { bare, work } = makePair();
    const other = secondClone(bare);
    writeFileSync(join(other, 'b.txt'), 'b\n');
    git(other, 'add', 'b.txt'); git(other, 'commit', '-qm', 'b'); git(other, 'push', '-q', 'origin', 'main');
    const out = divergenceSafePull(work, 'main');
    expect(out.status).toBe('advanced');
    expect(existsSync(join(work, 'b.txt'))).toBe(true);
  });

  test('skipped_dirty when the working tree is dirty', () => {
    const { work } = makePair();
    writeFileSync(join(work, 'README.md'), 'local edit\n');
    expect(divergenceSafePull(work, 'main').status).toBe('skipped_dirty');
  });

  test('rebases local commits over origin', () => {
    const { bare, work } = makePair();
    const other = secondClone(bare);
    writeFileSync(join(other, 'remote.txt'), 'r\n');
    git(other, 'add', 'remote.txt'); git(other, 'commit', '-qm', 'remote'); git(other, 'push', '-q', 'origin', 'main');
    // local commit on a DIFFERENT file → clean rebase
    writeFileSync(join(work, 'local.txt'), 'l\n');
    git(work, 'add', 'local.txt'); git(work, 'commit', '-qm', 'local');
    const out = divergenceSafePull(work, 'main');
    expect(out.status).toBe('advanced');
    expect(existsSync(join(work, 'remote.txt'))).toBe(true);
    expect(existsSync(join(work, 'local.txt'))).toBe(true);
  });

  test('conflict_aborted leaves NO rebase state', () => {
    const { bare, work } = makePair();
    const other = secondClone(bare);
    writeFileSync(join(other, 'README.md'), 'remote version\n');
    git(other, 'add', 'README.md'); git(other, 'commit', '-qm', 'remote'); git(other, 'push', '-q', 'origin', 'main');
    // local commit touching the SAME line → rebase conflict
    writeFileSync(join(work, 'README.md'), 'local version\n');
    git(work, 'add', 'README.md'); git(work, 'commit', '-qm', 'local');
    const out = divergenceSafePull(work, 'main');
    expect(out.status).toBe('conflict_aborted');
    // The "never mid-rebase" invariant:
    expect(existsSync(join(work, '.git', 'rebase-merge'))).toBe(false);
    expect(existsSync(join(work, '.git', 'rebase-apply'))).toBe(false);
    // Working tree is usable (HEAD is the local commit, not a conflicted state).
    expect(gitIn(work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  test('repo-controlled pre-rebase and post-rewrite hooks never execute', () => {
    const { bare, work } = makePair();
    const other = secondClone(bare);
    const hooks = join(work, '.git', 'attacker-hooks');
    const sentinel = join(root, 'rebase-hook-ran');
    mkdirSync(hooks);
    for (const name of ['pre-rebase', 'post-rewrite']) {
      const hook = join(hooks, name);
      writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\n`);
      chmodSync(hook, 0o755);
    }
    git(work, 'config', 'core.hooksPath', hooks);

    writeFileSync(join(other, 'remote.txt'), 'remote\n');
    git(other, 'add', 'remote.txt'); git(other, 'commit', '-qm', 'remote'); git(other, 'push', '-q', 'origin', 'main');
    writeFileSync(join(work, 'local.txt'), 'local\n');
    git(work, 'add', 'local.txt'); git(work, 'commit', '-qm', 'local');

    expect(() => divergenceSafePull(work, 'main')).toThrow(/unsafe repo-local executable\/network config/);
    expect(existsSync(sentinel)).toBe(false);
  });
});

describe('pushProbe', () => {
  test('ok against a writable remote', () => {
    const { work } = makePair();
    expect(pushProbe(work, 'main')).toEqual({ ok: true });
  });

  test('not ok when origin is unreachable', () => {
    const { work } = makePair();
    git(work, 'remote', 'set-url', 'origin', join(root, 'does-not-exist.git'));
    const r = pushProbe(work, 'main');
    expect(r.ok).toBe(false);
  });

  test('redactDetail scrubs a token from the failure detail', () => {
    const { work } = makePair();
    git(work, 'remote', 'set-url', 'origin', join(root, 'nope-ghp_SECRETTOKEN.git'));
    const r = pushProbe(work, 'main', { redactDetail: (s) => s.replaceAll('ghp_SECRETTOKEN', '***') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail.includes('ghp_SECRETTOKEN')).toBe(false);
  });

  test('repo-controlled pre-push hook never executes', () => {
    const { work } = makePair();
    const hooks = join(work, '.git', 'attacker-hooks');
    const sentinel = join(root, 'pre-push-ran');
    mkdirSync(hooks);
    const hook = join(hooks, 'pre-push');
    writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\n`);
    chmodSync(hook, 0o755);
    git(work, 'config', 'core.hooksPath', hooks);

    expect(pushProbe(work, 'main').ok).toBe(false);
    expect(existsSync(sentinel)).toBe(false);
  });

  test('clean filter and signer config are rejected before status/rebase can execute them', () => {
    for (const mode of ['filter', 'signer'] as const) {
      const { work } = makePair();
      const sentinel = join(root, `${mode}-ran`);
      const executable = join(root, `${mode}.sh`);
      writeFileSync(executable, `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\ncat\n`);
      chmodSync(executable, 0o755);
      if (mode === 'filter') {
        writeFileSync(join(work, '.gitattributes'), '*.md filter=hostile\n');
        git(work, 'config', 'filter.hostile.clean', executable);
        writeFileSync(join(work, 'README.md'), 'dirty\n');
      } else {
        git(work, 'config', 'commit.gpgSign', 'true');
        git(work, 'config', 'gpg.program', executable);
      }

      expect(() => divergenceSafePull(work, 'main', { expectedRemoteUrl: git(work, 'remote', 'get-url', 'origin') }))
        .toThrow(/unsafe repo-local executable\/network config/);
      expect(existsSync(sentinel)).toBe(false);
    }
  });
});
