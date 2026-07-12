import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  readSync,
  readdirSync,
} from 'fs';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { cpus, totalmem } from 'os';
import type { BrainEngine } from '../core/engine.ts';
import { DELETE_BATCH_SIZE } from '../core/engine-constants.ts';
import {
  importFileContent,
  importImageBuffer,
  importGitBlob,
  isImageFilePath,
  MAX_IMPORT_IMAGE_BYTES,
  MAX_IMPORT_TEXT_BYTES,
  type ImportResult,
} from '../core/import-file.ts';
import {
  GIT_SNAPSHOT_SENTINEL,
  GitSnapshotError,
  openGitCommitSnapshot,
  type GitCommitBlob,
  type GitCommitSnapshot,
} from '../core/sync-delta.ts';
import { loadConfig, gbrainPath } from '../core/config.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import {
  isImageFilePath as isImageFilePathFromSync,
  isSyncable,
  pruneDir,
  type SyncStrategy,
} from '../core/sync.ts';
import { sortNewestFirst } from '../core/sort-newest-first.ts';
import {
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
  resumeFilter,
  type ImportConvergenceProof,
} from '../core/import-checkpoint.ts';
import { cleanInheritedGitEnvironment, gitAuthorityEnvironment } from '../core/git-environment.ts';
import { databaseIdentity } from '../core/database-identity.ts';
import {
  assertSourceWriterLease,
  assertSourceWriterLeaseAtCommit,
  withSourceWriterLease,
  type SourceWriterLease,
} from '../core/source-writer-lease.ts';

function defaultWorkers(): number {
  const cpuCount = cpus().length;
  const memGB = totalmem() / (1024 ** 3);
  // Network-bound, so we can go higher than CPU count.
  // Cap by: DB pool (leave 2 for other queries), CPU, memory.
  const byPool = 8;
  const byCpu = Math.max(2, cpuCount);
  const byMem = Math.floor(memGB * 2);
  return Math.min(byPool, byCpu, byMem);
}

/** Bug 9 — surface per-file failures so callers (performFullSync) can gate state advances. */
export interface RunImportResult {
  status: 'success' | 'partial_failure';
  exitCode: 0 | 1;
  imported: number;
  skipped: number;
  errors: number;
  chunksCreated: number;
  failures: Array<{ path: string; error: string }>;
  /** Present only while a managed full sync still owns anchor finalization. */
  convergence?: ImportConvergenceReceipt;
}

export type ImportInvocationFailureCode =
  | 'embedding_disabled'
  | 'embedding_credentials_missing'
  | 'missing_directory'
  | 'invalid_directory'
  | 'invalid_workers';

export interface ImportInvocationFailureReceipt {
  status: 'failed';
  exitCode: 1;
  code: ImportInvocationFailureCode;
  message: string;
  diagnosis?: unknown;
}

/** Library-safe validation failure. CLI owns process exit; workers stay alive. */
export class ImportInvocationError extends Error {
  readonly exitCode = 1 as const;
  readonly importResult: ImportInvocationFailureReceipt;

