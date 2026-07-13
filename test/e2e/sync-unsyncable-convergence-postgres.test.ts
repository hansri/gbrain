import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performSync } from '../../src/commands/sync.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { getPostgresTestUrl } from '../helpers/postgres-test-authority.ts';

const DATABASE_URL = getPostgresTestUrl();

describe.skipIf(!DATABASE_URL)('Postgres incremental unsyncable convergence', () => {
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => engine?.disconnect());

  for (const mixed of [false, true]) {
    test(`${mixed ? 'mixed' : 'zero-change'} path aborts anchor when a row is restored after cleanup`, async () => {
      const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
      const sourceId = `e2e-unsync-${suffix}`;
      const repo = mkdtempSync(join(tmpdir(), 'gbrain-e2e-unsync-'));
      const git = (...args: string[]): string => execFileSync('git', args, {
        cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      try {
        git('init', '-q', '-b', 'main');
        git('config', 'user.email', 'test@example.invalid');
        git('config', 'user.name', 'Test');
        mkdirSync(join(repo, 'people'), { recursive: true });
        writeFileSync(join(repo, 'people', 'alice.md'), [
          '---', 'type: person', 'title: Alice', '---', '', 'Initial.',
        ].join('\n'));
        git('add', '-A'); git('commit', '-q', '-m', 'initial');
        await engine.executeRaw(
          `INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)`,
          [sourceId, repo],
        );
        await performSync(engine, {
          repoPath: repo, sourceId, noPull: true, noEmbed: true, noExtract: true,
        });
        const before = (await engine.executeRaw<{ last_commit: string | null }>(
          `SELECT last_commit FROM sources WHERE id = $1`, [sourceId],
        ))[0]!.last_commit;

        writeFileSync(join(repo, 'people', 'alice.md'), [
          '---', 'type: person', 'title: Alice', '---', '', 'Changed.',
        ].join('\n'));
        if (mixed) {
          mkdirSync(join(repo, 'src'), { recursive: true });
          writeFileSync(join(repo, 'src', 'worker.ts'), 'export const worker = 1;\n');
        }
        git('add', '-A'); git('commit', '-q', '-m', 'delta');

        await expect(performSync(engine, {
          repoPath: repo,
          sourceId,
          strategy: 'code',
          noPull: true,
          noEmbed: true,
          noExtract: true,
          _hooks: {
            afterUnsyncableCleanup: async tx => {
              await tx.executeRaw(
                `INSERT INTO pages
                   (source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, source_path)
                 VALUES ($1, 'hostile-restore', 'person', 'Hostile restore', 'restored', '', '{}'::jsonb, 'hostile', 'people/alice.md')`,
                [sourceId],
              );
            },
          },
        })).rejects.toThrow(/cleanup absence proof failed/);

        const after = (await engine.executeRaw<{ last_commit: string | null }>(
          `SELECT last_commit FROM sources WHERE id = $1`, [sourceId],
        ))[0]!.last_commit;
        expect(after).toBe(before);
        expect(await engine.getPage('people/alice', { sourceId })).not.toBeNull();
        expect(await engine.getPage('hostile-restore', { sourceId })).toBeNull();
      } finally {
        await engine.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]);
        rmSync(repo, { recursive: true, force: true });
      }
    }, 90_000);
  }
});
