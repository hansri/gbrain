import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'path';
import { createHash } from 'crypto';
import { parse as parseYaml } from './yaml-lite.ts';
import type { StorageBackend } from './storage.ts';
import { assertValidSourceId } from './source-id.ts';

/**
 * Universal file reader with fallback chain:
 * 1. .redirect.yaml pointer exists → verify local or fetch+verify storage
 * 2. .redirect breadcrumb exists → verify local or fetch+verify storage
 * 3. No pointer + ordinary local regular file exists → return it
 * 4. nearest source-owned .supabase ancestor → deterministic storage path
 * 5. None → throw
 */

export interface ResolvedFile {
  data: Buffer;
  source: 'local' | 'storage' | 'redirect';
}

/** v0.9+ redirect format (.redirect.yaml) — richer metadata */
export interface RedirectYaml {
  target: string;           // supabase://brain-files/{storagePath}
  bucket: string;
  storage_path: string;
  size: number;
  size_human: string;
  hash: string;             // sha256:...
  mime: string;
  uploaded: string;         // ISO timestamp
  /** Required on source-qualified pointers created by v0.42.59+. */
  source_id?: string;
  source_url?: string;
  type?: string;            // transcript, article, image, etc.
}

/** Legacy v0.8 redirect format (.redirect) */
export interface RedirectInfo {
  moved_to: string;
  bucket: string;
  path: string;
  moved_at: string;
  original_hash: string;
}

export interface MarkerInfo {
  synced_at: string;
  bucket: string;
  prefix: string;
  file_count: number;
  /** Present on source-qualified mirrors; absent on legacy markers. */
  source_id?: string;
  /** Exact root-relative object ledger written by source-safe mirror versions. */
  paths?: string[];
  /** Flat-YAML compatible encoding used by the on-disk marker. */
  paths_json?: string;
}

function validateMarkerForSource(marker: MarkerInfo, sourceId: string): Set<string> | null {
  if (typeof marker.prefix !== 'string' || marker.prefix.length === 0 ||
      /\u0000|[\u0001-\u001f\u007f]/.test(marker.prefix) ||
      marker.prefix.startsWith('/') || marker.prefix === '..' || /\.\.[\\/]/.test(marker.prefix)) {
    throw new Error(`Blocked: .supabase marker prefix contains path traversal: ${String(marker.prefix)}`);
  }
  if (marker.source_id !== sourceId || marker.prefix !== `${sourceId}/`) {
    throw new Error(
      `Blocked: .supabase marker is not owned by source ${sourceId} with prefix ${sourceId}/`,
    );
  }
  const fileCount = Number(marker.file_count);
  if (!Number.isSafeInteger(fileCount) || fileCount < 0) {
    throw new Error('Blocked: .supabase marker has invalid file_count');
  }
  let rawPaths: unknown = marker.paths;
  if (rawPaths === undefined && marker.paths_json !== undefined) {
    try { rawPaths = JSON.parse(marker.paths_json); }
    catch { throw new Error('Blocked: .supabase marker has invalid paths_json ledger'); }
  }
  if (rawPaths === undefined) return null;
  if (!Array.isArray(rawPaths) || !rawPaths.every(path => typeof path === 'string')) {
    throw new Error('Blocked: .supabase marker has invalid paths ledger');
  }
  const paths = new Set<string>();
  for (const path of rawPaths) {
    const qualified = sourceQualifiedStoragePath(sourceId, path);
    paths.add(qualified.slice(`${sourceId}/`.length));
  }
  if (paths.size !== rawPaths.length || paths.size !== fileCount) {
    throw new Error('Blocked: .supabase marker paths ledger does not match file_count');
  }
  return paths;
}

function readRegularFileBound(path: string, label: string): Buffer {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) {
      throw new Error(`${label} must be a single-link regular file`);
    }
    const content = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (!after.isFile() || after.nlink !== 1n ||
        before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
        BigInt(content.byteLength) !== after.size) {
      throw new Error(`${label} changed while it was being read`);
    }
    return content;
  } finally {
    closeSync(fd);
  }
}

function readLocalRegularFile(path: string): Buffer | null {
  try {
    return readRegularFileBound(path, 'Local file');
  } catch {
    return null;
  }
}

function isPathContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Resolve through the candidate's parent once, then operate on that canonical
 * in-root directory. This closes the lexical-prefix gap where `root/link/file`
 * passed a string check even when `link` was a directory symlink to `/outside`.
 */
function confinedFilePath(filePath: string, brainRoot: string): string {
  const canonicalRoot = realpathSync(resolvePath(brainRoot));
  const lexicalFull = resolvePath(canonicalRoot, filePath);
  if (lexicalFull === canonicalRoot || !isPathContained(canonicalRoot, lexicalFull)) {
    throw new Error(`Path traversal blocked: ${filePath} resolves outside brain root`);
  }

  // Fresh clones can legitimately omit every descendant directory after a
  // clean migration. Resolve the nearest existing ancestor, then append only
  // the lexically-confined missing components so the root marker can still
  // locate the cloud object without manufacturing directories locally.
  let probe = dirname(lexicalFull);
  const missing: string[] = [];
  let canonicalExisting: string | null = null;
  while (isPathContained(canonicalRoot, probe)) {
    try {
      canonicalExisting = realpathSync(probe);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (probe === canonicalRoot) break;
      missing.unshift(basename(probe));
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  if (!canonicalExisting || !isPathContained(canonicalRoot, canonicalExisting)) {
    throw new Error(`Path traversal blocked: ${filePath} escapes brain root through an ancestor symlink`);
  }
  const existingStat = lstatSync(canonicalExisting);
  if (!existingStat.isDirectory() || existingStat.isSymbolicLink()) {
    throw new Error(`File not found: ${filePath}`);
  }
  const canonicalParent = join(canonicalExisting, ...missing);
  if (!isPathContained(canonicalRoot, canonicalParent)) {
    throw new Error(`Path traversal blocked: ${filePath} escapes brain root`);
  }
  return join(canonicalParent, basename(lexicalFull));
}

export interface ValidatedRedirect {
  storagePath: string;
  expectedSize?: number;
  expectedSha256: string;
}

export interface ResolveFileOpts {
  /** Explicit one-time compatibility path for pre-source legacy pointers. */
  allowLegacyUnqualified?: boolean;
}

export interface RedirectSourceValidationOpts {
  /** Explicit one-time restore/read path for pre-source, unqualified objects. */
  allowLegacyUnqualified?: boolean;
}

const SHA256_POINTER_RE = /^sha256:([a-f0-9]{64})$/;

function redirectObjectPath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') ||
      /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid redirect ${field}`);
  }
  const normalized = value.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Invalid redirect ${field}`);
  }
  return normalized;
}

