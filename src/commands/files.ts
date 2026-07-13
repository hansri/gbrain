import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from 'fs';
import { join, relative, extname, basename, dirname, isAbsolute, resolve, sep } from 'path';
import { randomUUID } from 'crypto';
import { dlopen, FFIType, ptr } from 'bun:ffi';
import type { BrainEngine } from '../core/engine.ts';
import { sqlQueryForEngine } from '../core/sql-query.ts';
import {
  humanSize,
  parseRedirect,
  parseRedirectContent,
  parseRedirectYaml,
  parseRedirectYamlContent,
  parseMarkerContent,
  sourceQualifiedStoragePath,
  validateLegacyRedirect,
  validateRedirectYamlForSource,
  verifyRedirectBytes,
  type MarkerInfo,
  type ValidatedRedirect,
} from '../core/file-resolver.ts';
import {
  ensureStoredObjectExact,
  publishStoredFile,
  sha256Hex,
} from '../core/file-storage-publish.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import { resolveSourceId } from '../core/source-resolver.ts';

/** Size threshold: files >= 100 MB use TUS resumable upload */
const SIZE_THRESHOLD = 100 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.heic': 'image/heic',
  '.tiff': 'image/tiff', '.tif': 'image/tiff', '.dng': 'image/x-adobe-dng',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function getMimeType(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || null;
}

export async function runFiles(engine: BrainEngine, args: string[]) {
  const subcommand = args[0];
  const parsedSource = takeOption(args.slice(1), '--source');
  const commandArgs = parsedSource.rest;
  const sourceAware = new Set([
    'list', 'mirror', 'upload', 'upload-raw', 'signed-url', 'sync', 'verify',
    'unmirror', 'redirect', 'restore', 'clean',
  ]).has(subcommand ?? '');
  const sourceId = sourceAware
    ? await resolveSourceId(engine, parsedSource.value)
    : undefined;

  switch (subcommand) {
    case 'list':
      await listFiles(engine, sourceId!, commandArgs[0]);
      break;
    case 'upload':
      await uploadFile(engine, sourceId!, commandArgs);
      break;
    case 'sync':
      await syncFiles(engine, sourceId!, commandArgs[0]);
      break;
    case 'verify':
      await verifyFiles(engine, sourceId!);
      break;
    case 'mirror':
      await mirrorFiles(sourceId!, commandArgs);
      break;
    case 'unmirror':
      await unmirrorFiles(sourceId!, commandArgs);
      break;
    case 'redirect':
      await redirectFiles(sourceId!, commandArgs);
      break;
    case 'restore':
      await restoreFiles(sourceId!, commandArgs);
      break;
    case 'clean':
      await cleanFiles(sourceId!, commandArgs);
      break;
    case 'upload-raw':
      await uploadRaw(engine, sourceId!, commandArgs);
      break;
    case 'signed-url':
      await signedUrl(engine, sourceId!, commandArgs);
      break;
    case 'status':
      await filesStatus(commandArgs);
      break;
    default:
      console.error(`Usage: gbrain files <command> [args]`);
      console.error(`  list [slug]               List files for a page (or all)`);
      console.error(`  upload <file> --page <slug>  Upload file linked to page`);
      console.error(`  upload-raw <file> --page <slug> [--type <type>]  Smart upload with .redirect.yaml pointer`);
      console.error(`  signed-url <path>         Generate signed URL for stored file`);
      console.error(`  sync <dir>                Upload directory to storage`);
      console.error(`  verify                    Verify all uploads match local`);
      console.error(`  mirror <dir> [--dry-run]  Mirror files to cloud storage`);
      console.error(`  unmirror <dir>            Remove mirror marker (files stay in storage)`);
      console.error(`  redirect <dir> [--dry-run]  Replace files with .redirect.yaml pointers`);
      console.error(`  restore <dir>             Download from storage, recreate local files`);
      console.error(`  clean <dir> [--yes]       Delete redirect pointers (irreversible)`);
      console.error(`  status                    Show migration status of directories`);
      console.error(`  --source <id>             Select the exact source for source-aware commands`);
      process.exit(1);
  }
}

/** Extract one value-bearing option without letting its value become positional input. */
function takeOption(args: string[], name: string): { value: string | undefined; rest: string[] } {
  let value: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === name) {
      const next = args[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error(`${name} requires a value`);
      }
      value = next;
      i++;
      continue;
    }
    if (arg.startsWith(`${name}=`)) {
      const next = arg.slice(name.length + 1);
      if (!next) throw new Error(`${name} requires a value`);
      value = next;
      continue;
    }
    rest.push(arg);
  }
  return { value, rest };
}

/** Return the first positional argument, skipping values owned by named flags. */
function firstPositional(args: string[], valueFlags: ReadonlySet<string>): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (valueFlags.has(arg)) {
      i++;
      continue;
    }
    if (!arg.startsWith('--')) return arg;
  }
  return undefined;
}

export type RedirectDurabilityStep =
  | 'temp_fsynced'
  | 'pointer_renamed'
  | 'pointer_parent_fsynced'
  | 'original_quarantined'
  | 'quarantine_verified'
  | 'stale_pointer_retired'
  | 'original_unlinked'
  | 'unlink_parent_fsynced';

type RedirectDurabilityTrace = (step: RedirectDurabilityStep) => void;

export type RestoreRetirementStep =
  | 'restore_pointer_quarantined'
  | 'restore_destination_verified'
  | 'restore_pointer_retired'
  | 'restore_destination_reverified'
  | 'restore_pointer_reinstated';

type RestoreRetirementTrace = (step: RestoreRetirementStep) => void;

interface RedirectOriginalIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  hash: string;
}

export interface RedirectOriginalSnapshot {
  content: Buffer;
  identity: RedirectOriginalIdentity;
}

interface RedirectOriginalSnapshotWithLinks {
  snapshot: RedirectOriginalSnapshot;
  linkCount: bigint;
}

function sameRedirectOriginalIdentity(
  left: RedirectOriginalIdentity,
  right: RedirectOriginalIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.hash === right.hash;
}

/**
 * Compare content revision identity after an atomic rename. POSIX filesystems
 * may advance ctime when a directory entry is renamed even though the inode's
 * bytes are unchanged, so ctime is intentionally excluded at this boundary.
 * The no-follow snapshot itself still compares ctime before/after its read.
 */
function sameRedirectOriginalRevision(
  left: RedirectOriginalIdentity,
  right: RedirectOriginalIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.hash === right.hash;
}

function sameRedirectSnapshot(
  left: RedirectOriginalSnapshot,
  right: RedirectOriginalSnapshot,
): boolean {
  return sameRedirectOriginalRevision(left.identity, right.identity)
    && left.content.equals(right.content);
}

interface StableDirectoryHandle {
  path: string;
  fd: number;
  dev: bigint;
  ino: bigint;
}

export interface StableRootReadHooks {
  /** @internal Deterministic race-test hook; production callers omit it. */
  beforeRootOpen?: () => void;
  /** @internal Deterministic race-test hook; production callers omit it. */
  beforeLeafOpen?: () => void;
}

type NativeOpenAt = (
  dirFd: number,
  path: ReturnType<typeof ptr>,
  flags: number,
  mode: number,
) => number;

let nativeOpenAt: NativeOpenAt | null = null;
const nativeOpenAtLibraries: Array<{ close(): void }> = [];

