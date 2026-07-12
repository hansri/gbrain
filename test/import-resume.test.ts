/**
 * Integration tests for `runImport`'s checkpoint behavior.
 *
 * Predicate-level tests for `loadCheckpoint`/`saveCheckpoint`/`resumeFilter`
 * live in `test/import-checkpoint.test.ts`. This file drives the full
 * `runImport` against PGLite to verify the end-to-end resume contract:
 *
 *   - Old positional checkpoints from pre-v0.33.2 brains are discarded
 *     cleanly + the migration stderr log fires.
 *   - v0.33.2 path-based checkpoints honor the completedPaths set on resume.
 *   - Failed files do NOT enter `completedPaths`; the next run retries them
 *     (the pre-existing P1 codex caught).
 *   - Clean completion clears the checkpoint.
 *
 * Test isolation:
 *   - `GBRAIN_HOME` env override via `withEnv` so we NEVER touch the real
 *     `~/.gbrain/import-checkpoint.json`. Pre-v0.33.2 this file did exactly
 *     that — see codex finding P2 in the plan.
 *   - PGLite via the canonical block (`beforeAll` + `resetPgliteState` +
 *     `afterAll`) per CLAUDE.md test-isolation rules R3 + R4.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { appendFileSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, symlinkSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { databaseIdentity } from '../src/core/database-identity.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { loadSyncFailures } from '../src/core/sync-failure-ledger.ts';
import { syncLockId, tryAcquireDbLock } from '../src/core/db-lock.ts';
import {
  withSourceWriterLease,
  type SourceWriterLease,
} from '../src/core/source-writer-lease.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import {
  collectSyncableFiles,
  computeFilesystemImportSnapshot,
  fingerprintImportBytes,
  resolveImportCheckpointBrainIdentity,
  resolveImportCheckpointScope,
  runImport,
} from '../src/commands/import.ts';

let engine: PGLiteEngine;
let secondaryIdentityEngine: PGLiteEngine;
let unconnectedIdentityEngine: PGLiteEngine;
let workspace: string;        // GBRAIN_HOME target — `${workspace}/.gbrain/` holds the checkpoint file
let gbrainHomeDir: string;    // Resolves to `${workspace}/.gbrain` — the actual checkpoint dir
let cpPath: string;           // The checkpoint file path inside gbrainHomeDir
let cpIdentity: string;
let brainDir: string;         // The brain content dir — fixture markdown lives here

beforeAll(async () => {
  engine = new PGLiteEngine();
  secondaryIdentityEngine = new PGLiteEngine();
  unconnectedIdentityEngine = new PGLiteEngine();
  await engine.connect({});
  await secondaryIdentityEngine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await secondaryIdentityEngine.disconnect();
  await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  workspace = mkdtempSync(join(tmpdir(), 'gbrain-import-resume-home-'));
  // GBRAIN_HOME is the parent dir; configDir() appends '.gbrain' itself.
  // The checkpoint lives at `${workspace}/.gbrain/import-checkpoint.json`.
  gbrainHomeDir = join(workspace, '.gbrain');
  mkdirSync(gbrainHomeDir, { recursive: true });
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-import-resume-brain-'));
});

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  if (brainDir) rmSync(brainDir, { recursive: true, force: true });
});

function writeBrainFile(rel: string, body: string) {
  const full = join(brainDir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
}

function validMarkdown(slug: string, title = slug) {
  return [
    '---',
    `slug: ${slug}`,
    `title: ${title}`,
    '---',
    '',
    `Body for ${slug}.`,
  ].join('\n');
}

async function withCheckpointEnv<T>(fn: () => Promise<T>): Promise<T> {
  return withEnv({ GBRAIN_HOME: workspace }, async () => {
    const scope = resolveImportCheckpointScope(brainDir, {
      brainIdentity: resolveImportCheckpointBrainIdentity(engine),
    });
    cpPath = scope.path;
    cpIdentity = scope.identity;
    mkdirSync(dirname(cpPath), { recursive: true });
    return fn();
  });
}

function refreshFilesystemCheckpointScope(): void {
  const files = collectSyncableFiles(brainDir, { strategy: 'markdown' });
  const scope = resolveImportCheckpointScope(brainDir, {
    brainIdentity: resolveImportCheckpointBrainIdentity(engine),
    filesystemSnapshot: computeFilesystemImportSnapshot(brainDir, files, 'markdown'),
  });
  cpPath = scope.path;
  cpIdentity = scope.identity;
  mkdirSync(dirname(cpPath), { recursive: true });
}

function initializeGitRepo(dir: string): string {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['add', '--', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function brainFileFingerprint(rel: string): string {
  return fingerprintImportBytes(readFileSync(join(brainDir, rel)));
}

describe('runImport checkpoint resume — v0.33.2 path-based', () => {
  test('direct import shares the canonical per-source writer lease with sync', async () => {
    await withCheckpointEnv(async () => {
      writeBrainFile('locked.md', validMarkdown('locked'));
      const held = await tryAcquireDbLock(engine, syncLockId('default'));
      expect(held).not.toBeNull();
      try {
        await expect(runImport(engine, [brainDir, '--no-embed']))
          .rejects.toThrow(/held by another process/i);
        expect(await engine.getPage('locked')).toBeNull();
      } finally {
        await held?.release();
      }
    });
  }, 30_000);

  test('library callers cannot forge or reuse an expired writer-lease bypass', async () => {
    await withCheckpointEnv(async () => {
      writeBrainFile('guarded.md', validMarkdown('guarded'));
      const forged = Object.freeze({
        sourceId: 'default',
        lockId: syncLockId('default'),
      }) as unknown as SourceWriterLease;
      await expect(runImport(engine, [brainDir, '--no-embed'], { writerLease: forged }))
        .rejects.toThrow(/Invalid or inactive source writer lease/);
      expect(await engine.getPage('guarded')).toBeNull();

      let expired!: SourceWriterLease;
      await withSourceWriterLease(engine, 'default', async lease => {
        expired = lease;
      });
      await expect(runImport(engine, [brainDir, '--no-embed'], { writerLease: expired }))
        .rejects.toThrow(/Invalid or inactive source writer lease/);
      expect(await engine.getPage('guarded')).toBeNull();

      const valid = await withSourceWriterLease(engine, 'default', lease =>
        runImport(engine, [brainDir, '--no-embed'], { writerLease: lease }));
      expect(valid.imported).toBe(1);
      expect(await engine.getPage('guarded')).not.toBeNull();
    });
  }, 30_000);

  test('put_page cannot mutate a source while checkpoint proofs are being consumed', async () => {
    await withCheckpointEnv(async () => {
      writeBrainFile('a.md', `${validMarkdown('a')}\n\nOriginal import authority.`);
      writeBrainFile('b.md', [
        '---', 'title: B', 'slug: wrong-b', '---', '', 'Broken on purpose.',
      ].join('\n'));
      const first = await runImport(engine, [brainDir, '--no-embed']);
      expect(first.failures.some(f => f.path === 'b.md')).toBe(true);
      writeBrainFile('b.md', validMarkdown('b'));

      let putResult: Awaited<ReturnType<typeof dispatchToolCall>> | undefined;
      const second = await runImport(engine, [brainDir, '--no-embed'], {
        _hooks: {
          afterResumeProofsLoaded: async () => {
            putResult = await dispatchToolCall(engine, 'put_page', {
              slug: 'a',
              content: `${validMarkdown('a')}\n\nConcurrent replacement.`,
            }, { remote: false, sourceId: 'default' });
          },
        },
      });

      expect(putResult?.isError).toBe(true);
      expect(putResult?.content[0]?.text).toMatch(/lock|held by another process/i);
      expect(second.imported).toBe(1); // only repaired b.md; a's proof stayed valid
      expect((await engine.getPage('a'))?.compiled_truth).toContain('Original import authority.');
    });
  }, 60_000);

  test('a legacy out-of-band row change after initial proof forces re-import', async () => {
    await withCheckpointEnv(async () => {
      writeBrainFile('a.md', `${validMarkdown('a')}\n\nCanonical A.`);
      writeBrainFile('b.md', [
        '---', 'title: B', 'slug: wrong-b', '---', '', 'Broken on purpose.',
      ].join('\n'));
      const first = await runImport(engine, [brainDir, '--no-embed']);
      expect(first.failures.some(f => f.path === 'b.md')).toBe(true);
      writeBrainFile('b.md', validMarkdown('b'));

      const second = await runImport(engine, [brainDir, '--no-embed'], {
        _hooks: {
          afterResumeProofsLoaded: async () => {
            await engine.executeRaw(
              `UPDATE pages SET content_hash = 'out-of-band-replacement'
                WHERE source_id = 'default' AND source_path = 'a.md'`,
            );
          },
        },
      });

      expect(second.failures).toHaveLength(0);
      expect(second.imported).toBe(2); // a proof was invalidated; b was newly repaired
      expect(existsSync(cpPath)).toBe(false);
    });
  }, 60_000);

  test('a row change after proofs are banked fails finalization and preserves the checkpoint', async () => {
    await withCheckpointEnv(async () => {
      writeBrainFile('a.md', `${validMarkdown('a')}\n\nCanonical A.`);

      const first = await runImport(engine, [brainDir, '--no-embed'], {
        _hooks: {
          beforeConvergenceFinalize: async () => {
            // Models a legacy writer that bypassed the source lease after the
            // import produced its exact proof but before checkpoint retirement.
            await engine.executeRaw(
              `UPDATE pages SET content_hash = 'late-out-of-band-replacement'
                WHERE source_id = 'default' AND source_path = 'a.md'`,
            );
          },
        },
      });

      expect(first.status).toBe('partial_failure');
      expect(first.failures[0]?.error).toContain('convergence proof changed');
      expect(existsSync(cpPath)).toBe(true);

      const recovered = await runImport(engine, [brainDir, '--no-embed']);
      expect(recovered.status).toBe('success');
      expect(recovered.imported).toBe(1);
      expect(existsSync(cpPath)).toBe(false);
    });
  }, 60_000);

  test('old positional checkpoint gets discarded with stderr log', async () => {
    await withCheckpointEnv(async () => {
      // Plant a pre-v0.33.2 positional checkpoint.
      writeFileSync(cpPath, JSON.stringify({
        dir: cpIdentity,
        totalFiles: 10,
        processedIndex: 5,
        completedFiles: 5,
        timestamp: '2026-01-01T00:00:00Z',
      }));

      // One fixture file so runImport has work to do.
      writeBrainFile('concepts/foo.md', validMarkdown('concepts/foo'));

      // Capture console.error to verify the migration log fires.
      let captured = '';
      const origErr = console.error.bind(console);
      console.error = (...args: unknown[]) => {
        captured += args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n';
      };

      try {
        const result = await runImport(engine, [brainDir, '--no-embed']);
        expect(result.imported + result.skipped).toBeGreaterThan(0);
      } finally {
        console.error = origErr;
      }

      expect(captured).toContain('Older checkpoint format detected');
    });
  }, 30_000);

  test('legacy path/fingerprint checkpoint cannot skip missing DB rows', async () => {
    await withCheckpointEnv(async () => {
      writeBrainFile('a.md', validMarkdown('a'));
      writeBrainFile('b.md', validMarkdown('b'));
      writeBrainFile('c.md', validMarkdown('c'));
      refreshFilesystemCheckpointScope();

      // Plant a v0.33.2 checkpoint that says a.md and b.md are done.
      writeFileSync(cpPath, JSON.stringify({
        dir: cpIdentity,
        completedPaths: ['a.md', 'b.md'],
        completedFingerprints: {
          'a.md': brainFileFingerprint('a.md'),
          'b.md': brainFileFingerprint('b.md'),
        },
        timestamp: '2026-05-14T00:00:00Z',
      }));

      const result = await runImport(engine, [brainDir, '--no-embed']);
      // No source-scoped DB proof exists for a/b, so all three re-import.
      expect(result.imported).toBe(3);
    });
  }, 30_000);

  test('clean completion clears the checkpoint file', async () => {
    await withCheckpointEnv(async () => {
      writeBrainFile('only.md', validMarkdown('only'));

      // No prior checkpoint.
      expect(existsSync(cpPath)).toBe(false);

      const result = await runImport(engine, [brainDir, '--no-embed']);
      expect(result.errors).toBe(0);
      expect(result.imported).toBe(1);

      // After clean completion the checkpoint is cleaned up so the next
      // run doesn't think it needs to resume.
      expect(existsSync(cpPath)).toBe(false);
    });
  }, 30_000);

  test('failed file does NOT enter completedPaths — next run retries it', async () => {
    await withCheckpointEnv(async () => {
      // Two healthy files plus one with a path-vs-frontmatter slug mismatch.
      // import-file.ts rejects path-derived 'people/bob' vs declared slug
      // 'wrong-slug' with a SLUG_MISMATCH failure (test/e2e/sync.test.ts uses
      // the same fixture shape).
      writeBrainFile('people/alice.md', validMarkdown('people/alice'));
      writeBrainFile('people/carol.md', validMarkdown('people/carol'));
      writeBrainFile('people/bob.md', [
        '---', 'type: person', 'title: Bob', 'slug: wrong-slug', '---', '', 'Body.',
      ].join('\n'));

      // First run: bob fails with SLUG_MISMATCH, others succeed.
      const result1 = await runImport(engine, [brainDir, '--no-embed']);
      // `failures` includes both thrown-exception (errors++) and
      // returned-skipped-with-error paths. SLUG_MISMATCH hits the latter.
      expect(result1.failures.length).toBeGreaterThan(0);
      expect(result1.failures.some(f => f.path.includes('bob'))).toBe(true);
      expect(existsSync(cpPath)).toBe(true);
      const checkpoint = JSON.parse(readFileSync(cpPath, 'utf8')) as {
        completedPaths: string[];
        completedFingerprints: Record<string, string>;
      };
      expect(checkpoint.completedPaths).toContain('people/alice.md');
      expect(checkpoint.completedPaths).toContain('people/carol.md');
      expect(checkpoint.completedPaths).not.toContain('people/bob.md');
      expect(checkpoint.completedFingerprints['people/alice.md'])
        .toBe(brainFileFingerprint('people/alice.md'));

      // Fix the broken file.
      writeBrainFile('people/bob.md', validMarkdown('people/bob'));

      // Second run: every file should now succeed. Critically, bob.md must
      // process — not silently skipped because of a stale checkpoint
      // pointer (the pre-v0.33.2 bug class).
      const result2 = await runImport(engine, [brainDir, '--no-embed']);
      expect(result2.failures.length).toBe(0);
      expect(result2.imported).toBe(1);

      // bob now exists in the DB.
      const pages = await engine.executeRaw<{ slug: string }>(
        `SELECT slug FROM pages WHERE slug = 'people/bob'`,
      );
      expect(pages.length).toBe(1);

      // Suppress unused warning — cpPath is referenced for clarity above.
      void cpPath;
    });
  }, 60_000);

  test('filesystem resume verifies the exact bytes imported, not only the initial tree snapshot', async () => {
    await withCheckpointEnv(async () => {
      writeBrainFile('a.md', `${validMarkdown('a')}\n\nTransient version.`);
      const first = await runImport(engine, [brainDir, '--no-embed']);
      expect(first.imported).toBe(1);
      const transientFingerprint = brainFileFingerprint('a.md');

      // Model the crash race: the run's initial tree was "Restored version",
      // but it imported transient bytes and banked that exact fingerprint;
      // the filesystem then returned to its initial bytes before resume.
      writeBrainFile('a.md', `${validMarkdown('a')}\n\nRestored version.`);
      refreshFilesystemCheckpointScope();
      writeFileSync(cpPath, JSON.stringify({
        dir: cpIdentity,
        completedPaths: ['a.md'],
        completedFingerprints: { 'a.md': transientFingerprint },
        timestamp: '2026-07-10T00:00:00Z',
      }));

      const resumed = await runImport(engine, [brainDir, '--no-embed']);
      expect(resumed.imported).toBe(1);
      expect((await engine.getPage('a'))?.compiled_truth).toContain('Restored version.');
    });
  }, 60_000);

  test('filesystem content changes invalidate completed-path resume state', async () => {
    await withCheckpointEnv(async () => {
      writeBrainFile('a.md', `${validMarkdown('a')}\n\nVersion one.`);
      writeBrainFile('b.md', [
        '---', 'title: B', 'slug: wrong-b', '---', '', 'Broken on purpose.',
      ].join('\n'));

      const first = await runImport(engine, [brainDir, '--no-embed']);
      expect(first.imported).toBe(1);
      expect(first.failures.some(f => f.path === 'b.md')).toBe(true);
      expect(existsSync(cpPath)).toBe(true);

      // a.md was previously completed, but changed while the failed-run
      // checkpoint survived. The next run must not silently skip it.
      writeBrainFile('a.md', `${validMarkdown('a')}\n\nVersion two.`);
      writeBrainFile('b.md', validMarkdown('b'));
      const second = await runImport(engine, [brainDir, '--no-embed']);

      expect(second.failures).toHaveLength(0);
      expect(second.imported).toBe(2);
      const a = await engine.getPage('a');
      expect(a?.compiled_truth).toContain('Version two.');
      expect(existsSync(cpPath)).toBe(false);
    });
  }, 60_000);

  test('filesystem resume reads every selected path at most once and reuses changed bytes for import', async () => {
    await withCheckpointEnv(async () => {
      writeBrainFile('a.md', validMarkdown('a'));
      const seeded = await runImport(engine, [brainDir, '--no-embed']);
      expect(seeded.imported).toBe(1);
      const aPage = await engine.getPage('a');
      expect(aPage).not.toBeNull();
      writeBrainFile('b.md', validMarkdown('b'));
      writeBrainFile('c.md', `${validMarkdown('c')}\n\nCurrent version.`);
      refreshFilesystemCheckpointScope();
      writeFileSync(cpPath, JSON.stringify({
        dir: cpIdentity,
        completedPaths: ['a.md', 'c.md'],
        completedFingerprints: {
          'a.md': brainFileFingerprint('a.md'),
          // A stale fingerprint forces c.md through import, using the same
          // buffer that failed checkpoint verification.
          'c.md': fingerprintImportBytes(Buffer.from('older c bytes')),
        },
        completedProofs: {
          'a.md': {
            authorityFingerprint: `sha256:${brainFileFingerprint('a.md')}`,
            pageId: aPage!.id,
            slug: aPage!.slug,
            contentHash: aPage!.content_hash,
          },
          'c.md': {
            authorityFingerprint: `sha256:${fingerprintImportBytes(Buffer.from('older c bytes'))}`,
            pageId: 999999,
            slug: 'c',
            contentHash: 'not-present-in-db',
          },
        },
        timestamp: '2026-07-10T00:00:00Z',
      }));

      const reads = new Map<string, number>();
      const result = await runImport(engine, [brainDir, '--no-embed'], {
        _hooks: {
          onFilesystemRead(path) {
            reads.set(path, (reads.get(path) ?? 0) + 1);
          },
        },
      });

      expect(result.imported).toBe(2);
      expect(reads).toEqual(new Map([
        ['c.md', 1],
        ['b.md', 1],
        ['a.md', 1],
      ]));
      expect((await engine.getPage('c'))?.compiled_truth).toContain('Current version.');
    });
  }, 60_000);

  test('oversized filesystem input is rejected before any content read', async () => {
    await withCheckpointEnv(async () => {
      writeBrainFile('oversized.md', 'x'.repeat(5_000_001));
      let reads = 0;
      const result = await runImport(engine, [brainDir, '--no-embed'], {
        _hooks: { onFilesystemRead: () => { reads++; } },
      });
      expect(reads).toBe(0);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.error).toContain('File too large');
      expect(await engine.getPage('oversized')).toBeNull();
    });
  }, 60_000);

  test('a file growing after lstat cannot make the bounded reader allocate past its cap', async () => {
    await withCheckpointEnv(async () => {
      writeBrainFile('growing.md', validMarkdown('growing'));
      let reads = 0;
      const result = await runImport(engine, [brainDir, '--no-embed'], {
        _hooks: {
          onFilesystemRead(path) {
            reads++;
            if (path === 'growing.md') {
              appendFileSync(join(brainDir, path), Buffer.alloc(5_000_001));
            }
          },
        },
      });
      expect(reads).toBe(1);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.error).toContain('File too large while reading');
      expect(await engine.getPage('growing')).toBeNull();
    });
  }, 60_000);

  test('checkpoint with mismatched dir is discarded silently (no migration log)', async () => {
    await withCheckpointEnv(async () => {
      writeBrainFile('one.md', validMarkdown('one'));

      // v0.33.2-shaped checkpoint pointing at a different brain dir.
      writeFileSync(cpPath, JSON.stringify({
        dir: '/some/other/brain',
        completedPaths: ['one.md'],
        timestamp: '2026-05-14T00:00:00Z',
      }));

      let captured = '';
      const origErr = console.error.bind(console);
      console.error = (...args: unknown[]) => {
        captured += args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n';
      };

      try {
        const result = await runImport(engine, [brainDir, '--no-embed']);
        // Dir mismatch → discard → re-walk → import the file fresh.
        expect(result.imported).toBe(1);
      } finally {
        console.error = origErr;
      }

      // The "older checkpoint format" log is for the POSITIONAL legacy
      // shape, not v0.33.2-dir-mismatch. Silent discard is intentional.
      expect(captured).not.toContain('Older checkpoint format');
    });
  }, 30_000);

  test('checkpoint files are isolated by source, brain, and pinned commit', () => {
    const commitA = 'a'.repeat(40);
    const sourceA = resolveImportCheckpointScope(brainDir, { brainIdentity: 'db-a', sourceId: 'source-a', commit: commitA });
    const sourceB = resolveImportCheckpointScope(brainDir, { brainIdentity: 'db-a', sourceId: 'source-b', commit: commitA });
    const otherBrain = resolveImportCheckpointScope(brainDir, { brainIdentity: 'db-b', sourceId: 'source-a', commit: commitA });
    const otherCommit = resolveImportCheckpointScope(brainDir, { brainIdentity: 'db-a', sourceId: 'source-a', commit: 'b'.repeat(40) });
    const filesystemA = resolveImportCheckpointScope(brainDir, {
      brainIdentity: 'db-a', sourceId: 'source-a', filesystemSnapshot: 'snapshot-a',
    });
    const filesystemB = resolveImportCheckpointScope(brainDir, {
      brainIdentity: 'db-a', sourceId: 'source-a', filesystemSnapshot: 'snapshot-b',
    });

    expect(sourceA.path).not.toBe(sourceB.path);
    expect(sourceA.path).not.toBe(otherBrain.path);
    expect(sourceA.path).not.toBe(otherCommit.path);
    expect(sourceA.identity).not.toBe(sourceB.identity);
    expect(filesystemA.path).toBe(filesystemB.path);
    // Mutable filesystem authority is stable; per-file fingerprints inside
    // the checkpoint decide skip vs retry without a corpus pre-read.
    expect(filesystemA.identity).toBe(filesystemB.identity);
  });

  test('commit checkpoint cannot skip a path whose source-scoped DB row is missing', async () => {
    await withEnv({ GBRAIN_HOME: workspace }, async () => {
      writeBrainFile('a.md', validMarkdown('a'));
      const commit = initializeGitRepo(brainDir);
      const oid = execFileSync('git', ['rev-parse', `${commit}:a.md`], {
        cwd: brainDir, encoding: 'utf8',
      }).trim();
      const scope = resolveImportCheckpointScope(brainDir, {
        brainIdentity: resolveImportCheckpointBrainIdentity(engine),
        sourceId: 'default',
        commit,
      });
      mkdirSync(dirname(scope.path), { recursive: true });
      writeFileSync(scope.path, JSON.stringify({
        dir: scope.identity,
        completedPaths: ['a.md'],
        completedProofs: {
          'a.md': {
            authorityFingerprint: `git:${oid}`,
            pageId: 999999,
            slug: 'a',
            contentHash: 'forged-db-hash',
          },
        },
        timestamp: '2026-07-11T00:00:00Z',
      }));

      const result = await runImport(engine, [brainDir, '--no-embed'], { commit });
      expect(result.imported).toBe(1);
      expect(await engine.getPage('a', { sourceId: 'default' })).not.toBeNull();
    });
  }, 60_000);

  test('mounted-brain engine identity wins over the host brain config', () => {
    const mountedIdentity = databaseIdentity({ database_path: '/mounts/team-brain/.pglite' });
    const hostIdentity = databaseIdentity({ database_path: '/var/lib/gbrain/test-brain' });
    const mountedEngine = {
      getDatabaseIdentity: () => mountedIdentity,
    } as BrainEngine;

    expect(resolveImportCheckpointBrainIdentity(mountedEngine)).toBe(mountedIdentity);
    const mountedScope = resolveImportCheckpointScope(brainDir, {
      brainIdentity: resolveImportCheckpointBrainIdentity(mountedEngine),
      sourceId: 'source-a',
    });
    const hostScope = resolveImportCheckpointScope(brainDir, {
      brainIdentity: hostIdentity,
      sourceId: 'source-a',
    });
    expect(mountedScope.path).not.toBe(hostScope.path);
  });

  test('database identity requires connection and is unique per in-memory brain', () => {
    const postgres = new PostgresEngine();
    expect(() => unconnectedIdentityEngine.getDatabaseIdentity()).toThrow('before connect() succeeds');
    expect(() => postgres.getDatabaseIdentity()).toThrow('before connect() succeeds');

    const firstIdentity = engine.getDatabaseIdentity();
    expect(firstIdentity).toBe(engine.getDatabaseIdentity());
    expect(firstIdentity).not.toBe(secondaryIdentityEngine.getDatabaseIdentity());
  });

  test('database identity keeps principal/schema, ignores password rotation, and canonicalizes PGLite symlinks', () => {
    const a = databaseIdentity({ database_url: 'postgresql://writer:old@DB.EXAMPLE:5432/brain?sslmode=require&options=-csearch_path%3Done' });
    const rotated = databaseIdentity({ database_url: 'postgresql://writer:new@db.example/brain?options=-csearch_path%3Done&sslmode=require' });
    const protocolAlias = databaseIdentity({ database_url: 'postgres://writer:new@db.example/brain?options=-csearch_path%3Done&sslmode=require' });
    const otherPrincipal = databaseIdentity({ database_url: 'postgresql://reader:new@db.example/brain?options=-csearch_path%3Done&sslmode=require' });
    const otherSchema = databaseIdentity({ database_url: 'postgresql://writer:new@db.example/brain?options=-csearch_path%3Dtwo&sslmode=require' });
    expect(a).toBe(rotated);
    expect(a).toBe(protocolAlias);
    expect(a).not.toBe(otherPrincipal);
    expect(a).not.toBe(otherSchema);

    const real = mkdtempSync(join(tmpdir(), 'gbrain-identity-real-'));
    const link = `${real}-link`;
    try {
      symlinkSync(real, link);
      expect(databaseIdentity({ database_path: real })).toBe(databaseIdentity({ database_path: link }));
    } finally {
      rmSync(link, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  test('CLI --source-id selects the checkpoint scope after source resolution', async () => {
    await withEnv({ GBRAIN_HOME: workspace }, async () => {
      await engine.executeRaw(
        `INSERT INTO sources (id, name) VALUES ('source-a', 'Source A') ON CONFLICT DO NOTHING`,
      );
      writeBrainFile('people/alice.md', [
        '---', 'slug: wrong/source', 'title: Alice', '---', '', 'Broken on purpose.',
      ].join('\n'));

      const result = await runImport(
        engine,
        [brainDir, '--source-id', 'source-a', '--no-embed'],
        { brainIdentity: 'db-a' },
      );
      expect(result.failures.length).toBe(1);
      const effective = resolveImportCheckpointScope(brainDir, {
        brainIdentity: 'db-a', sourceId: 'source-a',
      });
      const wrongDefault = resolveImportCheckpointScope(brainDir, {
        brainIdentity: 'db-a', sourceId: 'default',
      });
      expect(existsSync(effective.path)).toBe(true);
      expect(existsSync(wrongDefault.path)).toBe(false);
    });
  }, 30_000);

  test('parallel workers come from the mounted parent engine and retain its source boundary', async () => {
    await withEnv({ GBRAIN_HOME: workspace }, async () => {
      await engine.executeRaw(
        `INSERT INTO sources (id, name) VALUES ('mounted-source', 'Mounted') ON CONFLICT DO NOTHING`,
      );
      writeBrainFile('a.md', validMarkdown('a'));
      writeBrainFile('b.md', validMarkdown('b'));
      let workerFactories = 0;
      const mounted = new Proxy(engine as BrainEngine, {
        get(target, prop, receiver) {
          if (prop === 'createWorkerEngine') {
            return async () => {
              workerFactories++;
              return new Proxy(engine as BrainEngine, {
                get(workerTarget, workerProp, workerReceiver) {
                  // The mounted parent owns the underlying test database. A
                  // worker disconnect must therefore release only its own
                  // logical handle, not tear down the shared fixture engine.
                  if (workerProp === 'disconnect') return async () => {};
                  const workerValue = Reflect.get(workerTarget, workerProp, workerReceiver);
                  return typeof workerValue === 'function'
                    ? workerValue.bind(workerTarget)
                    : workerValue;
                },
              });
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      const result = await runImport(
        mounted,
        [brainDir, '--source-id', 'mounted-source', '--workers', '2', '--no-embed'],
      );
      expect(result.imported).toBe(2);
      expect(workerFactories).toBe(2);
      expect(await engine.getPage('a', { sourceId: 'mounted-source' })).not.toBeNull();
      expect(await engine.getPage('a', { sourceId: 'default' })).toBeNull();
    });
  }, 60_000);

  test('effective named source owns ingest log, failure ledger, and successful Git anchor', async () => {
    await withEnv({ GBRAIN_HOME: workspace }, async () => {
      await engine.executeRaw(
        `INSERT INTO sources (id, name) VALUES ('source-a', 'Source A') ON CONFLICT DO NOTHING`,
      );
      writeBrainFile('people/alice.md', validMarkdown('people/alice'));
      const head = initializeGitRepo(brainDir);

      const result = await runImport(
        engine,
        [brainDir, '--source-id', 'source-a', '--no-embed', '--json'],
        { brainIdentity: 'db-a', commit: head },
      );
      expect(result.status).toBe('success');
      expect(result.exitCode).toBe(0);
      const ingest = await engine.executeRaw<{ source_id: string }>(
        `SELECT source_id FROM ingest_log ORDER BY id DESC LIMIT 1`,
      );
      expect(ingest[0]?.source_id).toBe('source-a');
      const anchors = await engine.executeRaw<{
        last_commit: string | null;
        local_path: string | null;
        last_sync_at: string | null;
      }>(
        `SELECT last_commit, local_path, last_sync_at FROM sources WHERE id = 'source-a'`,
      );
      expect(anchors[0]?.last_commit).toBe(head);
      expect(anchors[0]?.local_path).toBe(brainDir);
      expect(anchors[0]?.last_sync_at).not.toBeNull();
      expect(await engine.getConfig('sync.last_commit')).toBeNull();
      expect(loadSyncFailures().filter(row => row.source_id === 'source-a')).toHaveLength(0);
    });
  }, 30_000);

  test('effective named source records returned import failures and does not advance its anchor', async () => {
    await withEnv({ GBRAIN_HOME: workspace }, async () => {
      await engine.executeRaw(
        `INSERT INTO sources (id, name) VALUES ('source-a', 'Source A') ON CONFLICT DO NOTHING`,
      );
      writeBrainFile('people/alice.md', [
        '---', 'slug: wrong/source', 'title: Alice', '---', '', 'Broken on purpose.',
      ].join('\n'));
      const head = initializeGitRepo(brainDir);

      const result = await runImport(
        engine,
        [brainDir, '--source-id', 'source-a', '--no-embed', '--json'],
        { brainIdentity: 'db-a', commit: head },
      );
      expect(result.status).toBe('partial_failure');
      expect(result.exitCode).toBe(1);
      expect(result.errors).toBe(0);
      expect(result.failures).toHaveLength(1);
      const ledger = loadSyncFailures().filter(row => row.source_id === 'source-a');
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.path).toBe('people/alice.md');
      const anchors = await engine.executeRaw<{
        last_commit: string | null;
        local_path: string | null;
        last_sync_at: string | null;
      }>(
        `SELECT last_commit, local_path, last_sync_at FROM sources WHERE id = 'source-a'`,
      );
      expect(anchors[0]?.last_commit).toBeNull();
      expect(anchors[0]?.local_path).toBe(brainDir);
      expect(anchors[0]?.last_sync_at).toBeNull();
      const ingest = await engine.executeRaw<{ source_id: string }>(
        `SELECT source_id FROM ingest_log ORDER BY id DESC LIMIT 1`,
      );
      expect(ingest[0]?.source_id).toBe('source-a');
    });
  }, 30_000);

  test('direct mutable-worktree import never binds dirty or concurrently changed bytes to HEAD', async () => {
    await withEnv({ GBRAIN_HOME: workspace }, async () => {
      await engine.executeRaw(
        `INSERT INTO sources (id, name) VALUES ('source-a', 'Source A') ON CONFLICT DO NOTHING`,
      );
      writeBrainFile('page.md', validMarkdown('page', 'Committed authority'));
      const initialHead = initializeGitRepo(brainDir);
      writeBrainFile('page.md', validMarkdown('page', 'Dirty worktree bytes'));

      const result = await runImport(
        engine,
        [brainDir, '--source-id', 'source-a', '--no-embed'],
        {
          brainIdentity: 'db-a',
          _hooks: {
            beforeConvergenceFinalize: () => {
              writeBrainFile('page.md', validMarkdown('page', 'Changed again during import'));
              execFileSync('git', ['add', 'page.md'], { cwd: brainDir });
              execFileSync('git', ['commit', '-q', '-m', 'concurrent change'], { cwd: brainDir });
            },
          },
        },
      );
      expect(result.status).toBe('success');
      const anchors = await engine.executeRaw<{ last_commit: string | null }>(
        `SELECT last_commit FROM sources WHERE id = 'source-a'`,
      );
      expect(anchors[0]?.last_commit).toBeNull();
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: brainDir, encoding: 'utf8' }).trim())
        .not.toBe(initialHead);
      expect((await engine.getPage('page', { sourceId: 'source-a' }))?.title).toBe('Dirty worktree bytes');
    });
  }, 30_000);
});
