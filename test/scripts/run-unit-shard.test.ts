/**
 * Regression test (b): scripts/run-unit-shard.sh exclusion symmetry.
 *
 * Pins the contract that the local fast-loop unit-shard script:
 *   1. EXCLUDES *.slow.test.ts (those run via scripts/run-slow-tests.sh).
 *   2. EXCLUDES *.serial.test.ts (those run via scripts/run-serial-tests.sh
 *      after the parallel pass).
 *   3. Includes plain *.test.ts files (the fast-loop unit set).
 *
 * Without this guard, a future refactor that drops one of the `-not -name`
 * clauses from the find expression would cause slow OR serial files to
 * run inside the parallel pass — silently undoing the quarantine and
 * re-introducing the contention flakes that motivated v0.26.4.
 */

import { describe, it, expect } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const SHARD_SH = resolve(REPO_ROOT, 'scripts/run-unit-shard.sh');

function dryRunList(): string[] {
  const out = execFileSync('bash', [SHARD_SH, '--dry-run-list'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, SHARD: '' },
  });
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

function runWithFakeBun(args: string[]): {
  code: number;
  stdout: string;
  stderr: string;
  calls: string[][];
} {
  const temp = mkdtempSync(join(tmpdir(), 'gbrain-unit-batches-'));
  const capture = join(temp, 'calls.bin');
  const fakeBun = join(temp, 'bun');
  writeFileSync(fakeBun, `#!/usr/bin/env bash
printf '%s\\0' "$@" >> "$BUN_CAPTURE"
printf '\\036' >> "$BUN_CAPTURE"
`);
  chmodSync(fakeBun, 0o755);
  try {
    const result = spawnSync('bash', [SHARD_SH, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: `${temp}:${process.env.PATH ?? ''}`,
        BUN_CAPTURE: capture,
        SHARD: '',
      },
    });
    const raw = readFileSync(capture, 'utf-8');
    const calls = raw
      .split('\x1e')
      .filter(Boolean)
      .map(record => record.split('\0').filter(Boolean));
    return {
      code: result.status ?? -1,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      calls,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

describe('run-unit-shard.sh exclusion symmetry', () => {
  it('lists at least one plain *.test.ts file', () => {
    const files = dryRunList();
    expect(files.length).toBeGreaterThan(0);
    expect(files.some(f => /\.test\.ts$/.test(f) && !/\.(slow|serial)\.test\.ts$/.test(f))).toBe(true);
  });

  it('excludes every *.slow.test.ts file', () => {
    const files = dryRunList();
    const leaks = files.filter(f => /\.slow\.test\.ts$/.test(f));
    expect(leaks).toEqual([]);
  });

  it('excludes every *.serial.test.ts file', () => {
    const files = dryRunList();
    const leaks = files.filter(f => /\.serial\.test\.ts$/.test(f));
    expect(leaks).toEqual([]);
  });

  it('excludes the test/e2e/ subtree', () => {
    const files = dryRunList();
    const leaks = files.filter(f => f.startsWith('test/e2e/'));
    expect(leaks).toEqual([]);
  });
});

describe('run-unit-shard.sh bounded process batches', () => {
  it('preserves the default single-process invocation', () => {
    const files = dryRunList();
    const result = runWithFakeBun(['--max-concurrency=1']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toEqual([
      'test',
      '--max-concurrency=1',
      '--timeout=60000',
      ...files,
    ]);
  });

  it('runs deterministic slices in separate sequential Bun processes', () => {
    const files = dryRunList();
    const batchSize = 37;
    const result = runWithFakeBun([
      '--max-concurrency=1',
      `--batch-size=${batchSize}`,
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.calls).toHaveLength(Math.ceil(files.length / batchSize));
    expect(result.calls.every(call => call.slice(3).length <= batchSize)).toBe(true);
    expect(result.calls.flatMap(call => call.slice(3))).toEqual(files);
    expect(result.stdout).toContain(`max ${batchSize} files each`);
  });

  it('keeps dry-run output unchanged when batching is requested', () => {
    const out = execFileSync('bash', [SHARD_SH, '--batch-size=7', '--dry-run-list'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: { ...process.env, SHARD: '' },
    });
    expect(out.split('\n').map(s => s.trim()).filter(Boolean)).toEqual(dryRunList());
  });

  it('rejects missing, zero, and non-numeric batch sizes', () => {
    for (const args of [
      ['--batch-size'],
      ['--batch-size='],
      ['--batch-size=0'],
      ['--batch-size=nope'],
    ]) {
      const result = spawnSync('bash', [SHARD_SH, ...args], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        env: { ...process.env, SHARD: '' },
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('batch-size');
    }
  });
});
