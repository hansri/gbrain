import { createHash } from 'crypto';
import type { BrainEngine, FileRow } from './engine.ts';
import { sourceQualifiedStoragePath } from './file-resolver.ts';
import type { StorageBackend } from './storage.ts';

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

/** Hash bytes once using the canonical lowercase SHA-256 representation. */
export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Immutable object key for one logical attachment revision.
 *
 * The logical path remains visible for operators, while the full content hash
 * makes every changed payload a new object. This is intentionally not a bare
 * hash key: `files` has a unique `(source_id, storage_path)` identity, so two
 * independent logical attachments containing equal bytes still need distinct
 * rows and object keys.
 */
export function contentAddressedStoragePath(
  sourceId: string,
  logicalPath: string,
  contentHash: string,
): string {
  if (!SHA256_HEX_RE.test(contentHash)) {
    throw new Error('Content hash must be a lowercase SHA-256 hex digest');
  }
  return `${sourceQualifiedStoragePath(sourceId, logicalPath)}.sha256-${contentHash}`;
}

function bytesMatch(data: Buffer, expectedHash: string, expectedSize: number): boolean {
  return data.byteLength === expectedSize && sha256Hex(data) === expectedHash;
}

/**
 * Ensure an object contains the exact expected bytes before a local file or DB
 * pointer may move. Existing objects are accepted only after full size+hash
 * verification. Missing or mismatched objects are uploaded and then verified
 * again, so a successful return is a data-loss-safe handoff point.
 */
export async function ensureStoredObjectExact(
  storage: StorageBackend,
  storagePath: string,
  data: Buffer,
  mime?: string,
): Promise<{ uploaded: boolean }> {
  const expectedHash = sha256Hex(data);
  const expectedSize = data.byteLength;

  if (await storage.exists(storagePath)) {
    const current = await storage.download(storagePath);
    if (bytesMatch(current, expectedHash, expectedSize)) {
      return { uploaded: false };
    }
  }

  await storage.upload(storagePath, data, mime);
  const stored = await storage.download(storagePath);
  if (!bytesMatch(stored, expectedHash, expectedSize)) {
    throw new Error(
      `Storage verification failed after upload for ${storagePath}: ` +
      `expected sha256:${expectedHash} (${expectedSize} bytes)`,
    );
  }
  return { uploaded: true };
}

interface StoredFilePointerRow extends Pick<
  FileRow,
  'id' | 'storage_path' | 'content_hash' | 'metadata'
> {}

function objectMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // A malformed legacy metadata value must not control the new pointer.
    }
  }
  return {};
}

export interface PublishStoredFileInput {
  engine: BrainEngine;
  storage: StorageBackend;
  sourceId: string;
  /** Stable attachment identity within the source, e.g. `page/file.pdf`. */
  logicalPath: string;
  pageSlug: string | null;
  filename: string;
  mimeType: string | null;
  data: Buffer;
  metadata?: Record<string, unknown>;
}

export interface PublishStoredFileResult {
  storagePath: string;
  contentHash: string;
  sizeBytes: number;
  created: boolean;
  changed: boolean;
  objectUploaded: boolean;
  previousStoragePath: string | null;
}

/**
 * Publish bytes and atomically switch the DB pointer to their immutable key.
 *
 * Crash order is deliberate:
 *   1. upload + verify the new immutable object;
 *   2. switch/insert the DB pointer in one transaction;
 *   3. leave the prior object untouched for a separate reference-aware GC.
 *
 * A crash or DB failure can therefore create only an unreferenced NEW object;
 * it can never delete or overwrite the object referenced by the committed DB
 * row. Inline rollback deletion is forbidden because a content-addressed
 * object may already be a valid retry artifact.
 */
export async function publishStoredFile(
  input: PublishStoredFileInput,
): Promise<PublishStoredFileResult> {
  const contentHash = sha256Hex(input.data);
  const storagePath = contentAddressedStoragePath(
    input.sourceId,
    input.logicalPath,
    contentHash,
  );
  const legacyQualifiedPath = sourceQualifiedStoragePath(input.sourceId, input.logicalPath);
  const objectResult = await ensureStoredObjectExact(
    input.storage,
    storagePath,
    input.data,
    input.mimeType ?? undefined,
  );

  let created = false;
  let changed = true;
  let previousStoragePath: string | null = null;

  await input.engine.transaction(async (tx) => {
    // Serialize first-insert and replacement races on the stable logical
    // identity. Row locking alone cannot protect the empty-set case; both
    // Postgres and PGLite provide transaction-scoped advisory locks.
    await tx.executeRaw(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`gbrain:file-pointer:${input.sourceId}:${input.logicalPath}`],
    );

    // `logical_path` is the stable pointer identity for new rows. The two
    // storage_path fallbacks adopt source-qualified and pre-v23 legacy rows.
    // The new immutable path is included so an interrupted retry converges.
    const candidates = await tx.executeRaw<StoredFilePointerRow>(
      `SELECT id, storage_path, content_hash, metadata
         FROM files
        WHERE source_id = $1
          AND (
            metadata->>'logical_path' = $2
            OR storage_path = $3
            OR storage_path = $2
            OR storage_path = $4
          )
        ORDER BY id
        FOR UPDATE`,
      [input.sourceId, input.logicalPath, legacyQualifiedPath, storagePath],
    );

    if (candidates.length > 1) {
      throw new Error(
        `Ambiguous file pointer for ${input.sourceId}:${input.logicalPath}; ` +
        `${candidates.length} rows require manual reconciliation`,
      );
    }

    const current = candidates[0] ?? null;
    previousStoragePath = current?.storage_path ?? null;
    const page = input.pageSlug
      ? await tx.getPage(input.pageSlug, { sourceId: input.sourceId })
      : null;
    const metadata = {
      ...objectMetadata(current?.metadata),
      ...(input.metadata ?? {}),
      logical_path: input.logicalPath,
      storage_key_scheme: 'logical-sha256-v1',
    };

    if (current) {
      changed = current.storage_path !== storagePath ||
        current.content_hash.replace(/^sha256:/, '') !== contentHash;
      const rows = await tx.executeRaw<{ id: number }>(
        `UPDATE files
            SET page_slug = $1,
                page_id = $2,
                filename = $3,
                storage_path = $4,
                mime_type = $5,
                size_bytes = $6,
                content_hash = $7,
                metadata = $8::text::jsonb
          WHERE id = $9
            AND source_id = $10
            AND storage_path = $11
          RETURNING id`,
        [
          input.pageSlug,
          page?.id ?? null,
          input.filename,
          storagePath,
          input.mimeType,
          input.data.byteLength,
          contentHash,
          JSON.stringify(metadata),
          current.id,
          input.sourceId,
          current.storage_path,
        ],
      );
      if (rows.length !== 1) {
        throw new Error(
          `File pointer changed concurrently for ${input.sourceId}:${input.logicalPath}`,
        );
      }
      return;
    }

    const result = await tx.upsertFile({
      source_id: input.sourceId,
      page_slug: input.pageSlug,
      page_id: page?.id ?? null,
      filename: input.filename,
      storage_path: storagePath,
      mime_type: input.mimeType,
      size_bytes: input.data.byteLength,
      content_hash: contentHash,
      metadata,
    });
    created = result.created;
  });

  return {
    storagePath,
    contentHash,
    sizeBytes: input.data.byteLength,
    created,
    changed,
    objectUploaded: objectResult.uploaded,
    previousStoragePath,
  };
}
