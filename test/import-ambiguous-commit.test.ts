import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine, TransactionOpts } from '../src/core/engine.ts';
import { importFileContent } from '../src/core/import-file.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

function page(title: string): string {
  return `---\ntitle: ${title}\n---\n\nBody for ${title}.\n`;
}

function postCommitAckLoss(base: PGLiteEngine): { engine: BrainEngine; txCalls: () => number } {
  let calls = 0;
  const wrapped = new Proxy(base as BrainEngine, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return async <T>(fn: (tx: BrainEngine) => Promise<T>, opts?: TransactionOpts): Promise<T> => {
          calls++;
          // Import commits are intentionally classified no-retry. A generic
          // whole-transaction retry after commit-ack loss can duplicate rename
          // side effects or replay against a different identity.
          expect(opts?.retryOnConnectionError).not.toBe(true);
          await base.transaction(fn);
          throw new Error('simulated post-commit acknowledgement loss');
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { engine: wrapped, txCalls: () => calls };
}

describe('import commit-ambiguity convergence', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  beforeEach(async () => resetPgliteState(engine));
  afterAll(async () => engine.disconnect());

  test('normal import does not blindly replay after post-commit ack loss', async () => {
    const lossy = postCommitAckLoss(engine);
    await expect(importFileContent(lossy.engine, page('Alpha'), 'alpha.md', { noEmbed: true }))
      .rejects.toThrow(/acknowledgement loss/);
    expect(lossy.txCalls()).toBe(1);
    expect(await engine.getPage('alpha', { sourceId: 'default' })).not.toBeNull();

    // The next explicit attempt converges through content_hash instead of an
    // invisible transaction replay.
    const retry = await importFileContent(engine, page('Alpha'), 'alpha.md', { noEmbed: true });
    expect(retry.status).toBe('skipped');
  });

  test('rename commit survives ack loss and converges without replaying the move', async () => {
    await importFileContent(engine, page('Old'), 'old.md', { noEmbed: true });
    const lossy = postCommitAckLoss(engine);
    await expect(importFileContent(lossy.engine, page('New'), 'new.md', {
      noEmbed: true,
      renameFromSlug: 'old',
      renameFromSourcePath: 'old.md',
    })).rejects.toThrow(/acknowledgement loss/);
    expect(lossy.txCalls()).toBe(1);
    expect(await engine.getPage('old', { sourceId: 'default' })).toBeNull();
    expect(await engine.getPage('new', { sourceId: 'default' })).not.toBeNull();

    const retry = await importFileContent(engine, page('New'), 'new.md', { noEmbed: true });
    expect(retry.status).toBe('skipped');
  });
});
