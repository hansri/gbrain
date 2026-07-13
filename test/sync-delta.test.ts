/**
 * v0.42.42.0 (#2139) — computeSyncDelta unit coverage.
 *
 * The shared diff/manifest helper that BOTH the sync executor and the inline
 * cost estimator route through (so the gate's dollar figure can't drift from
 * what the sync imports). Real temp git repos; no PGLite, no env writes
 * (R1/R2-clean). The git-runner seam drives the unavailable branches.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, renameSync, symlinkSync } from 'fs';
import { execFileSync, execSync, spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  computeSyncDelta,
  buildDetachedWorkingTreeManifest,
  listGitCommitBlobs,
  openGitCommitSnapshot,
  resolveGitCommitBlob,
  readGitCommitBlob,
  type SpawnGit,
  _setGitRunnerForTests,
} from '../src/core/sync-delta.ts';

let repo: string;

function git(args: string): string {
  return execSync(`git ${args}`, { cwd: repo, stdio: 'pipe' }).toString().trim();
}
function commitAll(msg: string): string {
  execSync('git add -A', { cwd: repo, stdio: 'pipe' });
  execSync(`git commit -m "${msg}"`, { cwd: repo, stdio: 'pipe' });
  return git('rev-parse HEAD');
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'gbrain-delta-'));
  execSync('git init', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email "t@t.com"', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name "T"', { cwd: repo, stdio: 'pipe' });
  mkdirSync(join(repo, 'topics'), { recursive: true });
});

afterEach(() => {
  _setGitRunnerForTests(null);
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe('computeSyncDelta — commit diff', () => {
  test('[CRITICAL] commit blob reads ignore post-commit worktree edits', () => {
    writeFileSync(join(repo, 'topics/a.md'), 'committed authority');
    const commit = commitAll('base');
    const blob = resolveGitCommitBlob(repo, commit, 'topics/a.md');

    // A same-path edit after the anchor must never change the bytes imported
    // for that anchor. This is the production pipeline race in miniature.
    writeFileSync(join(repo, 'topics/a.md'), 'mutable worktree poison');

    expect(readGitCommitBlob(repo, blob, 5_000_000).toString('utf8')).toBe('committed authority');
    expect(listGitCommitBlobs(repo, commit).map(entry => entry.path)).toContain('topics/a.md');
  });

  test('commit blob reader enforces its byte limit before returning content', () => {
    writeFileSync(join(repo, 'topics/a.md'), '12345');
    const commit = commitAll('base');
    const blob = resolveGitCommitBlob(repo, commit, 'topics/a.md');
    expect(() => readGitCommitBlob(repo, blob, 4)).toThrow('Git blob too large');
  });

  test('[CRITICAL] commit reader ignores Git replace refs', async () => {
    writeFileSync(join(repo, 'topics/a.md'), 'committed authority');
    const commit = commitAll('base');
    const originalOid = git('rev-parse HEAD:topics/a.md');
    const poisonOid = execSync('git hash-object -w --stdin', {
      cwd: repo,
      input: 'replace-ref poison',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
    execSync(`git replace ${originalOid} ${poisonOid}`, { cwd: repo, stdio: 'pipe' });

    const snapshot = openGitCommitSnapshot(repo, commit);
    try {
      expect((await snapshot.read('topics/a.md', 1024)).toString('utf8')).toBe('committed authority');
    } finally {
      await snapshot.close();
    }
  });

  test('[CRITICAL] authority subprocess scrubs inherited Git repository/object/config poisoning', () => {
    writeFileSync(join(repo, 'topics/a.md'), 'committed authority');
    const commit = commitAll('base');
    const originalOid = git('rev-parse HEAD:topics/a.md');
    const poisonOid = execSync('git hash-object -w --stdin', {
      cwd: repo,
      input: 'replace-ref poison',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
    execSync(`git replace ${originalOid} ${poisonOid}`, { cwd: repo, stdio: 'pipe' });

    const emptyObjects = join(repo, 'poison-objects');
    mkdirSync(emptyObjects);
    const poisonConfig = join(repo, 'poison.gitconfig');
    writeFileSync(poisonConfig, '[core]\nrepositoryFormatVersion = 999\n');
    const moduleUrl = new URL('../src/core/sync-delta.ts', import.meta.url).href;
    const script = [
      `import { openGitCommitSnapshot } from ${JSON.stringify(moduleUrl)};`,
      `const snapshot = openGitCommitSnapshot(${JSON.stringify(repo)}, ${JSON.stringify(commit)});`,
      `try { process.stdout.write((await snapshot.read('topics/a.md', 1024)).toString('utf8')); }`,
      `finally { await snapshot.close(); }`,
    ].join('\n');

    const output = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_DIR: '/dev/null',
        GIT_WORK_TREE: '/dev/null',
        GIT_COMMON_DIR: '/dev/null',
        GIT_OBJECT_DIRECTORY: emptyObjects,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: emptyObjects,
        GIT_GRAFT_FILE: join(repo, 'poison-grafts'),
        GIT_REPLACE_REF_BASE: 'refs/replace-poisoned/',
        GIT_CONFIG_GLOBAL: poisonConfig,
        GIT_CONFIG_SYSTEM: poisonConfig,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.repositoryformatversion',
        GIT_CONFIG_VALUE_0: '999',
      },
    });
    expect(output).toBe('committed authority');
  });

  test('colon paths are literal and survive snapshot lookup/read', async () => {
    writeFileSync(join(repo, 'topics/meeting:notes.md'), 'literal colon path');
    const commit = commitAll('colon');
    const snapshot = openGitCommitSnapshot(repo, commit);
    try {
      expect((await snapshot.read('topics/meeting:notes.md', 1024)).toString('utf8'))
        .toBe('literal colon path');
    } finally {
      await snapshot.close();
    }
  });

  test('NUL-delimited diff preserves tabs and newlines in committed paths', () => {
    writeFileSync(join(repo, 'topics/base.md'), 'base');
    const base = commitAll('base');
    const special = 'topics/line\nbreak\tname.md';
    writeFileSync(join(repo, special), 'special');
    const head = commitAll('special path');

    const result = computeSyncDelta(repo, base, head);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.manifest.added).toContain(special);
  });

  test('large tree uses one persistent cat-file process, not one process per file', async () => {
    const FILE_COUNT = 1000;
    for (let i = 0; i < FILE_COUNT; i++) writeFileSync(join(repo, `topics/page-${i}.md`), `page ${i}`);
    const commit = commitAll('many');
    let processCount = 0;
    const spawnGit: SpawnGit = (command, args, options) => {
      processCount++;
      return spawn(command, [...args], options as any) as any;
    };
    const snapshot = openGitCommitSnapshot(repo, commit, {
      spawnGit,
    });
    try {
      const contents = await Promise.all(
        Array.from({ length: FILE_COUNT }, (_, i) => snapshot.read(`topics/page-${i}.md`, 1024)),
      );
      expect(contents.map(buf => buf.toString('utf8'))).toHaveLength(FILE_COUNT);
      expect(processCount).toBe(1);
    } finally {
      await snapshot.close();
    }
  }, 30_000);

  test('cat-file spawn failure is a rejected snapshot read, not a process crash', async () => {
    writeFileSync(join(repo, 'topics/a.md'), 'committed authority');
    const commit = commitAll('base');
    const spawnMissing: SpawnGit = (_command, _args, options) =>
      spawn('/definitely/missing/gbrain-git', [], options as any) as any;
    const snapshot = openGitCommitSnapshot(repo, commit, { spawnGit: spawnMissing });
    try {
      await expect(snapshot.read('topics/a.md', 1024)).rejects.toThrow('Git cat-file');
    } finally {
      await snapshot.close();
    }
  });

  test('hung cat-file reads and close are bounded', async () => {
    writeFileSync(join(repo, 'topics/a.md'), 'committed authority');
    const commit = commitAll('base');
    const spawnHung: SpawnGit = (_command, _args, options) =>
      spawn(
        process.execPath,
        ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'],
        options as any,
      ) as any;
    const snapshot = openGitCommitSnapshot(repo, commit, {
      spawnGit: spawnHung,
      readTimeoutMs: 75,
      closeTimeoutMs: 75,
    });
    const started = Date.now();
    await expect(snapshot.read('topics/a.md', 1024)).rejects.toThrow('timed out');
    await snapshot.close();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('A/M/D classified; only committed changes in the manifest', () => {
    writeFileSync(join(repo, 'topics/a.md'), 'a');
    writeFileSync(join(repo, 'topics/b.md'), 'b');
    const base = commitAll('base');
    writeFileSync(join(repo, 'topics/a.md'), 'a-edited'); // modify
    writeFileSync(join(repo, 'topics/c.md'), 'c');         // add
    rmSync(join(repo, 'topics/b.md'));                      // delete
    const head = commitAll('change');

    const r = computeSyncDelta(repo, base, head);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.manifest.modified).toContain('topics/a.md');
    expect(r.manifest.added).toContain('topics/c.md');
    expect(r.manifest.deleted).toContain('topics/b.md');
  });

  test('rename → destination path on the renamed list', () => {
    writeFileSync(join(repo, 'topics/old.md'), 'x'.repeat(200));
    const base = commitAll('base');
    renameSync(join(repo, 'topics/old.md'), join(repo, 'topics/new.md'));
    const head = commitAll('rename');

    const r = computeSyncDelta(repo, base, head);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.manifest.renamed.map(x => x.to)).toContain('topics/new.md');
  });

  test('regular file to symlink is classified as a target type change', () => {
    writeFileSync(join(repo, 'topics/a.md'), 'regular');
    const base = commitAll('base');
    rmSync(join(repo, 'topics/a.md'));
    symlinkSync('../outside.md', join(repo, 'topics/a.md'));
    const head = commitAll('regular to symlink');

    const r = computeSyncDelta(repo, base, head);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.manifest.modified).toContain('topics/a.md');
    expect(listGitCommitBlobs(repo, head).some(blob => blob.path === 'topics/a.md')).toBe(false);
  });

  test('[D2A] attached HEAD: dirty tracked + untracked files are NOT in the manifest', () => {
    writeFileSync(join(repo, 'topics/a.md'), 'a');
    const base = commitAll('base');
    const head = git('rev-parse HEAD'); // HEAD == base, no new commits
    // Dirty the tree: an uncommitted edit + an untracked scratch file.
    writeFileSync(join(repo, 'topics/a.md'), 'uncommitted edit');
    writeFileSync(join(repo, 'scratch.tmp'), 'untracked');

    const r = computeSyncDelta(repo, base, head); // not detached → commit diff only
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.manifest.added).toHaveLength(0);
    expect(r.manifest.modified).toHaveLength(0);
    expect(r.manifest.deleted).toHaveLength(0);
  });
});

describe('computeSyncDelta — detached HEAD merges the working-tree manifest', () => {
  test('detached + working-tree changes → merged into the manifest', () => {
    writeFileSync(join(repo, 'topics/a.md'), 'a');
    const base = commitAll('base');
    // Detach HEAD and dirty the tree.
    execSync(`git checkout --detach ${base}`, { cwd: repo, stdio: 'pipe' });
    writeFileSync(join(repo, 'topics/a.md'), 'detached edit'); // tracked modify
    writeFileSync(join(repo, 'topics/new.md'), 'new');          // untracked add

    const r = computeSyncDelta(repo, base, base, { detached: true });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.manifest.modified).toContain('topics/a.md');
    expect(r.manifest.added).toContain('topics/new.md'); // untracked picked up on detached
  });

  test('buildDetachedWorkingTreeManifest: clean detached tree → empty manifest', () => {
    writeFileSync(join(repo, 'topics/a.md'), 'a');
    const base = commitAll('base');
    execSync(`git checkout --detach ${base}`, { cwd: repo, stdio: 'pipe' });
    const m = buildDetachedWorkingTreeManifest(repo);
    expect(m.added).toHaveLength(0);
    expect(m.modified).toHaveLength(0);
  });
});

describe('computeSyncDelta — fail-open ladder', () => {
  test('bogus anchor SHA → unavailable: anchor_missing', () => {
    writeFileSync(join(repo, 'topics/a.md'), 'a');
    const head = commitAll('base');
    const r = computeSyncDelta(repo, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', head);
    expect(r.status).toBe('unavailable');
    if (r.status === 'unavailable') expect(r.reason).toBe('anchor_missing');
  });

  test('non-ancestor anchor still diffs (the #1970 property)', () => {
    // git diff A..B is endpoint-tree, no ancestry requirement.
    writeFileSync(join(repo, 'topics/a.md'), 'a');
    const base = commitAll('base');
    // Rewrite history: amend creates a new commit not descended from `base`,
    // but `base` is still on disk (reflog) → diffable.
    writeFileSync(join(repo, 'topics/a.md'), 'rewritten');
    execSync('git add -A && git commit --amend -m rewritten', { cwd: repo, stdio: 'pipe' });
    const head = git('rev-parse HEAD');
    expect(head).not.toBe(base);

    const r = computeSyncDelta(repo, base, head);
    expect(r.status).toBe('ok'); // orphaned-but-present anchor is still diffable
  });

  test('injected git failure on the diff → unavailable: diff_failed', () => {
    writeFileSync(join(repo, 'topics/a.md'), 'a');
    const base = commitAll('base');
    const head = git('rev-parse HEAD');
    _setGitRunnerForTests((_repo, args) => {
      if (args[0] === 'cat-file') return 'commit'; // anchor reachable
      if (args[0] === 'diff') throw new Error('simulated oversized diff / timeout');
      return '';
    });
    const r = computeSyncDelta(repo, base, head);
    expect(r.status).toBe('unavailable');
    if (r.status === 'unavailable') expect(r.reason).toBe('diff_failed');
  });
});
