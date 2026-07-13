/**
 * SERIAL fault-injection regression for source-ownership lookup failures.
 * The deliberate repeated resolver exceptions can poison later PGLite/WASM
 * imports in the same Bun process, so this assertion owns a fresh process.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performSync } from '../src/commands/sync.ts';
import type { BrainEngine, TransactionOpts } from '../src/core/engine.ts';
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

test('unsyncable cleanup lookup failure cannot advance the bookmark', async () => {
  const repo = makeRepo();
  const syncOptions = {
    noPull: true,
    noEmbed: true,
    noExtract: true,
    sourceId: 'default',
  } as const;
  await performSync(engine, { repoPath: repo, ...syncOptions, strategy: 'auto' });
  const before = await bookmark();
  writeFileSync(join(repo, 'src', 'worker.ts'), 'export const worker = 2;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'modify code');

  const installTransactionFailure = (queryFragment: string, message: string): (() => void) => {
    const originalTransaction = engine.transaction.bind(engine);
    (engine as unknown as { transaction: BrainEngine['transaction'] }).transaction = async <T>(
      fn: (tx: BrainEngine) => Promise<T>,
      opts?: TransactionOpts,
    ): Promise<T> => originalTransaction(async tx => {
      const wrapped = new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop === 'executeRaw') {
            return async (query: string, params?: unknown[]) => {
              if (query.includes(queryFragment)) throw new Error(message);
              return target.executeRaw(query, params);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return fn(wrapped);
    }, opts);
    return () => {
      (engine as unknown as { transaction: BrainEngine['transaction'] }).transaction = originalTransaction;
    };
  };

  let restore = installTransactionFailure('SELECT id, slug, source_path', 'ownership lookup unavailable');
  try {
    await expect(performSync(engine, {
      repoPath: repo,
      ...syncOptions,
      strategy: 'markdown',
    })).rejects.toThrow('ownership lookup unavailable');
  } finally {
    restore();
  }

  restore = installTransactionFailure('SELECT source_path', 'absence proof unavailable');
  try {
    await expect(performSync(engine, {
      repoPath: repo,
      ...syncOptions,
      strategy: 'markdown',
    })).rejects.toThrow('absence proof unavailable');
  } finally {
    restore();
  }

  expect(await bookmark()).toBe(before);
  expect(await engine.getPage('src-worker-ts', { sourceId: 'default' })).not.toBeNull();
});

const makeRepo = (): string => {
  const repo = mkdtempSync(join(tmpdir(), 'gbrain-lookup-failure-'));
  repos.push(repo);
  git(repo, 'init');
  git(repo, 'config', 'user.email', 'test@test.com');
  git(repo, 'config', 'user.name', 'Test');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'worker.ts'), 'export const worker = 1;\n');
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
