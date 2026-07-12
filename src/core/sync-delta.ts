/**
 * Shared sync-delta machinery — ONE implementation of "what changed since
 * last_commit" consumed by BOTH the sync executor (`performSyncInner` in
 * `src/commands/sync.ts`) and the inline-embed cost estimator
 * (`src/core/sync-cost-estimate.ts`). Before this module the executor diffed
 * `last_commit..pin` while the estimator priced the entire tree, so the
 * gate's dollar figure had no relationship to what the sync actually embedded
 * (issue #2139: a 400x overestimate that wedged the daily cron). Routing both
 * through `computeSyncDelta` makes diff/manifest drift between estimate and
 * execution structurally impossible.
 *
 * Shell-injection safe: `execFileSync` with array args (no `/bin/sh -c`), so a
 * `sources.local_path` containing shell metacharacters can never escape — same
 * posture documented at `git-head.ts:14-19`.
 *
 * Fail-open ladder (never throws):
 *
 *   computeSyncDelta(repo, from, to)
 *        │
 *        ├─ `git cat-file -t <from>` throws  → { unavailable, anchor_missing }
 *        │    (bookmark object gc'd after a history rewrite — nothing to diff;
 *        │     caller falls back to a full reconcile / full-tree ceiling)
 *        │
 *        ├─ `git diff --name-status -M from..to` throws → { unavailable, diff_failed }
 *        │    (oversized post-rewrite diff exceeds the 30s / 100 MiB budget)
 *        │
 *        └─ ok → { ok, manifest }   (+ optional diagnostic detached manifest)
 *
 * NOTE: a present-but-non-ancestor `from` (force-push, squash, master→main) is
 * still diffable — `git diff A..B` is an endpoint-tree comparison and does NOT
 * require A to be an ancestor of B (unlike a rev-walk or `A...B` merge-base).
 * That is the #1970 property this module preserves.
 */
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { buildSyncManifest, type SyncManifest } from './sync.ts';
import { gitAuthorityEnvironment } from './git-environment.ts';

/** A regular file entry resolved from one immutable Git commit tree. */
export interface GitCommitBlob {
  path: string;
  oid: string;
  mode: '100644' | '100755';
  size: number;
}

/** Hard failure in the immutable Git-object authority, never a page parse error. */
export class GitSnapshotError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GitSnapshotError';
  }
}

/** Failure-ledger sentinel: immutable authority failures can never be skipped. */
export const GIT_SNAPSHOT_SENTINEL = '<git-snapshot>';

const RESOLVED_COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function assertResolvedCommit(commit: string): void {
  if (!RESOLVED_COMMIT_RE.test(commit)) {
    throw new Error(`Git snapshot commit must be a resolved object id, got: ${commit}`);
  }
}

function assertSafeGitPath(path: string): void {
  if (!path || path.includes('\0') || path.startsWith('/') || path.split('/').some(p => p === '.' || p === '..')) {
    throw new Error(`Unsafe Git snapshot path: ${JSON.stringify(path)}`);
  }
}

function parseTreeRecord(record: string): GitCommitBlob | null {
  const tab = record.indexOf('\t');
  if (tab < 0) return null;
  const [mode, type, oid, sizeRaw] = record.slice(0, tab).split(/ +/);
  const path = record.slice(tab + 1);
  const size = Number(sizeRaw);
  if (
    (mode !== '100644' && mode !== '100755')
    || type !== 'blob'
    || !OBJECT_ID_RE.test(oid ?? '')
    || !Number.isSafeInteger(size)
    || size < 0
  ) {
    return null;
  }
  assertSafeGitPath(path);
  return { path, oid, mode, size };
}

/** Global Git option used on every object-authority read. */
export const GIT_NO_REPLACE_OBJECTS_ARG = '--no-replace-objects';

function gitObjectArgs(repoPath: string, args: string[]): string[] {
  return [
    GIT_NO_REPLACE_OBJECTS_ARG,
    '-c', 'core.quotepath=false',
    '-c', 'core.fsmonitor=false',
    '-C', repoPath,
    ...args,
  ];
}

/**
 * Enumerate regular files from the exact tree at `commit`.
 *
 * This deliberately does not consult the index, working tree, attributes, or
 * smudge filters. The returned object ids are immutable provenance: a caller
 * can keep reading them even when another process advances HEAD or edits the
 * checkout while a sync is running.
 */
