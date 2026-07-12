/**
 * End-to-end trusted commit CLI + local hook (v0.42.44). Real git against a
 * local bare remote. Proves evidence contains no executable mutation helper,
 * explicit-path commits preserve concurrent staging, and the local hook pushes.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { hardenBrainRepo } from '../src/core/brain-repo-durability.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', env: { ...process.env },
  }).trim();
}
function originHead(bare: string): string {
  return git(bare, 'rev-parse', 'refs/heads/main');
}
async function waitForOrigin(bare: string, expectSha: string, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (originHead(bare) === expectSha) return true; } catch { /* */ }
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

let root: string, work: string, bare: string;
let oldHome: string | undefined, oldGbrainHome: string | undefined, oldPath: string | undefined;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function installGbrainShim(): void {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, 'gbrain');
  const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
  writeFileSync(shim, `#!/usr/bin/env bash\nexec ${shellQuote(process.execPath)} ${shellQuote(cli)} "$@"\n`);
  chmodSync(shim, 0o755);
  process.env.PATH = `${bin}:${oldPath ?? ''}`;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'bdh-'));
  oldHome = process.env.HOME; oldGbrainHome = process.env.GBRAIN_HOME;
  oldPath = process.env.PATH;
  // Exercise the install-time shell-escaped GBRAIN_HOME fallback as well as
  // ordinary hook behavior. Git launchers may sanitize runtime env updates.
  process.env.HOME = mkdtempSync(join(root, "home with ' quote-"));
  process.env.GBRAIN_HOME = join(process.env.HOME, '.gbrain');
  process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1';
  installGbrainShim();
  bare = mkdtempSync(join(root, 'origin-')) + '.git';
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
  work = mkdtempSync(join(root, 'work-'));
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, work], { stdio: 'ignore' });
  git(work, 'config', 'user.email', 't@t.t'); git(work, 'config', 'user.name', 'tester');
  writeFileSync(join(work, 'README.md'), 'init\n');
  git(work, 'add', 'README.md'); git(work, 'commit', '-qm', 'init'); git(work, 'push', '-q', 'origin', 'main');
  git(work, 'remote', 'set-head', 'origin', 'main');
  await hardenBrainRepo({
    repoPath: work, sourceId: 'wiki', expectedRemoteUrl: bare,
    pat: 'ghp_x', installCron: false,
  });
});
afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldGbrainHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = oldGbrainHome;
  if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
  delete process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT;
  rmSync(root, { recursive: true, force: true });
});

