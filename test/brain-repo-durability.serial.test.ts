/**
 * brain-repo-durability core (v0.42.44): hardenBrainRepo / unhardenBrainRepo /
 * acceptPat. Real git against a local bare remote. HOME + GBRAIN_HOME are
 * redirected to a tmp dir; installCron:false so the suite never touches launchd.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { devNull, tmpdir } from 'os';
import { execFileSync } from 'child_process';
import {
  hardenBrainRepo, unhardenBrainRepo, acceptPat,
} from '../src/core/brain-repo-durability.ts';

const PAT = 'ghp_TESTSECRETTOKEN0123456789abcdef';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', env: { ...process.env },
  }).trim();
}
function commitCount(work: string): number {
  return parseInt(git(work, 'rev-list', '--count', 'HEAD'), 10);
}
/** git config read that returns '' instead of throwing when the key is unset. */
function cfg(work: string, key: string): string {
  try { return git(work, 'config', '--local', '--get', key); } catch { return ''; }
}

let root: string;
let work: string;
let bare: string;
let oldHome: string | undefined;
let oldGbrainHome: string | undefined;
let oldGitConfigGlobal: string | undefined;
let oldGitConfigNoSystem: string | undefined;

function makePair(): void {
  bare = mkdtempSync(join(root, 'origin-')) + '.git';
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], {
    stdio: 'ignore', env: { ...process.env },
  });
  work = mkdtempSync(join(root, 'work-'));
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, work], {
    stdio: 'ignore', env: { ...process.env },
  });
  git(work, 'config', 'user.email', 't@t.t');
  git(work, 'config', 'user.name', 'tester');
  writeFileSync(join(work, 'README.md'), 'init\n');
  git(work, 'add', 'README.md'); git(work, 'commit', '-qm', 'init'); git(work, 'push', '-q', 'origin', 'main');
  try { git(work, 'remote', 'set-head', 'origin', 'main'); } catch { /* */ }
}

async function harden(extra: Record<string, unknown> = {}) {
  return hardenBrainRepo({
    repoPath: work, sourceId: 'wiki', expectedRemoteUrl: bare,
    pat: PAT, installCron: false, ...extra,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'brd-'));
  oldHome = process.env.HOME; oldGbrainHome = process.env.GBRAIN_HOME;
  oldGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  oldGitConfigNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.HOME = mkdtempSync(join(root, 'home-'));
  process.env.GBRAIN_HOME = join(process.env.HOME, '.gbrain');
  process.env.GIT_CONFIG_GLOBAL = devNull;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1';
  makePair();
});
afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldGbrainHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = oldGbrainHome;
  if (oldGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = oldGitConfigGlobal;
  if (oldGitConfigNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = oldGitConfigNoSystem;
  delete process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT;
  rmSync(root, { recursive: true, force: true });
});