export function listGitCommitBlobs(repoPath: string, commit: string): GitCommitBlob[] {
  assertResolvedCommit(commit);
  const stdout = execFileSync(
    'git',
    gitObjectArgs(repoPath, ['ls-tree', '-r', '-l', '-z', '--full-tree', commit]),
    {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 256 * 1024 * 1024,
      env: gitAuthorityEnvironment(),
    },
  );
  const out: GitCommitBlob[] = [];
  for (const record of stdout.split('\0')) {
    if (!record) continue;
    const parsed = parseTreeRecord(record);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Resolve one regular file path inside an immutable commit tree. */
export function resolveGitCommitBlob(
  repoPath: string,
  commit: string,
  relativePath: string,
): GitCommitBlob {
  assertResolvedCommit(commit);
  assertSafeGitPath(relativePath);
  const match = listGitCommitBlobs(repoPath, commit).find(entry => entry.path === relativePath);
  if (!match) {
    throw new Error(`Path is not a regular file in Git snapshot ${commit.slice(0, 12)}: ${relativePath}`);
  }
  return match;
}

function parseBatchOutput(
  output: Buffer,
  blobs: readonly GitCommitBlob[],
): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  let offset = 0;
  for (const blob of blobs) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) {
      throw new GitSnapshotError(`Truncated Git cat-file header for ${blob.path}`);
    }
    const header = output.subarray(offset, newline).toString('ascii');
    const expected = `${blob.oid} blob ${blob.size}`;
    if (header !== expected) {
      throw new GitSnapshotError(
        `Unexpected Git cat-file header for ${blob.path}: ${JSON.stringify(header)}`,
      );
    }
    const start = newline + 1;
    const end = start + blob.size;
    if (end >= output.length || output[end] !== 0x0a) {
      throw new GitSnapshotError(`Truncated Git blob payload for ${blob.path}`);
    }
    result.set(blob.path, Buffer.from(output.subarray(start, end)));
    offset = end + 1;
  }
  if (offset !== output.length) {
    throw new GitSnapshotError('Unexpected trailing bytes from Git cat-file batch');
  }
  return result;
}

/**
 * Read a bounded group of blobs through ONE `git cat-file --batch` process.
 * Requests use object ids only, so paths containing `:` are literal data and
 * can never be parsed as Git's `<rev>:<path>` revision syntax.
 */
export function readGitCommitBlobsBatch(
  repoPath: string,
  blobs: readonly GitCommitBlob[],
  maxBytesPerBlob: number,
): Map<string, Buffer> {
  if (!Number.isSafeInteger(maxBytesPerBlob) || maxBytesPerBlob < 0) {
    throw new Error(`Invalid Git blob size limit: ${maxBytesPerBlob}`);
  }
  if (blobs.length === 0) return new Map();
  let totalBytes = 0;
  for (const blob of blobs) {
    assertSafeGitPath(blob.path);
    if (!OBJECT_ID_RE.test(blob.oid)) throw new Error(`Invalid Git blob object id for ${blob.path}`);
    if (blob.size > maxBytesPerBlob) {
      throw new Error(`Git blob too large (${blob.size} bytes, max ${maxBytesPerBlob}): ${blob.path}`);
    }
    totalBytes += blob.size;
  }
  const input = blobs.map(blob => `${blob.oid}\n`).join('');
  try {
    const output = execFileSync(
      'git',
      gitObjectArgs(repoPath, ['cat-file', '--batch']),
      {
        input,
        timeout: 30_000,
        maxBuffer: Math.max(1024 * 1024, totalBytes + blobs.length * 160 + 1),
        env: gitAuthorityEnvironment(),
      },
    );
    return parseBatchOutput(output, blobs);
  } catch (error) {
    if (error instanceof GitSnapshotError) throw error;
    throw new GitSnapshotError('Git cat-file batch read failed', { cause: error });
  }
}

/**
 * Read one already-resolved blob object with a pre-allocation size gate.
 * `git cat-file` reads the raw committed blob, never a mutable/smudged checkout.
 */
export function readGitCommitBlob(
  repoPath: string,
  blob: GitCommitBlob,
  maxBytes: number,
): Buffer {
  const result = readGitCommitBlobsBatch(repoPath, [blob], maxBytes).get(blob.path);
  if (!result) throw new GitSnapshotError(`Git blob batch omitted ${blob.path}`);
  return result;
}