function loadNativeOpenAt(): NativeOpenAt {
  if (nativeOpenAt) return nativeOpenAt;
  const muslArch = process.arch === 'arm64'
    ? 'aarch64'
    : process.arch === 'x64'
      ? 'x86_64'
      : process.arch;
  const candidates = process.platform === 'darwin'
    ? ['/usr/lib/libSystem.B.dylib']
    : [
        'libc.so.6',
        `/lib/libc.musl-${muslArch}.so.1`,
        `/lib/ld-musl-${muslArch}.so.1`,
      ];
  let lastError: unknown;
  for (const libraryPath of candidates) {
    try {
      const library = dlopen(libraryPath, {
        openat: {
          args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.u32],
          returns: FFIType.i32,
        },
      });
      const linked = library.symbols.openat as NativeOpenAt;
      nativeOpenAtLibraries.push(library);
      nativeOpenAt = linked;
      return linked;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error('This platform cannot provide the required POSIX openat boundary', {
    cause: lastError,
  });
}

/** Open one slash-free child relative to a held directory descriptor. */
function openAtNoFollow(parentFd: number, entry: string, flags: number): number {
  if (!entry || entry.includes('/') || entry.includes('\\') || entry.includes('\0')) {
    throw new Error('Invalid stable-root path segment');
  }
  const encoded = Buffer.from(`${entry}\0`);
  const fd = loadNativeOpenAt()(parentFd, ptr(encoded), flags, 0);
  if (!Number.isInteger(fd) || fd < 0) {
    throw new Error(`Stable-root openat refused path segment: ${entry}`);
  }
  return fd;
}

function openStableDirectory(
  path: string,
  label: string,
  parent?: StableDirectoryHandle,
  entry?: string,
): StableDirectoryHandle {
  const noFollow = fsConstants.O_NOFOLLOW;
  const directory = fsConstants.O_DIRECTORY;
  if (typeof noFollow !== 'number' || typeof directory !== 'number') {
    throw new Error('This platform cannot perform a no-follow directory traversal');
  }

  const before = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(`${label} uses a symlink or non-directory ancestor: ${path}`);
  }
  const fd = parent && entry
    ? openAtNoFollow(parent.fd, entry, fsConstants.O_RDONLY | noFollow | directory)
    : openSync(path, fsConstants.O_RDONLY | noFollow | directory);
  try {
    const opened = fstatSync(fd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (
      !opened.isDirectory()
      || named.isSymbolicLink()
      || !named.isDirectory()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || named.dev !== opened.dev
      || named.ino !== opened.ino
    ) {
      throw new Error(`${label} ancestor changed while it was being opened: ${path}`);
    }
    return { path, fd, dev: opened.dev, ino: opened.ino };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/**
 * Open an absolute directory without following any symlink in its ancestry.
 *
 * `open(path, O_NOFOLLOW)` protects only the final component. Starting from a
 * held `/` descriptor and resolving every segment with `openat` extends that
 * guarantee to the complete root path. Keep every descriptor alive until the
 * leaf read finishes so a concurrent rename cannot redirect later segments.
 */
function openStableAbsoluteDirectoryChain(
  absolutePath: string,
  label: string,
): StableDirectoryHandle[] {
  if (process.platform === 'win32' || !isAbsolute(absolutePath)) {
    throw new Error('This platform cannot perform a POSIX stable-root traversal');
  }

  const handles: StableDirectoryHandle[] = [];
  let current: string = sep;
  try {
    handles.push(openStableDirectory(current, label));
    const segments = absolutePath.split(sep).filter(Boolean);
    for (const segment of segments) {
      current = join(current, segment);
      handles.push(openStableDirectory(
        current,
        label,
        handles[handles.length - 1],
        segment,
      ));
    }
    return handles;
  } catch (error) {
    for (const handle of handles.reverse()) closeSync(handle.fd);
    throw error;
  }
}

function assertStableDirectory(handle: StableDirectoryHandle, label: string): void {
  let opened: ReturnType<typeof fstatSync>;
  let named: ReturnType<typeof lstatSync>;
  try {
    opened = fstatSync(handle.fd, { bigint: true });
    named = lstatSync(handle.path, { bigint: true });
  } catch (error) {
    throw new Error(`${label} ancestor moved while the file was being read: ${handle.path}`, {
      cause: error,
    });
  }
  if (
    !opened.isDirectory()
    || named.isSymbolicLink()
    || !named.isDirectory()
    || opened.dev !== handle.dev
    || opened.ino !== handle.ino
    || named.dev !== handle.dev
    || named.ino !== handle.ino
  ) {
    throw new Error(`${label} ancestor changed while the file was being read: ${handle.path}`);
  }
}

function sameEntryRevision(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.nlink === right.nlink;
}

/**
 * Read a relative file beneath one stable root without trusting pathname
 * validation performed earlier. Every parent is opened with O_NOFOLLOW and
 * held through the leaf read; the leaf must match the revision captured before
 * open, and the complete directory chain is revalidated before and after I/O.
 * A parent rename/symlink swap therefore produces no returned bytes.
 */
function readStableRootSnapshotWithLinks(
  rootPath: string,
  relativePath: string,
  allowedLinkCounts: ReadonlySet<bigint>,
  linkError: string,
  hooks: StableRootReadHooks = {},
): RedirectOriginalSnapshotWithLinks {
  const root = resolve(rootPath);
  const normalized = normalizeRelativePath(relativePath, 'stable-root file path');
  const segments = normalized.split('/');
  const leafPath = join(root, ...segments);
  const handles: StableDirectoryHandle[] = [];
  let leafFd: number | null = null;

  try {
    hooks.beforeRootOpen?.();
    handles.push(...openStableAbsoluteDirectoryChain(root, 'Stable-root read'));
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      current = join(current, segment);
      handles.push(openStableDirectory(
        current,
        'Stable-root read',
        handles[handles.length - 1],
        segment,
      ));
    }
    for (const handle of handles) assertStableDirectory(handle, 'Stable-root read');

    const before = lstatSync(leafPath, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() || !allowedLinkCounts.has(before.nlink)) {
      throw new Error(`${linkError}: ${leafPath}`);
    }
    // lstat(leaf) itself traverses parents; prove they still name the held
    // directories before allowing the testable open boundary to proceed.
    for (const handle of handles) assertStableDirectory(handle, 'Stable-root read');

    hooks.beforeLeafOpen?.();

    const noFollow = fsConstants.O_NOFOLLOW;
    if (typeof noFollow !== 'number') {
      throw new Error('This platform cannot perform a no-follow file read');
    }
    leafFd = openAtNoFollow(
      handles[handles.length - 1].fd,
      segments[segments.length - 1],
      fsConstants.O_RDONLY | noFollow,
    );
    const opened = fstatSync(leafFd, { bigint: true });
    if (
      !opened.isFile()
      || !allowedLinkCounts.has(opened.nlink)
      || !sameEntryRevision(before, opened)
    ) {
      throw new Error(`Local original or an ancestor changed before it was opened; preserving it: ${leafPath}`);
    }
    for (const handle of handles) assertStableDirectory(handle, 'Stable-root read');

    const content = readFileSync(leafFd);
    const after = fstatSync(leafFd, { bigint: true });
    const namedAfter = lstatSync(leafPath, { bigint: true });
    const beforeIdentity: RedirectOriginalIdentity = {
      dev: opened.dev,
      ino: opened.ino,
      size: opened.size,
      mtimeNs: opened.mtimeNs,
      ctimeNs: opened.ctimeNs,
      hash: sha256Hex(content),
    };
    const afterIdentity: RedirectOriginalIdentity = {
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeNs: after.mtimeNs,
      ctimeNs: after.ctimeNs,
      hash: beforeIdentity.hash,
    };
    if (
      after.nlink !== opened.nlink
      || !allowedLinkCounts.has(after.nlink)
      || !sameRedirectOriginalIdentity(beforeIdentity, afterIdentity)
      || namedAfter.isSymbolicLink()
      || !sameEntryRevision(namedAfter, after)
    ) {
      throw new Error(`Local original changed while it was being read; preserving it: ${leafPath}`);
    }
    for (const handle of handles) assertStableDirectory(handle, 'Stable-root read');
    return {
      snapshot: { content, identity: afterIdentity },
      linkCount: after.nlink,
    };
  } finally {
    if (leafFd !== null) closeSync(leafFd);
    for (const handle of handles.reverse()) closeSync(handle.fd);
  }
}

function readRedirectOriginalSnapshotWithLinks(
  path: string,
  allowedLinkCounts: ReadonlySet<bigint>,
  linkError: string,
): RedirectOriginalSnapshotWithLinks {
  const absolutePath = resolve(path);
  const root = realpathSync.native(dirname(absolutePath));
  return readStableRootSnapshotWithLinks(
    root,
    basename(absolutePath),
    allowedLinkCounts,
    linkError,
  );
}

/**
 * Read one regular-file revision through a no-follow descriptor and bind its
 * bytes to stable filesystem identity. Metadata is checked on both sides of
 * the read so a concurrent writer cannot silently produce a mixed snapshot.
 */
export function readRedirectOriginalSnapshot(path: string): RedirectOriginalSnapshot {
  return readRedirectOriginalSnapshotWithLinks(
    path,
    new Set([1n]),
    'Redirect original is not a single-link regular file',
  ).snapshot;
}

/** Stable-root variant used by confined upload/sync/mirror flows. */
export function readRedirectOriginalSnapshotWithinRoot(
  root: string,
  relativePath: string,
  hooks: StableRootReadHooks = {},
): RedirectOriginalSnapshot {
  return readStableRootSnapshotWithLinks(
    root,
    relativePath,
    new Set([1n]),
    'Upload source is not a single-link regular file',
    hooks,
  ).snapshot;
}

/**
 * Recovery alone may observe the two names intentionally created by the
 * link-then-unlink no-clobber protocol. Callers must still prove that both
 * names resolve to the same expected inode before retiring either one.
 */
function readRedirectRecoverySnapshot(path: string): RedirectOriginalSnapshotWithLinks {
  return readRedirectOriginalSnapshotWithLinks(
    path,
    new Set([1n, 2n]),
    'Redirect recovery artifact has an unsafe link count',
  );
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null
    && (error as NodeJS.ErrnoException).code === code;
}

function redirectQuarantinePath(path: string, kind: 'original' | 'pointer'): string {
  return join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.redirect-${kind}-quarantine`,
  );
}

/**
 * Restore a same-directory quarantine without ever overwriting a newer path.
 * `link(2)` is the no-clobber primitive: it atomically fails with EEXIST when
 * a writer has already recreated the destination. Only after the durable link
 * exists do we remove the private quarantine name.
 */
function restoreRedirectQuarantineNoClobber(
  quarantinePath: string,
  destinationPath: string,
): boolean {
  try {
    const stat = lstatSync(quarantinePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    linkSync(quarantinePath, destinationPath);
    fsyncDirectory(dirname(destinationPath));
    unlinkSync(quarantinePath);
    fsyncDirectory(dirname(destinationPath));
    return true;
  } catch (error) {
    if (isErrnoCode(error, 'EEXIST') || isErrnoCode(error, 'ENOENT')) return false;
    throw error;
  }
}

/**
 * Retire only the pointer bytes this redirect attempt wrote. The pointer is
 * first atomically moved to an unguessable same-directory quarantine; a
 * concurrently replaced pointer is restored with no-clobber semantics rather
 * than deleted. This keeps race recovery from turning into a second TOCTOU.
 */
function retireOwnedRedirectPointerWithLinkCount(
  pointerPath: string,
  expected: RedirectOriginalSnapshot,
  expectedLinkCount: bigint,
  trace?: RedirectDurabilityTrace,
): boolean {
  const quarantinePath = redirectQuarantinePath(pointerPath, 'pointer');
  try {
    renameSync(pointerPath, quarantinePath);
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return false;
    throw error;
  }

  let captured: RedirectOriginalSnapshot;
  try {
    captured = readRedirectOriginalSnapshotWithLinks(
      quarantinePath,
      new Set([expectedLinkCount]),
      'Redirect pointer link count changed during retirement',
    ).snapshot;
  } catch (error) {
    try { restoreRedirectQuarantineNoClobber(quarantinePath, pointerPath); }
    catch { /* preserve the private quarantine as recovery evidence */ }
    throw error;
  }
  if (!sameRedirectOriginalRevision(expected.identity, captured.identity)
    || !captured.content.equals(expected.content)) {
    // A newer inode/revision won the race — even identical-looking bytes are
    // not ownership proof. Preserve it; never delete another writer's
    // recovery metadata.
    restoreRedirectQuarantineNoClobber(quarantinePath, pointerPath);
    return false;
  }

  unlinkSync(quarantinePath);
  fsyncDirectory(dirname(pointerPath));
  trace?.('stale_pointer_retired');
  return true;
}

export function retireOwnedRedirectPointer(
  pointerPath: string,
  expected: RedirectOriginalSnapshot,
  trace?: RedirectDurabilityTrace,
): boolean {
  return retireOwnedRedirectPointerWithLinkCount(pointerPath, expected, 1n, trace);
}

/** Recreate captured pointer bytes without overwriting a concurrently-created pointer. */
function restoreRedirectPointerContentNoClobber(
  pointerPath: string,
  content: Buffer,
): boolean {
  const tmpPath = join(
    dirname(pointerPath),
    `.${basename(pointerPath)}.${process.pid}.${randomUUID()}.pointer-restore-tmp`,
  );
  let fd: number | null = null;
  try {
    fd = openSync(
      tmpPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    try {
      linkSync(tmpPath, pointerPath);
    } catch (error) {
      if (isErrnoCode(error, 'EEXIST')) return false;
      throw error;
    }
    fsyncDirectory(dirname(pointerPath));
    unlinkSync(tmpPath);
    fsyncDirectory(dirname(pointerPath));
    return true;
  } finally {
    if (fd !== null) closeSync(fd);
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
  }
}

/**
 * Retire one exact redirect only while the exact promoted destination remains
 * visible. Pointer quarantine, destination comparison, retirement, and a
 * post-retirement comparison form one fail-closed protocol:
 *
 * - a replacement before retirement restores the quarantined pointer;
 * - a replacement in the narrow comparison-to-unlink window reinstates the
 *   captured pointer without clobbering any newer pointer;
 * - the replacement file is never removed or overwritten.
 */
export function retireRedirectAfterRestoredPromotion(
  pointerPath: string,
  expectedPointer: RedirectOriginalSnapshot,
  destinationPath: string,
  expectedDestination: RedirectOriginalSnapshot,
  trace?: RestoreRetirementTrace,
): boolean {
  const quarantinePath = redirectQuarantinePath(pointerPath, 'pointer');
  let capturedPointer: RedirectOriginalSnapshot | null = null;
  try {
    renameSync(pointerPath, quarantinePath);
    fsyncDirectory(dirname(pointerPath));
    trace?.('restore_pointer_quarantined');
    capturedPointer = readRedirectOriginalSnapshot(quarantinePath);
    if (!sameRedirectSnapshot(expectedPointer, capturedPointer)) {
      restoreRedirectQuarantineNoClobber(quarantinePath, pointerPath);
      return false;
    }

    const beforeRetirement = readRedirectOriginalSnapshot(destinationPath);
    if (!sameRedirectSnapshot(expectedDestination, beforeRetirement)) {
      restoreRedirectQuarantineNoClobber(quarantinePath, pointerPath);
      return false;
    }
    trace?.('restore_destination_verified');

    // A new pointer created after our atomic quarantine is newer recovery
    // metadata. Never delete the captured pointer and report success while the
    // newer pointer remains authoritative over the restored destination.
    if (existsSync(pointerPath)) return false;

    unlinkSync(quarantinePath);
    fsyncDirectory(dirname(pointerPath));
    trace?.('restore_pointer_retired');

    const afterRetirement = readRedirectOriginalSnapshot(destinationPath);
    if (existsSync(pointerPath)) return false;
    if (!sameRedirectSnapshot(expectedDestination, afterRetirement)) {
      restoreRedirectPointerContentNoClobber(pointerPath, capturedPointer.content);
      trace?.('restore_pointer_reinstated');
      return false;
    }
    trace?.('restore_destination_reverified');
    return true;
  } catch (error) {
    if (existsSync(quarantinePath)) {
      try {
        restoreRedirectQuarantineNoClobber(quarantinePath, pointerPath);
        trace?.('restore_pointer_reinstated');
      } catch { /* preserve quarantine as recovery evidence */ }
    } else if (capturedPointer && !existsSync(pointerPath)) {
      try {
        restoreRedirectPointerContentNoClobber(pointerPath, capturedPointer.content);
        trace?.('restore_pointer_reinstated');
      } catch { /* destination remains visible; caller reports failure */ }
    }
    throw error;
  }
}

/**
 * Crash-durably replace a redirect breadcrumb before any original is removed.
 * The exclusive temp is file-fsynced, atomically renamed, then its parent is
 * fsynced so a successful return is a durable pointer boundary.
 */
export function writeRedirectPointerDurable(
  pointerPath: string,
  content: string,
  trace?: RedirectDurabilityTrace,
): void {
  const tmpPath = join(
    dirname(pointerPath),
    `.${basename(pointerPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = openSync(
      tmpPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    writeFileSync(fd, content);
    fsyncSync(fd);
    trace?.('temp_fsynced');
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, pointerPath);
    trace?.('pointer_renamed');
    fsyncDirectory(dirname(pointerPath));
    trace?.('pointer_parent_fsynced');
  } finally {
    if (fd !== null) closeSync(fd);
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
  }
}

/**
 * Replace a verified local original only after its redirect is durable.
 * The second directory fsync makes the unlink durable; if it fails, the
 * already-durable pointer remains authoritative and recovery-safe.
 */
function replaceLocalWithRedirectDurableGuarded(
  originalPath: string,
  pointerPath: string,
  pointerContent: string,
  expectedIdentity: RedirectOriginalIdentity,
  trace?: RedirectDurabilityTrace,
): void {
  writeRedirectPointerDurable(pointerPath, pointerContent, trace);
  const ownedPointer = readRedirectOriginalSnapshot(pointerPath);
  const quarantinePath = redirectQuarantinePath(originalPath, 'original');

  // Atomically move whichever revision currently owns the public path into a
  // private name. Writers can now recreate originalPath without any chance of
  // our cleanup unlinking their new inode by pathname.
  renameSync(originalPath, quarantinePath);
  trace?.('original_quarantined');

  try {
    const current = readRedirectOriginalSnapshot(quarantinePath).identity;
    if (!sameRedirectOriginalRevision(expectedIdentity, current)) {
      // The path changed before our atomic rename. Our durable pointer now
      // describes the older uploaded revision, so retire only that pointer and
      // restore the captured newer file without clobbering another writer.
      retireOwnedRedirectPointer(pointerPath, ownedPointer, trace);
      restoreRedirectQuarantineNoClobber(quarantinePath, originalPath);
      throw new Error(
        `Local original changed during redirect; preserving the newer file: ${originalPath}`,
      );
    }

    // Deliberate test/observability boundary: the identity has been checked,
    // but deletion targets the private quarantine name, never originalPath.
    trace?.('quarantine_verified');

    if (existsSync(originalPath)) {
      // A newer local revision arrived after the final identity comparison.
      // Remove our stale pointer first so resolveFile cannot hide that revision.
      retireOwnedRedirectPointer(pointerPath, ownedPointer, trace);
      unlinkSync(quarantinePath);
      trace?.('original_unlinked');
      fsyncDirectory(dirname(originalPath));
      trace?.('unlink_parent_fsynced');
      throw new Error(
        `Local original changed during redirect; preserving the newer file: ${originalPath}`,
      );
    }

    unlinkSync(quarantinePath);
    trace?.('original_unlinked');
    fsyncDirectory(dirname(originalPath));
    trace?.('unlink_parent_fsynced');

    // Catch a cooperative writer that landed while the unlink directory fsync
    // completed. The pointer is stale relative to that new local revision.
    if (existsSync(originalPath)) {
      retireOwnedRedirectPointer(pointerPath, ownedPointer, trace);
      throw new Error(
        `Local original changed during redirect; preserving the newer file: ${originalPath}`,
      );
    }
  } catch (error) {
    // On any unexpected failure after the atomic quarantine, prefer a visible
    // local file over an authoritative stale pointer. Never overwrite a path a
    // concurrent writer already recreated; the unique quarantine remains as
    // explicit recovery evidence in that rare conflict.
    if (existsSync(quarantinePath)) {
      try { retireOwnedRedirectPointer(pointerPath, ownedPointer, trace); } catch { /* preserve both artifacts */ }
      try { restoreRedirectQuarantineNoClobber(quarantinePath, originalPath); } catch { /* preserve quarantine */ }
    }
    throw error;
  }
}

export function replaceLocalWithRedirectDurable(
  originalPath: string,
  pointerPath: string,
  pointerContent: string,
  trace?: RedirectDurabilityTrace,
): void {
  const original = readRedirectOriginalSnapshot(originalPath);
  replaceLocalWithRedirectDurableGuarded(
    originalPath,
    pointerPath,
    pointerContent,
    original.identity,
    trace,
  );
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, fsConstants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

interface OwnedMirrorMarker {
  root: string;
  path: string;
  snapshot: RedirectOriginalSnapshot;
  marker: MarkerInfo;
  fileCount: number;
  paths: Set<string> | null;
}

function canonicalDirectory(path: string): string {
  const canonical = realpathSync(resolve(path));
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Expected a real directory: ${path}`);
  }
  return canonical;
}

/** Read and source-bind the one marker that authorizes mirror lifecycle writes. */
function readOwnedMirrorMarker(dir: string, sourceId: string): OwnedMirrorMarker {
  const root = canonicalDirectory(dir);
  const path = join(root, '.supabase');
  let snapshot: RedirectOriginalSnapshot;
  try {
    snapshot = readRedirectOriginalSnapshot(path);
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) {
      throw new Error(`Directory must be mirrored first: ${root}`);
    }
    throw new Error(`Invalid .supabase marker for ${root}: ${(error as Error).message}`);
  }
  const marker = parseMarkerContent(snapshot.content.toString('utf8'));
  if (marker.source_id !== sourceId || marker.prefix !== `${sourceId}/`) {
    throw new Error(
      `Mirror marker source mismatch: expected source_id=${sourceId} and prefix=${sourceId}/`,
    );
  }
  const fileCount = Number(marker.file_count);
  if (!Number.isSafeInteger(fileCount) || fileCount < 0) {
    throw new Error('Mirror marker has invalid file_count');
  }
  let paths: Set<string> | null = null;
  let rawPaths: unknown = marker.paths;
  if (rawPaths === undefined && marker.paths_json !== undefined) {
    try { rawPaths = JSON.parse(marker.paths_json); }
    catch { throw new Error('Mirror marker has invalid paths_json ledger'); }
  }
  if (rawPaths !== undefined) {
    if (!Array.isArray(rawPaths) || !rawPaths.every(value => typeof value === 'string')) {
      throw new Error('Mirror marker has invalid paths ledger');
    }
    paths = new Set(rawPaths.map(value => normalizeRelativePath(value, 'mirror marker path')));
    if (paths.size !== rawPaths.length || paths.size !== fileCount) {
      throw new Error('Mirror marker paths ledger does not match file_count');
    }
  }
  return { root, path, snapshot, marker, fileCount, paths };
}

interface MirrorLocatorState {
  logicalPaths: Set<string>;
  pointers: Array<{ path: string; snapshot: RedirectOriginalSnapshot; redirect: ValidatedRedirect }>;
}

function collectMirrorLocatorState(root: string, sourceId: string): MirrorLocatorState {
  const logicalPaths = new Set<string>();
  const pointers: MirrorLocatorState['pointers'] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const full = join(dir, entry);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith('.redirect')) {
        throw new Error(
          `Legacy redirect is not a source-bound live locator; restore it before unmirroring: ${full}`,
        );
      }
      if (entry.endsWith('.redirect.yaml')) {
        const snapshot = readRedirectOriginalSnapshot(full);
        const redirect = validateRedirectYamlForSource(
          parseRedirectYamlContent(snapshot.content.toString('utf8')),
          sourceId,
        );
        const original = full.slice(0, -'.redirect.yaml'.length);
        const logicalPath = containedRelativePath(root, original, 'redirect original');
        const expectedStoragePath = sourceQualifiedStoragePath(sourceId, logicalPath);
        if (redirect.storagePath !== expectedStoragePath) {
          throw new Error(
            `Redirect is not recoverable through this mirror marker: ${full}`,
          );
        }
        logicalPaths.add(logicalPath);
        pointers.push({ path: full, snapshot, redirect });
        continue;
      }
      if (!entry.endsWith('.md')) {
        logicalPaths.add(containedRelativePath(root, full, 'mirror file'));
      }
    }
  };
  walk(root);
  return { logicalPaths, pointers };
}

function normalizeRelativePath(value: string, label: string): string {
  const normalized = value.replace(/\\/g, '/');
  if (!normalized || isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Invalid ${label}`);
  }
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

function containedRelativePath(root: string, candidate: string, label: string): string {
  const rel = relative(root, candidate);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} is outside the mirror root`);
  }
  return normalizeRelativePath(rel, label);
}

function pathFromSafeRelative(root: string, rel: string, label: string): string {
  const normalized = normalizeRelativePath(rel, label);
  const candidate = resolve(root, ...normalized.split('/'));
  const check = relative(root, candidate);
  if (!check || check === '..' || check.startsWith(`..${sep}`) || isAbsolute(check)) {
    throw new Error(`${label} escapes its root`);
  }
  return candidate;
}

function writeJsonDurableAtomic(path: string, value: unknown): void {
  const parent = dirname(path);
  const tmp = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let fd: number | null = null;
  try {
    fd = openSync(
      tmp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600,
    );
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
    fsyncDirectory(parent);
  } finally {
    if (fd !== null) closeSync(fd);
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

const CLEAN_QUARANTINE_PREFIX = '.gbrain-pointer-quarantine';
const CLEAN_JOURNAL_FILE = 'MANIFEST.json';

type CleanJournalState = 'prepared' | 'complete' | 'rolled_back';

interface CleanJournalPointer {
  original_path: string;
  quarantine_path: string;
  pointer_sha256: string;
  storage_path: string;
  expected_sha256: string;
  expected_size?: number;
}

interface CleanJournal {
  schema_version: 1;
  state: CleanJournalState;
  source_id: string;
  prepared_at: string;
  completed_at?: string;
  rolled_back_at?: string;
  pointers: CleanJournalPointer[];
}

interface VerifiedCleanPointer {
  path: string;
  snapshot: RedirectOriginalSnapshot;
  redirect: ValidatedRedirect;
}

function listCleanJournalRoots(root: string): string[] {
  const roots: string[] = [];
  for (const entry of readdirSync(root).sort()) {
    if (!entry.startsWith(CLEAN_QUARANTINE_PREFIX)) continue;
    const candidate = join(root, entry);
    const stat = lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Refusing unsafe clean quarantine path: ${candidate}`);
    }
    if (entry === CLEAN_QUARANTINE_PREFIX) {
      // Compatibility with the short-lived nested layout: the shared ancestor
      // itself is never trusted, but real child run directories can be read for
      // recovery after proving every component is a regular directory.
      for (const child of readdirSync(candidate).sort()) {
        const run = join(candidate, child);
        const childStat = lstatSync(run);
        if (!childStat.isDirectory() || childStat.isSymbolicLink()) {
          throw new Error(`Refusing unsafe clean quarantine run: ${run}`);
        }
        roots.push(run);
      }
    } else {
      roots.push(candidate);
    }
  }
  return roots;
}

