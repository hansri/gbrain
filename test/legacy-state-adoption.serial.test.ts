import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { adoptLegacyMigrationState } from '../src/core/legacy-state-adoption.ts';
import {
  appendAmbiguousMigration,
  loadCompletedMigrations,
  loadPreferences,
} from '../src/core/preferences.ts';
import { indexMigrationEntries, migrationStatusForVersion } from '../src/core/migration-state.ts';

const BRAIN_ID = 'db:11111111-1111-4111-8111-111111111111';
let root: string;
let priorHome: string | undefined;
let priorGbrainHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-legacy-adoption-'));
  priorHome = process.env.HOME;
  priorGbrainHome = process.env.GBRAIN_HOME;
  process.env.HOME = root;
  process.env.GBRAIN_HOME = root;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = priorGbrainHome;
  rmSync(root, { recursive: true, force: true });
});

function writeLegacyLedger(entries: unknown[]): void {
  const dir = join(root, 'migrations');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'completed.jsonl'), entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
}

describe('legacy migration state adoption', () => {
  test('copies old GBRAIN_HOME preferences and scopes settled completions once', () => {
    writeFileSync(join(root, 'preferences.json'), JSON.stringify({ minion_mode: 'always', custom: true }));
    writeLegacyLedger([
      { version: '0.11.0', status: 'complete' },
      { version: '0.12.0', status: 'partial' },
      { version: '0.12.0', status: 'complete' },
    ]);

    const first = adoptLegacyMigrationState(BRAIN_ID);
    expect(first.preferences).toBe('adopted');
    expect(first.ledgerVersionsAdopted).toEqual(['0.11.0', '0.12.0']);
    expect(loadPreferences()).toEqual({ minion_mode: 'always', custom: true });

    const entries = loadCompletedMigrations();
    expect(migrationStatusForVersion('0.11.0', indexMigrationEntries(entries, BRAIN_ID))).toBe('complete');
    expect(migrationStatusForVersion('0.12.0', indexMigrationEntries(entries, BRAIN_ID))).toBe('complete');
    const count = entries.length;
    expect(adoptLegacyMigrationState(BRAIN_ID).preferences).toBe('already_adopted');
    expect(loadCompletedMigrations()).toHaveLength(count);
  });

  test('turns unresolved legacy work into an explicit brain-scoped ambiguity fence', () => {
    writeLegacyLedger([{ version: '0.21.0', status: 'partial' }]);
    const result = adoptLegacyMigrationState(BRAIN_ID);
    expect(result.unresolvedVersionsFenced).toEqual(['0.21.0']);
    const entries = loadCompletedMigrations();
    expect(migrationStatusForVersion('0.21.0', indexMigrationEntries(entries, BRAIN_ID))).toBe('ambiguous');
    expect(entries.filter(entry => entry.brain_id === BRAIN_ID)).toHaveLength(3);
  });

  test('adopts legacy unscoped receipts already in the canonical ledger', () => {
    const dir = join(root, '.gbrain', 'migrations');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'completed.jsonl'), `${JSON.stringify({ version: '0.31.0', status: 'complete' })}\n`);
    expect(adoptLegacyMigrationState(BRAIN_ID).ledgerVersionsAdopted).toEqual(['0.31.0']);
    const entries = loadCompletedMigrations();
    expect(migrationStatusForVersion('0.31.0', indexMigrationEntries(entries, BRAIN_ID))).toBe('complete');
  });

  test('never lets rollback-era legacy completion hide current scoped ambiguity', () => {
    appendAmbiguousMigration({ version: '0.31.0', brain_id: BRAIN_ID });
    writeLegacyLedger([{ version: '0.31.0', status: 'complete' }]);

    expect(() => adoptLegacyMigrationState(BRAIN_ID))
      .toThrow(/coexists with unresolved scoped migration history/);
    const entries = loadCompletedMigrations();
    expect(migrationStatusForVersion(
      '0.31.0',
      indexMigrationEntries(entries, BRAIN_ID),
    )).toBe('ambiguous');
    expect(entries.some(entry =>
      entry.brain_id === BRAIN_ID
      && entry.version === '0.31.0'
      && entry.status === 'complete')).toBe(false);
  });

  test('refuses conflicting preference authorities and changed adopted history', () => {
    writeFileSync(join(root, 'preferences.json'), JSON.stringify({ minion_mode: 'always' }));
    mkdirSync(join(root, '.gbrain'), { recursive: true });
    writeFileSync(join(root, '.gbrain', 'preferences.json'), JSON.stringify({ minion_mode: 'off' }));
    expect(() => adoptLegacyMigrationState(BRAIN_ID)).toThrow('differ');

    rmSync(join(root, '.gbrain'), { recursive: true, force: true });
    writeLegacyLedger([{ version: '0.11.0', status: 'complete' }]);
    adoptLegacyMigrationState(BRAIN_ID);
    writeLegacyLedger([
      { version: '0.11.0', status: 'complete' },
      { version: '0.11.0', status: 'partial' },
    ]);
    expect(() => adoptLegacyMigrationState(BRAIN_ID)).toThrow(/changed after adoption/);
  });

  test('leaves the legacy files intact for the supervised rollback window', () => {
    writeFileSync(join(root, 'preferences.json'), JSON.stringify({ minion_mode: 'off' }));
    writeLegacyLedger([{ version: '0.11.0', status: 'complete' }]);
    adoptLegacyMigrationState(BRAIN_ID);
    expect(JSON.parse(readFileSync(join(root, 'preferences.json'), 'utf8')).minion_mode).toBe('off');
    expect(readFileSync(join(root, 'migrations', 'completed.jsonl'), 'utf8')).toContain('0.11.0');
  });
});