export type SpawnGit = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildProcessWithoutNullStreams;

class BufferedChildStdout {
  private iterator: AsyncIterator<Buffer | string>;
  private buffered: Buffer = Buffer.alloc(0);

  constructor(stream: NodeJS.ReadableStream & AsyncIterable<Buffer | string>) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  private async pull(): Promise<void> {
    const next = await this.iterator.next();
    if (next.done) throw new GitSnapshotError('Git cat-file closed its output unexpectedly');
    const chunk: Buffer = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    this.buffered = this.buffered.length === 0
      ? chunk
      : Buffer.concat([this.buffered, chunk]);
  }

  async readLine(): Promise<string> {
    for (;;) {
      const newline = this.buffered.indexOf(0x0a);
      if (newline >= 0) {
        const line = this.buffered.subarray(0, newline).toString('ascii');
        this.buffered = this.buffered.subarray(newline + 1);
        return line;
      }
      await this.pull();
    }
  }

  async readExact(size: number): Promise<Buffer> {
    const pieces: Buffer[] = [];
    let remaining = size;
    while (remaining > 0) {
      if (this.buffered.length === 0) await this.pull();
      const take = Math.min(remaining, this.buffered.length);
      pieces.push(this.buffered.subarray(0, take));
      this.buffered = this.buffered.subarray(take);
      remaining -= take;
    }
    return pieces.length === 1 ? Buffer.from(pieces[0]!) : Buffer.concat(pieces, size);
  }
}

class GitCatFileReader {
  private child: ChildProcessWithoutNullStreams;
  private stdout: BufferedChildStdout;
  private tail: Promise<void> = Promise.resolve();
  private stderr = '';
  private processError: Error | null = null;
  private processClosed = false;
  private closed = false;

  constructor(
    repoPath: string,
    spawnGit: SpawnGit,
    private readonly readTimeoutMs: number,
    private readonly closeTimeoutMs: number,
  ) {
    this.child = spawnGit(
      'git',
      gitObjectArgs(repoPath, ['cat-file', '--batch']),
      { stdio: ['pipe', 'pipe', 'pipe'], env: gitAuthorityEnvironment() },
    );
    this.stdout = new BufferedChildStdout(this.child.stdout);
    // `spawn()` failures and late EPIPE events are asynchronous. Keep explicit
    // listeners so a missing/terminated Git process becomes a fail-closed
    // GitSnapshotError instead of an unhandled EventEmitter crash.
    this.child.once('error', error => {
      this.processError = error;
    });
    this.child.once('close', () => {
      this.processClosed = true;
    });
    this.child.stdin.on('error', error => {
      this.processError ??= error;
    });
    this.child.stderr.on('data', chunk => {
      if (this.stderr.length < 8192) this.stderr += Buffer.from(chunk).toString('utf8');
    });
  }

  read(blob: GitCommitBlob, maxBytes: number): Promise<Buffer> {
    const work = this.tail.then(() => this.readWithTimeout(blob, maxBytes));
    this.tail = work.then(() => undefined, () => undefined);
    return work;
  }

