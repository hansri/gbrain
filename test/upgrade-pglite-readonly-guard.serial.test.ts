import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfiguredUpgradeBrainId } from '../src/commands/upgrade.ts';
import { __testing as preflightTesting } from '../src/commands/upgrade-preflight.ts';
import { assertExistingPgliteDataDirForReadOnlyOpen } from '../src/core/engine-factory.ts';
import { createEngine } from '../src/core/engine-factory.ts';

const ISOLATED_ENV_KEYS = [
  'GBRAIN_HOME',
  'HOME',
  'DATABASE_URL',
  'GBRAIN_DATABASE_URL',
] as const;

const roots: string[] = [];
let priorEnv: Record<string, string | undefined>;

function configurePglite(root: string, databasePath?: string): void {
  const configDir = join(root, '.gbrain');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      engine: 'pglite',
      ...(databasePath === undefined ? {} : { database_path: databasePath }),
    }),
    { mode: 0o600 },
  );
  process.env.GBRAIN_HOME = root;
  process.env.HOME = root;
}

async function openThroughUpgradeAuthority(): Promise<unknown> {
  return resolveConfiguredUpgradeBrainId();
}

async function openThroughUpgradePreflight(): Promise<unknown> {
  return preflightTesting.withConfiguredEngine(async () => 'opened');
}

describe('persistent PGLite read-only open guard', () => {
  beforeEach(() => {
    priorEnv = Object.fromEntries(ISOLATED_ENV_KEYS.map(key => [key, process.env[key]]));
    for (const key of ISOLATED_ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ISOLATED_ENV_KEYS) {
      const value = priorEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test('post-upgrade authority and preflight refuse a missing configured store without creating it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-pglite-readonly-missing-'));
    roots.push(root);
    const missing = join(root, 'moved-brain.pglite');
    configurePglite(root, missing);

    for (const open of [openThroughUpgradeAuthority, openThroughUpgradePreflight]) {
      await expect(open()).rejects.toThrow(/does not exist.*will not create an empty store/i);
      expect(existsSync(missing)).toBe(false);
    }
  });

  test('post-upgrade authority and preflight refuse a symlinked configured store before connect', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-pglite-readonly-symlink-'));
    roots.push(root);
    const target = join(root, 'real-brain.pglite');
    const alias = join(root, 'configured-brain.pglite');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, alias, 'dir');
    configurePglite(root, alias);

    for (const open of [openThroughUpgradeAuthority, openThroughUpgradePreflight]) {
      await expect(open()).rejects.toThrow(/not a direct existing directory|symlinked read-only open/i);
      // PGLiteEngine.connect() would create .gbrain-lock here. Its absence
      // proves both workflows failed before constructing/connecting an engine.
      expect(readdirSync(target)).toEqual([]);
    }
  });

  test('unsafe writable persistent directories fail closed on both read-only paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-pglite-readonly-mode-'));
    roots.push(root);
    const databasePath = join(root, 'brain.pglite');
    mkdirSync(databasePath, { mode: 0o700 });
    chmodSync(databasePath, 0o777);
    configurePglite(root, databasePath);

    for (const open of [openThroughUpgradeAuthority, openThroughUpgradePreflight]) {
      await expect(open()).rejects.toThrow(/group\/other-writable/i);
      expect(readdirSync(databasePath)).toEqual([]);
    }
  });

  test('intentional in-memory PGLite remains available to read-only library callers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-pglite-readonly-memory-'));
    roots.push(root);
    configurePglite(root);

    expect(() => assertExistingPgliteDataDirForReadOnlyOpen({ engine: 'pglite' })).not.toThrow();
    expect(await openThroughUpgradePreflight()).toBe('opened');
  }, 60_000);

  test('removal after validation cannot be recreated by read-only lock acquisition', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-pglite-readonly-remove-race-'));
    roots.push(root);
    const canonicalRoot = realpathSync(root);
    const databasePath = join(canonicalRoot, 'brain.pglite');
    const movedPath = join(canonicalRoot, 'brain.pglite.moved');
    mkdirSync(databasePath, { mode: 0o700 });
    const engineConfig = { engine: 'pglite' as const, database_path: databasePath };
    const pgliteReadOnlyAuthority = assertExistingPgliteDataDirForReadOnlyOpen(engineConfig);

    // Actual namespace swap after the read-only guard but before connect.
    renameSync(databasePath, movedPath);
    const engine = await createEngine(engineConfig, { pgliteReadOnlyAuthority });
    await expect(engine.connect(engineConfig)).rejects.toThrow(/moved before connection|will not create/i);

    expect(existsSync(databasePath)).toBe(false);
    expect(readdirSync(movedPath)).toEqual([]);
  });

  test('replacement directory after validation cannot inherit read-only authority', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-pglite-readonly-replace-race-'));
    roots.push(root);
    const canonicalRoot = realpathSync(root);
    const databasePath = join(canonicalRoot, 'brain.pglite');
    const movedPath = join(canonicalRoot, 'brain.pglite.original');
    mkdirSync(databasePath, { mode: 0o700 });
    const engineConfig = { engine: 'pglite' as const, database_path: databasePath };
    const pgliteReadOnlyAuthority = assertExistingPgliteDataDirForReadOnlyOpen(engineConfig);

    // Keep the old inode alive through the authority fd, but replace its name
    // with a different real directory. dev/ino binding must reject it.
    renameSync(databasePath, movedPath);
    mkdirSync(databasePath, { mode: 0o700 });
    const engine = await createEngine(engineConfig, { pgliteReadOnlyAuthority });
    await expect(engine.connect(engineConfig)).rejects.toThrow(/changed before connection/i);

    expect(readdirSync(databasePath)).toEqual([]);
    expect(readdirSync(movedPath)).toEqual([]);
  });
});
