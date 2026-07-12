import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join, relative, extname, basename, dirname } from 'path';
import { randomUUID } from 'crypto';
import type { BrainEngine } from '../core/engine.ts';
import { sqlQueryForEngine } from '../core/sql-query.ts';
import {
  humanSize,
  parseRedirect,
  parseRedirectContent,
  parseRedirectYaml,
  parseRedirectYamlContent,
  sourceQualifiedStoragePath,
  validateLegacyRedirect,
  validateRedirectYaml,
  verifyRedirectBytes,
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
      await unmirrorFiles(commandArgs);
      break;
    case 'redirect':
      await redirectFiles(commandArgs);
      break;
    case 'restore':
      await restoreFiles(commandArgs);
      break;
    case 'clean':
      await cleanFiles(commandArgs);
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

/**
 * Read one regular-file revision through a no-follow descriptor and bind its
 * bytes to stable filesystem identity. Metadata is checked on both sides of
 * the read so a concurrent writer cannot silently produce a mixed snapshot.
 */
export function readRedirectOriginalSnapshot(path: string): RedirectOriginalSnapshot {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) {
      throw new Error(`Redirect original is not a regular file: ${path}`);
    }
    const content = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const beforeIdentity: RedirectOriginalIdentity = {
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
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
    if (!sameRedirectOriginalIdentity(beforeIdentity, afterIdentity)) {
      throw new Error(`Local original changed while it was being read; preserving it: ${path}`);
    }
    return { content, identity: afterIdentity };
  } finally {
    closeSync(fd);
  }
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
export function retireOwnedRedirectPointer(
  pointerPath: string,
  expected: RedirectOriginalSnapshot,
  trace?: RedirectDurabilityTrace,
): boolean {
  const quarantinePath = redirectQuarantinePath(pointerPath, 'pointer');
  try {
    renameSync(pointerPath, quarantinePath);
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return false;
    throw error;
  }

  const captured = readRedirectOriginalSnapshot(quarantinePath);
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
  const content = readFileSync(filePath);
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

  const stat = statSync(filePath);
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

  const content = readFileSync(filePath);
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

  const files = collectFiles(dir);
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
    const relativePath = relative(dir, filePath);

    progress.tick(1);

    const content = readFileSync(filePath);
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

  const { createStorage } = await import('../core/storage.ts');
  const { loadConfig } = await import('../core/config.ts');
  const { stringify } = await import('../core/yaml-lite.ts');
  const config = loadConfig();
  if (!config?.storage) { console.error('No storage backend configured. Run gbrain init with storage settings.'); process.exit(1); }

  const storage = await createStorage(config.storage as any);
  const files = collectFiles(dir);
  console.log(`Found ${files.length} files to mirror`);

  if (dryRun) {
    for (const f of files) {
      console.log(`  Would upload: ${sourceQualifiedStoragePath(sourceId, relative(dir, f))}`);
    }
    console.log(`\nDry run: ${files.length} files would be uploaded.`);
    return;
  }

  let uploaded = 0;
  for (const filePath of files) {
    const relPath = relative(dir, filePath);
    const storagePath = sourceQualifiedStoragePath(sourceId, relPath);
    const data = readFileSync(filePath);
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
    file_count: uploaded,
  });
  writeFileSync(join(dir, '.supabase'), marker);

  console.log(`Mirrored ${uploaded} files. Marker written to ${dir}/.supabase`);
}

async function unmirrorFiles(args: string[]) {
  const dir = args.find(a => !a.startsWith('--'));
  if (!dir) { console.error('Usage: gbrain files unmirror <dir>'); process.exit(1); }

  const markerPath = join(dir, '.supabase');
  if (existsSync(markerPath)) {
    unlinkSync(markerPath);
    console.log(`Removed mirror marker from ${dir}. Files remain in storage.`);
  } else {
    console.log(`No mirror marker found in ${dir}. Nothing to do.`);
  }
}

async function redirectFiles(args: string[]) {
  const dir = args.find(a => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  if (!dir || !existsSync(dir)) { console.error('Usage: gbrain files redirect <dir> [--dry-run]'); process.exit(1); }

  const markerPath = join(dir, '.supabase');
  if (!existsSync(markerPath)) {
    console.error('Directory must be mirrored first. Run: gbrain files mirror <dir>');
    process.exit(1);
  }

  const { parse: parseYaml, stringify } = await import('../core/yaml-lite.ts');
  const marker = parseYaml(readFileSync(markerPath, 'utf-8'));
  const files = collectFiles(dir);

  const { loadConfig } = await import('../core/config.ts');
  const config = loadConfig();
  if (!config?.storage) {
    throw new Error('No storage backend configured. Refusing to remove local originals.');
  }
  const { createStorage } = await import('../core/storage.ts');
  const storage = await createStorage(config.storage as any);

  if (dryRun) {
    for (const f of files) { console.log(`  Would redirect: ${relative(dir, f)}`); }
    console.log(`\nDry run: ${files.length} files would be redirected.`);
    return;
  }

  let redirected = 0;
  for (const filePath of files) {
    const relPath = relative(dir, filePath);
    // New markers bind the exact source-qualified object namespace. Legacy
    // markers lack source_id and keep their historical bare-path read only.
    const storagePath = typeof marker.source_id === 'string'
      ? sourceQualifiedStoragePath(marker.source_id, relPath)
      : relPath;
    // Bind upload + pointer metadata to the exact local revision observed
    // before network I/O. A final identity/hash check prevents a concurrent
    // replacement from being unlinked after a newer revision arrives.
    const original = readRedirectOriginalSnapshot(filePath);
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

async function restoreFiles(args: string[]) {
  const dir = args.find(a => !a.startsWith('--'));
  if (!dir || !existsSync(dir)) { console.error('Usage: gbrain files restore <dir>'); process.exit(1); }

  const { createStorage } = await import('../core/storage.ts');
  const { loadConfig } = await import('../core/config.ts');
  const config = loadConfig();
  if (!config?.storage) { console.error('No storage backend configured.'); process.exit(1); }

  const storage = await createStorage(config.storage as any);
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
        ? validateRedirectYaml(parseRedirectYamlContent(pointerSnapshot.content.toString('utf8')))
        : validateLegacyRedirect(parseRedirectContent(pointerSnapshot.content.toString('utf8')));
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

async function cleanFiles(args: string[]) {
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

  let cleaned = 0;
  function findAndClean(d: string) {
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
      if (stat.isDirectory()) findAndClean(full);
      else if (entry.endsWith('.redirect.yaml') || entry.endsWith('.redirect')) { unlinkSync(full); cleaned++; }
    }
  }
  findAndClean(dir);

  console.log(`Cleaned ${cleaned} redirect breadcrumbs. Cloud storage is now the only source.`);
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
