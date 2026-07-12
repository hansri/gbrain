import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runApplyMigrations } from '../src/commands/apply-migrations.ts';

const originalHome = process.env.HOME;
const originalGbrainHome = process.env.GBRAIN_HOME;
let home: string | undefined;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = originalGbrainHome;
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

describe('apply-migrations migration-ledger boundary', () => {
  test('returns non-zero before config discovery when the ledger is malformed', async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-apply-ledger-'));
    process.env.HOME = home;
    process.env.GBRAIN_HOME = home;
    const dir = join(home, '.gbrain', 'migrations');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'completed.jsonl'), '{"version":"torn"');

    const result = await runApplyMigrations(['--yes', '--non-interactive']);
    expect(result).toMatchObject({ exitCode: 1, status: 'blocked', reason: 'failed' });
    expect(result.message).toContain('Migration ledger is unreadable or corrupt');
  });
});