function readCleanJournal(runRoot: string): CleanJournal {
  const snapshot = readRedirectOriginalSnapshot(join(runRoot, CLEAN_JOURNAL_FILE));
  let raw: unknown;
  try {
    raw = JSON.parse(snapshot.content.toString('utf8'));
  } catch {
    throw new Error(`Invalid clean recovery journal: ${runRoot}`);
  }
  const journal = raw as Partial<CleanJournal>;
  if (journal.schema_version !== 1 ||
      !['prepared', 'complete', 'rolled_back'].includes(String(journal.state)) ||
      typeof journal.source_id !== 'string' || !Array.isArray(journal.pointers)) {
    throw new Error(`Invalid clean recovery journal schema: ${runRoot}`);
  }
  for (const pointer of journal.pointers) {
    normalizeRelativePath(pointer.original_path, 'journal original_path');
    normalizeRelativePath(pointer.quarantine_path, 'journal quarantine_path');
    if (!/^[a-f0-9]{64}$/.test(pointer.pointer_sha256) ||
        !/^[a-f0-9]{64}$/.test(pointer.expected_sha256) ||
        typeof pointer.storage_path !== 'string') {
      throw new Error(`Invalid clean recovery journal pointer: ${runRoot}`);
    }
  }
  return journal as CleanJournal;
}

