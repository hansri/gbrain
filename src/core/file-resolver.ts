import { readFileSync, existsSync, lstatSync, realpathSync } from 'fs';
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
 * 4. .supabase marker in parent dir → prefer storage, fall back to local
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
}

function readLocalRegularFile(path: string): Buffer | null {
  if (!existsSync(path)) return null;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return readFileSync(path);
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

  let canonicalParent: string;
  try {
    canonicalParent = realpathSync(dirname(lexicalFull));
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }
  if (!isPathContained(canonicalRoot, canonicalParent)) {
    throw new Error(`Path traversal blocked: ${filePath} escapes brain root through an ancestor symlink`);
  }
  return join(canonicalParent, basename(lexicalFull));
}

export interface ValidatedRedirect {
  storagePath: string;
  expectedSize?: number;
  expectedSha256: string;
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
): Promise<ResolvedFile> {
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
    const redirect = validateRedirectYaml(info);
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

  // 4. .supabase marker in parent directory
  const markerPath = join(dirname(fullPath), '.supabase');
  if (existsSync(markerPath)) {
    if (!storage) throw new Error(`Directory mirrored to storage but no storage backend configured: ${filePath}`);
    const marker = parseMarker(markerPath);
    // Validate marker.prefix: reject path traversal, absolute paths, bare '..'
    if (marker.prefix) {
      if (/\.\.[\\/]/.test(marker.prefix) || marker.prefix === '..' || marker.prefix.startsWith('/')) {
        throw new Error(`Blocked: .supabase marker prefix contains path traversal: ${marker.prefix}`);
      }
    }
    const filename = filePath.split('/').pop() || '';
    if (/\.\.[\\/]/.test(filename) || filename === '..' || filename.startsWith('/')) {
      throw new Error(`Blocked: filename contains path traversal: ${filename}`);
    }
    const storagePath = (marker.prefix || '') + filename;
    try {
      const data = await storage.download(storagePath);
      return { data, source: 'storage' };
    } catch {
      // Fall back to local if storage fails and local exists
      const fallback = readLocalRegularFile(fullPath);
      if (fallback) {
        return { data: fallback, source: 'local' };
      }
      throw new Error(`File not found locally or in storage: ${filePath}`);
    }
  }

  throw new Error(`File not found: ${filePath}`);
}

/** Parse v0.9+ .redirect.yaml pointer */
export function parseRedirectYaml(path: string): RedirectYaml {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid redirect pointer file');
  const content = readFileSync(path, 'utf-8');
  return parseRedirectYamlContent(content);
}

/** Parse bytes already captured through a no-follow, identity-checked read. */
export function parseRedirectYamlContent(content: string): RedirectYaml {
  return parseYaml(content) as unknown as RedirectYaml;
}

/** Parse legacy v0.8 .redirect breadcrumb */
export function parseRedirect(path: string): RedirectInfo {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid redirect pointer file');
  const content = readFileSync(path, 'utf-8');
  return parseRedirectContent(content);
}

/** Parse legacy pointer bytes already bound to a filesystem revision. */
export function parseRedirectContent(content: string): RedirectInfo {
  return parseYaml(content) as unknown as RedirectInfo;
}

export function parseMarker(path: string): MarkerInfo {
  const content = readFileSync(path, 'utf-8');
  return parseYaml(content) as unknown as MarkerInfo;
}

/** Human-readable file size */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
