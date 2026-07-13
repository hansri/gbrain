import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performSync } from '../../src/commands/sync.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { getPostgresTestUrl } from '../helpers/postgres-test-authority.ts';

const DATABASE_URL = getPostgresTestUrl();

describe.skipIf(!DATABASE_URL)('Postgres sync delete fallback', () => {
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    await engine?.disconnect();
  });

  test('restarts per-slug fallback only after the failed batch transaction rolls back', async () => {
    const suffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1_000_000).toString(36)}`;
    const sourceId = `df-${suffix}`;
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-e2e-delete-fallback-'));
    const pagePath = join(repo, 'delete-me.md');
    const git = (...args: string[]): string => execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

    try {
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'test@example.invalid');
      git('config', 'user.name', 'Test');
      writeFileSync(pagePath, ['---', 'title: Delete Me', '---', '', 'Initial.'].join('\n'));
      git('add', 'delete-me.md');
      git('commit', '-q', '-m', 'initial');
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)`,
        [sourceId, repo],
      );
      await performSync(engine, {
        repoPath: repo,
        sourceId,
        noPull: true,
        noEmbed: true,
        noExtract: true,
      });
      expect(await engine.executeRaw(
        `SELECT 1 FROM pages WHERE source_id = $1 AND source_path = 'delete-me.md'`,
        [sourceId],
      )).toHaveLength(1);

      rmSync(pagePath);
      git('add', '-u');
      git('commit', '-q', '-m', 'delete page');

      // Force the batch primitive to put Postgres into the aborted-transaction
      // state. The implementation must let begin() roll back before it starts
      // its per-slug fallback in fresh fenced transactions.
      Object.defineProperty(engine, 'deletePages', {
        configurable: true,
        value: async function(this: PostgresEngine): Promise<string[]> {
          await this.executeRaw('SELECT 1 / 0');
          return [];
        },
      });
      const result = await performSync(engine, {
        repoPath: repo,
        sourceId,
        noPull: true,
        noEmbed: true,
        noExtract: true,
      });
      expect(result.status).toBe('synced');
      expect(await engine.executeRaw(
        `SELECT 1 FROM pages WHERE source_id = $1 AND source_path = 'delete-me.md'`,
        [sourceId],
      )).toHaveLength(0);
      expect((await engine.executeRaw<{ last_commit: string | null }>(
        `SELECT last_commit FROM sources WHERE id = $1`,
        [sourceId],
      ))[0]!.last_commit).toBe(git('rev-parse', 'HEAD'));
    } finally {
      delete (engine as unknown as Record<string, unknown>).deletePages;
      await engine.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]);
      rmSync(repo, { recursive: true, force: true });
    }
  }, 90_000);
});