function recoverCleanJournalRun(runRoot: string, root: string, sourceId: string): boolean {
  const journal = readCleanJournal(runRoot);
  if (journal.source_id !== sourceId) {
    throw new Error(
      `Clean recovery journal belongs to source ${journal.source_id}, not ${sourceId}: ${runRoot}`,
    );
  }
  if (journal.state !== 'prepared') return false;

  for (const item of journal.pointers) {
    const original = pathFromSafeRelative(root, item.original_path, 'journal original_path');
    const quarantine = pathFromSafeRelative(runRoot, item.quarantine_path, 'journal quarantine_path');
    const originalExists = existsSync(original);
    const quarantineExists = existsSync(quarantine);
    if (!originalExists && !quarantineExists) {
      throw new Error(`Clean recovery lost both pointer copies: ${item.original_path}`);
    }

    let quarantineSnapshot: RedirectOriginalSnapshotWithLinks | null = null;
    if (quarantineExists) {
      quarantineSnapshot = readRedirectRecoverySnapshot(quarantine);
      if (sha256Hex(quarantineSnapshot.snapshot.content) !== item.pointer_sha256) {
        throw new Error(`Clean recovery quarantine changed: ${item.quarantine_path}`);
      }
    }
    if (originalExists) {
      const live = readRedirectRecoverySnapshot(original);
      if (sha256Hex(live.snapshot.content) !== item.pointer_sha256) {
        throw new Error(`Clean recovery found a newer live pointer: ${item.original_path}`);
      }
      if (quarantineSnapshot) {
        const hasRecoveryHardlink = quarantineSnapshot.linkCount === 2n || live.linkCount === 2n;
        if (hasRecoveryHardlink && (
          quarantineSnapshot.linkCount !== 2n ||
          live.linkCount !== 2n ||
          !sameRedirectSnapshot(quarantineSnapshot.snapshot, live.snapshot)
        )) {
          throw new Error(
            `Clean recovery found an unowned hardlink instead of its exact live pointer: ${item.original_path}`,
          );
        }
        if (!hasRecoveryHardlink && (
          quarantineSnapshot.linkCount !== 1n || live.linkCount !== 1n
        )) {
          throw new Error(`Clean recovery found an unsafe pointer link count: ${item.original_path}`);
        }
        if (!retireOwnedRedirectPointerWithLinkCount(
          quarantine,
          quarantineSnapshot.snapshot,
          quarantineSnapshot.linkCount,
        )) {
          throw new Error(`Clean recovery could not retire duplicate quarantine: ${item.quarantine_path}`);
        }
        const remaining = readRedirectOriginalSnapshot(original);
        if (!sameRedirectSnapshot(live.snapshot, remaining)) {
          throw new Error(`Clean recovery live pointer changed during retirement: ${item.original_path}`);
        }
      } else if (live.linkCount !== 1n) {
        throw new Error(`Clean recovery found an unowned hardlink: ${item.original_path}`);
      }
      continue;
    }
    if (!quarantineSnapshot || quarantineSnapshot.linkCount !== 1n ||
        !restoreRedirectQuarantineNoClobber(quarantine, original)) {
      throw new Error(`Clean recovery could not restore pointer: ${item.original_path}`);
    }
    fsyncDirectory(dirname(quarantine));
  }

  writeJsonDurableAtomic(join(runRoot, CLEAN_JOURNAL_FILE), {
    ...journal,
    state: 'rolled_back',
    rolled_back_at: new Date().toISOString(),
  } satisfies CleanJournal);
  return true;
}