  constructor(
    code: ImportInvocationFailureCode,
    message: string,
    opts: { diagnosis?: unknown; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ImportInvocationError';
    this.importResult = {
      status: 'failed',
      exitCode: 1,
      code,
      message,
      ...(opts.diagnosis === undefined ? {} : { diagnosis: opts.diagnosis }),
    };
  }
}

export interface ImportConvergenceReceipt {
  checkpointPath: string;
  checkpointIdentity: string;
  sourceId: string;
  completedPaths: string[];
  completedFingerprints?: Record<string, string>;
  completedProofs: Record<string, ImportConvergenceProof>;
  /** Exact immutable source manifest used by a managed full import. */
  authoritativePaths?: string[];
  strategy?: SyncStrategy;
  /** Legacy exact tombstones that must remain non-live during finalization. */
  absentProofs?: ImportAbsenceProof[];
}

export interface ImportAbsenceProof {
  pageId: number;
  slug: string;
  sourcePath: string;
}

export interface FinalizeImportConvergenceOpts {
  /** Delete live, sync-managed rows absent from the immutable manifest. */
  reconcileStale?: boolean;
  /** Adversarial test seam after row selection but before exact deletion. */
  afterStaleSelection?: (
    tx: BrainEngine,
    rows: ReadonlyArray<ImportAbsenceProof>,
  ) => void | Promise<void>;
}

export class ImportConvergenceLostError extends Error {
  constructor(
    public readonly sourceId: string,
    public readonly invalidPaths: readonly string[],
  ) {
    super(
      `Import convergence proof changed for ${sourceId} before anchor advancement ` +
      `(first: ${invalidPaths[0] ?? 'unknown'}); checkpoint preserved`,
    );
    this.name = 'ImportConvergenceLostError';
  }
}

/**
 * Source- and brain-scoped checkpoint identity/path.
 *
 * A single global `import-checkpoint.json` let concurrent source A/B imports
 * overwrite or consume each other's completed paths whenever they shared a
 * checkout and commit. The opaque identity is stored in the checkpoint; its
 * hash gives each (brain, source, authority commit) an independent file.
 */
export function resolveImportCheckpointScope(
  dir: string,
  opts: {
    brainIdentity?: string;
    sourceId?: string;
    commit?: string;
    /** @deprecated Filesystem checkpoints are verified per file. */
    filesystemSnapshot?: string;
  } = {},
): { identity: string; path: string } {
  const cfg = loadConfig();
  const common = {
    version: 5,
    // The checkout is not the brain: two databases can ingest the same repo.
    // Bind resume state to the credential-stable DB identity used by the
    // upgrade pipeline, while keeping the repo path as a separate axis.
    brain: opts.brainIdentity ?? databaseIdentity({
      database_url: cfg?.database_url,
      database_path: cfg?.database_path,
    }),
    repo: resolve(dir),
    source: opts.sourceId ?? 'default',
  };
  const identity = JSON.stringify({
    ...common,
    authority: opts.commit ? `git:${opts.commit}` : 'filesystem:per-file-fingerprint',
  });
  // Filesystem runs reuse one path so a changed snapshot invalidates and then
  // replaces/clears the prior checkpoint instead of leaking one file per edit.
  // Commit-backed imports retain per-commit paths for safe concurrent jobs.
  const pathIdentity = JSON.stringify({
    // Keep the v3 filename so an interrupted pre-v5 checkpoint is replaced
    // in place instead of becoming an orphan. The v5 identity above makes the
    // old payload fail closed on load.
    ...common,
    version: 3,
    authority: opts.commit ? `git:${opts.commit}` : 'filesystem',
  });
  const digest = createHash('sha256').update(pathIdentity).digest('hex').slice(0, 32);
  return {
    identity,
    path: gbrainPath('import-checkpoints', `${digest}.json`),
  };
}

/**
 * Legacy compatibility helper. Filesystem resume no longer hashes file bodies
 * up front: every selected path is opened once, bounded by type, fingerprinted,
 * and either skipped or passed to the importer using those exact bytes.
 */
export function computeFilesystemImportSnapshot(
  _dir: string,
  files: string[],
  strategy: SyncStrategy = 'markdown',
): string {
  const hash = createHash('sha256');
  hash.update(`filesystem-import-manifest-v2\0strategy:${strategy}\0`);
  for (const path of [...files].sort()) {
    const bytes = Buffer.from(path, 'utf8');
    hash.update(`path:${bytes.length}:`);
    hash.update(bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function fingerprintImportBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface ImportDbProof {
  pageId: number;
  slug: string;
  contentHash: string;
}

async function loadImportDbProofs(
  engine: BrainEngine,
  sourceId: string,
  paths: readonly string[],
  opts: { lockRows?: boolean } = {},
): Promise<Map<string, ImportDbProof>> {
  const out = new Map<string, ImportDbProof>();
  const ambiguous = new Set<string>();
  for (let i = 0; i < paths.length; i += 500) {
    const batch = paths.slice(i, i + 500);
    if (batch.length === 0) continue;
    const rows = await engine.executeRaw<{
      id: number;
      slug: string;
      source_path: string;
      content_hash: string;
    }>(
      `SELECT id, slug, source_path, content_hash FROM pages
        WHERE source_id = $1
          AND source_path = ANY($2::text[])
          AND deleted_at IS NULL
        ${opts.lockRows ? 'FOR UPDATE' : ''}`,
      [sourceId, batch],
    );
    for (const row of rows) {
      if (out.has(row.source_path)) ambiguous.add(row.source_path);
      else out.set(row.source_path, {
        pageId: Number(row.id),
        slug: row.slug,
        contentHash: row.content_hash,
      });
    }
  }
  // More than one live owner is corruption, never proof that a checkpoint can
  // skip the path. Re-import will hit the normal ownership/collision checks.
  for (const path of ambiguous) out.delete(path);
  return out;
}

/**
 * Capture one source-path proof under the exact writer acquisition. The row
 * lock and final lease-row fence prevent an old file/blob authority from being
 * paired with a successor writer's page revision between SELECT and banking.
 */
async function captureImportDbProof(
  engine: BrainEngine,
  sourceId: string,
  path: string,
  writerLease: SourceWriterLease,
): Promise<ImportDbProof | undefined> {
  assertSourceWriterLease(writerLease, engine, sourceId);
  return engine.transaction(async tx => {
    assertSourceWriterLease(writerLease, tx, sourceId);
    const proof = (await loadImportDbProofs(tx, sourceId, [path], { lockRows: true })).get(path);
    await assertSourceWriterLeaseAtCommit(writerLease, tx, sourceId);
    return proof;
  });
}

async function invalidImportConvergencePaths(
  engine: BrainEngine,
  receipt: ImportConvergenceReceipt,
  opts: { lockRows?: boolean } = {},
): Promise<string[]> {
  const paths = Object.keys(receipt.completedProofs);
  const rows = await loadImportDbProofs(engine, receipt.sourceId, paths, opts);
  return paths.filter(path => {
    const expected = receipt.completedProofs[path];
    const actual = rows.get(path);
    return !expected || !actual
      || actual.pageId !== expected.pageId
      || actual.slug !== expected.slug
      || actual.contentHash !== expected.contentHash;
  });
}

async function invalidImportAbsencePaths(
  engine: BrainEngine,
  receipt: ImportConvergenceReceipt,
): Promise<string[]> {
  if (!receipt.authoritativePaths || !receipt.strategy) return [];
  const authority = new Set(receipt.authoritativePaths);
  const liveRows = await engine.executeRaw<{
    id: number;
    slug: string;
    source_path: string;
  }>(
    `SELECT id, slug, source_path
       FROM pages
      WHERE source_id = $1
        AND source_path IS NOT NULL
        AND deleted_at IS NULL
      FOR UPDATE`,
    [receipt.sourceId],
  );

  // Prove the full live file-backed projection is contained by the immutable
  // commit manifest while the pages table is write-conflict locked. This also
  // catches a stale row restored with a new id between delete and finalization.
  const invalid = new Set<string>();
  for (const row of liveRows) {
    if (isSyncable(row.source_path, { strategy: receipt.strategy })
        && !authority.has(row.source_path)) {
      invalid.add(row.source_path);
    }
  }

  // Keep exact tombstone evidence too: it makes a restored old identity fail
  // loudly even if a future strategy classifier stops considering its path.
  for (const proof of receipt.absentProofs ?? []) {
    const restored = liveRows.some(row => (
      row.id === proof.pageId
      || row.slug === proof.slug
      || row.source_path === proof.sourcePath
    ));
    if (restored) invalid.add(proof.sourcePath);
  }
  return [...invalid].sort();
}

/**
 * Reconcile stale managed rows inside the same transaction that advances the
 * source anchor. The caller has already taken the Postgres table lock (PGLite
 * is single-writer), so selection, exact deletion, absence proof, and anchor
 * promotion form one convergence boundary.
 */
async function reconcileImportStaleRows(
  tx: BrainEngine,
  receipt: ImportConvergenceReceipt,
  opts: FinalizeImportConvergenceOpts,
): Promise<number> {
  if (!opts.reconcileStale) return 0;
  if (!receipt.authoritativePaths || !receipt.strategy) {
    throw new Error('Managed stale reconciliation requires an authoritative manifest and strategy');
  }

  const authority = new Set(receipt.authoritativePaths);
  const rows = await tx.executeRaw<{
    id: number;
    slug: string;
    source_path: string;
  }>(
    `SELECT id, slug, source_path
       FROM pages
      WHERE source_id = $1
        AND source_path IS NOT NULL
        AND deleted_at IS NULL
      FOR UPDATE`,
    [receipt.sourceId],
  );
  const stale = rows
    .filter(row => isSyncable(row.source_path, { strategy: receipt.strategy })
      && !authority.has(row.source_path))
    .map(row => ({
      pageId: Number(row.id),
      slug: row.slug,
      sourcePath: row.source_path,
    }));
  if (stale.length === 0) return 0;

  await opts.afterStaleSelection?.(tx, stale);

  const deletedIds = new Set<number>();
  for (let i = 0; i < stale.length; i += DELETE_BATCH_SIZE) {
    const batch = stale.slice(i, i + DELETE_BATCH_SIZE);
    const payload = JSON.stringify({
      rows: batch.map(proof => ({
        page_id: proof.pageId,
        slug: proof.slug,
        source_path: proof.sourcePath,
      })),
    });
    const deleted = await tx.executeRaw<{ id: number }>(
      `WITH candidates AS (
         SELECT page_id, slug, source_path
           FROM jsonb_to_recordset(($2::text::jsonb)->'rows')
             AS c(page_id bigint, slug text, source_path text)
       )
       DELETE FROM pages p
        USING candidates c
        WHERE p.source_id = $1
          AND p.id = c.page_id
          AND p.slug = c.slug
          AND p.source_path = c.source_path
          AND p.deleted_at IS NULL
       RETURNING p.id`,
      [receipt.sourceId, payload],
    );
    for (const row of deleted) deletedIds.add(Number(row.id));
  }

  // A missing exact match is safe only when the row is now absent/tombstoned,
  // moved to another source, or no longer belongs to this sync strategy. A
  // still-live syncable row outside the manifest is unexplained drift and must
  // roll back both deletes and anchor advancement.
  const unresolved = stale.filter(proof => !deletedIds.has(proof.pageId));
  if (unresolved.length > 0) {
    const current = await tx.executeRaw<{
      id: number;
      slug: string;
      source_path: string | null;
      content_hash: string;
      deleted_at: Date | string | null;
    }>(
      `SELECT id, slug, source_path, content_hash, deleted_at
         FROM pages
        WHERE source_id = $1
          AND id = ANY($2::bigint[])
        FOR UPDATE`,
      [receipt.sourceId, unresolved.map(proof => proof.pageId)],
    );
    const byId = new Map(current.map(row => [Number(row.id), row]));
    const invalid: string[] = [];
    for (const proof of unresolved) {
      const row = byId.get(proof.pageId);
      if (!row || row.deleted_at !== null || row.source_path === null) continue;
      if (!isSyncable(row.source_path, { strategy: receipt.strategy })) continue;
      if (authority.has(row.source_path)) {
        const completed = receipt.completedProofs[row.source_path];
        if (completed
            && completed.pageId === Number(row.id)
            && completed.slug === row.slug
            && completed.contentHash === row.content_hash) continue;
      }
      invalid.push(row.source_path);
    }
    if (invalid.length > 0) {
      throw new ImportConvergenceLostError(receipt.sourceId, invalid.sort());
    }
  }

  return deletedIds.size;
}

/**
 * Linearization point for a managed import/full-sync completion.
 *
 * Postgres takes a short write-conflicting table lock because an absent row
 * has no row lock to acquire; PGLite's transaction is already single-writer.
 * The exact row proof and anchor write therefore commit as one unit. The file
 * checkpoint is retired only after that transaction commits, so a crash or a
 * stale writer can cause safe rework but never a false anchor advance.
 */
export async function finalizeImportConvergence(
  engine: BrainEngine,
  receipt: ImportConvergenceReceipt,
  writerLease: SourceWriterLease,
  advance?: (tx: BrainEngine) => Promise<void>,
  opts: FinalizeImportConvergenceOpts = {},
): Promise<{ deleted: number }> {
  assertSourceWriterLease(writerLease, engine, receipt.sourceId);
  const deleted = await engine.transaction(async tx => {
    assertSourceWriterLease(writerLease, tx, receipt.sourceId);
    if (tx.kind === 'postgres') {
      await tx.executeRaw('LOCK TABLE pages IN SHARE ROW EXCLUSIVE MODE');
    }
    const invalid = await invalidImportConvergencePaths(tx, receipt, { lockRows: true });
    if (invalid.length > 0) {
      throw new ImportConvergenceLostError(receipt.sourceId, invalid);
    }
    const reconciled = await reconcileImportStaleRows(tx, receipt, opts);
    const staleRestored = await invalidImportAbsencePaths(tx, receipt);
    if (staleRestored.length > 0) {
      throw new ImportConvergenceLostError(receipt.sourceId, staleRestored);
    }
    assertSourceWriterLease(writerLease, tx, receipt.sourceId);
    await advance?.(tx);
    await assertSourceWriterLeaseAtCommit(writerLease, tx, receipt.sourceId);
    return reconciled;
  });
  assertSourceWriterLease(writerLease, engine, receipt.sourceId);
  clearCheckpoint(receipt.checkpointPath);
  return { deleted };
}

/**
 * Open and read one filesystem import target without following symlinks.
 * The pre-open lstat and post-open fstat close the replacement race; the
 * before/after fstat pair catches in-place mutation during the read. The
 * returned buffer is the only buffer the caller passes to the importer.
 */
export function readBoundedFilesystemImportFile(
  filePath: string,
  relativePath: string,
  importRoot: string,
  onRead?: (path: string) => void,
): Buffer {
  const canonicalRoot = realpathSync(resolve(importRoot));
  const lexicalFile = resolve(importRoot, relativePath);
  if (lexicalFile !== resolve(filePath)) {
    throw new Error(`Import path/root mismatch: ${relativePath}`);
  }
  const contained = (candidate: string): boolean => {
    const rel = relative(canonicalRoot, candidate);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  const lexicalRelative = relative(resolve(importRoot), lexicalFile);
  if (
    lexicalRelative === '..'
    || lexicalRelative.startsWith(`..${sep}`)
    || isAbsolute(lexicalRelative)
  ) {
    throw new Error(`Import path escapes root: ${relativePath}`);
  }
  const assertNoNestedAncestorSymlink = (): void => {
    const lexicalRoot = resolve(importRoot);
    const parentRelative = relative(lexicalRoot, dirname(lexicalFile));
    if (parentRelative === '') return;
    let current = lexicalRoot;
    for (const segment of parentRelative.split(sep)) {
      if (!segment) continue;
      current = join(current, segment);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Import path uses a symlink ancestor: ${relativePath}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Import path has a non-directory ancestor: ${relativePath}`);
      }
    }
  };
  assertNoNestedAncestorSymlink();
  // Resolve ancestors only. Resolving the selected leaf before lstat/open
  // follows an in-root symlink and can import an excluded private file. The
  // leaf itself must remain lexical and is opened with O_NOFOLLOW below.
  const canonicalParent = realpathSync(dirname(lexicalFile));
  if (!contained(canonicalParent)) {
    throw new Error(`Import path escapes root through an ancestor symlink: ${relativePath}`);
  }

  const beforeOpen = lstatSync(lexicalFile);
  if (beforeOpen.isSymbolicLink()) throw new Error(`Skipping symlink: ${filePath}`);
  if (!beforeOpen.isFile()) throw new Error(`Skipping non-regular file: ${filePath}`);
  const maxBytes = isImageFilePath(relativePath)
    ? MAX_IMPORT_IMAGE_BYTES
    : MAX_IMPORT_TEXT_BYTES;
  if (beforeOpen.size > maxBytes) {
    throw new Error(`File too large (${beforeOpen.size} bytes, max ${maxBytes}): ${relativePath}`);
  }

  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(lexicalFile, fsConstants.O_RDONLY | noFollow);
  try {
    const beforeRead = fstatSync(fd);
    if (!beforeRead.isFile()) throw new Error(`Skipping non-regular file: ${filePath}`);
    if (beforeRead.dev !== beforeOpen.dev || beforeRead.ino !== beforeOpen.ino) {
      throw new Error(`File changed before read: ${relativePath}`);
    }
    assertNoNestedAncestorSymlink();
    const postOpenParent = realpathSync(dirname(lexicalFile));
    const postOpenPathStat = lstatSync(lexicalFile);
    if (
      postOpenParent !== canonicalParent ||
      !contained(postOpenParent) ||
      postOpenPathStat.dev !== beforeRead.dev ||
      postOpenPathStat.ino !== beforeRead.ino ||
      postOpenPathStat.isSymbolicLink()
    ) {
      throw new Error(`Import ancestor changed before read: ${relativePath}`);
    }
    if (beforeRead.size > maxBytes) {
      throw new Error(`File too large (${beforeRead.size} bytes, max ${maxBytes}): ${relativePath}`);
    }
    onRead?.(relativePath);
    // Bound the allocation itself. A pre-read stat is not a memory bound: a
    // concurrently growing regular file makes readFileSync(fd) read to EOF
    // before the after-read rejection. maxBytes+1 lets us detect overflow
    // without ever allocating beyond the documented per-file ceiling.
    const bounded = Buffer.allocUnsafe(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < bounded.byteLength) {
      const n = readSync(
        fd,
        bounded,
        bytesRead,
        bounded.byteLength - bytesRead,
        null,
      );
      if (n === 0) break;
      bytesRead += n;
    }
    if (bytesRead > maxBytes) {
      throw new Error(`File too large while reading (max ${maxBytes} bytes): ${relativePath}`);
    }
    const bytes = bounded.subarray(0, bytesRead);
    const afterRead = fstatSync(fd);
    assertNoNestedAncestorSymlink();
    const afterReadParent = realpathSync(dirname(lexicalFile));
    const afterReadPathStat = lstatSync(lexicalFile);
    if (
      afterRead.dev !== beforeRead.dev ||
      afterRead.ino !== beforeRead.ino ||
      afterRead.size !== beforeRead.size ||
      afterRead.mtimeMs !== beforeRead.mtimeMs ||
      afterRead.ctimeMs !== beforeRead.ctimeMs ||
      bytesRead !== beforeRead.size ||
      afterReadParent !== canonicalParent ||
      !contained(afterReadParent) ||
      afterReadPathStat.dev !== afterRead.dev ||
      afterReadPathStat.ino !== afterRead.ino ||
      afterReadPathStat.isSymbolicLink()
    ) {
      throw new Error(`File changed while reading: ${relativePath}`);
    }
    if (bytes.byteLength > maxBytes) {
      throw new Error(`File too large (${bytes.byteLength} bytes, max ${maxBytes}): ${relativePath}`);
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export function resolveImportCheckpointBrainIdentity(
  engine: BrainEngine,
  explicit?: string,
): string {
  const config = loadConfig();
  return explicit ?? engine.getDatabaseIdentity?.() ?? databaseIdentity({
    database_url: config?.database_url,
    database_path: config?.database_path,
  });
}

export async function runImport(
  engine: BrainEngine,
  args: string[],
  opts: {
    /** Resolved Git commit whose tree is the immutable import authority. */
    commit?: string;
    strategy?: SyncStrategy;
    sourceId?: string;
    /** Stable identity of the connected database. Defaults from active config. */
    brainIdentity?: string;
    managedBookmark?: boolean;
    /**
     * Internal runtime-issued proof that this exact engine/source lease is
     * active. It cannot be constructed or reused by library callers.
     */
    writerLease?: SourceWriterLease;
    /** Test-only observation seam; never changes import behavior. */
    _hooks?: {
      onFilesystemRead?: (path: string) => void;
      /** Adversarial-test seam: fires after checkpoint DB proofs are loaded. */
      afterResumeProofsLoaded?: () => void | Promise<void>;
      /** Adversarial-test seam: fires after proofs are banked, before finalization. */
      beforeConvergenceFinalize?: () => void | Promise<void>;
    };
  } = {},
): Promise<RunImportResult> {
  const noEmbed = args.includes('--no-embed');
  const fresh = args.includes('--fresh');
  const jsonOutput = args.includes('--json');
  // `--json` owns stdout as one machine-readable document. Human progress
  // remains visible on stderr; non-JSON callers retain the historical stdout
  // presentation.
  const humanLog = (message: string): void => {
    if (jsonOutput) console.error(message);
    else console.log(message);
  };

  // T7 (D9): refuse cleanly when init persisted the deferred-setup sentinel,
  // unless the user is explicitly skipping embedding via `--no-embed` (in
  // which case the chunks land without vectors and the user can backfill
  // later with `gbrain embed --stale` after configuring a provider).
  if (!noEmbed) {
    const { assertEmbeddingEnabled } = await import('../core/embedding-dim-check.ts');
    const { loadConfig } = await import('../core/config.ts');
    try {
      assertEmbeddingEnabled(loadConfig());
    } catch (e) {
      const message = `${e instanceof Error ? e.message : String(e)}\n` +
        'Tip: run `gbrain import <dir> --no-embed` to import without embedding now.';
      throw new ImportInvocationError('embedding_disabled', message, { cause: e });
    }

    // v0.41.6.0 D1: preflight embedding credentials. Closes the bug class
    // where `gbrain import` per-file embed writes N identical
    // "missing OPENAI_API_KEY" failures into sync-failures.jsonl.
    const { validateEmbeddingCreds, EmbeddingCredentialError } = await import('../core/embed-preflight.ts');
    try {
      validateEmbeddingCreds();
    } catch (e) {
      if (e instanceof EmbeddingCredentialError) {
        throw new ImportInvocationError(
          'embedding_credentials_missing',
          e.userMessage,
          { diagnosis: e.diagnosis, cause: e },
        );
      }
      throw e;
    }
  }
  // v0.30.x follow-up to PR #707: programmatic sourceId support so internal
  // callers (performFullSync, future Step 6 paths) can route to a named
  // source.
  //
  // v0.37.7.0 #1167+#1222: the CLI surface now also accepts a
  // `--source-id <id>` flag (named to avoid colliding with `--source`
  // which other commands use for different axes). Pre-fix, users
  // passing `gbrain import --source dept-x ...` silently fell back to
  // default because the parser ignored the flag. Now an explicit
  // `--source-id <id>` opt-in routes the import to that source.
  // Programmatic callers continue passing `opts.sourceId` directly;
  // CLI callers' flag wins over opts when both are set.
  const sourceIdIdx = args.indexOf('--source-id');
  const flagSourceId = sourceIdIdx !== -1 ? args[sourceIdIdx + 1] : null;
  const workersIdx = args.indexOf('--workers');
  const workersArg = workersIdx !== -1 ? args[workersIdx + 1] : null;
  // Resolve the import root before source selection. The canonical resolver's
  // dotfile and local_path tiers are rooted at the corpus being imported, not
  // at the shell that happened to launch gbrain (which may be a scheduler,
  // service unit, or parent workspace).
  const flagValues = new Set<number>();
  if (workersIdx !== -1) flagValues.add(workersIdx + 1);
  if (sourceIdIdx !== -1) flagValues.add(sourceIdIdx + 1);
  const dirArg = args.find((a, i) => !a.startsWith('--') && !flagValues.has(i));

  if (!dirArg) {
    throw new ImportInvocationError(
      'missing_directory',
      'Usage: gbrain import <dir> [--no-embed] [--workers N] [--fresh] [--source-id <id>] [--json]',
    );
  }
  const dir: string = dirArg;  // narrowed; survives closure capture
  try {
    if (!lstatSync(dir).isDirectory()) {
      throw new ImportInvocationError('invalid_directory', `Import path is not a directory: ${dir}`);
    }
  } catch (error) {
    if (error instanceof ImportInvocationError) throw error;
    throw new ImportInvocationError('invalid_directory', `Import directory is unavailable: ${dir}`, { cause: error });
  }
  const explicitSourceId = flagSourceId ?? opts.sourceId;

  // v0.41.13 (#1434): when no explicit source / env / opts.sourceId is set,
  // fall through to the resolver so the new sole_non_default tier (5.5) can
  // auto-route to the only registered non-default source. Pre-fix, import
  // followed the explicit-only design from PR #707 and silently routed
  // every import to 'default', mirroring the sync bug class.
  //
  // Resolution chain (full 7 tiers): flag → env → dotfile → local_path →
  // brain_default → sole_non_default → seed_default. The nudge fires only
  // when the resolver returns tier='sole_non_default', so explicit users
  // see no behavior change.
  const { resolveSourceWithTier, formatSoleNonDefaultNudge } = await import('../core/source-resolver.ts');
  const resolvedSource = await resolveSourceWithTier(engine, explicitSourceId, resolve(dir));
  const sourceId = resolvedSource.source_id;
  if (!opts.writerLease) {
    // Direct import and sync share one `(brain, source)` writer lease. The
    // connected engine supplies the brain boundary; the lock id supplies the
    // source boundary. Full sync passes the runtime-issued token from the
    // exact lease acquired by performSync.
    return withSourceWriterLease(
      engine,
      sourceId,
      writerLease => runImport(engine, args, { ...opts, sourceId, writerLease }),
    );
  }
  assertSourceWriterLease(opts.writerLease, engine, sourceId);
  // Preserve the pre-multi-source legacy anchor only for the literal terminal
  // seed-default tier. Every configured tier (including a configured/default
  // source whose id happens to be "default") owns its sources-row anchor.
  const usesSourceRowAnchor = resolvedSource.tier !== 'seed_default';
  if (resolvedSource.tier === 'sole_non_default') {
    const nudge = formatSoleNonDefaultNudge(sourceId);
    if (nudge) process.stderr.write(nudge + '\n');
  }
  const effectiveSourceId = sourceId;

  // Load the active pack once, AFTER source resolution. Flag/env/dotfile and
  // sole-source routing must select the same per-source pack that owns every
  // page, checkpoint, ingest row, and failure record in this run.
  let importActivePack: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> } | undefined;
  try {
    const { loadActivePack } = await import('../core/schema-pack/load-active.ts');
    const resolved = await loadActivePack({
      cfg: loadConfig(),
      remote: false,
      sourceId: effectiveSourceId,
    });
    importActivePack = { page_types: resolved.manifest.page_types };
  } catch {
    importActivePack = undefined;
  }
  // v0.22.13 (PR #490 Q2): shared parseWorkers helper rejects bad input
  // (--workers 0, -3, "foo") with a loud error instead of silently falling
  // through to 1. Mirrors sync.ts's flag handling.
  const { parseWorkers } = await import('../core/sync-concurrency.ts');
  let workerCount: number;
  try {
    workerCount = parseWorkers(workersArg ?? undefined) ?? 1;
  } catch (e) {
    throw new ImportInvocationError(
      'invalid_workers',
      e instanceof Error ? e.message : String(e),
      { cause: e },
    );
  }
  // v0.31.2: collect under the right strategy. Pre-fix this called
  // collectMarkdownFiles unconditionally — code-strategy first sync
  // silently no-op'd because no code file ever made it through walker
  // enumeration (codex C11 confirms dispatch was correct; bug was here).
  const strategy: SyncStrategy = opts.strategy ?? 'markdown';
  const _walkT0 = Date.now();
  console.error(`[gbrain phase] import.collect_files start dir=${dir} strategy=${strategy}`);
  const commitSnapshot: GitCommitSnapshot | null = opts.commit
    ? openGitCommitSnapshot(dir, opts.commit)
    : null;
  const snapshotBlobs = commitSnapshot
    ? filterSyncableGitBlobs(commitSnapshot.blobs, { strategy })
    : null;
  const snapshotBlobByPath = new Map<string, GitCommitBlob>(
    (snapshotBlobs ?? []).map(blob => [blob.path, blob]),
  );
  const allFiles = snapshotBlobs
    ? snapshotBlobs.map(blob => blob.path)
    : collectSyncableFiles(dir, { strategy });
  console.error(
    `[gbrain phase] import.collect_files done ${Date.now() - _walkT0}ms files=${allFiles.length}`,
  );
  const fileTypeLabel = strategy === 'code' ? 'code'
    : strategy === 'auto' ? 'syncable' : 'markdown';
  humanLog(`Found ${allFiles.length} ${fileTypeLabel} files`);

  // Sort newest-first so date-prefixed brain paths get embedded before older ones.
  // See src/core/sort-newest-first.ts for the policy.
  sortNewestFirst(allFiles);
  // Resume from checkpoint if available. v0.33.2: path-based resume —
  // see src/core/import-checkpoint.ts for the bug-class this fixes
  // (parallel-import silent-skip and failed-file no-retry).
  // Use the EFFECTIVE source after flag/env/sole-source resolution. Passing
  // the original opts here let `--source-id A` and `--source-id B` consume the
  // same `default` checkpoint when run programmatically with empty opts.
  const checkpointScope = resolveImportCheckpointScope(dir, {
    // The connected engine is authoritative. loadConfig() may describe the
    // host brain while a registry/job caller passed a mounted-brain engine.
    brainIdentity: resolveImportCheckpointBrainIdentity(engine, opts.brainIdentity),
    sourceId: effectiveSourceId,
    commit: opts.commit,
  });
  const checkpointPath = checkpointScope.path;
  const checkpointIdentity = checkpointScope.identity;
  const completed = new Set<string>();
  const completedFingerprints = new Map<string, string>();
  const completedProofs = new Map<string, ImportConvergenceProof>();
  const resumeProofs = new Map<string, ImportConvergenceProof>();
  if (!fresh) {
    const cp = loadCheckpoint(checkpointPath, checkpointIdentity);
    if (cp) {
      const dbProofs = await loadImportDbProofs(engine, effectiveSourceId, cp.completedPaths);
      for (const p of cp.completedPaths) {
        const proof = cp.completedProofs?.[p];
        const dbProof = dbProofs.get(p);
        if (
          !proof || !dbProof
          || dbProof.pageId !== proof.pageId
          || dbProof.slug !== proof.slug
          || dbProof.contentHash !== proof.contentHash
        ) continue;
        if (snapshotBlobs) {
          const blob = snapshotBlobByPath.get(p);
          if (blob && proof.authorityFingerprint === `git:${blob.oid}`) {
            completed.add(p);
            completedProofs.set(p, proof);
          }
          continue;
        }
        resumeProofs.set(p, proof);
      }
      const resumeCount = snapshotBlobs ? completed.size : resumeProofs.size;
      if (resumeCount > 0) {
        humanLog(
          snapshotBlobs
            ? `Resuming from checkpoint: skipping ${resumeCount} immutable file(s)`
            : `Resuming from checkpoint: fingerprint-verifying ${resumeCount} completed file(s) during their single read`,
        );
      }
    }
  }
  await opts._hooks?.afterResumeProofsLoaded?.();
  // Immutable Git blobs can be skipped without a read. Mutable filesystem
  // files must be opened exactly once: processFile fingerprints that buffer,
  // skips it when the checkpoint matches, or imports those same exact bytes.
  const files = snapshotBlobs ? resumeFilter(allFiles, dir, completed) : allFiles;

  // Determine actual worker count
  const actualWorkers = workerCount > 1 ? workerCount : 1;
  if (actualWorkers > 1) {
    humanLog(`Using ${actualWorkers} parallel workers`);
  }

  let imported = 0;
  let skipped = 0;
  let errors = 0;
  let processed = 0;
  let chunksCreated = 0;
  const importedSlugs: string[] = [];
  const errorCounts: Record<string, number> = {};
  const failures: Array<{ path: string; error: string }> = []; // Bug 9
  let snapshotAuthorityFailed = false;
  const startTime = Date.now();

  // Progress on stderr so stdout stays clean for the final summary / --json payload.
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('import.files', files.length);

  function tickProgress() {
    progress.tick(1, `imported=${imported} skipped=${skipped} errors=${errors}`);
  }

  async function processFile(eng: BrainEngine, filePath: string) {
    const relativePath = snapshotBlobs ? filePath : relative(dir, filePath);
    let sourceFingerprint: string | undefined;
    // v0.31.2 (D5): per-file slow-path log. Fires only when a single
    // file takes >5s. The user's hang surfaces as one file taking
    // forever — without this, the agent can't see which file.
    const _fileT0 = Date.now();
    try {
      assertSourceWriterLease(opts.writerLease!, eng, effectiveSourceId);
      // v0.27.1 (F2): dispatch image extensions to importImageFile when
      // multimodal is enabled. The walker (collectMarkdownFiles) only picks
      // up images when GBRAIN_EMBEDDING_MULTIMODAL=true so this branch is
      // unreachable when the gate is off; defense-in-depth check anyway.
      let result: ImportResult;
      if (snapshotBlobs) {
        const snapshotBlob = snapshotBlobByPath.get(relativePath);
        if (!snapshotBlob) throw new Error(`Git snapshot entry disappeared from manifest: ${relativePath}`);
        if (!commitSnapshot) throw new GitSnapshotError('Git commit snapshot was not initialized');
        result = await importGitBlob(eng, commitSnapshot, snapshotBlob, {
          noEmbed, sourceId: effectiveSourceId, activePack: importActivePack,
          writerLease: opts.writerLease,
        });
      } else {
        // Read once under a no-follow, type-aware size bound. The checkpoint
        // fingerprint either skips this exact buffer or describes the exact
        // bytes passed to the importer — no corpus pre-read and no second read.
        const bytes = readBoundedFilesystemImportFile(
          filePath,
          relativePath,
          dir,
          opts._hooks?.onFilesystemRead,
        );
        sourceFingerprint = fingerprintImportBytes(bytes);
        const resumeProof = resumeProofs.get(relativePath);
        if (resumeProof && resumeProof.authorityFingerprint === `sha256:${sourceFingerprint}`) {
          // The initial batch proof is only a candidate. Re-read this exact row
          // at the skip boundary so a same-source writer that changed it after
          // checkpoint loading cannot be banked as converged.
          const currentProof = await captureImportDbProof(
            eng,
            effectiveSourceId,
            relativePath,
            opts.writerLease!,
          );
          if (
            currentProof?.pageId === resumeProof.pageId
            && currentProof.slug === resumeProof.slug
            && currentProof.contentHash === resumeProof.contentHash
          ) {
            result = { slug: currentProof.slug, status: 'skipped', chunks: 0 };
          } else if (isImageFilePath(relativePath) && process.env.GBRAIN_EMBEDDING_MULTIMODAL === 'true') {
            result = await importImageBuffer(eng, bytes, relativePath, {
              noEmbed,
              sourceId: effectiveSourceId,
              writerLease: opts.writerLease,
            });
          } else {
            result = await importFileContent(eng, bytes.toString('utf8'), relativePath, {
              noEmbed, sourceId: effectiveSourceId, activePack: importActivePack,
              writerLease: opts.writerLease,
            });
          }
        } else if (isImageFilePath(relativePath) && process.env.GBRAIN_EMBEDDING_MULTIMODAL === 'true') {
          result = await importImageBuffer(eng, bytes, relativePath, {
            noEmbed,
            sourceId: effectiveSourceId,
            writerLease: opts.writerLease,
          });
        } else {
          result = await importFileContent(eng, bytes.toString('utf8'), relativePath, {
            noEmbed, sourceId: effectiveSourceId, activePack: importActivePack,
            writerLease: opts.writerLease,
          });
        }
      }
      assertSourceWriterLease(opts.writerLease!, eng, effectiveSourceId);
      const _fileMs = Date.now() - _fileT0;
      if (_fileMs > 5000) {
        console.error(`[gbrain phase] import.process_file slow ${_fileMs}ms ${relativePath}`);
      }
      if (result.status === 'imported') {
        const dbProof = await captureImportDbProof(
          eng, effectiveSourceId, relativePath, opts.writerLease!,
        );
        if (!dbProof) throw new Error(`Import convergence proof missing for ${effectiveSourceId}:${relativePath}`);
        if (dbProof.slug !== result.slug) {
          throw new Error(`Import convergence slug changed for ${effectiveSourceId}:${relativePath}`);
        }
        imported++;
        chunksCreated += result.chunks;
        importedSlugs.push(result.slug);
        // v0.33.2: path-based checkpoint — record only on success.
        completed.add(relativePath);
        if (sourceFingerprint) completedFingerprints.set(relativePath, sourceFingerprint);
        const authorityFingerprint = snapshotBlobs
          ? `git:${snapshotBlobByPath.get(relativePath)!.oid}`
          : `sha256:${sourceFingerprint}`;
        completedProofs.set(relativePath, {
          authorityFingerprint,
          pageId: dbProof.pageId,
          slug: dbProof.slug,
          contentHash: dbProof.contentHash,
        });
      } else {
        skipped++;
        if (result.error && result.error !== 'unchanged') {
          console.error(`  Skipped ${relativePath}: ${result.error}`);
          // Bug 9 — non-"unchanged" skips carry a real error reason.
          failures.push({ path: relativePath, error: result.error });
        } else {
          const dbProof = await captureImportDbProof(
            eng, effectiveSourceId, relativePath, opts.writerLease!,
          );
          if (!dbProof) throw new Error(`Import convergence proof missing for ${effectiveSourceId}:${relativePath}`);
          if (dbProof.slug !== result.slug) {
            throw new Error(`Import convergence slug changed for ${effectiveSourceId}:${relativePath}`);
          }
          // 'unchanged' or no-error skip: content_hash matched a prior
          // successful import, so this file IS done for checkpoint purposes.
          completed.add(relativePath);
          if (sourceFingerprint) completedFingerprints.set(relativePath, sourceFingerprint);
          const authorityFingerprint = snapshotBlobs
            ? `git:${snapshotBlobByPath.get(relativePath)!.oid}`
            : `sha256:${sourceFingerprint}`;
          completedProofs.set(relativePath, {
            authorityFingerprint,
            pageId: dbProof.pageId,
            slug: dbProof.slug,
            contentHash: dbProof.contentHash,
          });
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const errorKey = msg.replace(/"[^"]*"/g, '""');
      errorCounts[errorKey] = (errorCounts[errorKey] || 0) + 1;
      if (errorCounts[errorKey] <= 5) {
        console.error(`  Warning: skipped ${relativePath}: ${msg}`);
      } else if (errorCounts[errorKey] === 6) {
        console.error(`  (suppressing further "${errorKey.slice(0, 60)}..." errors)`);
      }
      errors++;
      skipped++;
      if (e instanceof GitSnapshotError) {
        snapshotAuthorityFailed = true;
        if (!failures.some(f => f.path === GIT_SNAPSHOT_SENTINEL)) {
          failures.push({ path: GIT_SNAPSHOT_SENTINEL, error: msg });
        }
      } else {
        failures.push({ path: relativePath, error: msg });
      }
    }
    processed++;
    tickProgress();
    // Save checkpoint every 100 SUCCESSFUL adds (not every 100 processed).
    // Failed files never enter `completed`, so a flaky file can't push the
    // checkpoint past it — the next run will retry it.
    if (completed.size > 0 && completed.size % 100 === 0) {
      assertSourceWriterLease(opts.writerLease!, engine, effectiveSourceId);
      const cpDir = dirname(checkpointPath);
      if (!existsSync(cpDir)) {
        try { const { mkdirSync } = await import('fs'); mkdirSync(cpDir, { recursive: true }); }
        catch { /* non-fatal */ }
      }
      saveCheckpoint(checkpointPath, {
        dir: checkpointIdentity,
        completedPaths: Array.from(completed),
        ...(snapshotBlobs
          ? {}
          : { completedFingerprints: Object.fromEntries(completedFingerprints) }),
        completedProofs: Object.fromEntries(completedProofs),
        timestamp: new Date().toISOString(),
      });
    }
  }

  try {
    if (actualWorkers > 1) {
    // A mounted-brain caller may intentionally differ from loadConfig().
    // Workers therefore come only from the connected parent engine.
    if (!engine.createWorkerEngine) {
      for (const file of files) {
        if (snapshotAuthorityFailed) break;
        await processFile(engine, file);
      }
    } else {
      const { resolvePoolSize } = await import('../core/db.ts');
      // Default per-worker pool is 2 (small, parallel import case). Users on
      // constrained poolers (e.g. Supabase port 6543) can cap below this via
      // GBRAIN_POOL_SIZE=1.
      const workerPoolSize = Math.min(2, resolvePoolSize(2));

      // v0.22.13 (PR #490 A2): connect workers serially so a partial failure
      // leaves us with the connected ones already pushed onto workerEngines
      // for the finally-block cleanup. The prior Promise.all could leak any
      // engine that connected before another's connect() rejected.
      const workerEngines: BrainEngine[] = [];
      try {
        for (let i = 0; i < actualWorkers; i++) {
          const eng = await engine.createWorkerEngine(workerPoolSize);
          workerEngines.push(eng);
        }

        // Thread-safe queue: atomic index counter (JS is single-threaded; the
        // read-then-increment happens between awaits so no lock is needed).
        let queueIndex = 0;
        await Promise.all(workerEngines.map(async (eng) => {
          while (true) {
            if (snapshotAuthorityFailed) break;
            const idx = queueIndex++;
            if (idx >= files.length) break;
            await processFile(eng, files[idx]);
          }
        }));
      } finally {
        // v0.22.13 (PR #490 A2): try/finally guarantees cleanup even when the
        // worker loop throws. Each disconnect is best-effort — one failing
        // disconnect must not strand the others.
        await Promise.all(
          workerEngines.map(e =>
            e.disconnect().catch((err: unknown) =>
              console.error(`  worker disconnect failed: ${err instanceof Error ? err.message : String(err)}`),
            ),
          ),
        );
      }
      } // end else (postgres parallel)
    } else {
      // Sequential: use the provided engine
      for (const filePath of files) {
        if (snapshotAuthorityFailed) break;
        await processFile(engine, filePath);
      }
    }
  } finally {
    await commitSnapshot?.close();
  }

  progress.finish();

  // Resolve the commit authority before deciding whether the checkpoint may be
  // retired. Managed full-sync callers advance through their own shared gate;
  // direct imports linearize proof + anchor here.
  // Only immutable commit-backed imports may advance a Git sync anchor. A
  // direct worktree import reads mutable filesystem bytes; binding those rows
  // to whatever HEAD happens to be after the read would assert false authority
  // for dirty files or a concurrent commit. Callers that need anchoring pass an
  // explicit commit, which is read through openGitCommitSnapshot above.
  const gitHead: string | null = opts.commit ?? null;

  const checkpointDir = dirname(checkpointPath);
  if (!existsSync(checkpointDir)) {
    try { const { mkdirSync } = await import('fs'); mkdirSync(checkpointDir, { recursive: true }); }
    catch { /* safe fallback is rework */ }
  }
  const convergence: ImportConvergenceReceipt = {
    checkpointPath,
    checkpointIdentity,
    sourceId: effectiveSourceId,
    completedPaths: Array.from(completed),
    ...(snapshotBlobs
      ? {}
      : { completedFingerprints: Object.fromEntries(completedFingerprints) }),
    completedProofs: Object.fromEntries(completedProofs),
    ...(opts.managedBookmark ? { authoritativePaths: [...allFiles], strategy } : {}),
  };
  // Bank the complete proof set BEFORE finalization. Anchor first, checkpoint
  // retirement second; a crash between them causes harmless rework.
  saveCheckpoint(checkpointPath, {
    dir: checkpointIdentity,
    completedPaths: convergence.completedPaths,
    ...(convergence.completedFingerprints
      ? { completedFingerprints: convergence.completedFingerprints }
      : {}),
    completedProofs: convergence.completedProofs,
    timestamp: new Date().toISOString(),
  });
  await opts._hooks?.beforeConvergenceFinalize?.();

  assertSourceWriterLease(opts.writerLease!, engine, effectiveSourceId);
  if (failures.length === 0 && opts.managedBookmark) {
    // Early diagnostic only. Sync repeats this under a write-conflicting
    // transaction immediately before its shared bookmark gate advances.
    const invalid = await invalidImportConvergencePaths(engine, convergence);
    if (invalid.length > 0) {
      failures.push(...invalid.map(path => ({
        path,
        error: `checkpoint convergence proof changed before managed completion for ${effectiveSourceId}:${path}`,
      })));
    }
  }

  if (failures.length === 0 && !opts.managedBookmark) {
    try {
      await finalizeImportConvergence(
        engine,
        convergence,
        opts.writerLease!,
        gitHead
          ? async tx => {
              if (usesSourceRowAnchor) {
                const updated = await tx.executeRaw<{ id: string }>(
                  `UPDATE sources
                      SET last_commit = $1, last_sync_at = now(), local_path = $2
                    WHERE id = $3
                    RETURNING id`,
                  [gitHead, dir, effectiveSourceId],
                );
                if (updated.length !== 1) {
                  throw new Error(`Import source anchor missing: ${effectiveSourceId}`);
                }
              } else {
                await tx.setConfig('sync.last_commit', gitHead);
                await tx.setConfig('sync.last_run', new Date().toISOString());
                await tx.setConfig('sync.repo_path', dir);
              }
            }
          : undefined,
      );
    } catch (error) {
      if (!(error instanceof ImportConvergenceLostError)) throw error;
      failures.push(...error.invalidPaths.map(path => ({ path, error: error.message })));
    }
  }

  // Error summary
  for (const [err, count] of Object.entries(errorCounts)) {
    if (count > 5) {
      console.error(`  ${count} files failed: ${err.slice(0, 100)}`);
    }
  }

  if (failures.length > 0) {
    humanLog(`  Checkpoint preserved (${failures.length} failure(s)). Run again to retry failed files.`);
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  const status: RunImportResult['status'] = failures.length > 0
    ? 'partial_failure'
    : 'success';
  const exitCode: RunImportResult['exitCode'] = failures.length > 0 ? 1 : 0;
  if (jsonOutput) {
    console.log(JSON.stringify({
      status, exit_code: exitCode, duration_s: parseFloat(totalTime),
      imported, skipped, errors, chunks: chunksCreated,
      failures: failures.length, total_files: allFiles.length,
    }));
  } else {
    console.log(`\nImport ${status === 'success' ? 'complete' : 'completed with failures'} (${totalTime}s):`);
    console.log(`  ${imported} pages imported`);
    console.log(`  ${skipped} pages skipped (${failures.length} failures, ${errors} thrown errors)`);
    console.log(`  ${chunksCreated} chunks created`);
  }

  // v0.39 T7 — end-of-run schema mismatch warn. Fires ONCE per import,
  // not per page. Counts untyped pages in the affected source AND
  // compares to import size; warns at >=10% untyped. The doctor
  // schema_pack_consistency check (also T7) gives the persistent surface.
  // Best-effort: query failure is non-fatal.
  if (imported > 0) {
    try {
      const sid = effectiveSourceId;
      const rows = await engine.executeRaw<{ total: string | number; untyped: string | number }>(
        `SELECT
           COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE type IS NULL OR type = '')::text AS untyped
         FROM pages
         WHERE source_id = $1 AND deleted_at IS NULL`,
        [sid],
      );
      const total = Number(rows[0]?.total ?? 0);
      const untyped = Number(rows[0]?.untyped ?? 0);
      if (total > 0 && untyped / total >= 0.1) {
        const pct = ((untyped / total) * 100).toFixed(1);
        console.error(
          `\n[schema] ${untyped} of ${total} pages (${pct}%) in source \`${sid}\` ` +
          `have no \`type\` matching the active schema pack. Run \`gbrain schema detect\` ` +
          `to propose a pack matching your content shape, or \`gbrain doctor --json\` ` +
          `for the persistent surface (schema_pack_consistency check).`,
        );
      }
    } catch {
      // best-effort
    }
  }

  // Log the ingest
  await engine.logIngest({
    source_id: effectiveSourceId,
    source_type: 'directory',
    source_ref: opts.commit ? `${dir} @ ${opts.commit}` : dir,
    pages_updated: importedSlugs,
    summary: `Imported ${imported} pages, ${skipped} skipped, ${chunksCreated} chunks`,
  });

  // issue #1939: when performFullSync drives runImport it owns the failure
  // ledger + bookmark via the shared gate (applySyncFailureGate). Skipping the
  // internal handling here prevents double-recording (which would double-count
  // the auto-skip `attempts` streak) and a competing bookmark write.
  if (gitHead && !opts.managedBookmark) {
    // Record failures into the central JSONL so doctor can surface them.
    // Use gitHead as the commit so a later sync can tell "same broken
    // state as last time" from "new broken state." Source-scoped (#1939 #2).
    if (failures.length > 0) {
      const { recordFailures } = await import('../core/sync.ts');
      recordFailures(effectiveSourceId, failures, gitHead);
    }
    if (failures.length > 0 || snapshotAuthorityFailed) {
      console.error(
        `\nImport completed with ${failures.length} failure(s). ` +
        `the ${effectiveSourceId} sync anchor was NOT advanced — re-run 'gbrain sync' to retry, or ` +
        `'gbrain sync --skip-failed' to acknowledge and move past them.`,
      );
      if (usesSourceRowAnchor) {
        const updated = await engine.executeRaw<{ id: string }>(
          `UPDATE sources SET local_path = $1 WHERE id = $2 RETURNING id`,
          [dir, effectiveSourceId],
        );
        if (updated.length !== 1) {
          throw new Error(`Import source anchor missing: ${effectiveSourceId}`);
        }
      } else {
        await engine.setConfig('sync.last_run', new Date().toISOString());
        await engine.setConfig('sync.repo_path', dir);
      }
    }
  }

  return {
    status,
    exitCode,
    imported,
    skipped,
    errors,
    chunksCreated,
    failures,
    ...(opts.managedBookmark ? { convergence } : {}),
  };
}

/**
 * v0.31.2: max walker depth before bailing out. 32 levels is more than
 * any real source tree on disk; reaching it is a structural cycle the
 * lstat+inode-set defenses missed (e.g., a Linux bind-mount or btrfs
 * subvolume that returns a fresh inode for the same content). Override
 * via `GBRAIN_MAX_WALK_DEPTH`.
 */
function resolveMaxWalkDepth(): number {
  const raw = process.env.GBRAIN_MAX_WALK_DEPTH;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 32;
}

interface CollectOpts {
  strategy?: SyncStrategy;
}

/**
 * v0.27.1 + v0.31.2: walker-context image admission. `isSyncable` (the
 * incremental-diff filter at sync.ts:213) admits images only on `auto`.
 * The first-sync walker historically admitted them on markdown too when
 * `GBRAIN_EMBEDDING_MULTIMODAL=true`. Codex (C5) flagged the contradiction
 * — preserve the walker semantic explicitly.
 */
function isCollectibleForWalker(
  path: string,
  strategy: SyncStrategy,
  multimodalOn: boolean,
): boolean {
  // Canonical policy first: strategy, pruned directories, and metafiles all
  // come from one classifier. Preserve the historical markdown+multimodal
  // image carve-out by evaluating images through the canonical auto policy.
  if (isSyncable(path, { strategy })) return true;
  return strategy === 'markdown'
    && multimodalOn
    && isImageFilePathFromSync(path)
    && isSyncable(path, { strategy: 'auto' });
}

/**
 * Enumerate syncable regular files from one immutable commit tree.
 * Unlike `collectSyncableFiles`, this never consults the index, worktree,
 * untracked files, attributes, or smudge filters.
 */
export function collectSyncableGitBlobs(
  repoPath: string,
  commit: string,
  opts: CollectOpts = {},
): GitCommitBlob[] {
  const snapshot = openGitCommitSnapshot(repoPath, commit);
  return filterSyncableGitBlobs(snapshot.blobs, opts);
}

/** Apply the normal import strategy to an already-enumerated commit tree. */
export function filterSyncableGitBlobs(
  blobs: readonly GitCommitBlob[],
  opts: CollectOpts = {},
): GitCommitBlob[] {
  const strategy = opts.strategy ?? 'markdown';
  const multimodalOn = process.env.GBRAIN_EMBEDDING_MULTIMODAL === 'true';
  return blobs.filter(blob => isCollectibleForWalker(blob.path, strategy, multimodalOn));
}

/**
 * Git-aware fast path for `collectSyncableFiles`. Returns the strategy-filtered
 * list of syncable files when `dir` is inside a git work tree (paths absolute,
 * sorted), or `null` when `dir` is not a git repo / git is unavailable — in
 * which case the caller falls back to the recursive FS walk.
 *
 * Honors `.gitignore` (the whole point): `git ls-files --cached --others
 * --exclude-standard` lists tracked + untracked-not-ignored files, so vendored
 * / build / generated trees never reach the importer. `-z` (NUL-delimited)
 * survives paths with spaces/newlines. Each path is lstat-checked to preserve
 * the walker's no-symlink policy and to drop submodule gitlinks (which surface
 * as a single non-regular entry).
 */
function gitListSyncableFiles(
  dir: string,
  strategy: SyncStrategy,
  multimodalOn: boolean,
): string[] | null {
  let stdout: string;
  try {
    stdout = execFileSync(
      'git',
      [
        '--no-replace-objects',
        '-c', 'core.fsmonitor=false',
        '-C', dir,
        'ls-files', '--cached', '--others', '--exclude-standard', '-z',
      ],
      {
        encoding: 'utf8',
        maxBuffer: 512 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: cleanInheritedGitEnvironment(process.env, {
          GIT_NO_REPLACE_OBJECTS: '1',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
        }),
      },
    );
  } catch {
    return null; // not a git work tree, or git not on PATH → FS-walk fallback
  }
  const files: string[] = [];
  for (const rel of stdout.split('\0')) {
    if (!rel) continue;
    if (!isCollectibleForWalker(rel, strategy, multimodalOn)) continue;
    const full = join(dir, rel);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue; // ls-files raced a deletion, or unreadable
    }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    files.push(full);
  }
  return files.sort();
}

/**
 * v0.31.2 (codex C4 + C5 + C8): unified walker with five hardenings:
 *
 * 1. `lstatSync` + explicit `isSymbolicLink()` skip — never follow symlinks.
 *    Replaces the old `collectMarkdownFiles` lstat path AND the old
 *    `walkSyncableFiles` `statSync` path (the latter was the cost-preview
 *    walker, weaker than the import walker for no good reason).
 * 2. Inode-set cycle detection keyed on `${st_dev}:${st_ino}` — defense in
 *    depth for non-symlink cycles (bind mounts, ZFS snapshots).
 * 3. `MAX_WALK_DEPTH` bailout — last-line backstop if both layers above miss.
 * 4. Strategy-aware filter via `isCollectibleForWalker` — single helper that
 *    surfaces the markdown+multimodal carve-out at one site instead of
 *    leaking it across two filter paths.
 * 5. `.sort()` output — `runImport`'s checkpoint-resume at line 68–74 is
 *    index-based against a sorted list. Unstable order skips the wrong
 *    files on resume.
 */
export function collectSyncableFiles(dir: string, opts: CollectOpts = {}): string[] {
  const strategy: SyncStrategy = opts.strategy ?? 'markdown';
  const multimodalOn = process.env.GBRAIN_EMBEDDING_MULTIMODAL === 'true';

  // v0.42.x (#1159 --respect-gitignore / #1483 .gbrainignore): when `dir` is a
  // git work tree, enumerate via `git ls-files` so the walk honors
  // `.gitignore`. Pre-fix the recursive FS walk below descended into every
  // git-ignored tree — `vendor/` (PHP Composer), `storage/`, `public/build/`,
  // etc. — so a Laravel/PHP repo's `--strategy code` sync tried to import ~50k
  // dependency/build files (and bloated DB + embedding cost on any repo with
  // vendored data/fixtures). `--cached --others --exclude-standard` = tracked
  // PLUS untracked-not-ignored, so uncommitted source is still indexed. Non-git
  // dirs (or git unavailable) fall through to the FS walk below.
  const gitFiles = gitListSyncableFiles(dir, strategy, multimodalOn);
  if (gitFiles) return gitFiles;

  const maxDepth = resolveMaxWalkDepth();
  const visitedInodes = new Map<string, true>();
  const files: string[] = [];

  function walk(d: string, depth: number): void {
    if (depth >= maxDepth) {
      console.warn(`[gbrain] walker depth limit reached at ${d}; skipping`);
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      // Descent-time prune through the canonical gate (single source of truth
      // in core/sync.ts) instead of a hand-maintained inline list that drifted
      // from it. Skips hidden dirs (`.git`, `.raw`, etc.), `node_modules`,
      // `vendor`, `dist`, `build`, `venv` (#2020), `ops`, and git submodules.
      if (!pruneDir(entry, d)) continue;

      const full = join(d, entry);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        console.warn(`[gbrain import] Skipping unreadable path: ${full}`);
        continue;
      }

      if (stat.isSymbolicLink()) {
        console.warn(`[gbrain import] Skipping symlink: ${full}`);
        continue;
      }

      if (stat.isDirectory()) {
        const inodeKey = `${stat.dev}:${stat.ino}`;
        if (visitedInodes.has(inodeKey)) {
          console.warn(`[gbrain] walker cycle detected at ${full}; skipping`);
          continue;
        }
        visitedInodes.set(inodeKey, true);
        walk(full, depth + 1);
      } else if (stat.isFile()) {
        if (!isCollectibleForWalker(entry, strategy, multimodalOn)) continue;
        files.push(full);
      }
    }
  }

  walk(dir, 0);
  return files.sort();
}

/**
 * @deprecated v0.31.2: kept as a thin wrapper so legacy callers keep
 * compiling. Prefer `collectSyncableFiles(dir, { strategy: 'markdown' })`.
 */
export function collectMarkdownFiles(dir: string): string[] {
  return collectSyncableFiles(dir, { strategy: 'markdown' });
}
