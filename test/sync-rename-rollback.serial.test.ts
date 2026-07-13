/**
 * SERIAL fault-injection regression for the final slug-keyed write in a sync
 * rename. Keeping this in a fresh Bun process avoids the order-dependent
 * PGLite/WASM hang observed when the method-table mutation followed the full
 * sync lifecycle suite. The normal sync suite remains parallel.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performSync } from '../src/commands/sync.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
const repos: string[] = [];

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
    const repo = repos.pop();
    if (repo) rmSync(repo, { recursive: true, force: true });
  }
});

test('final importer failure rolls back rename and preserves bookmark for retry', async () => {
  const repo = makeRepo();
  const syncOptions = {
    noPull: true,
    noEmbed: true,
    noExtract: true,
    sourceId: 'default',
  } as const;

  await performSync(engine, { repoPath: repo, ...syncOptions });
  const before = await bookmark();
  git(repo, 'mv', 'people/old.md', 'people/new.md');
  git(repo, 'commit', '-m', 'rename page');

  // setPageAliases is the last slug-keyed write in the import transaction.
  // Failing there proves updateSlug and every earlier write roll back together.
  (engine as unknown as { setPageAliases: PGLiteEngine['setPageAliases'] }).setPageAliases = async () => {
    throw new Error('simulated final write failure');
  };
  let blocked: Awaited<ReturnType<typeof performSync>> | undefined;
  try {
    blocked = await performSync(engine, { repoPath: repo, ...syncOptions });
  } finally {
    delete (engine as unknown as { setPageAliases?: PGLiteEngine['setPageAliases'] }).setPageAliases;
  }

  expect(blocked?.status).toBe('blocked_by_failures');
  expect(await bookmark()).toBe(before);
  expect(await engine.getPage('people/old')).not.toBeNull();
  expect(await engine.getPage('people/new')).toBeNull();

  const resumed = await performSync(engine, { repoPath: repo, ...syncOptions });
  expect(resumed.status).toBe('synced');
  expect(await engine.getPage('people/new')).not.toBeNull();
  expect(await bookmark()).toBe(git(repo, 'rev-parse', 'HEAD'));
});

const makeRepo = (): string => {
  const repo = mkdtempSync(join(tmpdir(), 'gbrain-rename-rollback-'));
  repos.push(repo);
  git(repo, 'init');
  git(repo, 'config', 'user.email', 'test@test.com');
  git(repo, 'config', 'user.name', 'Test');
  mkdirSync(join(repo, 'people'), { recursive: true });
  writeFileSync(join(repo, 'people', 'old.md'), [
    '---',
    'type: person',
    'title: Old',
    '---',
    '',
    'Original page.',
  ].join('\n'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'initial');
  return repo;
};

const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

const bookmark = async (): Promise<string | null> => {
  const rows = await engine.executeRaw<{ last_commit: string | null }>(
    `SELECT last_commit FROM sources WHERE id = 'default'`,
  );
  return rows[0]?.last_commit ?? null;
};