function inspectCleanJournals(
  dir: string,
  sourceId: string,
): { root: string; records: Array<{ runRoot: string; journal: CleanJournal }> } {
  const root = canonicalDirectory(dir);
  const journalRoots = listCleanJournalRoots(root);
  const records: Array<{ runRoot: string; journal: CleanJournal }> = [];
  for (const runRoot of journalRoots) {
    const journal = readCleanJournal(runRoot);
    if (journal.source_id !== sourceId) {
      throw new Error(
        `Clean recovery journal belongs to source ${journal.source_id}, not ${sourceId}: ${runRoot}`,
      );
    }
    records.push({ runRoot, journal });
  }
  return { root, records };
}

/** Validate journal ownership/shape without performing recovery (dry-run safe). */
function inspectCleanJournalsReadOnly(dir: string, sourceId: string): void {
  inspectCleanJournals(dir, sourceId);
}

function completedCleanLogicalPaths(dir: string, sourceId: string): Set<string> {
  const paths = new Set<string>();
  for (const { journal } of inspectCleanJournals(dir, sourceId).records) {
    if (journal.state !== 'complete') continue;
    for (const pointer of journal.pointers) {
      const logicalPath = pointer.original_path
        .replace(/\.redirect\.yaml$/, '')
        .replace(/\.redirect$/, '');
      paths.add(normalizeRelativePath(logicalPath, 'clean journal logical path'));
    }
  }
  return paths;
}

/** Recover every pre-commit pointer retirement before a mutating lifecycle action. */
export function recoverInterruptedCleanJournals(dir: string, sourceId: string): number {
  const { root, records } = inspectCleanJournals(dir, sourceId);
  // The complete set was validated before the first recovery mutation. A
  // command routed to the wrong source therefore has zero filesystem effects.
  let recovered = 0;
  for (const { runRoot } of records) {
    if (recoverCleanJournalRun(runRoot, root, sourceId)) recovered++;
  }
  return recovered;
}