function redirectHash(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid redirect ${field}`);
  const match = SHA256_POINTER_RE.exec(value);
  if (!match) throw new Error(`Invalid redirect ${field}: expected sha256:<64 lowercase hex>`);
  return match[1];
}

/** Validate a v0.9 pointer before its fields can select or bless stored bytes. */
export function validateRedirectYaml(info: RedirectYaml): ValidatedRedirect {
  const storagePath = redirectObjectPath(info.storage_path, 'storage_path');
  const expectedSize = Number(info.size);
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
    throw new Error('Invalid redirect size');
  }
  return {
    storagePath,
    expectedSize,
    expectedSha256: redirectHash(info.hash, 'hash'),
  };
}

/** Validate both pointer integrity and its exact source namespace authority. */
export function validateRedirectYamlForSource(
  info: RedirectYaml,
  sourceId: string,
  opts: RedirectSourceValidationOpts = {},
): ValidatedRedirect {
  assertValidSourceId(sourceId);
  const redirect = validateRedirectYaml(info);
  if (info.source_id === sourceId) {
    if (!redirect.storagePath.startsWith(`${sourceId}/`)) {
      throw new Error(`Redirect storage_path is outside source namespace ${sourceId}/`);
    }
    return redirect;
  }
  if (info.source_id === undefined) {
    // v0.23+ already wrote source-qualified keys before pointers gained their
    // explicit source_id field. The key itself is sufficient non-ambiguous
    // authority and keeps those cloud-only files readable after upgrade.
    if (redirect.storagePath.startsWith(`${sourceId}/`)) return redirect;
    // Truly pre-source objects belong to the historical default source only.
    // Non-default sources must migrate/copy them explicitly instead of gaining
    // an escape hatch into a shared unqualified namespace.
    if (opts.allowLegacyUnqualified && sourceId === 'default') return redirect;
    throw new Error(
      'Legacy unqualified redirect requires an explicit one-time migration/restore path',
    );
  }
  if (info.source_id !== sourceId) {
    throw new Error(
      `Redirect source mismatch: expected ${sourceId}, got ${info.source_id ?? '(legacy-unqualified)'}`,
    );
  }
  return redirect;
}

/** Validate a legacy pointer. Legacy breadcrumbs carry a hash but no size. */
export function validateLegacyRedirect(info: RedirectInfo): ValidatedRedirect {
  return {
    storagePath: redirectObjectPath(info.path, 'path'),
    expectedSha256: redirectHash(info.original_hash, 'original_hash'),
  };
}

/** Fail closed unless bytes match every integrity value committed in a pointer. */
export function verifyRedirectBytes(
  data: Buffer,
  redirect: ValidatedRedirect,
  label: string = redirect.storagePath,
): void {
  if (redirect.expectedSize !== undefined && data.byteLength !== redirect.expectedSize) {
    throw new Error(
      `Redirect integrity check failed for ${label}: expected ${redirect.expectedSize} bytes, got ${data.byteLength}`,
    );
  }
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== redirect.expectedSha256) {
    throw new Error(
      `Redirect integrity check failed for ${label}: SHA-256 does not match pointer`,
    );
  }
}

/**
 * Build the canonical object-store key for a new file write.
 *
 * v23 migrated legacy objects to `<source_id>/<old_path>`. New writes must use
 * that same layout or two sources with the same logical attachment path still
 * collide in a shared S3/Supabase bucket even though their DB rows are distinct.
 */
export function sourceQualifiedStoragePath(sourceId: string, logicalPath: string): string {
  assertValidSourceId(sourceId);
  const normalized = logicalPath.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Invalid storage path: ${JSON.stringify(logicalPath)}`);
  }
  const segments = normalized.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Invalid storage path: ${JSON.stringify(logicalPath)}`);
  }
  return `${sourceId}/${normalized}`;
}

/** Source-qualify a legacy read path without double-prefixing v23/new rows. */
export function sourceQualifiedStorageReadPath(sourceId: string, storagePath: string): string {
  assertValidSourceId(sourceId);
  return storagePath.startsWith(`${sourceId}/`)
    ? storagePath
    : sourceQualifiedStoragePath(sourceId, storagePath);
}

export async function resolveFile(
  filePath: string,
  brainRoot: string,
  storage?: StorageBackend,
  sourceId: string = 'default',
  opts: ResolveFileOpts = {},
): Promise<ResolvedFile> {
  assertValidSourceId(sourceId);
  // Canonicalize the parent so lexical traversal and ancestor-directory
  // symlink escapes cannot move reads outside the brain root.
  const fullPath = confinedFilePath(filePath, brainRoot);

  // A redirect is authoritative when present. A crash can leave both the
  // promoted local file and its pointer; accept the local bytes only after
  // proving they match that pointer. Partial/corrupt locals must never shadow
  // a valid stored object.
  const yamlRedirectPath = fullPath + '.redirect.yaml';
  if (existsSync(yamlRedirectPath)) {
    const info = parseRedirectYaml(yamlRedirectPath);
    const redirect = validateRedirectYamlForSource(info, sourceId, opts);
    const local = readLocalRegularFile(fullPath);
    if (local) {
      try {
        verifyRedirectBytes(local, redirect, filePath);
        return { data: local, source: 'local' };
      } catch {
        // Continue to the authoritative stored object.
      }
    }
    if (!storage) throw new Error(`File redirected to storage but no storage backend configured: ${filePath}`);
    const data = await storage.download(redirect.storagePath);
    verifyRedirectBytes(data, redirect, filePath);
    return { data, source: 'redirect' };
  }

  // Legacy pointers follow the same rule, with hash-only verification because
  // their schema predates the explicit byte count.
  const legacyRedirectPath = fullPath + '.redirect';
  if (existsSync(legacyRedirectPath)) {
    const info = parseRedirect(legacyRedirectPath);
    if (!opts.allowLegacyUnqualified) {
      throw new Error(
        'Legacy unqualified redirect requires an explicit one-time migration/restore path',
      );
    }
    if (sourceId !== 'default') {
      throw new Error('Legacy unqualified redirect is restricted to the historical default source');
    }
    const redirect = validateLegacyRedirect(info);
    const local = readLocalRegularFile(fullPath);
    if (local) {
      try {
        verifyRedirectBytes(local, redirect, filePath);
        return { data: local, source: 'local' };
      } catch {
        // Continue to the authoritative stored object.
      }
    }
    if (!storage) throw new Error(`File redirected to storage but no storage backend configured: ${filePath}`);
    const data = await storage.download(redirect.storagePath);
    verifyRedirectBytes(data, redirect, filePath);
    return { data, source: 'redirect' };
  }

  // No redirect: an ordinary local file is authoritative.
  const local = readLocalRegularFile(fullPath);
  if (local) {
    return { data: local, source: 'local' };
  }

  // 4. Walk to the nearest source-owned mirror root. A mirror writes one
  // marker at its root, so nested files must retain their full root-relative
  // path instead of degrading to basename-only object lookup.
  const canonicalRoot = realpathSync(resolvePath(brainRoot));
  let markerDir = dirname(fullPath);
  while (isPathContained(canonicalRoot, markerDir)) {
    const markerPath = join(markerDir, '.supabase');
    let markerExists = false;
    try {
      lstatSync(markerPath);
      markerExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (markerExists) {
      const marker = parseMarker(markerPath);
      const markerPaths = validateMarkerForSource(marker, sourceId);
      if (!storage) {
        throw new Error(`Directory mirrored to storage but no storage backend configured: ${filePath}`);
      }
      const logicalPath = relative(markerDir, fullPath);
      const storagePath = sourceQualifiedStoragePath(sourceId, logicalPath);
      const normalizedLogicalPath = storagePath.slice(`${sourceId}/`.length);
      if (markerPaths && !markerPaths.has(normalizedLogicalPath)) {
        throw new Error(`File is not present in the .supabase paths ledger: ${filePath}`);
      }
      try {
        const data = await storage.download(storagePath);
        return { data, source: 'storage' };
      } catch {
        // Fall back only to a verified regular local file. In the normal
        // marker path the earlier local check already returned, but retaining
        // this closes a concurrent storage/local transition safely.
        const fallback = readLocalRegularFile(fullPath);
        if (fallback) return { data: fallback, source: 'local' };
        throw new Error(`File not found locally or in storage: ${filePath}`);
      }
    }
    if (markerDir === canonicalRoot) break;
    const parent = dirname(markerDir);
    if (parent === markerDir) break;
    markerDir = parent;
  }

  throw new Error(`File not found: ${filePath}`);
}

/** Parse v0.9+ .redirect.yaml pointer */
export function parseRedirectYaml(path: string): RedirectYaml {
  return parseRedirectYamlContent(readRegularFileBound(path, 'Redirect pointer').toString('utf8'));
}

/** Parse bytes already captured through a no-follow, identity-checked read. */
export function parseRedirectYamlContent(content: string): RedirectYaml {
  return parseYaml(content) as unknown as RedirectYaml;
}

/** Parse legacy v0.8 .redirect breadcrumb */
export function parseRedirect(path: string): RedirectInfo {
  return parseRedirectContent(readRegularFileBound(path, 'Legacy redirect pointer').toString('utf8'));
}

/** Parse legacy pointer bytes already bound to a filesystem revision. */
export function parseRedirectContent(content: string): RedirectInfo {
  return parseYaml(content) as unknown as RedirectInfo;
}

export function parseMarker(path: string): MarkerInfo {
  return parseMarkerContent(readRegularFileBound(path, '.supabase marker').toString('utf8'));
}

/** Parse marker bytes already captured through a no-follow snapshot. */
export function parseMarkerContent(content: string): MarkerInfo {
  return parseYaml(content) as unknown as MarkerInfo;
}

/** Human-readable file size */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