function trustedCommitPush(message: string, paths: string[], expectedRemote = bare): void {
  execFileSync(join(root, 'bin', 'gbrain'), [
    'sources', 'commit-push', '--path', work, '--branch', 'main',
    '--expected-remote', expectedRemote, '--message', message, '--', ...paths,
  ], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
}

describe('trusted installed commit-push CLI', () => {
  test('add → commit → push lands on origin', () => {
    mkdirSync(join(work, 'people'), { recursive: true });
    writeFileSync(join(work, 'people', 'alice.md'), '# alice\n');
    trustedCommitPush('add alice', ['people/alice.md']);
    expect(originHead(bare)).toBe(git(work, 'rev-parse', 'HEAD'));
    // origin actually has the file
    const verify = mkdtempSync(join(root, 'verify-'));
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, verify], { stdio: 'ignore' });
    expect(existsSync(join(verify, 'people', 'alice.md'))).toBe(true);
  });

  test('refuses success when the push cannot land (exit non-zero)', () => {
    const gone = join(root, 'gone.git');
    git(work, 'remote', 'set-url', 'origin', gone);
    writeFileSync(join(work, 'x.md'), 'x\n');
    let code = 0;
    try {
      trustedCommitPush('msg', ['x.md'], gone);
    } catch (e: any) { code = e.status ?? 1; }
    expect(code).not.toBe(0);
  });

  test('refuses a blind add (no explicit path)', () => {
    let code = 0;
    try {
      execFileSync(join(root, 'bin', 'gbrain'), [
        'sources', 'commit-push', '--path', work, '--branch', 'main',
        '--expected-remote', bare, '--message', 'msg',
      ], {
        cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
      });
    } catch (e: any) { code = e.status ?? 1; }
    expect(code).toBe(2);
  });

  test('unrelated pre-staged work makes the managed commit refuse without changing staging', () => {
    writeFileSync(join(work, 'PRIVATE.txt'), 'keep staged\n');
    git(work, 'add', 'PRIVATE.txt');
    writeFileSync(join(work, 'managed.md'), 'managed\n');

    let code = 0;
    try {
      trustedCommitPush('managed only', ['managed.md']);
    } catch (error: any) { code = error.status ?? 1; }

    expect(code).not.toBe(0);
    expect(git(work, 'show', '--pretty=', '--name-only', 'HEAD')).not.toContain('PRIVATE.txt');
    expect(git(work, 'show', '--pretty=', '--name-only', 'HEAD')).not.toContain('managed.md');
    expect(git(work, 'diff', '--cached', '--name-only')).toContain('PRIVATE.txt');
  });

  test('concurrent staging after isolated commit survives real-index reconciliation', () => {
    writeFileSync(join(work, 'managed.md'), 'managed by automation\n');
    writeFileSync(join(work, 'PRIVATE.txt'), 'staged-later\n');
    const trigger = join(root, 'inject-concurrent-stage');
    writeFileSync(trigger, 'armed\n');
    const wrapperDir = join(root, 'git-wrapper');
    mkdirSync(wrapperDir);
    const wrapper = join(wrapperDir, 'git');
    const realGit = execFileSync('which', ['git'], {
      encoding: 'utf8', env: { ...process.env, PATH: oldPath ?? '' },
    }).trim();
    writeFileSync(wrapper, `#!/usr/bin/env bash
${shellQuote(realGit)} "$@"
status=$?
if [ "$status" -eq 0 ] && [ -f ${shellQuote(trigger)} ] && [ -n "\${GIT_INDEX_FILE:-}" ]; then
  for arg in "$@"; do
    if [ "$arg" = "commit" ]; then
      rm -f ${shellQuote(trigger)}
      env -u GIT_INDEX_FILE ${shellQuote(realGit)} -C ${shellQuote(work)} add -- PRIVATE.txt
      break
    fi
  done
fi
exit "$status"
`);
    chmodSync(wrapper, 0o755);
    process.env.PATH = `${wrapperDir}:${process.env.PATH ?? ''}`;

    trustedCommitPush('managed only', ['managed.md']);

    expect(existsSync(trigger)).toBe(false);
    expect(git(work, 'show', '--pretty=', '--name-only', 'HEAD').split('\n').filter(Boolean)).toEqual(['managed.md']);
    expect(git(work, 'diff', '--cached', '--name-only').split('\n').filter(Boolean)).toEqual(['PRIVATE.txt']);
    expect(git(work, 'show', ':PRIVATE.txt')).toBe('staged-later');
    expect(readFileSync(join(work, 'PRIVATE.txt'), 'utf8')).toBe('staged-later\n');
  });
});

describe('post-commit hook (D9 local, D7 self-contained)', () => {
  test('a direct commit auto-pushes in the background', async () => {
    writeFileSync(join(work, 'note.md'), 'note\n');
    git(work, 'add', 'note.md'); git(work, 'commit', '-qm', 'note'); // fires .git/hooks/post-commit
    const head = git(work, 'rev-parse', 'HEAD');
    expect(await waitForOrigin(bare, head)).toBe(true);
  }, 15_000);

  test('the hook is self-contained and no repo executable exists', async () => {
    expect(existsSync(join(work, 'scripts', 'brain-commit-push.sh'))).toBe(false);
    writeFileSync(join(work, 'another-note.md'), 'note\n');
    git(work, 'add', 'another-note.md'); git(work, 'commit', '-qm', 'another note');
    const head = git(work, 'rev-parse', 'HEAD');
    expect(await waitForOrigin(bare, head)).toBe(true);
  }, 15_000);

  test('logs a clear LOCAL-ONLY line when origin is unreachable', async () => {
    git(work, 'remote', 'set-url', 'origin', join(root, 'gone2.git'));
    writeFileSync(join(work, 'orphan.md'), 'o\n');
    git(work, 'add', 'orphan.md'); git(work, 'commit', '-qm', 'orphan');
    const log = join(process.env.GBRAIN_HOME!, 'brain-push.log');
    const deadline = Date.now() + 8000;
    let found = false;
    while (Date.now() < deadline) {
      if (existsSync(log) && readFileSync(log, 'utf-8').includes('NEEDS ATTENTION')) { found = true; break; }
      await new Promise(r => setTimeout(r, 150));
    }
    expect(found).toBe(true);
  }, 15_000);
});
