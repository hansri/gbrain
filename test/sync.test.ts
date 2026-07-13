import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { buildSyncManifest, isSyncable, pathToSlug, pruneDir, isCodeFilePath } from '../src/core/sync.ts';
import {
  buildAutoEmbedArgs,
  buildGitInvocation,
  formatSyncSentinelRemediation,
  resolvedIntegritySentinelPaths,
} from '../src/commands/sync.ts';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, renameSync, symlinkSync } from 'fs';
import { join } from 'path';
import { execFileSync, execSync } from 'child_process';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { gitAuthorityEnvironment } from '../src/core/git-environment.ts';

describe('buildSyncManifest', () => {
  test('parses A/M/D entries from single commit', () => {
    const output = `A\tpeople/new-person.md\nM\tpeople/existing-person.md\nD\tpeople/deleted-person.md`;
    const manifest = buildSyncManifest(output);
    expect(manifest.added).toEqual(['people/new-person.md']);
    expect(manifest.modified).toEqual(['people/existing-person.md']);
    expect(manifest.deleted).toEqual(['people/deleted-person.md']);
    expect(manifest.renamed).toEqual([]);
  });

  test('parses R100 rename entries', () => {
    const output = `R100\tpeople/old-name.md\tpeople/new-name.md`;
    const manifest = buildSyncManifest(output);
    expect(manifest.renamed).toEqual([{ from: 'people/old-name.md', to: 'people/new-name.md' }]);
    expect(manifest.added).toEqual([]);
    expect(manifest.modified).toEqual([]);
    expect(manifest.deleted).toEqual([]);
  });

  test('parses partial rename (R075)', () => {
    const output = `R075\tpeople/old.md\tpeople/new.md`;
    const manifest = buildSyncManifest(output);
    expect(manifest.renamed).toEqual([{ from: 'people/old.md', to: 'people/new.md' }]);
  });

  test('handles empty diff', () => {
    const manifest = buildSyncManifest('');
    expect(manifest.added).toEqual([]);
    expect(manifest.modified).toEqual([]);
    expect(manifest.deleted).toEqual([]);
    expect(manifest.renamed).toEqual([]);
  });

  test('handles mixed entries with blank lines', () => {
    const output = `A\tpeople/a.md\n\nM\tpeople/b.md\n\nD\tpeople/c.md`;
    const manifest = buildSyncManifest(output);
    expect(manifest.added).toEqual(['people/a.md']);
    expect(manifest.modified).toEqual(['people/b.md']);
    expect(manifest.deleted).toEqual(['people/c.md']);
  });

  test('skips malformed lines', () => {
    const output = `A\tpeople/a.md\ngarbage line\nM\tpeople/b.md`;
    const manifest = buildSyncManifest(output);
    expect(manifest.added).toEqual(['people/a.md']);
    expect(manifest.modified).toEqual(['people/b.md']);
  });
});

describe('isSyncable', () => {
  test('accepts normal .md files', () => {
    expect(isSyncable('people/pedro-franceschi.md')).toBe(true);
    expect(isSyncable('meetings/2026-04-03-lunch.md')).toBe(true);
    expect(isSyncable('daily/2026-04-05.md')).toBe(true);
    expect(isSyncable('notes.md')).toBe(true);
  });

  test('accepts .mdx files', () => {
    expect(isSyncable('components/hero.mdx')).toBe(true);
    expect(isSyncable('docs/getting-started.mdx')).toBe(true);
  });

  test('rejects non-.md/.mdx files', () => {
    expect(isSyncable('people/photo.jpg')).toBe(false);
    expect(isSyncable('config.json')).toBe(false);
    expect(isSyncable('src/cli.ts')).toBe(false);
  });

  test('rejects files in hidden directories', () => {
    expect(isSyncable('.git/config')).toBe(false);
    expect(isSyncable('.obsidian/plugins.md')).toBe(false);
    expect(isSyncable('people/.hidden/secret.md')).toBe(false);
  });

  test('rejects .raw/ sidecar directories', () => {
    expect(isSyncable('people/pedro.raw/source.md')).toBe(false);
    expect(isSyncable('dir/.raw/notes.md')).toBe(false);
  });

  test('rejects skip-list basenames', () => {
    expect(isSyncable('schema.md')).toBe(false);
    expect(isSyncable('index.md')).toBe(false);
    expect(isSyncable('log.md')).toBe(false);
    expect(isSyncable('README.md')).toBe(false);
    expect(isSyncable('people/README.md')).toBe(false);
  });

  test('rejects ops/ directory', () => {
    expect(isSyncable('ops/deploy-log.md')).toBe(false);
    expect(isSyncable('ops/config.md')).toBe(false);
  });

  // ────────────────────────────────────────────────────────────────
  // v0.36 walker drift fix (closes #923, #202): node_modules exclusion
  // ────────────────────────────────────────────────────────────────

  test('CRITICAL latent-bug regression: rejects node_modules paths at any depth', () => {
    // Pre-v0.36, isSyncable had no node_modules check. Any markdown file
    // under a non-dot `node_modules` directory slipped through. This is
    // the canonical latent-bug fix gated by IRON RULE per the wave plan.
    expect(isSyncable('node_modules/some-pkg/README.md')).toBe(false);
    expect(isSyncable('node_modules/some-pkg/CHANGELOG.md')).toBe(false);
    expect(isSyncable('node_modules/some-pkg/docs/api.md')).toBe(false);
    expect(isSyncable('apps/web/node_modules/dep/notes.md')).toBe(false);
  });
});

describe('pruneDir', () => {
  test('blocks node_modules (no leading dot, the latent-bug case)', () => {
    expect(pruneDir('node_modules')).toBe(false);
  });

  test('blocks dot-prefix dirs (.git, .obsidian, .raw, .cache, etc.)', () => {
    expect(pruneDir('.git')).toBe(false);
    expect(pruneDir('.obsidian')).toBe(false);
    expect(pruneDir('.raw')).toBe(false);
    expect(pruneDir('.cache')).toBe(false);
    expect(pruneDir('.vscode')).toBe(false);
  });

  test('blocks ops (gbrain operational dir)', () => {
    expect(pruneDir('ops')).toBe(false);
  });

  test('blocks *.raw sidecar dirs (gbrain convention)', () => {
    expect(pruneDir('.raw')).toBe(false);
    expect(pruneDir('pedro.raw')).toBe(false);
    expect(pruneDir('article.raw')).toBe(false);
  });

  test('allows normal content dirs', () => {
    expect(pruneDir('wiki')).toBe(true);
    expect(pruneDir('people')).toBe(true);
    expect(pruneDir('meetings')).toBe(true);
    expect(pruneDir('corpus')).toBe(true);
    expect(pruneDir('2026')).toBe(true);
  });

  test('empty string returns true (defensive default)', () => {
    expect(pruneDir('')).toBe(true);
  });
});

describe('isCodeFilePath', () => {
  test('v0.36.x #878 regression: Terraform / HCL extensions are admitted', () => {
    expect(isCodeFilePath('infra/main.tf')).toBe(true);
    expect(isCodeFilePath('infra/prod.tfvars')).toBe(true);
    expect(isCodeFilePath('modules/network/variables.hcl')).toBe(true);
  });

  test('extensions are case-insensitive', () => {
    expect(isCodeFilePath('INFRA/MAIN.TF')).toBe(true);
    expect(isCodeFilePath('Modules/Net/Vars.HCL')).toBe(true);
  });

  test('does not false-positive on lookalike suffixes', () => {
    expect(isCodeFilePath('docs/notes.txt')).toBe(false);
    expect(isCodeFilePath('readme.tflint')).toBe(false);
    expect(isCodeFilePath('config.hcling')).toBe(false);
  });

  test('still accepts the v0.20.0 baseline set (regression guard)', () => {
    expect(isCodeFilePath('src/foo.ts')).toBe(true);
    expect(isCodeFilePath('src/bar.py')).toBe(true);
    expect(isCodeFilePath('config.toml')).toBe(true);
  });
});

