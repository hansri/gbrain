import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'fs';
import type { Stats } from 'fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';

export class OwnedStateFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnedStateFileError';
  }
}

let forceNoFollowFallbackForTest = false;
let forceDirectoryHandleFallbackForTest = false;
const ownedStateReadPolicy = new AsyncLocalStorage<{ repairPermissions: boolean }>();

/** Keep inspection reads byte- and metadata-preserving while retaining checks. */
export function withOwnedStateReadPolicy<T>(
  repairPermissions: boolean,
  fn: () => T,
): T {
  return ownedStateReadPolicy.run({ repairPermissions }, fn);
}

function hasNativeNoFollow(): boolean {
  return !forceNoFollowFallbackForTest && typeof constants.O_NOFOLLOW === 'number';
}

function noFollowFlag(): number {
  return hasNativeNoFollow() ? constants.O_NOFOLLOW : 0;
}

function assertCurrentOwner(uid: number, label: string): void {
  if (typeof process.getuid === 'function' && uid !== process.getuid()) {
    throw new OwnedStateFileError(`${label} is not owned by the current user`);
  }
}

function assertWithinRoot(path: string, rootDir: string): { path: string; root: string } {
  const normalizedPath = resolve(path);
  const normalizedRoot = resolve(rootDir);
  const fromRoot = relative(normalizedRoot, normalizedPath);
  if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new OwnedStateFileError(`state path escapes its canonical root: ${path}`);
  }
  return { path: normalizedPath, root: normalizedRoot };
}

function sameFilesystemObject(a: Stats, b: Stats): boolean {
  return a.dev === b.dev
    && a.ino === b.ino
    && a.birthtimeMs === b.birthtimeMs
    && a.isFile() === b.isFile()
    && a.isDirectory() === b.isDirectory();
}

function lstatIfPresent(path: string): Stats | null {
  try { return lstatSync(path); }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: unknown }).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * O_NOFOLLOW is absent on some Windows/Bun builds. The fallback rejects a
 * symlink before open, then proves the opened handle and final path are the
 * exact same filesystem object. It never silently drops the symlink check.
 */
