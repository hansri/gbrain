import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import packageJson from '../package.json';

let root: string;
let binDir: string;
let marker: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-postinstall-safety-'));
  binDir = join(root, 'bin');
  marker = join(root, 'gbrain-called');
  mkdirSync(binDir, { recursive: true });
  const fake = join(binDir, 'gbrain');
  writeFileSync(fake, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" > "$GBRAIN_TEST_MARKER"\n');
  chmodSync(fake, 0o755);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function runPostinstall(extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    GBRAIN_TEST_MARKER: marker,
    ...extraEnv,
  };
  delete env.DATABASE_URL;
  delete env.GBRAIN_DATABASE_URL;
  return Bun.spawnSync(['bash', '-c', packageJson.scripts.postinstall], {
    cwd: root,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('postinstall migration safety', () => {
  test('default install never invokes the configured gbrain binary', () => {
    const result = runPostinstall();
    expect(result.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(result.stderr.toString()).toContain('postinstall is non-mutating');
    expect(result.stderr.toString()).toContain('exact staged/current-release binary');
  });

  test('legacy opt-in cannot execute a PATH-selected binary', () => {
    const result = runPostinstall({ GBRAIN_POSTINSTALL_APPLY_MIGRATIONS: '1' });
    expect(result.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(result.stderr.toString()).toContain('No environment opt-in runs migrations');
  });
});