describe('pathToSlug', () => {
  test('strips .md extension and lowercases', () => {
    expect(pathToSlug('people/pedro-franceschi.md')).toBe('people/pedro-franceschi');
  });

  test('normalizes to lowercase', () => {
    expect(pathToSlug('People/Pedro-Franceschi.md')).toBe('people/pedro-franceschi');
  });

  test('strips leading slash', () => {
    expect(pathToSlug('/people/pedro.md')).toBe('people/pedro');
  });

  test('normalizes backslash separators', () => {
    expect(pathToSlug('people\\pedro.md')).toBe('people/pedro');
  });

  test('handles flat files', () => {
    expect(pathToSlug('notes.md')).toBe('notes');
  });

  test('handles nested paths', () => {
    expect(pathToSlug('projects/gbrain/spec.md')).toBe('projects/gbrain/spec');
  });

  test('adds repo prefix when provided', () => {
    expect(pathToSlug('people/pedro.md', 'brain')).toBe('brain/people/pedro');
  });

  test('no prefix when not provided', () => {
    expect(pathToSlug('people/pedro.md')).toBe('people/pedro');
  });

  test('handles empty string', () => {
    expect(pathToSlug('')).toBe('');
  });

  test('handles file with only extension', () => {
    expect(pathToSlug('.md')).toBe('');
  });

  test('slugifies spaces to hyphens', () => {
    expect(pathToSlug('Apple Notes/2017-05-03 ohmygreen.md')).toBe('apple-notes/2017-05-03-ohmygreen');
  });

  test('strips special characters', () => {
    expect(pathToSlug('notes/meeting (march 2024).md')).toBe('notes/meeting-march-2024');
  });
});

describe('isSyncable edge cases', () => {
  test('rejects uppercase .MD extension', () => {
    // isSyncable checks path.endsWith('.md'), so .MD should fail
    expect(isSyncable('people/someone.MD')).toBe(false);
  });

  test('rejects files with no extension', () => {
    expect(isSyncable('README')).toBe(false);
  });

  test('accepts deeply nested .md files', () => {
    expect(isSyncable('a/b/c/d/e/f/deep.md')).toBe(true);
  });

  test('rejects .md files inside nested hidden dirs', () => {
    expect(isSyncable('docs/.internal/secret.md')).toBe(false);
  });
});