function openPathChecked(path: string, flags: number, mode?: number): number {
  if (hasNativeNoFollow()) return openSync(path, flags | noFollowFlag(), mode);
  const before = lstatIfPresent(path);
  if (before?.isSymbolicLink()) {
    throw new OwnedStateFileError(`state path is a symbolic link: ${path}`);
  }
  const fd = openSync(path, flags, mode);
  try {
    const opened = fstatSync(fd);
    const after = lstatSync(path);
    if (after.isSymbolicLink()
      || (before !== null && !sameFilesystemObject(before, opened))
      || !sameFilesystemObject(opened, after)) {
      throw new OwnedStateFileError(`state path changed while it was being opened: ${path}`);
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function isDirectoryHandleUnsupported(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32' || typeof error !== 'object' || error === null || !('code' in error)) return false;
  return ['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP'].includes(String((error as { code?: unknown }).code));
}

function validateDirectoryPathFallback(path: string, repairPermissions = true): void {
  let before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new OwnedStateFileError(`state directory is not a real directory: ${path}`);
  }
  assertCurrentOwner(before.uid, `state directory ${path}`);
  if ((before.mode & 0o777) !== 0o700) {
    if (!repairPermissions) {
      throw new OwnedStateFileError(`state directory permissions are not 0700: ${path}`);
    }
    chmodSync(path, 0o700);
  }
  const after = lstatSync(path);
  if (after.isSymbolicLink() || !after.isDirectory() || !sameFilesystemObject(before, after)) {
    throw new OwnedStateFileError(`state directory changed while it was being checked: ${path}`);
  }
  assertCurrentOwner(after.uid, `state directory ${path}`);
}

function openOwnedDirectory(path: string, repairPermissions = true): number | null {
  if (forceDirectoryHandleFallbackForTest) {
    validateDirectoryPathFallback(path, repairPermissions);
    return null;
  }
  const flags = constants.O_RDONLY
    | (typeof constants.O_DIRECTORY === 'number' ? constants.O_DIRECTORY : 0)
    | noFollowFlag();
  let fd: number;
  try {
    fd = openPathChecked(path, flags);
  } catch (error) {
    if (isDirectoryHandleUnsupported(error)) {
      validateDirectoryPathFallback(path, repairPermissions);
      return null;
    }
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory()) {
      throw new OwnedStateFileError(`state directory is not a real directory: ${path}`);
    }
    assertCurrentOwner(stat.uid, `state directory ${path}`);
    if ((stat.mode & 0o777) !== 0o700) {
      if (!repairPermissions) {
        throw new OwnedStateFileError(`state directory permissions are not 0700: ${path}`);
      }
      fchmodSync(fd, 0o700);
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function validateOwnedStateDirectory(
  path: string,
  rootDir: string,
  repairPermissions = true,
): void {
  const normalized = assertWithinRoot(path, rootDir);
  let current = normalized.root;
  let fd = openOwnedDirectory(current, repairPermissions);
  if (fd !== null) closeSync(fd);
  const suffix = relative(normalized.root, normalized.path);
  if (!suffix) return;
  for (const component of suffix.split(sep)) {
    current = resolve(current, component);
    fd = openOwnedDirectory(current, repairPermissions);
    if (fd !== null) closeSync(fd);
  }
}

export function isDirectoryFsyncUnsupported(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32' || typeof error !== 'object' || error === null || !('code' in error)) return false;
  return ['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP'].includes(String((error as { code?: unknown }).code));
}

function fsyncDirectory(path: string, requireCurrentOwner = true): void {
  const flags = constants.O_RDONLY
    | (typeof constants.O_DIRECTORY === 'number' ? constants.O_DIRECTORY : 0)
    | noFollowFlag();
  let fd: number;
  try {
    fd = openPathChecked(path, flags);
  } catch (error) {
    if (isDirectoryHandleUnsupported(error)) {
      validateDirectoryPathFallback(path);
      return;
    }
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory()) throw new OwnedStateFileError(`state parent is not a directory: ${path}`);
    if (requireCurrentOwner) assertCurrentOwner(stat.uid, `state directory ${path}`);
    try { fsyncSync(fd); }
    catch (error) {
      if (!isDirectoryFsyncUnsupported(error)) throw error;
      // Windows may reject fsync on directory handles. File fsync remains
      // mandatory; only directory-entry durability is unavailable there.
    }
  } finally { closeSync(fd); }
}

/**
 * Create and validate each directory entry from the canonical GBrain state
 * root down. No component below that root may be a symlink.
 */
export function ensureOwnedStateDirectory(path: string, rootDir = path): void {
  const normalized = assertWithinRoot(path, rootDir);
  const createdRoot = mkdirSync(normalized.root, { recursive: true, mode: 0o700 });
  let fd = openOwnedDirectory(normalized.root);
  if (fd !== null) closeSync(fd);
  if (createdRoot !== undefined) {
    // Persist the new canonical root entry. Its parent need not be user-owned
    // (for example a container mount), but O_NOFOLLOW still rejects redirects.
    fsyncDirectory(dirname(normalized.root), false);
  }

  const suffix = relative(normalized.root, normalized.path);
  if (!suffix) return;
  let current = normalized.root;
  for (const component of suffix.split(sep)) {
    const next = resolve(current, component);
    let created = false;
    try {
      mkdirSync(next, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error
        && (error as { code?: unknown }).code === 'EEXIST')) throw error;
    }
    fd = openOwnedDirectory(next);
    if (fd !== null) closeSync(fd);
    if (created) fsyncDirectory(current);
    current = next;
  }
}

type FileIdentity = Stats;

function validateOpenedFile(
  fd: number,
  path: string,
  maxBytes: number,
  repairPermissions = true,
): FileIdentity {
  let stat = fstatSync(fd);
  if (!stat.isFile()) throw new OwnedStateFileError(`state path is not a regular file: ${path}`);
  if (stat.nlink !== 1) throw new OwnedStateFileError(`state file has ${stat.nlink} hard links: ${path}`);
  assertCurrentOwner(stat.uid, `state file ${path}`);
  if (stat.size > maxBytes) {
    throw new OwnedStateFileError(`state file exceeds ${maxBytes} bytes: ${path}`);
  }
  if ((stat.mode & 0o777) !== 0o600) {
    if (!repairPermissions) {
      throw new OwnedStateFileError(`state file permissions are not 0600: ${path}`);
    }
    fchmodSync(fd, 0o600);
    stat = fstatSync(fd);
  }
  return stat;
}

function sameReadIdentity(before: FileIdentity, after: FileIdentity): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

let afterBoundedReadForTest: (() => void) | undefined;

export const ownedStateFileTesting = {
  setAfterBoundedReadHook(hook?: () => void): void {
    afterBoundedReadForTest = hook;
  },
  setForceNoFollowFallback(value = false): void {
    forceNoFollowFallbackForTest = value;
  },
  setForceDirectoryHandleFallback(value = false): void {
    forceDirectoryHandleFallbackForTest = value;
  },
};

export function readOwnedStateFile(path: string, maxBytes: number, rootDir = dirname(path)): string {
  // Reads must never create state merely because a diagnostic probed for it.
  // Existing directories are always identity-checked. Routine reads repair
  // permissions; explicit inspection policy fails without metadata mutation.
  const repairPermissions = ownedStateReadPolicy.getStore()?.repairPermissions ?? true;
  validateOwnedStateDirectory(dirname(path), rootDir, repairPermissions);
  const fd = openPathChecked(path, constants.O_RDONLY);
  try {
    const before = validateOpenedFile(fd, path, maxBytes, repairPermissions);
    // Never trust a pre-read stat as the allocation/read bound: another
    // process may grow an append-only file between fstat and read.
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    afterBoundedReadForTest?.();
    if (offset > maxBytes) {
      throw new OwnedStateFileError(`state file exceeds ${maxBytes} bytes: ${path}`);
    }
    const after = validateOpenedFile(fd, path, maxBytes, repairPermissions);
    if (!sameReadIdentity(before, after) || offset !== after.size) {
      throw new OwnedStateFileError(`state file changed while it was being read: ${path}`);
    }
    return buffer.toString('utf8', 0, offset);
  } finally {
    closeSync(fd);
  }
}

/** O_APPEND keeps concurrent ledger/error records as one indivisible write. */
export function appendOwnedStateFile(
  path: string,
  body: string,
  maxBytes: number,
  rootDir = dirname(path),
): void {
  ensureOwnedStateDirectory(dirname(path), rootDir);
  const bytes = Buffer.from(body, 'utf8');
  const fd = openPathChecked(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
    0o600,
  );
  try {
    const before = validateOpenedFile(fd, path, maxBytes);
    if (before.size + bytes.length > maxBytes) {
      throw new OwnedStateFileError(`state append would exceed ${maxBytes} bytes: ${path}`);
    }
    const written = writeSync(fd, bytes, 0, bytes.length);
    if (written !== bytes.length) throw new OwnedStateFileError(`short state write: ${path}`);
    const after = validateOpenedFile(fd, path, maxBytes);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size + bytes.length) {
      throw new OwnedStateFileError(`state file changed during append: ${path}`);
    }
    fsyncSync(fd);
    fsyncDirectory(dirname(path));
  } finally {
    closeSync(fd);
  }
}

/** Write, fsync, rename, then fsync the parent directory. */
export function writeOwnedStateFileAtomic(
  path: string,
  body: string,
  maxBytes: number,
  rootDir = dirname(path),
): void {
  ensureOwnedStateDirectory(dirname(path), rootDir);
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > maxBytes) throw new OwnedStateFileError(`state body exceeds ${maxBytes} bytes: ${path}`);
  const temp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  let fd: number | undefined;
  try {
    fd = openPathChecked(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    validateOpenedFile(fd, temp, maxBytes);
    writeFileSync(fd, body, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    fsyncDirectory(dirname(path));
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort */ }
    }
    try { if (existsSync(temp)) unlinkSync(temp); } catch { /* best-effort */ }
  }
}