function retireVerifiedPointersWithJournal(
  dir: string,
  sourceId: string,
  verified: VerifiedCleanPointer[],
): string {
  const root = canonicalDirectory(dir);
  const runRoot = join(
    root,
    `${CLEAN_QUARANTINE_PREFIX}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`,
  );
  // Direct, exclusive child creation removes the old repo-controlled shared
  // ancestor. Recursive mkdir begins only below this newly-owned directory.
  mkdirSync(runRoot, { mode: 0o700 });
  const runStat = lstatSync(runRoot);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : runStat.uid;
  if (!runStat.isDirectory() || runStat.isSymbolicLink() || runStat.uid !== currentUid ||
      (runStat.mode & 0o077) !== 0 || dirname(realpathSync(runRoot)) !== root) {
    throw new Error(`Refusing unsafe clean quarantine root: ${runRoot}`);
  }

  const journal: CleanJournal = {
    schema_version: 1,
    state: 'prepared',
    source_id: sourceId,
    prepared_at: new Date().toISOString(),
    pointers: verified.map(item => {
      const originalPath = containedRelativePath(root, item.path, 'redirect pointer');
      return {
        original_path: originalPath,
        quarantine_path: originalPath,
        pointer_sha256: sha256Hex(item.snapshot.content),
        storage_path: item.redirect.storagePath,
        expected_sha256: item.redirect.expectedSha256,
        ...(item.redirect.expectedSize === undefined ? {} : { expected_size: item.redirect.expectedSize }),
      };
    }),
  };
  writeJsonDurableAtomic(join(runRoot, CLEAN_JOURNAL_FILE), journal);

  try {
    for (let index = 0; index < verified.length; index++) {
      const item = verified[index];
      const journalItem = journal.pointers[index];
      const quarantine = pathFromSafeRelative(runRoot, journalItem.quarantine_path, 'journal quarantine_path');
      mkdirSync(dirname(quarantine), { recursive: true, mode: 0o700 });
      renameSync(item.path, quarantine);
      const captured = readRedirectOriginalSnapshot(quarantine);
      if (!sameRedirectSnapshot(item.snapshot, captured) || existsSync(item.path)) {
        throw new Error(`Redirect was replaced during clean retirement: ${item.path}`);
      }
      fsyncDirectory(dirname(item.path));
      fsyncDirectory(dirname(quarantine));
    }
    writeJsonDurableAtomic(join(runRoot, CLEAN_JOURNAL_FILE), {
      ...journal,
      state: 'complete',
      completed_at: new Date().toISOString(),
    } satisfies CleanJournal);
    return runRoot;
  } catch (error) {
    try {
      recoverCleanJournalRun(runRoot, root, sourceId);
    } catch (recoveryError) {
      throw new Error(
        `Clean retirement failed and durable recovery needs attention: ${(recoveryError as Error).message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Durably promote already-verified bytes without exposing a partial target.
 *
 * The temporary file lives beside the destination, so rename is atomic on a
 * single filesystem. The file and containing directory are fsynced before the
 * caller is allowed to remove its redirect breadcrumb.
 */
export function promoteRestoredFileAtomic(
  originalPath: string,
  data: Buffer,
): RedirectOriginalSnapshot {
  const parent = dirname(originalPath);
  const tmpPath = join(parent, `.${basename(originalPath)}.${process.pid}.${randomUUID()}.restore.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(
      tmpPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    try {
      // link(2), unlike rename(2), is an atomic no-clobber promotion. If a
      // local writer wins the race, accept it only when its exact bytes match
      // the verified object; never overwrite a divergent local revision.
      linkSync(tmpPath, originalPath);
      fsyncDirectory(parent);
    } catch (error) {
      if (!isErrnoCode(error, 'EEXIST')) throw error;
      const existing = readRedirectOriginalSnapshot(originalPath);
      if (!existing.content.equals(data)) {
        throw new Error(`Refusing to overwrite divergent local file during restore: ${originalPath}`);
      }
    }
    unlinkSync(tmpPath);
    fsyncDirectory(parent);
    const promoted = readRedirectOriginalSnapshot(originalPath);
    if (!promoted.content.equals(data)) {
      throw new Error(`Restored file changed before pointer retirement: ${originalPath}`);
    }
    return promoted;
  } finally {
    if (fd !== null) closeSync(fd);
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
  }
}

async function listFiles(engine: BrainEngine, sourceId: string, slug?: string) {
  const sql = sqlQueryForEngine(engine);
  let rows;
  if (slug) {
    rows = await sql`
      SELECT source_id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash, created_at
      FROM files
      WHERE source_id = ${sourceId} AND page_slug = ${slug}
      ORDER BY filename
      LIMIT 100
    `;
  } else {
    rows = await sql`
      SELECT source_id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash, created_at
      FROM files
      WHERE source_id = ${sourceId}
      ORDER BY page_slug, filename
      LIMIT 100
    `;
  }

  if (rows.length === 0) {
    console.log(slug ? `No files for page: ${slug}` : 'No files stored.');
    return;
  }

  console.log(`${rows.length} file(s):`);
  for (const row of rows) {
    const sizeBytes = row.size_bytes as number | null;
    const size = sizeBytes ? `${Math.round(sizeBytes / 1024)}KB` : '?';
    console.log(`  [${row.source_id}] ${row.page_slug || '(unlinked)'} / ${row.filename}  [${size}, ${row.mime_type || '?'}]`);
  }
}

async function uploadFile(engine: BrainEngine, sourceId: string, args: string[]) {
  const filePath = firstPositional(args, new Set(['--page']));
  const pageSlug = args.find((a, i) => args[i - 1] === '--page') || null;

  if (!filePath || !existsSync(filePath)) {
    console.error('Usage: gbrain files upload <file> --page <slug>');
    process.exit(1);
  }

  const { loadConfig } = await import('../core/config.ts');
  const config = loadConfig();
  if (!config?.storage) {
    throw new Error('No storage backend configured. Refusing to create file metadata without stored bytes.');
  }
  const content = readRedirectOriginalSnapshot(filePath).content;
  const filename = basename(filePath);
  const hash = sha256Hex(content);
  const logicalPath = pageSlug ? `${pageSlug}/${filename}` : `unsorted/${hash.slice(0, 8)}-${filename}`;
  const mimeType = getMimeType(filePath);

  const { createStorage } = await import('../core/storage.ts');
  const storage = await createStorage(config.storage as any);
  const method = content.length >= SIZE_THRESHOLD ? 'TUS resumable' : 'standard';
  console.log(`Uploading ${humanSize(content.byteLength)} via ${method}...`);
  const result = await publishStoredFile({
    engine,
    storage,
    sourceId,
    logicalPath,
    pageSlug,
    filename,
    mimeType,
    data: content,
    metadata: { upload_method: method },
  });

  if (!result.changed && !result.objectUploaded) {
    console.log(`File already uploaded (exact hash/size match): ${result.storagePath}`);
    return;
  }
  console.log(`Uploaded: ${result.storagePath} (${humanSize(result.sizeBytes)})`);
}

/**
 * Smart upload with size routing and .redirect.yaml pointer creation.
 *
 * Size routing:
 *   < 100 MB text/PDF  → stays in git (brain repo), no cloud upload
 *   >= 100 MB OR media  → upload to cloud storage, create .redirect.yaml pointer
 *
 * The .redirect.yaml pointer stays in the brain repo so git tracks what was stored.
 */
async function uploadRaw(engine: BrainEngine, sourceId: string, args: string[]) {
  const filePath = firstPositional(args, new Set(['--page', '--type']));
  const pageSlug = args.find((a, i) => args[i - 1] === '--page') || null;
  const fileType = args.find((a, i) => args[i - 1] === '--type') || null;
  const noPointer = args.includes('--no-pointer');

  if (!filePath || !existsSync(filePath)) {
    console.error('Usage: gbrain files upload-raw <file> --page <slug> [--type <type>] [--no-pointer]');
    process.exit(1);
  }

  // Bind routing + uploaded bytes to one no-follow regular-file snapshot.
  // A path swapped to a symlink after argument parsing must never redirect an
  // upload outside the tree.
  const original = readRedirectOriginalSnapshot(filePath);
  const stat = { size: original.content.byteLength };
  const filename = basename(filePath);
  const mimeType = getMimeType(filePath);
  const isMedia = mimeType?.startsWith('video/') || mimeType?.startsWith('audio/') || mimeType?.startsWith('image/');
  const needsCloud = stat.size >= SIZE_THRESHOLD || isMedia;

  if (!needsCloud) {
    // Small text/PDF files stay in git
    console.log(JSON.stringify({
      success: true,
      storage: 'git',
      path: filePath,
      size: stat.size,
      size_human: humanSize(stat.size),
    }));
    return;
  }

  // Upload to cloud storage
  const { loadConfig } = await import('../core/config.ts');
  const config = loadConfig();
  if (!config?.storage) {
    console.error('No storage backend configured. Run gbrain init with storage settings.');
    console.error('Or use gbrain files upload for manual uploads.');
    process.exit(1);
  }

  const content = original.content;
  const hash = sha256Hex(content);
  const logicalPath = pageSlug ? `${pageSlug}/${filename}` : `unsorted/${hash.slice(0, 8)}-${filename}`;
  const bucket = (config.storage as any).bucket || 'brain-files';

  const method = content.length >= SIZE_THRESHOLD ? 'TUS resumable' : 'standard';
  console.error(`Uploading ${humanSize(stat.size)} via ${method}...`);
  const { createStorage } = await import('../core/storage.ts');
  const storage = await createStorage(config.storage as any);
  const published = await publishStoredFile({
    engine,
    storage,
    sourceId,
    logicalPath,
    pageSlug,
    filename,
    mimeType,
    data: content,
    metadata: { type: fileType, upload_method: method },
  });
  const storagePath = published.storagePath;

  // Create .redirect.yaml pointer in the brain repo
  let pointerPath: string | null = null;
  if (!noPointer && pageSlug) {
    const { stringify } = await import('../core/yaml-lite.ts');
    const pointer = stringify({
      target: `supabase://${bucket}/${storagePath}`,
      bucket,
      storage_path: storagePath,
      size: content.byteLength,
      size_human: humanSize(content.byteLength),
      hash: `sha256:${hash}`,
      mime: mimeType || 'application/octet-stream',
      uploaded: new Date().toISOString(),
      source_id: sourceId,
      ...(fileType ? { type: fileType } : {}),
    });
    // Write pointer next to the original file
    pointerPath = filePath + '.redirect.yaml';
    writeRedirectPointerDurable(pointerPath, pointer);
    console.error(`Pointer written: ${pointerPath}`);
  }

  // Output JSON for scripting
  console.log(JSON.stringify({
    success: true,
    storage: 'supabase',
    storagePath,
    bucket,
    reference: `supabase://${bucket}/${storagePath}`,
    pointerPath,
    size: content.byteLength,
    size_human: humanSize(content.byteLength),
    hash: `sha256:${hash}`,
    upload_method: method,
  }));
}

/** Generate a signed URL for a stored file */
async function signedUrl(engine: BrainEngine, sourceId: string, args: string[]) {
  const storagePath = args.find(a => !a.startsWith('--'));
  if (!storagePath) {
    console.error('Usage: gbrain files signed-url <storage-path>');
    process.exit(1);
  }

  const file = await engine.getFile(sourceId, storagePath);
  if (!file) {
    throw new Error(`File not found in source "${sourceId}": ${storagePath}`);
  }

  const { loadConfig } = await import('../core/config.ts');
  const config = loadConfig();
  if (!config?.storage) {
    console.error('No storage backend configured.');
    process.exit(1);
  }

  const { createStorage } = await import('../core/storage.ts');
  const storage = await createStorage(config.storage as any);
  const url = await storage.getUrl(storagePath);
  console.log(url);
}

async function syncFiles(engine: BrainEngine, sourceId: string, dir?: string) {
  if (!dir || !existsSync(dir)) {
    console.error('Usage: gbrain files sync <directory>');
    process.exit(1);
  }

  const root = canonicalDirectory(dir);
  const files = collectFiles(root);
  console.log(`Found ${files.length} files to sync`);

  const { loadConfig } = await import('../core/config.ts');
  const config = loadConfig();
  if (!config?.storage) {
    throw new Error('No storage backend configured. Refusing to create file metadata without stored bytes.');
  }
  const { createStorage } = await import('../core/storage.ts');
  const storage = await createStorage(config.storage as any);

  let uploaded = 0;
  let skipped = 0;

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('files.sync', files.length);

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    const relativePath = containedRelativePath(root, filePath, 'sync file');

    progress.tick(1);

    const content = readRedirectOriginalSnapshotWithinRoot(root, relativePath).content;
    const filename = basename(filePath);
    const mimeType = getMimeType(filePath);

    // Infer page slug from directory structure
    const pathParts = relativePath.split('/');
    const pageSlug = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : null;

    const result = await publishStoredFile({
      engine,
      storage,
      sourceId,
      logicalPath: relativePath,
      pageSlug,
      filename,
      mimeType,
      data: content,
      metadata: { upload_method: content.length >= SIZE_THRESHOLD ? 'TUS resumable' : 'standard' },
    });
    if (result.changed || result.objectUploaded) uploaded++;
    else skipped++;
  }

  progress.finish();
  // Stdout summary preserved for scripts/tests that grep for it.
  console.log(`Files sync complete: ${uploaded} uploaded, ${skipped} skipped (unchanged)`);
}

async function verifyFiles(engine: BrainEngine, sourceId: string) {
  const rows = await engine.executeRaw<{
    source_id: string;
    storage_path: string;
    content_hash: string;
    size_bytes: number | string | null;
  }>(
    `SELECT source_id, storage_path, content_hash, size_bytes
       FROM files
      WHERE source_id = $1
      ORDER BY storage_path`,
    [sourceId],
  );

  if (rows.length === 0) {
    console.log('No files to verify.');
    return;
  }

  const { loadConfig } = await import('../core/config.ts');
  const config = loadConfig();
  if (!config?.storage) {
    throw new Error('No storage backend configured. Cannot verify stored file bytes.');
  }
  const { createStorage } = await import('../core/storage.ts');
  const storage = await createStorage(config.storage as any);

  let verified = 0;
  let mismatches = 0;
  let missing = 0;

  for (const row of rows) {
    const expectedHash = row.content_hash?.replace(/^sha256:/, '') ?? '';
    const expectedSize = Number(row.size_bytes);
    if (!row.storage_path || row.size_bytes === null || !/^[a-f0-9]{64}$/.test(expectedHash) ||
        !Number.isSafeInteger(expectedSize) || expectedSize < 0) {
      mismatches++;
      console.error(`  MISMATCH: ${row.storage_path || '(missing path)'} (invalid DB size/hash metadata)`);
      continue;
    }
    if (!await storage.exists(row.storage_path)) {
      missing++;
      console.error(`  MISSING: ${row.storage_path}`);
      continue;
    }
    try {
      const data = await storage.download(row.storage_path);
      const actualHash = sha256Hex(data);
      if (data.byteLength !== expectedSize || actualHash !== expectedHash) {
        mismatches++;
        console.error(
          `  MISMATCH: ${row.storage_path} ` +
          `(expected ${expectedSize} bytes and sha256:${expectedHash}, ` +
          `got ${data.byteLength} bytes and sha256:${actualHash})`,
        );
        continue;
      }
      verified++;
    } catch (error) {
      missing++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  UNREADABLE: ${row.storage_path} (${message})`);
    }
  }

  if (mismatches === 0 && missing === 0) {
    console.log(`${verified} files verified, 0 mismatches, 0 missing`);
  } else {
    throw new Error(
      `VERIFY FAILED: ${verified} verified, ${mismatches} mismatches, ${missing} missing. ` +
      `Repair or re-upload the affected objects before trusting this source.`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// File Migration Commands (mirror → redirect → clean lifecycle)
// ─────────────────────────────────────────────────────────────────

async function mirrorFiles(sourceId: string, args: string[]) {
  const dir = args.find(a => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  if (!dir || !existsSync(dir)) { console.error('Usage: gbrain files mirror <dir> [--dry-run]'); process.exit(1); }

  const root = canonicalDirectory(dir);
  const markerPath = join(root, '.supabase');
  let existingMarker: OwnedMirrorMarker | null = null;
  try {
    lstatSync(markerPath);
    existingMarker = readOwnedMirrorMarker(root, sourceId);
  } catch (error) {
    if (!isErrnoCode(error, 'ENOENT')) throw error;
  }
  if (dryRun) inspectCleanJournalsReadOnly(root, sourceId);
  else recoverInterruptedCleanJournals(root, sourceId);
  // Validate all existing pointer metadata before considering a marker write.
  collectMirrorLocatorState(root, sourceId);

  const { createStorage } = await import('../core/storage.ts');
  const { loadConfig } = await import('../core/config.ts');
  const { stringify } = await import('../core/yaml-lite.ts');
  const config = loadConfig();
  if (!config?.storage) { console.error('No storage backend configured. Run gbrain init with storage settings.'); process.exit(1); }

  const storage = await createStorage(config.storage as any);
  const files = collectFiles(root);
  const currentPaths = new Set(
    files.map(file => containedRelativePath(root, file, 'mirror file')),
  );
  let exactPaths = new Set<string>();
  if (existingMarker?.paths) {
    exactPaths = new Set(existingMarker.paths);
  } else if ((existingMarker?.fileCount ?? 0) > 0) {
    throw new Error(
      'Existing count-only mirror marker cannot prove exact historical paths; refusing automatic ledger adoption',
    );
  }
  for (const path of completedCleanLogicalPaths(root, sourceId)) exactPaths.add(path);
  for (const path of currentPaths) exactPaths.add(path);
  console.log(`Found ${files.length} files to mirror`);

  if (dryRun) {
    for (const f of files) {
      console.log(`  Would upload: ${sourceQualifiedStoragePath(sourceId, relative(root, f))}`);
    }
    console.log(`\nDry run: ${files.length} files would be uploaded.`);
    return;
  }

  let uploaded = 0;
  for (const filePath of files) {
    const relPath = relative(root, filePath);
    const storagePath = sourceQualifiedStoragePath(sourceId, relPath);
    const data = readRedirectOriginalSnapshotWithinRoot(root, relPath).content;
    const mime = getMimeType(filePath);
    await storage.upload(storagePath, data, mime || undefined);
    uploaded++;
  }

  // Write .supabase marker
  const marker = stringify({
    synced_at: new Date().toISOString(),
    bucket: (config.storage as { bucket?: string })?.bucket || 'brain-files',
    source_id: sourceId,
    prefix: `${sourceId}/`,
    file_count: exactPaths.size,
    paths_json: JSON.stringify([...exactPaths].sort()),
  });
  writeRedirectPointerDurable(markerPath, marker);

  console.log(`Mirrored ${uploaded} files. Marker written to ${markerPath}`);
}

async function unmirrorFiles(sourceId: string, args: string[]) {
  const dir = args.find(a => !a.startsWith('--'));
  if (!dir) { console.error('Usage: gbrain files unmirror <dir>'); process.exit(1); }

  const root = canonicalDirectory(dir);
  const markerPath = join(root, '.supabase');
  try { lstatSync(markerPath); }
  catch (error) {
    if (!isErrnoCode(error, 'ENOENT')) throw error;
    console.log(`No mirror marker found in ${root}. Nothing to do.`);
    return;
  }
  const owned = readOwnedMirrorMarker(root, sourceId);
  if (owned.fileCount > 0 && !owned.paths) {
    throw new Error(
      'Refusing to unmirror: count-only marker has no exact paths ledger; re-mirror with a source-safe version first',
    );
  }
  recoverInterruptedCleanJournals(root, sourceId);
  const locatorState = collectMirrorLocatorState(root, sourceId);
  const missingPaths = [...(owned.paths ?? [])]
    .filter(path => !locatorState.logicalPaths.has(path));
  if (missingPaths.length > 0) {
    throw new Error(
      `Refusing to unmirror: the .supabase marker is the last live locator for ` +
      `${missingPaths.length} cloud-only file(s) (first: ${missingPaths[0]})`,
    );
  }
  if (!retireOwnedRedirectPointer(owned.path, owned.snapshot)) {
    throw new Error('Mirror marker changed during unmirror; it was preserved');
  }
  console.log(`Removed mirror marker from ${root}. Files remain in storage.`);
}

async function redirectFiles(sourceId: string, args: string[]) {
  const dir = args.find(a => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  if (!dir || !existsSync(dir)) { console.error('Usage: gbrain files redirect <dir> [--dry-run]'); process.exit(1); }

  const owned = readOwnedMirrorMarker(dir, sourceId);
  if (dryRun) inspectCleanJournalsReadOnly(owned.root, sourceId);
  else recoverInterruptedCleanJournals(owned.root, sourceId);
  const { stringify } = await import('../core/yaml-lite.ts');
  const marker = owned.marker;
  const files = collectFiles(owned.root);

  const { loadConfig } = await import('../core/config.ts');
  const config = loadConfig();
  if (!config?.storage) {
    throw new Error('No storage backend configured. Refusing to remove local originals.');
  }
  const { createStorage } = await import('../core/storage.ts');
  const storage = await createStorage(config.storage as any);

  if (dryRun) {
    for (const f of files) { console.log(`  Would redirect: ${relative(owned.root, f)}`); }
    console.log(`\nDry run: ${files.length} files would be redirected.`);
    return;
  }

  let redirected = 0;
  for (const filePath of files) {
    const relPath = relative(owned.root, filePath);
    const storagePath = sourceQualifiedStoragePath(sourceId, relPath);
    // Bind upload + pointer metadata to the exact local revision observed
    // before network I/O. A final identity/hash check prevents a concurrent
    // replacement from being unlinked after a newer revision arrives.
    const original = readRedirectOriginalSnapshotWithinRoot(owned.root, relPath);
    const content = original.content;
    const hash = sha256Hex(content);
    const mimeType = getMimeType(filePath);
    // Existence alone is not evidence that the mirrored object is current.
    // Upload missing/mismatched bytes and verify the exact stored hash+size
    // before writing the breadcrumb or unlinking the only local copy.
    await ensureStoredObjectExact(storage, storagePath, content, mimeType || undefined);

    const bucket = marker.bucket || 'brain-files';
    const pointer = stringify({
      target: `supabase://${bucket}/${storagePath}`,
      bucket,
      storage_path: storagePath,
      size: content.byteLength,
      size_human: humanSize(content.byteLength),
      hash: `sha256:${hash}`,
      mime: mimeType || 'application/octet-stream',
      uploaded: new Date().toISOString(),
      source_id: sourceId,
    });
    const pointerPath = filePath + '.redirect.yaml';
    replaceLocalWithRedirectDurableGuarded(
      filePath,
      pointerPath,
      pointer,
      original.identity,
    );
    redirected++;
  }

  console.log(`Redirected ${redirected} files. Originals removed, breadcrumbs created.`);
  console.log('To undo: gbrain files restore <dir>');
}

async function restoreFiles(sourceId: string, args: string[]) {
  const dir = args.find(a => !a.startsWith('--'));
  if (!dir || !existsSync(dir)) { console.error('Usage: gbrain files restore <dir>'); process.exit(1); }

  const { createStorage } = await import('../core/storage.ts');
  const { loadConfig } = await import('../core/config.ts');
  const config = loadConfig();
  if (!config?.storage) { console.error('No storage backend configured.'); process.exit(1); }

  const storage = await createStorage(config.storage as any);
  const allowLegacy = args.includes('--allow-legacy-unqualified') && args.includes('--yes');
  const redirectFiles: string[] = [];

  function findRedirects(d: string) {
    for (const entry of readdirSync(d)) {
      if (entry.startsWith('.')) continue;
      const full = join(d, entry);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue; // Broken symlink or permission error
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) findRedirects(full);
      else if (entry.endsWith('.redirect.yaml') || entry.endsWith('.redirect')) redirectFiles.push(full);
    }
  }
  findRedirects(dir);

  let restored = 0;
  let failed = 0;
  for (const redirectPath of redirectFiles) {
    const originalPath = redirectPath.replace(/\.redirect(\.yaml)?$/, '');
    try {
      const pointerSnapshot = readRedirectOriginalSnapshot(redirectPath);
      const redirect = redirectPath.endsWith('.redirect.yaml')
        ? validateRedirectYamlForSource(
            parseRedirectYamlContent(pointerSnapshot.content.toString('utf8')),
            sourceId,
            { allowLegacyUnqualified: allowLegacy },
          )
        : allowLegacy
          ? validateLegacyRedirect(parseRedirectContent(pointerSnapshot.content.toString('utf8')))
          : (() => {
              throw new Error(
                'Legacy unqualified redirect requires --allow-legacy-unqualified --yes for one-time restoration',
              );
            })();
      const data = await storage.download(redirect.storagePath);
      // Verification precedes every local write. A corrupt/truncated download
      // leaves both the prior local state and pointer untouched.
      verifyRedirectBytes(data, redirect, originalPath);
      const promoted = promoteRestoredFileAtomic(originalPath, data);
      if (!retireRedirectAfterRestoredPromotion(
        redirectPath,
        pointerSnapshot,
        originalPath,
        promoted,
      )) {
        throw new Error(
          `Restore destination or redirect changed during retirement; ` +
          `preserved the newer file and recovery pointer: ${redirectPath}`,
        );
      }
      try {
        fsyncDirectory(dirname(redirectPath));
      } catch (error) {
        // The restored file was already file+directory-fsynced before pointer
        // removal. If this final breadcrumb fsync is unsupported, a crash can
        // at worst resurrect a harmless pointer beside matching local bytes.
        const message = error instanceof Error ? error.message : String(error);
        console.error(`  Warning: restored ${originalPath}, but pointer directory fsync failed: ${message}`);
      }
      restored++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  Failed to restore ${originalPath}: ${msg}`);
      failed++;
    }
  }

  console.log(`Restored ${restored} files. ${failed > 0 ? `${failed} failed.` : ''}`);
  if (failed > 0) {
    throw new Error(
      `Restore incomplete: ${failed} file(s) failed integrity or durable promotion; ` +
      `their redirect pointers were retained for retry.`,
    );
  }
}

async function cleanFiles(sourceId: string, args: string[]) {
  const dir = args.find(a => !a.startsWith('--'));
  const confirmed = args.includes('--yes');
  if (!dir || !existsSync(dir)) { console.error('Usage: gbrain files clean <dir> [--yes]'); process.exit(1); }

  if (!confirmed) {
    console.error('WARNING: This permanently removes redirect pointers.');
    console.error('After this, files are only accessible from cloud storage.');
    console.error('Git history still has the originals if you need them.');
    console.error('Run with --yes to confirm.');
    process.exit(1);
  }

  const { createStorage } = await import('../core/storage.ts');
  const { loadConfig } = await import('../core/config.ts');
  const owned = readOwnedMirrorMarker(dir, sourceId);
  recoverInterruptedCleanJournals(owned.root, sourceId);
  const locatorState = collectMirrorLocatorState(owned.root, sourceId);
  if (locatorState.pointers.length === 0) {
    console.log('No source-bound redirect breadcrumbs to clean.');
    return;
  }
  const pointerLogicalPaths = new Set(
    locatorState.pointers.map(pointer => containedRelativePath(
      owned.root,
      pointer.path.slice(0, -'.redirect.yaml'.length),
      'redirect original',
    )),
  );
  if (owned.paths) {
    const outsideLedger = [...pointerLogicalPaths].find(path => !owned.paths!.has(path));
    if (outsideLedger) {
      throw new Error(`Redirect is absent from the mirror paths ledger: ${outsideLedger}`);
    }
  } else {
    throw new Error(
      'Count-only mirror marker cannot prove exact historical paths; refusing automatic ledger adoption',
    );
  }
  const config = loadConfig();
  if (!config?.storage) throw new Error('No storage backend configured. Refusing pointer cleanup.');
  const storage = await createStorage(config.storage as any);

  // Phase 1: verify every cloud object and capture every exact pointer revision.
  // Any failure here leaves the whole tree untouched.
  const verified: VerifiedCleanPointer[] = [];
  for (const pointer of locatorState.pointers) {
    const data = await storage.download(pointer.redirect.storagePath);
    verifyRedirectBytes(data, pointer.redirect, pointer.path);
    verified.push(pointer);
  }

  // Recheck the complete set before the first mutation. The per-pointer
  // quarantine check below closes the remaining compare-to-rename race.
  for (const item of verified) {
    if (!sameRedirectSnapshot(item.snapshot, readRedirectOriginalSnapshot(item.path))) {
      throw new Error(`Redirect changed during clean preflight; zero pointers retired: ${item.path}`);
    }
  }

  const quarantineRoot = retireVerifiedPointersWithJournal(owned.root, sourceId, verified);

  console.log(
    `Quarantined ${verified.length} verified redirect breadcrumbs under ${quarantineRoot}. ` +
    'Cloud bytes were hash/size verified before retirement.',
  );
}

async function filesStatus(args: string[]) {
  const dir = args[0] || '.';

  let mirrored = 0, redirected = 0, local = 0;

  function scan(d: string) {
    for (const entry of readdirSync(d)) {
      if (entry.startsWith('.') && entry !== '.supabase') continue;
      const full = join(d, entry);
      if (entry === '.supabase') { mirrored++; continue; }
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue; // Broken symlink or permission error
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) scan(full);
      else if (entry.endsWith('.redirect.yaml') || entry.endsWith('.redirect')) redirected++;
      else if (!entry.endsWith('.md')) local++;
    }
  }
  scan(dir);

  console.log('File migration status:');
  console.log(`  Mirrored directories: ${mirrored}`);
  console.log(`  Redirected files: ${redirected}`);
  console.log(`  Local binary files: ${local}`);

  if (mirrored === 0 && redirected === 0 && local > 0) {
    console.log(`\n${local} local files. Run: gbrain files mirror <dir> to start migration.`);
  } else if (redirected > 0) {
    console.log(`\n${redirected} files redirected to storage. Run: gbrain files clean <dir> --yes to remove breadcrumbs.`);
  }
}

export function collectFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      if (entry.startsWith('.')) continue;
      if (entry === 'node_modules') continue;

      const full = join(d, entry);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue; // Broken symlink or permission error
      }
      if (stat.isSymbolicLink()) continue;

      if (stat.isDirectory()) {
        walk(full);
      } else if (
        !entry.endsWith('.md') &&
        !entry.endsWith('.redirect.yaml') &&
        !entry.endsWith('.redirect')
      ) {
        // Non-markdown files are candidates for storage
        files.push(full);
      }
    }
  }

  walk(dir);
  return files.sort();
}