describe('hardenBrainRepo', () => {
  test('installs the local hook and AGENTS rules without a repo executable', async () => {
    const r = await harden();
    // hook
    const hookPath = join(work, '.git', 'hooks', 'post-commit');
    expect(existsSync(hookPath)).toBe(true);
    expect(readFileSync(hookPath, 'utf-8')).toContain('post-commit hook');
    expect(statSync(hookPath).mode & 0o111).toBeTruthy(); // executable
    // No executable from pulled evidence remains in the checkout.
    const helperPath = join(work, 'scripts', 'brain-commit-push.sh');
    expect(existsSync(helperPath)).toBe(false);
    // AGENTS.md with managed block + taxonomy
    const agents = readFileSync(join(work, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('BEGIN gbrain-brain-durability');
    expect(agents).toContain('people/');
    expect(agents).toContain('gbrain sources commit-push');
    expect(agents).not.toContain('run `scripts/brain-commit-push.sh');
    // verify pushed scaffolding → clean against origin
    expect(r.clean_against_origin).toBe(true);
    expect(r.needs_attention).toEqual([]);
  });

  test('is idempotent — second run adds NO new commit', async () => {
    await harden();
    const after1 = commitCount(work);
    const r2 = await harden();
    expect(commitCount(work)).toBe(after1); // no churn
    // every step is ok/skipped on the second pass (nothing left to fix)
    expect(r2.steps.every(s => s.status === 'ok' || s.status === 'skipped')).toBe(true);
  });

  test('scaffolding commit refuses unrelated staged work without committing or changing it', async () => {
    writeFileSync(join(work, 'PRIVATE.txt'), 'user staged work\n');
    git(work, 'add', 'PRIVATE.txt');

    const result = await harden();

    expect(result.needs_attention.some(line => line.includes('pre-staged paths'))).toBe(true);
    expect(git(work, 'show', '--pretty=', '--name-only', 'HEAD')).not.toContain('PRIVATE.txt');
    expect(git(work, 'diff', '--cached', '--name-only')).toContain('PRIVATE.txt');
    expect(readFileSync(join(work, 'PRIVATE.txt'), 'utf8')).toBe('user staged work\n');
  });

  test('the post-commit hook is UNTRACKED and the retired helper is absent', async () => {
    await harden();
    const tracked = git(work, 'ls-tree', '-r', '--name-only', 'HEAD');
    expect(tracked.includes('post-commit')).toBe(false);
    expect(tracked).not.toContain('scripts/brain-commit-push.sh');
  });

  test('migration deletes a pulled legacy helper without executing its contents', async () => {
    const helper = join(work, 'scripts', 'brain-commit-push.sh');
    const sentinel = join(root, 'repo-helper-executed');
    mkdirSync(dirname(helper), { recursive: true });
    writeFileSync(helper, `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\n`);
    chmodSync(helper, 0o755);
    git(work, 'add', 'scripts/brain-commit-push.sh');
    git(work, 'commit', '-qm', 'legacy helper fixture');
    git(work, 'push', '-q', 'origin', 'main');

    await harden();

    expect(existsSync(helper)).toBe(false);
    expect(existsSync(sentinel)).toBe(false);
    expect(git(work, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('scripts/brain-commit-push.sh');
  });

  test('D3 — patches RESOLVER.md when it exists, not AGENTS.md', async () => {
    writeFileSync(join(work, 'RESOLVER.md'), '# my resolver\n\nuser content\n');
    git(work, 'add', 'RESOLVER.md'); git(work, 'commit', '-qm', 'resolver');
    await harden();
    expect(readFileSync(join(work, 'RESOLVER.md'), 'utf-8')).toContain('BEGIN gbrain-brain-durability');
    expect(existsSync(join(work, 'AGENTS.md'))).toBe(false);
  });

  test('AGENTS block patch preserves user content above and below', async () => {
    writeFileSync(join(work, 'AGENTS.md'), '# Top\n\nkeep above\n\n## footer\nkeep below\n');
    git(work, 'add', 'AGENTS.md'); git(work, 'commit', '-qm', 'agents');
    await harden();
    const body = readFileSync(join(work, 'AGENTS.md'), 'utf-8');
    expect(body).toContain('keep above');
    expect(body).toContain('keep below');
    expect(body).toContain('BEGIN gbrain-brain-durability');
    // patch-in-place: exactly one managed block
    expect(body.split('BEGIN gbrain-brain-durability').length - 1).toBe(1);
  });

  test('D11 — writes an owner-only credential store without trusting repo config', async () => {
    await harden();
    const store = join(process.env.GBRAIN_HOME!, 'git-credentials');
    expect(existsSync(store)).toBe(true);
    expect(statSync(store).mode & 0o077).toBe(0); // not group/other readable
    expect(cfg(work, 'credential.helper')).toBe('');
    expect(cfg(work, 'gbrain.durability.managedcredential')).toBe('true');
  });

  test('D11 — ignores an existing repo credential.helper and uses the trusted store', async () => {
    git(work, 'config', 'credential.helper', 'osxkeychain');
    await harden();
    const store = join(process.env.GBRAIN_HOME!, 'git-credentials');
    expect(existsSync(store)).toBe(true);
    expect(git(work, 'config', '--local', '--get', 'credential.helper')).toBe('osxkeychain');
  });

  test('PAT never appears in the serialized report', async () => {
    const r = await harden();
    expect(JSON.stringify(r).includes(PAT)).toBe(false);
  });

  test('same-host credentials are path-bound and unharden removes only the exact source', async () => {
    const work2 = mkdtempSync(join(root, 'work-two-'));
    git(work2, 'init', '-q', '-b', 'main');
    git(work2, 'config', 'user.email', 't@t.t');
    git(work2, 'config', 'user.name', 'tester');
    writeFileSync(join(work2, 'README.md'), 'two\n');
    git(work2, 'add', 'README.md'); git(work2, 'commit', '-qm', 'init');

    const remoteA = 'https://127.0.0.1/org/source-a.git';
    const remoteB = 'https://127.0.0.1/org/source-b.git';
    git(work, 'remote', 'set-url', 'origin', remoteA);
    git(work2, 'remote', 'add', 'origin', remoteB);
    writeFileSync(join(work, 'dirty.tmp'), 'skip pull\n');
    writeFileSync(join(work2, 'dirty.tmp'), 'skip pull\n');
    process.env.GBRAIN_ALLOW_PRIVATE_REMOTES = '1';
    try {
      await hardenBrainRepo({
        repoPath: work, sourceId: 'source-a', expectedRemoteUrl: remoteA,
        pat: 'pat-source-a', installCron: false, verify: false,
      });
      await hardenBrainRepo({
        repoPath: work2, sourceId: 'source-b', expectedRemoteUrl: remoteB,
        pat: 'pat-source-b', installCron: false, verify: false,
      });
      const store = join(process.env.GBRAIN_HOME!, 'git-credentials');
      const lines = readFileSync(store, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines.some(line => line.includes('pat-source-a') && line.includes('/org/source-a.git'))).toBe(true);
      expect(lines.some(line => line.includes('pat-source-b') && line.includes('/org/source-b.git'))).toBe(true);

      await unhardenBrainRepo({ repoPath: work, sourceId: 'source-a', expectedRemoteUrl: remoteA });
      const remaining = readFileSync(store, 'utf8');
      expect(remaining).not.toContain('pat-source-a');
      expect(remaining).toContain('pat-source-b');
    } finally {
      delete process.env.GBRAIN_ALLOW_PRIVATE_REMOTES;
    }
  });

  for (const checkoutState of ['missing', 'corrupt'] as const) {
    test(`registered URL removes only its credential when checkout is ${checkoutState}`, async () => {
      const work2 = mkdtempSync(join(root, 'work-two-'));
      git(work2, 'init', '-q', '-b', 'main');
      git(work2, 'config', 'user.email', 't@t.t');
      git(work2, 'config', 'user.name', 'tester');
      writeFileSync(join(work2, 'README.md'), 'two\n');
      git(work2, 'add', 'README.md'); git(work2, 'commit', '-qm', 'init');
      const remoteA = 'https://127.0.0.1/org/missing-a.git';
      const remoteB = 'https://127.0.0.1/org/sibling-b.git';
      git(work, 'remote', 'set-url', 'origin', remoteA);
      git(work2, 'remote', 'add', 'origin', remoteB);
      writeFileSync(join(work, 'dirty.tmp'), 'skip pull\n');
      writeFileSync(join(work2, 'dirty.tmp'), 'skip pull\n');
      process.env.GBRAIN_ALLOW_PRIVATE_REMOTES = '1';
      try {
        await hardenBrainRepo({
          repoPath: work, sourceId: 'source-a', expectedRemoteUrl: remoteA,
          pat: 'pat-source-a', installCron: false, verify: false,
        });
        await hardenBrainRepo({
          repoPath: work2, sourceId: 'source-b', expectedRemoteUrl: remoteB,
          pat: 'pat-source-b', installCron: false, verify: false,
        });

        if (checkoutState === 'missing') rmSync(work, { recursive: true, force: true });
        else {
          rmSync(join(work, '.git'), { recursive: true, force: true });
          writeFileSync(join(work, '.git'), 'corrupt git metadata\n');
        }
        const steps = await unhardenBrainRepo({
          repoPath: work, sourceId: 'source-a', expectedRemoteUrl: remoteA,
        });

        const remaining = readFileSync(join(process.env.GBRAIN_HOME!, 'git-credentials'), 'utf8');
        expect(steps.find(step => step.step === 'credential')?.status).toBe('fixed');
        expect(remaining).not.toContain('pat-source-a');
        expect(remaining).toContain('pat-source-b');
      } finally {
        delete process.env.GBRAIN_ALLOW_PRIVATE_REMOTES;
      }
    });
  }

  test('detached HEAD → pull step needs_attention (refuses to push to a wrong ref)', async () => {
    const sha = git(work, 'rev-parse', 'HEAD');
    git(work, 'checkout', '-q', sha); // detached
    const r = await harden({ verify: false });
    const pull = r.steps.find(s => s.step === 'pull');
    expect(pull?.status).toBe('needs_attention');
  });

  test('D10 — verify reports needs_attention when push-probe fails (read-only/unreachable)', async () => {
    const unreachable = join(root, 'unreachable.git');
    git(work, 'remote', 'set-url', 'origin', unreachable);
    const r = await harden({ expectedRemoteUrl: unreachable });
    const verify = r.steps.find(s => s.step === 'verify');
    expect(verify?.status).toBe('needs_attention');
    expect(r.clean_against_origin).toBe(false);
    expect(r.needs_attention.length).toBeGreaterThan(0);
    // No scaffolding commit when we can't confirm a push.
    expect(r.steps.find(s => s.step === 'commit')).toBeUndefined();
  });

  test('registered origin drift fails before credential or scaffolding writes', async () => {
    const registered = bare;
    git(work, 'remote', 'set-url', 'origin', join(root, 'drifted.git'));
    await expect(hardenBrainRepo({
      repoPath: work,
      sourceId: 'wiki',
      expectedRemoteUrl: registered,
      pat: PAT,
      installCron: false,
    })).rejects.toThrow(/differs from the configured source URL/);
    expect(existsSync(join(process.env.GBRAIN_HOME!, 'git-credentials'))).toBe(false);
    expect(existsSync(join(work, 'scripts', 'brain-commit-push.sh'))).toBe(false);
  });

  test('dry-run makes no commit and writes no files', async () => {
    const before = commitCount(work);
    await harden({ dryRun: true });
    expect(commitCount(work)).toBe(before);
    expect(existsSync(join(work, 'scripts', 'brain-commit-push.sh'))).toBe(false);
  });
});

describe('unhardenBrainRepo', () => {
  test('removes hook + credential wiring and leaves no repo executable', async () => {
    await harden();
    const steps = await unhardenBrainRepo({ repoPath: work, sourceId: 'wiki' });
    expect(existsSync(join(work, '.git', 'hooks', 'post-commit'))).toBe(false);
    expect(cfg(work, 'gbrain.durability.managedcredential')).toBe('');
    expect(existsSync(join(work, 'scripts', 'brain-commit-push.sh'))).toBe(false);
    expect(steps.find(s => s.step === 'hook')?.status).toBe('fixed');
  });

  test('removes the retired helper even when Git metadata is gone', async () => {
    await harden();
    const helper = join(work, 'scripts', 'brain-commit-push.sh');
    mkdirSync(dirname(helper), { recursive: true });
    writeFileSync(helper, '#!/bin/sh\nexit 99\n');
    chmodSync(helper, 0o755);
    rmSync(join(work, '.git'), { recursive: true, force: true });

    const steps = await unhardenBrainRepo({
      repoPath: work, sourceId: 'wiki', expectedRemoteUrl: bare,
    });

    expect(existsSync(helper)).toBe(false);
    expect(steps.find(s => s.step === 'helper')?.status).toBe('fixed');
  });

  test('idempotent when not hardened (all skipped)', async () => {
    const steps = await unhardenBrainRepo({ repoPath: work, sourceId: 'wiki' });
    expect(steps.every(s => s.status === 'skipped')).toBe(true);
  });
});

describe('acceptPat (D8)', () => {
  test('reads + trims a pat-file', () => {
    const p = join(root, 'pat.txt');
    writeFileSync(p, `${PAT}\n`, { mode: 0o600 });
    const r = acceptPat({ patFile: p });
    expect(r?.token).toBe(PAT);
    expect(r?.warnings).toEqual([]);
  });
  test('throws on a missing pat-file', () => {
    expect(() => acceptPat({ patFile: join(root, 'nope.txt') })).toThrow();
  });
  test('throws on an empty pat-file', () => {
    const p = join(root, 'empty.txt'); writeFileSync(p, '   \n', { mode: 0o600 });
    expect(() => acceptPat({ patFile: p })).toThrow();
  });
  test('warns (but continues) on loose perms', () => {
    const p = join(root, 'loose.txt'); writeFileSync(p, PAT); chmodSync(p, 0o644);
    const r = acceptPat({ patFile: p });
    expect(r?.token).toBe(PAT);
    expect(r?.warnings.length).toBeGreaterThan(0);
  });
  test('falls back to GBRAIN_GITHUB_PAT env', () => {
    const old = process.env.GBRAIN_GITHUB_PAT;
    process.env.GBRAIN_GITHUB_PAT = PAT;
    try { expect(acceptPat({})?.source).toBe('env:GBRAIN_GITHUB_PAT'); }
    finally { if (old === undefined) delete process.env.GBRAIN_GITHUB_PAT; else process.env.GBRAIN_GITHUB_PAT = old; }
  });
  test('returns null when no PAT is available', () => {
    const old = process.env.GBRAIN_GITHUB_PAT; delete process.env.GBRAIN_GITHUB_PAT;
    try { expect(acceptPat({})).toBeNull(); }
    finally { if (old !== undefined) process.env.GBRAIN_GITHUB_PAT = old; }
  });
});
