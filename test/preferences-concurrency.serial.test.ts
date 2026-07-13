import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadCompletedMigrations } from '../src/core/preferences.ts';

let home: string;
let priorHome: string | undefined;
let priorGbrainHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-ledger-concurrency-'));
  priorHome = process.env.HOME;
  priorGbrainHome = process.env.GBRAIN_HOME;
  process.env.HOME = home;
  process.env.GBRAIN_HOME = home;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = priorGbrainHome;
  rmSync(home, { recursive: true, force: true });
});

describe('migration ledger cross-brain serialization', () => {
  test('concurrent writers preserve every brain partition', async () => {
    const childScript = join(home, 'append-ledger.ts');
    const moduleUrl = new URL('../src/core/preferences.ts', import.meta.url).href;
    writeFileSync(childScript, [
      `import { appendCompletedMigration } from ${JSON.stringify(moduleUrl)};`,
      `const [brainId, version] = process.argv.slice(2);`,
      `appendCompletedMigration({ brain_id: brainId!, version: version!, status: 'partial' });`,
    ].join('\n'));

    const children = Array.from({ length: 12 }, (_, index) => Bun.spawn([
      process.execPath,
      childScript,
      `brain-${index}`,
      `concurrent-${index}`,
    ], {
      env: {
        ...process.env,
        HOME: home,
        GBRAIN_HOME: home,
        NODE_ENV: 'test',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }));

    const results = await Promise.all(children.map(async child => ({
      exitCode: await child.exited,
      stderr: await new Response(child.stderr).text(),
    })));
    expect(results.filter(result => result.exitCode !== 0)).toEqual([]);

    const entries = loadCompletedMigrations();
    expect(entries).toHaveLength(12);
    expect(new Set(entries.map(entry => entry.brain_id)).size).toBe(12);
    expect(new Set(entries.map(entry => entry.version)).size).toBe(12);
    expect(readFileSync(join(home, '.gbrain', 'migrations', 'completed.jsonl'), 'utf8')
      .trim().split('\n')).toHaveLength(12);
    expect(existsSync(join(home, '.gbrain', 'locks', 'migration-ledger-write.lock'))).toBe(false);
  }, 30_000);
});