describe('buildSyncManifest edge cases', () => {
  test('handles tab-separated fields correctly', () => {
    const output = "A\tpath/to/file.md";
    const manifest = buildSyncManifest(output);
    expect(manifest.added).toEqual(['path/to/file.md']);
  });

  test('handles multiple renames', () => {
    const output = [
      'R100\told/a.md\tnew/a.md',
      'R095\told/b.md\tnew/b.md',
    ].join('\n');
    const manifest = buildSyncManifest(output);
    expect(manifest.renamed).toHaveLength(2);
    expect(manifest.renamed[0].from).toBe('old/a.md');
    expect(manifest.renamed[1].from).toBe('old/b.md');
  });

  test('ignores unknown status codes', () => {
    const output = "X\tunknown/file.md";
    const manifest = buildSyncManifest(output);
    expect(manifest.added).toEqual([]);
    expect(manifest.modified).toEqual([]);
    expect(manifest.deleted).toEqual([]);
    expect(manifest.renamed).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// performSync dry-run (v0.17 regression guard for full-sync silent writes)
// ────────────────────────────────────────────────────────────────

describe('performSync dry-run never writes', () => {
  let engine: PGLiteEngine;
  let repoPath: string;

  // One PGLite per file — beforeEach wipes data only. Each test still gets a
  // fresh git repo via mkdtempSync, but skips the ~20s PGLite cold-start.
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-sync-dryrun-'));
    execSync('git init', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: repoPath, stdio: 'pipe' });
    mkdirSync(join(repoPath, 'people'), { recursive: true });
    writeFileSync(join(repoPath, 'people/alice.md'), [
      '---',
      'type: person',
      'title: Alice',
      '---',
      '',
      'Alice is a person.',
    ].join('\n'));
    writeFileSync(join(repoPath, 'people/bob.md'), [
      '---',
      'type: person',
      'title: Bob',
      '---',
      '',
      'Bob is another person.',
    ].join('\n'));
    execSync('git add -A && git commit -m "initial"', { cwd: repoPath, stdio: 'pipe' });
  });

  afterEach(() => {
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('first-sync dry-run does NOT write to DB or advance the bookmark', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const result = await performSync(engine, {
      repoPath,
      dryRun: true,
      noPull: true,
      noEmbed: true,
    });

    // Status + counts reflect what WOULD be imported.
    expect(result.status).toBe('dry_run');
    expect(result.added).toBe(2); // alice + bob, both syncable
    expect(result.chunksCreated).toBe(0);
    expect(result.embedded).toBe(0);

    // DB is clean: no pages written.
    expect(await engine.getPage('people/alice')).toBeNull();
    expect(await engine.getPage('people/bob')).toBeNull();

    // Bookmark NOT set — this is the regression the guard enforces.
    expect(await engine.getConfig('sync.last_commit')).toBeNull();
    expect(await engine.getConfig('sync.repo_path')).toBeNull();
  });

  test('first sync without origin skips git pull noise and uses local working tree', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const messages: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { messages.push(args.map(String).join(' ')); };
    try {
      const result = await performSync(engine, {
        repoPath,
        noEmbed: true,
      });
      expect(result.status).toBe('first_sync');
    } finally {
      console.error = originalError;
    }

    expect(messages.some(m => m.includes('No origin remote') && m.includes('skipping git pull'))).toBe(true);
    expect(messages.some(m => m.includes('sync.git_pull start'))).toBe(false);
    expect(messages.some(m => m.includes('git pull failed'))).toBe(false);
  });

  test('incremental dry-run does NOT write to DB or advance the bookmark', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    // First do a real sync to seed the bookmark.
    const real = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
    });
    expect(real.status).toBe('first_sync');
    const bookmarkAfterReal = await engine.getConfig('sync.last_commit');
    expect(bookmarkAfterReal).not.toBeNull();

    // Add a third file.
    writeFileSync(join(repoPath, 'people/carol.md'), [
      '---',
      'type: person',
      'title: Carol',
      '---',
      '',
      'Carol joins the cast.',
    ].join('\n'));
    execSync('git add -A && git commit -m "add carol"', { cwd: repoPath, stdio: 'pipe' });

    // Incremental sync in dry-run mode.
    const result = await performSync(engine, {
      repoPath,
      dryRun: true,
      noPull: true,
      noEmbed: true,
    });

    expect(result.status).toBe('dry_run');
    expect(result.added).toBe(1); // carol only
    expect(result.chunksCreated).toBe(0);
    expect(result.embedded).toBe(0);

    // carol is NOT in the DB.
    expect(await engine.getPage('people/carol')).toBeNull();
    // alice + bob still present from the real sync.
    expect(await engine.getPage('people/alice')).not.toBeNull();
    expect(await engine.getPage('people/bob')).not.toBeNull();

    // Bookmark unchanged — still at the pre-carol commit.
    const bookmarkAfterDry = await engine.getConfig('sync.last_commit');
    expect(bookmarkAfterDry).toBe(bookmarkAfterReal);
  });

  test('incremental dry-run does not delete a page that became unsyncable', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const real = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    expect(real.status).toBe('first_sync');
    const bookmarkBefore = await engine.getConfig('sync.last_commit');
    const aliceBefore = await engine.getPage('people/alice', { sourceId: 'default' });
    expect(aliceBefore).not.toBeNull();

    writeFileSync(
      join(repoPath, 'people/alice.md'),
      readFileSync(join(repoPath, 'people/alice.md'), 'utf-8') + '\nA committed update.\n',
    );
    execSync('git add -A && git commit -m "modify alice"', { cwd: repoPath, stdio: 'pipe' });

    const result = await performSync(engine, {
      repoPath,
      strategy: 'code',
      dryRun: true,
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });

    expect(result.status).toBe('dry_run');
    expect(await engine.getPage('people/alice', { sourceId: 'default' }))
      .toEqual(aliceBefore);
    expect(await engine.getConfig('sync.last_commit')).toBe(bookmarkBefore);
  });

  for (const mixed of [false, true]) {
    test(`incremental unsyncable cleanup absence proof blocks ${mixed ? 'mixed' : 'zero-change'} anchor on hostile restore`, async () => {
      const { performSync } = await import('../src/commands/sync.ts');
      await performSync(engine, {
        repoPath, noPull: true, noEmbed: true, noExtract: true,
      });
      const beforeRows = await engine.executeRaw<{ last_commit: string | null }>(
        `SELECT last_commit FROM sources WHERE id = 'default'`,
      );
      const before = beforeRows[0]?.last_commit ?? null;

      writeFileSync(
        join(repoPath, 'people/alice.md'),
        readFileSync(join(repoPath, 'people/alice.md'), 'utf8') + '\nChanged.\n',
      );
      if (mixed) {
        mkdirSync(join(repoPath, 'src'), { recursive: true });
        writeFileSync(join(repoPath, 'src', 'worker.ts'), 'export const worker = 1;\n');
      }
      execSync('git add -A && git commit -m "unsyncable delta"', { cwd: repoPath, stdio: 'pipe' });

      await expect(performSync(engine, {
        repoPath,
        strategy: 'code',
        noPull: true,
        noEmbed: true,
        noExtract: true,
        _hooks: {
          afterUnsyncableCleanup: async tx => {
            await tx.executeRaw(
              `INSERT INTO pages
                 (source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, source_path)
               VALUES
                 ('default', 'hostile-restore', 'person', 'Hostile restore', 'restored', '', '{}'::jsonb, 'hostile', 'people/alice.md')`,
            );
          },
        },
      })).rejects.toThrow(/cleanup absence proof failed/);

      const afterRows = await engine.executeRaw<{ last_commit: string | null }>(
        `SELECT last_commit FROM sources WHERE id = 'default'`,
      );
      expect(afterRows[0]?.last_commit ?? null).toBe(before);
      expect(await engine.getPage('people/alice', { sourceId: 'default' })).not.toBeNull();
      expect(await engine.getPage('hostile-restore', { sourceId: 'default' })).toBeNull();
    });
  }

  test('default-source cleanup ignores a foreign same-slug page during verification', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const first = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    expect(first.status).toBe('first_sync');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ('overlap-source', 'overlap-source', NULL, '{}'::jsonb)`,
    );
    await engine.putPage('people/alice', {
      type: 'person',
      title: 'Foreign Alice',
      compiled_truth: 'Foreign source authority.',
      source_path: 'foreign/alice.md',
    }, { sourceId: 'overlap-source' });

    writeFileSync(
      join(repoPath, 'people/alice.md'),
      readFileSync(join(repoPath, 'people/alice.md'), 'utf-8') + '\nA committed update.\n',
    );
    execSync('git add -A && git commit -m "modify alice"', { cwd: repoPath, stdio: 'pipe' });

    const result = await performSync(engine, {
      repoPath,
      strategy: 'code',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });

    expect(result.status).toBe('up_to_date');
    expect(await engine.getPage('people/alice', { sourceId: 'default' })).toBeNull();
    expect((await engine.getPage('people/alice', { sourceId: 'overlap-source' }))?.title)
      .toBe('Foreign Alice');
  });

  test('source sync refreshes last_sync_at when HEAD is unchanged', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const sourceId = 'stale-source';
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $1, $2, '{}'::jsonb)`,
      [sourceId, repoPath],
    );

    const first = await performSync(engine, {
      repoPath,
      sourceId,
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    expect(first.status).toBe('first_sync');

    const staleIso = '2000-01-01T00:00:00.000Z';
    await engine.executeRaw(
      `UPDATE sources SET last_sync_at = $1 WHERE id = $2`,
      [staleIso, sourceId],
    );

    const second = await performSync(engine, {
      repoPath,
      sourceId,
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    expect(second.status).toBe('up_to_date');

    const rows = await engine.executeRaw<{ last_sync_at: string | Date | null }>(
      `SELECT last_sync_at FROM sources WHERE id = $1`,
      [sourceId],
    );
    expect(rows[0].last_sync_at).not.toBeNull();
    expect(new Date(rows[0].last_sync_at!).getTime()).toBeGreaterThan(new Date(staleIso).getTime());
  });

  test('full-sync (--full) dry-run does NOT write to DB or advance the bookmark', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    // Seed the bookmark so we hit the full-sync-with-bookmark path when --full is set.
    await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    // Clear DB so we can observe that a --full dry-run doesn't re-import.
    await (engine as any).db.exec(`DELETE FROM content_chunks; DELETE FROM pages;`);
    const bookmarkBefore = await engine.getConfig('sync.last_commit');
    expect(bookmarkBefore).not.toBeNull();

    const result = await performSync(engine, {
      repoPath,
      full: true,        // force full-sync path
      dryRun: true,
      noPull: true,
      noEmbed: true,
    });

    expect(result.status).toBe('dry_run');
    expect(result.added).toBe(2); // alice + bob would be imported
    expect(result.chunksCreated).toBe(0);

    // DB empty — full-sync dry-run did not reimport.
    expect(await engine.getPage('people/alice')).toBeNull();
    expect(await engine.getPage('people/bob')).toBeNull();

    // Bookmark unchanged.
    const bookmarkAfter = await engine.getConfig('sync.last_commit');
    expect(bookmarkAfter).toBe(bookmarkBefore);
  });

  test('SyncResult exposes embedded count field', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const result = await performSync(engine, {
      repoPath,
      dryRun: true,
      noPull: true,
      noEmbed: true,
    });
    // Structural assertion: the contract includes `embedded: number`.
    expect(typeof result.embedded).toBe('number');
  });

  test('detached HEAD refuses uncommitted working-tree files', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const seeded = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    expect(seeded.status).toBe('first_sync');

    execSync('git checkout --detach HEAD', { cwd: repoPath, stdio: 'pipe' });
    writeFileSync(join(repoPath, 'people/detached-local.md'), [
      '---',
      'type: person',
      'title: Detached Local',
      '---',
      '',
      'This file exists only in the detached working tree.',
    ].join('\n'));

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };

    try {
      await expect(performSync(engine, {
        repoPath,
        noEmbed: true,
        noExtract: true,
      })).rejects.toThrow('Detached HEAD has uncommitted changes');
    } finally {
      console.error = originalError;
    }

    expect(errors.join('\n')).toContain(`Detached HEAD on ${repoPath}; skipping git pull. Syncing immutable HEAD only.`);
    expect(errors.join('\n')).not.toContain('git pull failed');

    const page = await engine.getPage('people/detached-local');
    expect(page).toBeNull();
  });

  test('detached HEAD with --no-pull ingests an exact committed detached tip', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const seeded = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    expect(seeded.status).toBe('first_sync');

    execSync('git checkout --detach HEAD', { cwd: repoPath, stdio: 'pipe' });
    writeFileSync(join(repoPath, 'people/detached-nopull.md'), [
      '---',
      'type: person',
      'title: Detached NoPull',
      '---',
      '',
      'Committed on a detached tip, --no-pull caller.',
    ].join('\n'));
    execSync('git add -A && git commit -m "detached committed tip"', { cwd: repoPath, stdio: 'pipe' });

    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });

    expect(result.status).toBe('synced');
    expect(result.added).toBe(1);
    expect(result.pagesAffected).toContain('people/detached-nopull');

    const page = await engine.getPage('people/detached-nopull');
    expect(page).not.toBeNull();
    expect(page!.title).toBe('Detached NoPull');
  });
});

