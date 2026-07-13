import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  appendAmbiguousMigration,
  appendCompletedMigration,
  loadCompletedMigrations,
  preferencesPaths,
} from '../src/core/preferences.ts';

let home: string;
let originalHome: string | undefined;
let originalGbrainHome: string | undefined;
let originalUmask: number;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-ledger-permissions-'));
  originalHome = process.env.HOME;
  originalGbrainHome = process.env.GBRAIN_HOME;
  originalUmask = process.umask();
  process.env.HOME = home;
  process.env.GBRAIN_HOME = home;
});

afterEach(() => {
  process.umask(originalUmask);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = originalGbrainHome;
  rmSync(home, { recursive: true, force: true });
});

describe('migration ledger owner-only permissions', () => {
  for (const mask of [0o000, 0o022]) {
    test(`creates 0700 directory and 0600 ledger under umask ${mask.toString(8)}`, () => {
      process.umask(mask);
      appendCompletedMigration({ version: `permissions-${mask}`, status: 'complete' });

      expect(statSync(preferencesPaths.migrationsDir()).mode & 0o777).toBe(0o700);
      expect(statSync(preferencesPaths.completedJsonl()).mode & 0o777).toBe(0o600);
    });
  }

  test('tightens permissions left by an older installation', () => {
    const dir = preferencesPaths.migrationsDir();
    const ledger = preferencesPaths.completedJsonl();
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    writeFileSync(ledger, '', { mode: 0o644 });
    chmodSync(dir, 0o755);
    chmodSync(ledger, 0o644);

    appendCompletedMigration({ version: 'permissions-upgrade', status: 'complete' });

    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(ledger).mode & 0o777).toBe(0o600);
  });

  test('a read-only ledger load tightens old loose permissions', () => {
    const dir = preferencesPaths.migrationsDir();
    const ledger = preferencesPaths.completedJsonl();
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    writeFileSync(ledger, `${JSON.stringify({ version: 'legacy', status: 'complete' })}\n`, { mode: 0o644 });
    chmodSync(dir, 0o755);
    chmodSync(ledger, 0o644);

    expect(loadCompletedMigrations()).toHaveLength(1);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(ledger).mode & 0o777).toBe(0o600);
  });

  test('duplicate-complete no-op still tightens old loose permissions', () => {
    appendCompletedMigration({ version: 'already-complete', brain_id: 'brain-a', status: 'complete' });
    const dir = preferencesPaths.migrationsDir();
    const ledger = preferencesPaths.completedJsonl();
    chmodSync(dir, 0o755);
    chmodSync(ledger, 0o644);

    appendCompletedMigration({ version: 'already-complete', brain_id: 'brain-a', status: 'complete' });

    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(ledger).mode & 0o777).toBe(0o600);
  });

  test('ambiguity fence stays readable as a wedge to an older binary', () => {
    appendAmbiguousMigration({ version: 'ambiguous-upgrade', brain_id: 'brain-a' });
    const entries = loadCompletedMigrations().filter(entry => entry.version === 'ambiguous-upgrade');

    expect(entries).toHaveLength(3);
    expect(entries.every(entry => entry.status === 'partial')).toBe(true);
    expect(entries.every(entry => entry.ambiguous_state === true)).toBe(true);
    expect(entries.map(entry => entry.ambiguity_fence_part)).toEqual([1, 2, 3]);
  });

  test('GBRAIN_HOME uses the canonical parent/.gbrain ledger location', () => {
    appendCompletedMigration({ version: 'canonical-home', brain_id: 'brain-a', status: 'complete' });
    expect(preferencesPaths.completedJsonl()).toBe(join(home, '.gbrain', 'migrations', 'completed.jsonl'));
    expect(statSync(join(home, '.gbrain', 'migrations')).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, '.gbrain', 'migrations', 'completed.jsonl')).mode & 0o777).toBe(0o600);
  });

  for (const kind of ['symlink', 'hardlink'] as const) {
    test(`rejects an existing ${kind} ledger without changing its target`, () => {
      const dir = preferencesPaths.migrationsDir();
      const ledger = preferencesPaths.completedJsonl();
      const victim = join(home, `${kind}-victim.jsonl`);
      const original = `${JSON.stringify({ private: true })}\n`;
      mkdirSync(dir, { recursive: true });
      writeFileSync(victim, original, { mode: 0o600 });
      if (kind === 'symlink') symlinkSync(victim, ledger);
      else linkSync(victim, ledger);

      expect(() => loadCompletedMigrations()).toThrow();
      expect(() => appendCompletedMigration({ version: 'must-not-write', status: 'partial' })).toThrow();
      expect(readFileSync(victim, 'utf8')).toBe(original);
    });
  }

  test('rejects a symlinked migrations directory below canonical .gbrain', () => {
    const root = join(home, '.gbrain');
    const victimDir = join(home, 'redirected-migrations');
    mkdirSync(root, { recursive: true });
    mkdirSync(victimDir, { recursive: true });
    symlinkSync(victimDir, join(root, 'migrations'));

    expect(() => appendCompletedMigration({ version: 'must-not-redirect', status: 'partial' })).toThrow();
    expect(() => statSync(join(victimDir, 'completed.jsonl'))).toThrow();
  });

  test('rejects empty interior and torn ledger records but accepts one trailing newline', () => {
    const dir = preferencesPaths.migrationsDir();
    const ledger = preferencesPaths.completedJsonl();
    mkdirSync(dir, { recursive: true });
    writeFileSync(ledger, `${JSON.stringify({ version: 'ok', status: 'complete' })}\n`);
    expect(loadCompletedMigrations()).toHaveLength(1);

    writeFileSync(ledger, `${JSON.stringify({ version: 'ok', status: 'complete' })}\n\n`);
    expect(() => loadCompletedMigrations()).toThrow(/empty record/i);

    writeFileSync(ledger, '{"version":"torn"');
    expect(() => loadCompletedMigrations()).toThrow(/invalid or torn JSON/i);
  });

  test('rejects unbounded or unsafe doctor-rendered ledger labels', () => {
    const dir = preferencesPaths.migrationsDir();
    const ledger = preferencesPaths.completedJsonl();
    mkdirSync(dir, { recursive: true });

    writeFileSync(ledger, `${JSON.stringify({ version: 'v'.repeat(65), status: 'partial' })}\n`);
    expect(() => loadCompletedMigrations()).toThrow(/version.*at most 64/i);

    writeFileSync(ledger, `${JSON.stringify({ version: '1.2.3', brain_id: 'brain\nforged', status: 'partial' })}\n`);
    expect(() => loadCompletedMigrations()).toThrow(/brain_id.*safe token/i);

    writeFileSync(ledger, `${JSON.stringify({
      version: '1.2.3',
      brain_id: 'b'.repeat(257),
      status: 'partial',
      future_field: { preserved: true },
    })}\n`);
    expect(() => loadCompletedMigrations()).toThrow(/brain_id.*at most 256/i);
  });
});