  private readWithTimeout(blob: GitCommitBlob, maxBytes: number): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        const timeout = new GitSnapshotError(
          `Git cat-file read timed out after ${this.readTimeoutMs}ms for ${blob.path}`,
        );
        this.processError = timeout;
        this.child.kill('SIGKILL');
        reject(timeout);
      }, this.readTimeoutMs);
      timer.unref?.();
      this.readInner(blob, maxBytes).then(
        value => { clearTimeout(timer); resolve(value); },
        error => { clearTimeout(timer); reject(error); },
      );
    });
  }

  private async readInner(blob: GitCommitBlob, maxBytes: number): Promise<Buffer> {
    if (this.closed) throw new GitSnapshotError('Git commit snapshot reader is closed');
    if (this.processError) {
      throw new GitSnapshotError(`Git cat-file process failed: ${this.processError.message}`, {
        cause: this.processError,
      });
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new Error(`Invalid Git blob size limit: ${maxBytes}`);
    }
    if (blob.size > maxBytes) {
      throw new Error(`Git blob too large (${blob.size} bytes, max ${maxBytes}): ${blob.path}`);
    }
    try {
      if (!this.child.stdin.write(`${blob.oid}\n`)) {
        await new Promise<void>((resolve, reject) => {
          this.child.stdin.once('drain', resolve);
          this.child.stdin.once('error', reject);
        });
      }
      const header = await this.stdout.readLine();
      const expected = `${blob.oid} blob ${blob.size}`;
      if (header !== expected) {
        throw new GitSnapshotError(
          `Unexpected Git cat-file header for ${blob.path}: ${JSON.stringify(header)}`,
        );
      }
      const content = await this.stdout.readExact(blob.size);
      const terminator = await this.stdout.readExact(1);
      if (terminator[0] !== 0x0a) {
        throw new GitSnapshotError(`Invalid Git cat-file terminator for ${blob.path}`);
      }
      return content;
    } catch (error) {
      if (error instanceof GitSnapshotError || !(error instanceof Error)) throw error;
      const cause = this.processError ?? error;
      const processErrorMessage = (this.processError as Error | null)?.message;
      throw new GitSnapshotError(
        `Git cat-file read failed for ${blob.path}` +
        `${this.stderr ? `: ${this.stderr.trim()}` : ''}` +
        `${processErrorMessage && !this.stderr ? `: ${processErrorMessage}` : ''}`,
        { cause },
      );
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const drained = await Promise.race([
      this.tail.then(() => true),
      new Promise<false>(resolve => {
        const timer = setTimeout(() => resolve(false), this.closeTimeoutMs);
        timer.unref?.();
      }),
    ]);
    if (!drained) {
      this.processError ??= new Error(
        `Git cat-file close timed out after ${this.closeTimeoutMs}ms waiting for a read`,
      );
      this.child.kill('SIGKILL');
    }
    try { this.child.stdin.end(); } catch { /* already closed */ }
    if (this.child.exitCode !== null || this.processClosed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolve();
      }, this.closeTimeoutMs);
      timer.unref?.();
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/**
 * One immutable commit tree plus a single persistent cat-file process.
 * Bulk syncs call `read()` once per file but spawn Git only once.
 */
export class GitCommitSnapshot {
  readonly blobs: readonly GitCommitBlob[];
  private byPath: Map<string, GitCommitBlob>;
  private reader: GitCatFileReader | null = null;

  constructor(
    readonly repoPath: string,
    readonly commit: string,
    blobs: readonly GitCommitBlob[],
    private spawnGit: SpawnGit = spawn as unknown as SpawnGit,
    private readTimeoutMs = 30_000,
    private closeTimeoutMs = 2_000,
  ) {
    assertResolvedCommit(commit);
    this.blobs = blobs;
    this.byPath = new Map(blobs.map(blob => [blob.path, blob]));
  }

  getBlob(path: string): GitCommitBlob | null {
    assertSafeGitPath(path);
    return this.byPath.get(path) ?? null;
  }

  async read(path: string, maxBytes: number): Promise<Buffer> {
    const blob = this.getBlob(path);
    if (!blob) {
      throw new GitSnapshotError(
        `Path is not a regular file in Git snapshot ${this.commit.slice(0, 12)}: ${path}`,
      );
    }
    this.reader ??= new GitCatFileReader(
      this.repoPath,
      this.spawnGit,
      this.readTimeoutMs,
      this.closeTimeoutMs,
    );
    return this.reader.read(blob, maxBytes);
  }

  async close(): Promise<void> {
    await this.reader?.close();
    this.reader = null;
  }
}

export function openGitCommitSnapshot(
  repoPath: string,
  commit: string,
  opts?: {
    spawnGit?: SpawnGit;
    blobs?: readonly GitCommitBlob[];
    readTimeoutMs?: number;
    closeTimeoutMs?: number;
  },
): GitCommitSnapshot {
  return new GitCommitSnapshot(
    repoPath,
    commit,
    opts?.blobs ?? listGitCommitBlobs(repoPath, commit),
    opts?.spawnGit,
    opts?.readTimeoutMs,
    opts?.closeTimeoutMs,
  );
}

/** Runs a git subcommand in `repoPath` and returns trimmed stdout (throws on failure). */
export type GitRunner = (repoPath: string, args: string[]) => string;

// Mirrors `git()` + `buildGitInvocation()` in commands/sync.ts: `core.quotepath=false`
// so non-ASCII (CJK) paths arrive as UTF-8; 30s timeout; 100 MiB maxBuffer (a
// 100K-file `--name-status` diff tops out ~10-20 MiB — Node's 1 MiB default
// would ENOBUFS-crash the sync with no log line).
const DEFAULT_GIT_RUNNER: GitRunner = (repoPath, args) =>
  execFileSync('git', gitObjectArgs(repoPath, args), {
    encoding: 'utf-8',
    timeout: 30_000,
    maxBuffer: 100 * 1024 * 1024,
    env: gitAuthorityEnvironment(),
  }).trim();

let _gitRunner: GitRunner = DEFAULT_GIT_RUNNER;

/**
 * Test seam (probe-seam pattern, matches `git-head.ts:_setGitHeadProbeForTests`)
 * so tests drive `computeSyncDelta` without mocking child_process or routing
 * through `mock.module` (R2-compliant). Pass `null` to restore the default.
 */
export function _setGitRunnerForTests(fn: GitRunner | null): void {
  _gitRunner = fn ?? DEFAULT_GIT_RUNNER;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/**
 * Diagnostic working-tree manifest for a DETACHED HEAD. The production sync
 * executor uses this only to detect dirt and then refuses the run; it never
 * imports these mutable bytes. The explicit `computeSyncDelta({ detached:
 * true })` option remains for callers/tests that need to inspect the tracked +
 * untracked delta, while normal attached and detached syncs stay commit-only.
 */
export function buildDetachedWorkingTreeManifest(
  repoPath: string,
  run: GitRunner = _gitRunner,
): SyncManifest {
  const manifest = buildSyncManifest(run(repoPath, ['diff', '--name-status', '-M', 'HEAD']));
  const untracked = run(repoPath, ['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter(line => line.length > 0);
  return {
    added: unique([...manifest.added, ...untracked]),
    modified: unique(manifest.modified),
    deleted: unique(manifest.deleted),
    renamed: manifest.renamed,
  };
}

export type SyncDeltaResult =
  | { status: 'ok'; manifest: SyncManifest }
  | { status: 'unavailable'; reason: 'anchor_missing' | 'diff_failed' };

export interface ComputeSyncDeltaOpts {
  /**
   * Pre-computed detached working-tree manifest to merge into the commit diff
   * (the executor already builds one for its `up_to_date` gate; pass it to
   * avoid a redundant `git diff HEAD` + `ls-files`). When omitted and
   * `detached` is true, this module builds it.
   */
  detachedManifest?: SyncManifest | null;
  /** Build the detached manifest internally (estimator path). Ignored if `detachedManifest` is provided. */
  detached?: boolean;
}

/**
 * The single source of truth for "what changed between two commits in this
 * repo." Returns the RAW merged manifest (added/modified/deleted/renamed) —
 * callers apply their own `isSyncable` filtering + side effects.
 */
export function computeSyncDelta(
  repoPath: string,
  fromCommit: string,
  toCommit: string,
  opts: ComputeSyncDeltaOpts = {},
): SyncDeltaResult {
  const run = _gitRunner;

  // Reachability: a gc'd bookmark object can't be diffed (#1970).
  try {
    run(repoPath, ['cat-file', '-t', fromCommit]);
  } catch {
    return { status: 'unavailable', reason: 'anchor_missing' };
  }

  let diffOutput: string;
  try {
    diffOutput = run(repoPath, ['diff', '--name-status', '-z', '-M', `${fromCommit}..${toCommit}`]);
  } catch {
    return { status: 'unavailable', reason: 'diff_failed' };
  }

  const manifest = buildSyncManifest(diffOutput);

  const detached =
    opts.detachedManifest !== undefined && opts.detachedManifest !== null
      ? opts.detachedManifest
      : opts.detached
        ? buildDetachedWorkingTreeManifest(repoPath, run)
        : null;
  if (detached) {
    manifest.added = unique([...manifest.added, ...detached.added]);
    manifest.modified = unique([...manifest.modified, ...detached.modified]);
    manifest.deleted = unique([...manifest.deleted, ...detached.deleted]);
    manifest.renamed = [...manifest.renamed, ...detached.renamed];
  }

  return { status: 'ok', manifest };
}
