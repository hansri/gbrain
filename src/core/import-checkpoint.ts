import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import { relative, isAbsolute } from 'path';

/**
 * Path-based import checkpoint.
 *
 * Pre-v0.33.2 brains used a positional checkpoint (`processedIndex` into a
 * sorted file array). That model was broken in three ways under any non-
 * sequential execution:
 *
 *   1. Parallel workers — `processed++` fires on completion, not dispatch,
 *      so a slow worker on `files[0]` + three fast completions writes
 *      `processedIndex=3`. Crash-resume slices `files.slice(3)` and the
 *      slow file is silently lost.
 *   2. Failed files — error path still bumped the same counter, so failures
 *      pushed the checkpoint past them and the next run skipped them
 *      forever (line 268's "delete on clean exit" only fires when
 *      errors === 0; a single failure preserves the bad checkpoint).
 *   3. Sort-order changes — flipping the walk order makes positional
 *      indices from prior runs mean different files.
 *
 * Path-based resume fixes all three: a file is "done" only when its
 * `processFile` returns successfully, the completed set is keyed by the
 * relative path string (sort-order-agnostic), and failed files never
 * enter the set.
 */
export interface ImportCheckpoint {
  /** Opaque brain/source/authority identity. Mismatch on resume → discard. */
  dir: string;
  /**
   * Paths (relative to `dir`) that completed successfully or were unchanged.
   * Stored as a sorted array for serialization; loaded into a Set at runtime.
   */
  completedPaths: string[];
  /**
   * Raw-byte SHA-256 captured from the exact filesystem buffer passed to the
   * importer. Commit-backed imports omit this because the commit is immutable.
   */
  completedFingerprints?: Record<string, string>;
  /**
   * Convergence proof for each skippable path. A path is skipped only when
   * both its immutable/raw authority fingerprint and the source-scoped DB
   * row's semantic content_hash still match this record.
   */
  completedProofs?: Record<string, ImportConvergenceProof>;
  /** ISO 8601, diagnostic only. */
  timestamp: string;
}

/**
 * Exact source-row proof captured after a successful import/no-op.
 *
 * `contentHash` alone is not enough: an out-of-band writer could replace the
 * row at the same source path with a different slug/row identity while keeping
 * identical content. Finalization therefore binds the immutable/raw authority
 * to the exact source-scoped page row that converged.
 */
export interface ImportConvergenceProof {
  authorityFingerprint: string;
  pageId: number;
  slug: string;
  contentHash: string;
}

const OLD_FORMAT_LOG = 'Older checkpoint format detected — re-walking (cheap via content_hash)';

/**
 * Load a checkpoint and verify it's compatible with the current run.
 *
 * Returns null when:
 *   - the file is missing
 *   - the JSON is malformed
 *   - the recorded `dir` doesn't match the current `dir`
 *   - the payload is a pre-v0.33.2 positional checkpoint (logs to stderr
 *     so users see why a partial import is re-walking)
 *   - `completedPaths` is missing or not an array of strings
 */
export function loadCheckpoint(path: string, currentDir: string): ImportCheckpoint | null {
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  // Pre-v0.33.2 positional format: had `processedIndex`, no `completedPaths`.
  // Detect via the absence of the new field — discard and surface why.
  if (!Array.isArray(obj.completedPaths)) {
    if (typeof obj.processedIndex === 'number') {
      console.error(OLD_FORMAT_LOG);
    }
    return null;
  }

  if (typeof obj.dir !== 'string') return null;
  if (obj.dir !== currentDir) return null;
  if (typeof obj.timestamp !== 'string') return null;
  if (!obj.completedPaths.every((p): p is string => typeof p === 'string')) return null;
  if (obj.completedFingerprints !== undefined) {
    if (!obj.completedFingerprints || typeof obj.completedFingerprints !== 'object' || Array.isArray(obj.completedFingerprints)) {
      return null;
    }
    if (!Object.entries(obj.completedFingerprints as Record<string, unknown>)
      .every(([path, fingerprint]) => path.length > 0 && typeof fingerprint === 'string')) {
      return null;
    }
  }
  if (obj.completedProofs !== undefined) {
    if (!obj.completedProofs || typeof obj.completedProofs !== 'object' || Array.isArray(obj.completedProofs)) {
      return null;
    }
    if (!Object.entries(obj.completedProofs as Record<string, unknown>).every(([path, proof]) => {
      if (!path || !proof || typeof proof !== 'object' || Array.isArray(proof)) return false;
      const value = proof as Record<string, unknown>;
      return typeof value.authorityFingerprint === 'string'
        && value.authorityFingerprint.length > 0
        && typeof value.pageId === 'number'
        && Number.isSafeInteger(value.pageId)
        && value.pageId > 0
        && typeof value.slug === 'string'
        && value.slug.length > 0
        && typeof value.contentHash === 'string'
        && value.contentHash.length > 0;
    })) return null;
  }

  return {
    dir: obj.dir,
    completedPaths: obj.completedPaths,
    ...(obj.completedFingerprints !== undefined
      ? { completedFingerprints: obj.completedFingerprints as Record<string, string> }
      : {}),
    ...(obj.completedProofs !== undefined
      ? { completedProofs: obj.completedProofs as ImportCheckpoint['completedProofs'] }
      : {}),
    timestamp: obj.timestamp,
  };
}

/**
 * Write a checkpoint atomically (write-to-tmp + rename) so a crash mid-write
 * can never leave a partially-written JSON file that breaks the next resume.
 *
 * Failures are non-fatal — the caller logs nothing and the import continues.
 * A missing checkpoint just means the next run re-walks from zero, which
 * is cheap because `importFile` short-circuits unchanged files via
 * `content_hash`.
 */
export function saveCheckpoint(path: string, cp: ImportCheckpoint): void {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    // Sort for stable serialization — keeps diffs across snapshots minimal
    // and tests deterministic.
    const payload: ImportCheckpoint = {
      dir: cp.dir,
      completedPaths: [...cp.completedPaths].sort(),
      ...(cp.completedFingerprints
        ? {
            completedFingerprints: Object.fromEntries(
              Object.entries(cp.completedFingerprints).sort(([a], [b]) => a.localeCompare(b)),
            ),
          }
        : {}),
      ...(cp.completedProofs
        ? {
            completedProofs: Object.fromEntries(
              Object.entries(cp.completedProofs).sort(([a], [b]) => a.localeCompare(b)),
            ),
          }
        : {}),
      timestamp: cp.timestamp,
    };
    writeFileSync(tmp, JSON.stringify(payload));
    renameSync(tmp, path);
  } catch {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best-effort */ }
    /* non-fatal: lost checkpoint just means re-walk on next run */
  }
}

/**
 * Filter `allFiles` to those NOT already in the completed set.
 *
 * `allFiles` may contain absolute paths (from the recursive walker) or
 * already-relative paths (from tests). `completed` is always relative to
 * `dir`. Normalize each file to relative form before lookup.
 *
 * Pure function — no fs access. Test surface for the resume semantics.
 */
export function resumeFilter(
  allFiles: string[],
  dir: string,
  completed: Set<string>,
): string[] {
  if (completed.size === 0) return allFiles;
  return allFiles.filter((p) => {
    const rel = isAbsolute(p) ? relative(dir, p) : p;
    return !completed.has(rel);
  });
}

/**
 * Convenience for callers: remove a checkpoint file. Wraps the existing
 * cleanup-on-clean-exit site in import.ts. Non-fatal.
 */
export function clearCheckpoint(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* non-fatal */
  }
}