describe('sync regression — #132 nested transaction deadlock', () => {
  test('src/commands/sync.ts does not wrap the add/modify loop in engine.transaction()', async () => {
    const source = await Bun.file(new URL('../src/commands/sync.ts', import.meta.url)).text();
    // Accept either of the historical loop shapes: the original inline
    // `for (const path of [...filtered.added, ...filtered.modified])` or
    // the v0.15.2 progress-wrapped variant where the list is hoisted into
    // a local `addsAndMods` variable first.
    const inlineIdx = source.indexOf('for (const path of [...filtered.added, ...filtered.modified]');
    const hoistedIdx = source.indexOf('const addsAndMods = [...filtered.added, ...filtered.modified]');
    const loopStart = inlineIdx !== -1 ? inlineIdx : hoistedIdx;
    expect(loopStart).toBeGreaterThan(-1);
    const prelude = source.slice(0, loopStart);
    const lastTxIdx = prelude.lastIndexOf('engine.transaction');
    if (lastTxIdx !== -1) {
      const lineStart = prelude.lastIndexOf('\n', lastTxIdx) + 1;
      const line = prelude.slice(lineStart, prelude.indexOf('\n', lastTxIdx));
      expect(line.trim().startsWith('//')).toBe(true);
    }
  });
});

describe('resolveSlugByPathOrSourcePath (CJK wave v0.32.7, codex F4)', () => {
  let pgEngine: PGLiteEngine;

  beforeAll(async () => {
    pgEngine = new PGLiteEngine();
    await pgEngine.connect({});
    await pgEngine.initSchema();
  });

  afterAll(async () => {
    await pgEngine.disconnect();
  });

  beforeEach(async () => {
    await (pgEngine as any).db.exec('DELETE FROM content_chunks');
    await (pgEngine as any).db.exec('DELETE FROM pages');
  });

  test('returns stored slug when source_path matches a row', async () => {
    const { resolveSlugByPathOrSourcePath } = await import('../src/commands/sync.ts');
    // Seed a frontmatter-fallback page: slug doesn't derive from path (emoji)
    await pgEngine.executeRaw(
      `INSERT INTO pages (slug, type, title, compiled_truth, page_kind, source_path)
       VALUES ('projects/launch', 'project', 'Launch', 'body', 'markdown', '🚀.md')`,
    );
    const slug = await resolveSlugByPathOrSourcePath(pgEngine, '🚀.md');
    expect(slug).toBe('projects/launch');
  });

  test('returns null when no source_path matches (never authorizes a guessed mutation)', async () => {
    const { resolveSlugByPathOrSourcePath } = await import('../src/commands/sync.ts');
    // No row seeded: a coincidentally path-shaped manual page is not file-owned.
    const slug = await resolveSlugByPathOrSourcePath(pgEngine, 'concepts/hello-world.md');
    expect(slug).toBeNull();
  });

  test('propagates ownership lookup errors so cleanup cannot advance stale rows', async () => {
    const { resolveSlugByPathOrSourcePath } = await import('../src/commands/sync.ts');
    (pgEngine as any).resolveSlugsByPaths = async () => {
      throw new Error('ownership database unavailable');
    };
    try {
      await expect(resolveSlugByPathOrSourcePath(pgEngine, 'people/alice.md'))
        .rejects.toThrow('ownership database unavailable');
    } finally {
      delete (pgEngine as any).resolveSlugsByPaths;
    }
  });

  test('scoped by source_id when provided', async () => {
    const { resolveSlugByPathOrSourcePath } = await import('../src/commands/sync.ts');
    // Same source_path under TWO sources — without source_id scope we'd
    // get either at random. With source_id we get the right one.
    await pgEngine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('source-a', 'A') ON CONFLICT DO NOTHING`,
    );
    await pgEngine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('source-b', 'B') ON CONFLICT DO NOTHING`,
    );
    await pgEngine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, page_kind, source_path)
       VALUES ('source-a', 'slug-a/page', 'note', 'A', 'a', 'markdown', '🚀.md')`,
    );
    await pgEngine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, page_kind, source_path)
       VALUES ('source-b', 'slug-b/page', 'note', 'B', 'b', 'markdown', '🚀.md')`,
    );
    expect(await resolveSlugByPathOrSourcePath(pgEngine, '🚀.md', 'source-a')).toBe('slug-a/page');
    expect(await resolveSlugByPathOrSourcePath(pgEngine, '🚀.md', 'source-b')).toBe('slug-b/page');
  });

  test('legacy undefined scope means default only, never another source', async () => {
    const { resolveSlugByPathOrSourcePath } = await import('../src/commands/sync.ts');
    await pgEngine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('source-b', 'B') ON CONFLICT DO NOTHING`,
    );
    await pgEngine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, page_kind, source_path)
       VALUES ('default', 'shared/page', 'note', 'Manual default', 'manual', 'markdown', NULL)`,
    );
    await pgEngine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, page_kind, source_path)
       VALUES ('source-b', 'shared/page', 'note', 'File B', 'b', 'markdown', 'shared/page.md')`,
    );

    expect(await resolveSlugByPathOrSourcePath(pgEngine, 'shared/page.md')).toBeNull();
    expect(await resolveSlugByPathOrSourcePath(pgEngine, 'shared/page.md', 'source-b'))
      .toBe('shared/page');
  });
});

describe('git() helper invocation order (CJK wave v0.32.7)', () => {
  // The git CLI requires `-c key=val` to appear BEFORE the subcommand,
  // and `-C path` BEFORE the subcommand too. Pin the emit order so a future
  // refactor can't silently put `-c` after the subcommand and break CJK
  // path emission.

  test('core.quotepath=false is always emitted first', () => {
    const argv = buildGitInvocation('/repo', ['diff', '--name-status']);
    expect(argv).toEqual([
      '--no-replace-objects',
      '-c', 'core.quotepath=false',
      '-c', 'core.fsmonitor=false',
      '-C', '/repo',
      'diff', '--name-status',
    ]);
  });

  test('extra configs append AFTER quotepath, BEFORE -C and subcommand', () => {
    const argv = buildGitInvocation('/repo', ['diff'], ['foo=bar', 'baz=qux']);
    expect(argv).toEqual([
      '--no-replace-objects',
      '-c', 'core.quotepath=false',
      '-c', 'core.fsmonitor=false',
      '-c', 'foo=bar',
      '-c', 'baz=qux',
      '-C', '/repo',
      'diff',
    ]);
  });

  test('empty args produces a valid invocation', () => {
    const argv = buildGitInvocation('/repo', []);
    expect(argv).toEqual([
      '--no-replace-objects',
      '-c', 'core.quotepath=false',
      '-c', 'core.fsmonitor=false',
      '-C', '/repo',
    ]);
  });
});

describe('sync sentinel remediation', () => {
  test('reports every applicable integrity recovery action', () => {
    const message = formatSyncSentinelRemediation([
      '<git-snapshot>', '<delete-reconcile>', '<rename>', '<head>',
    ]);
    expect(message).toContain('object-store integrity');
    expect(message).toContain('file-backed row');
    expect(message).toContain('slug/path collision');
    expect(message).toContain('pin current HEAD');
  });

  test('a clean rerun resolves an old head sentinel instead of leaving a permanent ledger block', () => {
    expect(resolvedIntegritySentinelPaths({
      headFailed: false,
      renameFailed: false,
      deleteFailed: false,
      snapshotAuthorityFailed: false,
    })).toContain('<head>');
    expect(resolvedIntegritySentinelPaths({
      headFailed: true,
      renameFailed: false,
      deleteFailed: false,
      snapshotAuthorityFailed: false,
    })).not.toContain('<head>');
  });
});

describe('sync auto-embed arguments', () => {
  test('scopes incremental source sync embedding to the same source', () => {
    expect(buildAutoEmbedArgs(['hello-js'], 'source-a')).toEqual([
      '--source',
      'source-a',
      '--slugs',
      'hello-js',
    ]);
  });

  test('keeps default-source sync embed arguments unchanged', () => {
    expect(buildAutoEmbedArgs(['people/alice'])).toEqual(['--slugs', 'people/alice']);
  });
});

// #1970: sync silently full-walks forever when last_commit is unreachable.
// The bookmark can point at a commit orphaned by a history rewrite (force-push,
// master→main consolidation, squash). The old guard sent BOTH "object missing"
// AND "not an ancestor" to a blind full re-walk that never advanced the bookmark.
// The fix: only a truly-absent object forces a full reconcile; a present-but-
// non-ancestor bookmark is diffed tree-to-tree directly (`git diff A..B` needs
// no ancestry). Plus F-A (full-sync delete reconcile), F-B (oversized-diff
// fallback), F-C (rename-to-unsyncable deletes the old page).
describe('#1970: unreachable last_commit bookmark recovery', () => {
  let engine: PGLiteEngine;
  const repos: string[] = [];
  const FIXTURE_GIT_CONFIG = [
    'core.hooksPath=/dev/null',
    'commit.gpgSign=false',
    'tag.gpgSign=false',
    'user.useConfigOnly=true',
    'user.name=GBrain Sync Fixture',
    'user.email=gbrain-sync-fixture@example.invalid',
  ];

  function fixtureGit(repoPath: string, args: string[]): string {
    return execFileSync(
      'git',
      buildGitInvocation(repoPath, args, FIXTURE_GIT_CONFIG),
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
        env: gitAuthorityEnvironment(),
      },
    ).trim();
  }

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
  });

  afterEach(() => {
    while (repos.length) {
      const d = repos.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  function personMd(title: string, body: string): string {
    return ['---', 'type: person', `title: ${title}`, '---', '', body].join('\n');
  }

  /** Create a temp git repo seeded with the given files + an initial commit. */
  function mkRepo(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-1970-'));
    repos.push(dir);
    fixtureGit(dir, ['init', '--initial-branch=main']);
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    fixtureGit(dir, ['add', '-A']);
    fixtureGit(dir, ['commit', '-m', 'initial']);
    return dir;
  }

  const SYNC_OPTS = { noPull: true, noEmbed: true, noExtract: true, sourceId: 'default' } as const;

  async function bookmark(): Promise<string | null> {
    const rows = await engine.executeRaw<{ last_commit: string | null }>(
      `SELECT last_commit FROM sources WHERE id = 'default'`,
    );
    return rows[0]?.last_commit ?? null;
  }

  async function captureLog<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      const result = await fn();
      return { result, out: lines.join('\n') };
    } finally {
      console.log = origLog;
    }
  }

  test('[CRITICAL] attached full sync imports committed bytes, not dirty same-path edits', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({
      'people/alice-example.md': personMd('Alice Example', 'Committed authority.'),
    });

    // Dirty the attached checkout after HEAD is fixed. Full sync must enumerate
    // and read HEAD's tree, not the mutable file that happens to be on disk.
    writeFileSync(
      join(repo, 'people/alice-example.md'),
      personMd('Alice Example', 'Mutable worktree poison.'),
    );

    const result = await performSync(engine, { repoPath: repo, full: true, ...SYNC_OPTS });
    expect(result.status).toBe('first_sync');
    const page = await engine.getPage('people/alice-example', { sourceId: 'default' });
    expect(page?.compiled_truth).toContain('Committed authority.');
    expect(page?.compiled_truth).not.toContain('Mutable worktree poison.');
  });

  test('orphan-present (not an ancestor): diffs tree-to-tree, imports only the delta, advances bookmark', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({
      'people/alice.md': personMd('Alice', 'Alice is a person.'),
      'people/bob.md': personMd('Bob', 'Bob is a person.'),
    });

    const first = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(first.status).toBe('first_sync');
    const orphan = await bookmark();
    expect(orphan).not.toBeNull();

    // Rewrite history: amend the only commit (adds delta.md). The previous tip
    // is now orphaned but still on disk — cat-file succeeds, is-ancestor fails.
    writeFileSync(join(repo, 'people/carol.md'), personMd('Carol', 'Carol joins.'));
    fixtureGit(repo, ['add', '-A']);
    fixtureGit(repo, ['commit', '--amend', '-m', 'amended with carol']);

    // Sanity: the stored bookmark is present but no longer an ancestor of HEAD.
    expect(fixtureGit(repo, ['cat-file', '-t', orphan!])).toBe('commit');
    let isAncestor = true;
    try { fixtureGit(repo, ['merge-base', '--is-ancestor', orphan!, 'HEAD']); }
    catch { isAncestor = false; }
    expect(isAncestor).toBe(false);

    const { result, out } = await captureLog(() => performSync(engine, { repoPath: repo, ...SYNC_OPTS }));

    // Incremental diff path (status 'synced'), NOT a full re-walk ('first_sync').
    expect(result.status).toBe('synced');
    expect(result.added).toBe(1);
    expect(out).toContain('not an ancestor of HEAD');
    expect(await engine.getPage('people/carol')).not.toBeNull();
    // Bookmark advanced off the orphan onto the rewritten HEAD.
    const advanced = await bookmark();
    expect(advanced).not.toBe(orphan);
    expect(advanced).toBe(fixtureGit(repo, ['rev-parse', 'HEAD']));
  });

  test('orphan-absent (object gc\'d): falls back to a full reconcile', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/alice.md': personMd('Alice', 'Alice is a person.') });

    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    // Simulate an orphaned-AND-pruned bookmark: a valid-shaped SHA with no object.
    await engine.executeRaw(
      `UPDATE sources SET last_commit = $1 WHERE id = 'default'`,
      ['deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
    );
    writeFileSync(join(repo, 'people/bob.md'), personMd('Bob', 'Bob is a person.'));
    fixtureGit(repo, ['add', '-A']);
    fixtureGit(repo, ['commit', '-m', 'add bob']);

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    // Object absent → authoritative full reconcile.
    expect(result.status).toBe('first_sync');
    expect(await engine.getPage('people/bob')).not.toBeNull();
    expect(await engine.getPage('people/alice')).not.toBeNull();
  });

  test('divergence: a file present in the orphan tree but dropped from HEAD is deleted', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({
      'people/alice.md': personMd('Alice', 'Alice is a person.'),
      'people/bob.md': personMd('Bob', 'Bob is a person.'),
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('people/bob')).not.toBeNull();

    // Rewrite the tip: drop bob, edit alice. Orphans the prior tip (still on disk).
    fixtureGit(repo, ['rm', 'people/bob.md']);
    writeFileSync(join(repo, 'people/alice.md'), personMd('Alice', 'Alice was corrected.'));
    fixtureGit(repo, ['add', '-A']);
    fixtureGit(repo, ['commit', '--amend', '-m', 'drop bob, edit alice']);

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(await engine.getPage('people/bob')).toBeNull();          // deleted
    const alice = await engine.getPage('people/alice');
    expect(alice!.compiled_truth).toContain('corrected');           // updated
  });

  test('F-C: a rename whose destination is unsyncable deletes the old page', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('people/carol')).not.toBeNull();

    // git mv keeps content identical → classified as a 100% rename (R100).
    // The destination .txt is unsyncable, so without the F-C fix the old page
    // would linger (the rename drops out of both `renamed` and `deleted`).
    fixtureGit(repo, ['mv', 'people/carol.md', 'people/carol.txt']);
    fixtureGit(repo, ['commit', '-m', 'rename carol to txt']);

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(await engine.getPage('people/carol')).toBeNull();
  });

  test('[CRITICAL] regular file to symlink deletes the stale indexed page', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/alice.md': personMd('Alice', 'Regular committed page.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('people/alice')).not.toBeNull();

    rmSync(join(repo, 'people/alice.md'));
    symlinkSync('../outside.md', join(repo, 'people/alice.md'));
    fixtureGit(repo, ['add', '-A']);
    fixtureGit(repo, ['commit', '-m', 'regular to symlink']);

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(await engine.getPage('people/alice')).toBeNull();
  });

  test('[CRITICAL] absent source_path mapping never deletes a guessed manual/legacy slug', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/alice.md': personMd('Alice', 'Legacy row.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    await engine.executeRaw(
      `UPDATE pages SET source_path = NULL WHERE source_id = 'default' AND slug = 'people/alice'`,
    );
    fixtureGit(repo, ['rm', 'people/alice.md']);
    fixtureGit(repo, ['commit', '-m', 'remove unowned path']);

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(await engine.getPage('people/alice', { sourceId: 'default' })).not.toBeNull();
  });

  test('[CRITICAL] frontmatter-fallback rename never calls updateSlug with an empty slug', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const fallbackPage = [
      '---', 'type: project', 'title: Launch', 'slug: projects/launch', '---', '',
      'Committed launch context.',
    ].join('\n');
    const repo = mkRepo({ '🚀.md': fallbackPage });
    const first = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(first.status).toBe('first_sync');
    expect(await engine.getPage('projects/launch', { sourceId: 'default' })).not.toBeNull();

    renameSync(join(repo, '🚀.md'), join(repo, 'شروع.md'));
    fixtureGit(repo, ['add', '-A']);
    fixtureGit(repo, ['commit', '-m', 'rename fallback path']);

    const renamed = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(renamed.status).toBe('synced');
    const rows = await engine.executeRaw<{ slug: string; source_path: string | null }>(
      `SELECT slug, source_path FROM pages WHERE source_id = 'default' AND slug = 'projects/launch'`,
    );
    expect(rows).toEqual([{ slug: 'projects/launch', source_path: 'شروع.md' }]);
  });

  test('[CRITICAL] atomic markdown rename preserves identity, graph, history, and slug metadata', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const page = [
      '---',
      'type: person',
      'title: Alice',
      'aliases:',
      '  - Alice Alpha',
      'tags:',
      '  - keeper',
      '---',
      '',
      'Canonical Alice context.',
    ].join('\n');
    const repo = mkRepo({ 'people/alice.md': page });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    const oldPage = await engine.getPage('people/alice', { sourceId: 'default' });
    expect(oldPage).not.toBeNull();
    await engine.putPage('notes/reference', {
      type: 'note', title: 'Reference', compiled_truth: 'Points to Alice.',
    }, { sourceId: 'default' });
    await engine.addLink(
      'notes/reference', 'people/alice', 'manual relationship', 'mentions', 'manual',
      undefined, undefined,
      { fromSourceId: 'default', toSourceId: 'default', originSourceId: 'default' },
    );
    await engine.addTag('people/alice', 'manual-enrichment', { sourceId: 'default' });
    await engine.addTimelineEntry('people/alice', {
      date: '2026-01-02', source: 'manual', summary: 'Manual milestone',
    }, { sourceId: 'default' });
    await engine.createVersion('people/alice', { sourceId: 'default' });
    await engine.executeRaw(
      `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug)
       VALUES ('default', 'people/legacy-alice', 'people/alice')`,
    );
    await engine.executeRaw(
      `INSERT INTO facts
         (source_id, entity_slug, fact, source, source_markdown_slug, row_num)
       VALUES
         ('default', 'people/alice', 'self fact', 'test', 'people/alice', 1),
         ('default', 'people/alice', 'referenced fact', 'test', 'notes/reference', 1)`,
    );
    await engine.executeRaw(
      `INSERT INTO take_proposals
         (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
          status, claim_text, kind, holder, weight, model_id)
       VALUES
         ('default', 'people/alice', 'proposal-hash', 'v1', 'rename-run',
          'pending', 'pending claim', 'belief', 'alice', 0.5, 'test-model')`,
    );
    await engine.executeRaw(
      `INSERT INTO context_volunteer_events
         (source_id, slug, confidence, match_arm, rationale)
       VALUES ('default', 'people/alice', 0.9, 'test', 'rename coverage')`,
    );
    await engine.upsertFile({
      source_id: 'default',
      page_slug: 'people/alice',
      page_id: oldPage!.id,
      filename: 'alice.bin',
      storage_path: 'attachments/alice.bin',
      content_hash: 'fixture-hash',
    });
    const versionsBefore = await engine.getVersions('people/alice', { sourceId: 'default' });

    fixtureGit(repo, ['mv', 'people/alice.md', 'people/alice-renamed.md']);
    fixtureGit(repo, ['commit', '-m', 'rename alice atomically']);
    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    expect(result.status).toBe('synced');
    expect(await engine.getPage('people/alice', { sourceId: 'default' })).toBeNull();
    const renamed = await engine.getPage('people/alice-renamed', { sourceId: 'default' });
    expect(renamed?.id).toBe(oldPage!.id);
    expect((await engine.getBacklinks('people/alice-renamed', { sourceId: 'default' }))[0]?.from_slug)
      .toBe('notes/reference');
    expect(await engine.getTags('people/alice-renamed', { sourceId: 'default' }))
      .toEqual(expect.arrayContaining(['keeper', 'manual-enrichment']));
    expect((await engine.getTimeline('people/alice-renamed', { sourceId: 'default' }))[0]?.summary)
      .toBe('Manual milestone');
    expect((await engine.getVersions('people/alice-renamed', { sourceId: 'default' })).length)
      .toBeGreaterThan(versionsBefore.length);

    const aliasRows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM page_aliases
        WHERE source_id = 'default' AND alias_norm = 'alice alpha'
        ORDER BY slug`,
    );
    expect(aliasRows).toEqual([{ slug: 'people/alice-renamed' }]);
    expect(await engine.resolveSlugWithAlias('people/legacy-alice', 'default'))
      .toBe('people/alice-renamed');
    const factKeys = await engine.executeRaw<{
      entity_slug: string | null;
      source_markdown_slug: string | null;
    }>(
      `SELECT entity_slug, source_markdown_slug FROM facts
        WHERE source_id = 'default' ORDER BY fact`,
    );
    expect(factKeys).toEqual([
      // Entity identity and Markdown provenance are independent foreign keys:
      // an entity rename migrates entity_slug even when another page supplied
      // the evidence, while preserving that source page's provenance slug.
      { entity_slug: 'people/alice-renamed', source_markdown_slug: 'notes/reference' },
      { entity_slug: 'people/alice-renamed', source_markdown_slug: 'people/alice-renamed' },
    ]);
    expect((await engine.executeRaw<{ page_slug: string }>(
      `SELECT page_slug FROM take_proposals WHERE proposal_run_id = 'rename-run'`,
    ))).toEqual([{ page_slug: 'people/alice-renamed' }]);
    expect((await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM context_volunteer_events WHERE rationale = 'rename coverage'`,
    ))).toEqual([{ slug: 'people/alice-renamed' }]);
    const file = await engine.getFile('default', 'attachments/alice.bin');
    expect(file?.page_slug).toBe('people/alice-renamed');
    expect(file?.page_id).toBe(oldPage!.id);
  });

  test('[CRITICAL] rename commit replays cleanly after crash before sync checkpoint', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const { importFileContent } = await import('../src/core/import-file.ts');
    const repo = mkRepo({ 'people/old.md': personMd('Old', 'Replay-safe body.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    const before = await bookmark();
    const oldId = (await engine.getPage('people/old', { sourceId: 'default' }))!.id;

    fixtureGit(repo, ['mv', 'people/old.md', 'people/new.md']);
    fixtureGit(repo, ['commit', '-m', 'rename before simulated checkpoint crash']);
    const committed = await importFileContent(
      engine,
      readFileSync(join(repo, 'people/new.md'), 'utf8'),
      'people/new.md',
      {
        noEmbed: true,
        sourceId: 'default',
        forceRechunk: true,
        renameFromSlug: 'people/old',
        renameFromSourcePath: 'people/old.md',
      },
    );
    expect(committed.status).toBe('imported');
    expect(await bookmark()).toBe(before);
    expect((await engine.getPage('people/new', { sourceId: 'default' }))?.id).toBe(oldId);

    const resumed = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(resumed.status).toBe('synced');
    expect((await engine.getPage('people/new', { sourceId: 'default' }))?.id).toBe(oldId);
    expect(await bookmark()).toBe(fixtureGit(repo, ['rev-parse', 'HEAD']));
  });

  test('[CRITICAL] failed rename import rolls the old canonical slug back', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const explicitSlugPage = [
      '---', 'type: person', 'title: Alice', 'slug: people/alice', '---', '',
      'Canonical Alice context.',
    ].join('\n');
    const repo = mkRepo({ 'people/alice.md': explicitSlugPage });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    const before = await bookmark();

    // The committed destination is invalid until its explicit slug is also
    // changed. The importer must block without leaving the DB half-renamed.
    fixtureGit(repo, ['mv', 'people/alice.md', 'people/bob.md']);
    fixtureGit(repo, ['commit', '-m', 'rename without updating explicit slug']);
    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    expect(result.status).toBe('blocked_by_failures');
    expect(await bookmark()).toBe(before);
    expect(await engine.getPage('people/alice', { sourceId: 'default' })).not.toBeNull();
    expect(await engine.getPage('people/bob', { sourceId: 'default' })).toBeNull();
  });

  test('[CRITICAL] unrelated destination collision leaves both canonical pages untouched', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/old.md': personMd('Old', 'Original source page.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    await engine.putPage('people/new', {
      type: 'person', title: 'Unrelated New', compiled_truth: 'Do not overwrite.',
    }, { sourceId: 'default' });
    const before = await bookmark();

    fixtureGit(repo, ['mv', 'people/old.md', 'people/new.md']);
    fixtureGit(repo, ['commit', '-m', 'rename into occupied slug']);
    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    expect(result.status).toBe('blocked_by_failures');
    expect(await bookmark()).toBe(before);
    expect((await engine.getPage('people/old', { sourceId: 'default' }))?.compiled_truth)
      .toContain('Original source page.');
    expect((await engine.getPage('people/new', { sourceId: 'default' }))?.compiled_truth)
      .toBe('Do not overwrite.');
  });

  test('[CRITICAL] rename destination alias collision preserves canonical ownership', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/old.md': personMd('Old', 'Original source page.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    await engine.putPage('people/other', {
      type: 'person', title: 'Other', compiled_truth: 'Alias owner.',
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug)
       VALUES ('default', 'people/new', 'people/other')`,
    );
    const before = await bookmark();

    fixtureGit(repo, ['mv', 'people/old.md', 'people/new.md']);
    fixtureGit(repo, ['commit', '-m', 'rename into alias collision']);
    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    expect(result.status).toBe('blocked_by_failures');
    expect(await bookmark()).toBe(before);
    expect(await engine.getPage('people/old', { sourceId: 'default' })).not.toBeNull();
    expect(await engine.getPage('people/new', { sourceId: 'default' })).toBeNull();
    expect(await engine.resolveSlugWithAlias('people/new', 'default')).toBe('people/other');
  });

  test('[CRITICAL] custom-slug delete blocks on resolver failure or unverified fallback', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/alice.md': personMd('Alice', 'Custom slug target.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    await engine.updateSlug('people/alice', 'custom/alice', { sourceId: 'default' });
    const before = await bookmark();
    fixtureGit(repo, ['rm', 'people/alice.md']);
    fixtureGit(repo, ['commit', '-m', 'remove custom slug page']);

    try {
      (engine as any).resolveSlugsByPaths = async () => { throw new Error('resolver unavailable'); };
      const resolverBlocked = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
      expect(resolverBlocked.status).toBe('blocked_by_failures');
      expect(await bookmark()).toBe(before);
      expect(await engine.getPage('custom/alice')).not.toBeNull();

      // An empty/incorrect map must also fail verification instead of deleting a
      // guessed path slug and advancing past the still-live custom row.
      (engine as any).resolveSlugsByPaths = async () => new Map();
      const verifyBlocked = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
      expect(verifyBlocked.status).toBe('blocked_by_failures');
      expect(await bookmark()).toBe(before);
      expect(await engine.getPage('custom/alice')).not.toBeNull();
    } finally {
      // Remove the instance seam so transaction-scoped engines inherit the
      // prototype method with their own receiver. Restoring a bound root-engine
      // function would query the root PGLite connection while its tx is open.
      delete (engine as any).resolveSlugsByPaths;
    }
    const resumed = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(resumed.status).toBe('synced');
    expect(await engine.getPage('custom/alice')).toBeNull();
    expect(await bookmark()).toBe(fixtureGit(repo, ['rev-parse', 'HEAD']));
  });

  test('F-A: full reconcile purges stale file-backed pages but spares manual + metafile pages', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({
      'people/alice.md': personMd('Alice', 'Alice is a person.'),
      'people/bob.md': personMd('Bob', 'Bob is a person.'),
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    // A manually-curated page (put_page) — source_path stays NULL.
    await engine.putPage('manual/note', {
      type: 'note', title: 'Manual Note', compiled_truth: 'Hand-authored, not from a file.',
    }, { sourceId: 'default' });
    // A metafile-backed page (e.g. an older import or direct put_page of log.md).
    // Its source_path is unsyncable, so the reconcile must NOT delete it (#1433).
    await engine.putPage('people/log', {
      type: 'note', title: 'Log', compiled_truth: 'metafile page', source_path: 'people/log.md',
    }, { sourceId: 'default' });

    // Delete bob's backing file, then force a full reconcile.
    fixtureGit(repo, ['rm', 'people/bob.md']);
    fixtureGit(repo, ['commit', '-m', 'remove bob']);

    const result = await performSync(engine, { repoPath: repo, full: true, ...SYNC_OPTS });
    expect(result.status).toBe('first_sync');
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    expect(await engine.getPage('people/bob')).toBeNull();          // stale file-backed → purged
    expect(await engine.getPage('people/alice')).not.toBeNull();    // still present → kept
    expect(await engine.getPage('manual/note')).not.toBeNull();     // null source_path → spared
    expect(await engine.getPage('people/log')).not.toBeNull();      // metafile source_path → spared
  });

  test('[CRITICAL] a stale row restored before final selection is deleted in the anchor transaction', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({
      'people/alice.md': personMd('Alice', 'Alice is a person.'),
      'people/bob.md': personMd('Bob', 'Bob is a person.'),
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    fixtureGit(repo, ['rm', 'people/bob.md']);
    fixtureGit(repo, ['commit', '-m', 'remove bob for restore race']);
    const head = fixtureGit(repo, ['rev-parse', 'HEAD']);

    const result = await performSync(engine, {
      repoPath: repo,
      full: true,
      ...SYNC_OPTS,
      _hooks: {
        beforeBookmarkFinalize: async () => {
          // Simulate an out-of-band restore immediately before the final
          // transaction. The transaction must select and retire this exact
          // stale owner before advancing the anchor.
          await engine.executeRaw(
            `INSERT INTO pages
               (source_id, slug, type, title, compiled_truth, timeline, frontmatter,
                source_path, content_hash, deleted_at)
             VALUES
               ('default', 'people/bob', 'person', 'Bob', 'restored stale row', '',
                '{}'::jsonb, 'people/bob.md', 'restored-stale', NULL)
             ON CONFLICT (source_id, slug) DO UPDATE
               SET deleted_at = NULL,
                   source_path = EXCLUDED.source_path,
                   compiled_truth = EXCLUDED.compiled_truth,
                   content_hash = EXCLUDED.content_hash`,
          );
        },
      },
    });
    expect(result.status).toBe('first_sync');
    expect(await bookmark()).toBe(head);
    expect(await engine.getPage('people/bob', { sourceId: 'default' })).toBeNull();
  });

  test('[CRITICAL] exact full-delete proof spares a row reclassified after selection', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({
      'people/alice.md': personMd('Alice', 'Alice is a person.'),
      'people/bob.md': personMd('Bob', 'Bob is a person.'),
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    fixtureGit(repo, ['rm', 'people/bob.md']);
    fixtureGit(repo, ['commit', '-m', 'remove bob for reclassification race']);
    const head = fixtureGit(repo, ['rev-parse', 'HEAD']);
    let selected = false;

    const result = await performSync(engine, {
      repoPath: repo,
      full: true,
      ...SYNC_OPTS,
      _hooks: {
        afterFullStaleSelection: async (tx, rows) => {
          expect(rows.some(row => row.slug === 'people/bob' && row.sourcePath === 'people/bob.md')).toBe(true);
          selected = true;
          // Exact delete candidates were selected with the old path. Change
          // the row to a non-syncable/manual path before the DELETE executes.
          await tx.executeRaw(
            `UPDATE pages
                SET source_path = 'manual.json'
              WHERE source_id = 'default'
                AND slug = 'people/bob'
                AND source_path = 'people/bob.md'`,
          );
        },
      },
    });

    expect(selected).toBe(true);
    expect(result.status).toBe('first_sync');
    expect(await bookmark()).toBe(head);
    const bob = await engine.executeRaw<{ source_path: string }>(
      `SELECT source_path FROM pages
        WHERE source_id = 'default' AND slug = 'people/bob' AND deleted_at IS NULL`,
    );
    expect(bob).toHaveLength(1);
    expect(bob[0]!.source_path).toBe('manual.json');
    expect(result.deleted).toBe(0);
  });

  test('[CRITICAL] full delete failure blocks bookmark; retry reconciles then advances', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({
      'people/alice.md': personMd('Alice', 'Alice is a person.'),
      'people/bob.md': personMd('Bob', 'Bob is a person.'),
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    const before = await bookmark();
    fixtureGit(repo, ['rm', 'people/bob.md']);
    fixtureGit(repo, ['commit', '-m', 'remove bob']);
    const head = fixtureGit(repo, ['rev-parse', 'HEAD']);

    const blocked = await performSync(engine, {
      repoPath: repo,
      full: true,
      ...SYNC_OPTS,
      _hooks: {
        afterFullStaleSelection: async () => {
          throw new Error('simulated atomic delete outage');
        },
      },
    });
    expect(blocked!.status).toBe('blocked_by_failures');
    expect(await bookmark()).toBe(before);
    expect(await engine.getPage('people/bob')).not.toBeNull();

    const resumed = await performSync(engine, { repoPath: repo, full: true, ...SYNC_OPTS });
    expect(resumed.status).toBe('first_sync');
    expect(await engine.getPage('people/bob')).toBeNull();
    expect(await bookmark()).toBe(head);
  });

  test('F-B: an undiffable-but-present bookmark falls back to a full reconcile instead of throwing', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/alice.md': personMd('Alice', 'Alice is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    // A blob SHA: cat-file -t succeeds ("blob", so objectPresent=true), but
    // `git diff <blob>..HEAD` errors — the same failure shape as an oversized
    // post-rewrite diff hitting git()'s timeout/buffer limits. Must fall back,
    // not throw.
    const blob = fixtureGit(repo, ['rev-parse', 'HEAD:people/alice.md']);
    await engine.executeRaw(`UPDATE sources SET last_commit = $1 WHERE id = 'default'`, [blob]);

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('first_sync');                       // fell back cleanly
    expect(await engine.getPage('people/alice')).not.toBeNull();
  });

  test('convergence: after orphan recovery, a later commit syncs incrementally to up_to_date', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/alice.md': personMd('Alice', 'Alice is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    // Orphan + recover.
    writeFileSync(join(repo, 'people/bob.md'), personMd('Bob', 'Bob is a person.'));
    fixtureGit(repo, ['add', '-A']);
    fixtureGit(repo, ['commit', '--amend', '-m', 'amended with bob']);
    const recovered = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(recovered.status).toBe('synced');

    // A subsequent ordinary commit now syncs incrementally (bookmark is sane).
    writeFileSync(join(repo, 'people/carol.md'), personMd('Carol', 'Carol joins.'));
    fixtureGit(repo, ['add', '-A']);
    fixtureGit(repo, ['commit', '-m', 'add carol']);
    const next = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(next.status).toBe('synced');
    expect(next.added).toBe(1);

    // No further changes → up_to_date (converged).
    const settled = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(settled.status).toBe('up_to_date');
  });

  test('incremental ingest audit is stamped with the synced source_id', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/alice.md': personMd('Alice', 'Initial source page.') });
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path)
       VALUES ('source-a', 'Source A', $1)`,
      [repo],
    );
    const sourceOpts = { ...SYNC_OPTS, sourceId: 'source-a' } as const;
    await performSync(engine, { repoPath: repo, ...sourceOpts });

    writeFileSync(join(repo, 'people/alice.md'), personMd('Alice', 'Incremental update.'));
    fixtureGit(repo, ['add', '-A']);
    fixtureGit(repo, ['commit', '-m', 'update alice']);
    const result = await performSync(engine, { repoPath: repo, ...sourceOpts });
    expect(result.status).toBe('synced');

    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM ingest_log
        WHERE source_type = 'git_sync'
        ORDER BY id DESC LIMIT 1`,
    );
    expect(rows).toEqual([{ source_id: 'source-a' }]);
  });
});
