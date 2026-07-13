/**
 * Regression tests (a) + (d) for scripts/run-unit-parallel.sh:
 *   (a) Exit-code propagation: a failing test in any shard MUST cause the
 *       wrapper to exit non-zero. The hardest contract to silently break
 *       in a fan-out wrapper (`for ... &; wait` returns the LAST child's
 *       status, not any failure's).
 *   (d) Failure-log contract: when any test fails, the wrapper writes
 *       extracted failure block(s) to .context/test-failures.log with
 *       `--- shard $i:` prefixes, and prints a loud stderr banner with
 *       the absolute path. Empty log ⇔ exit 0.
 *
 * The wrapper takes ~1.5 minutes against the real test suite. To keep
 * this regression test fast and hermetic, we point it at a tiny tempdir
 * containing one passing and one failing test, override the discovery
 * roots via env-vars, and run with --shards=2.
 *
 * NOT covered here: the heartbeat (timing-sensitive, not load-bearing for
 * correctness). The portable manual-timeout path is covered with a bounded
 * fixture that traps TERM and exits 0, pinning timeout provenance rather than
 * relying on the child's eventual exit code.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const PARALLEL_SH_SRC = resolve(REPO_ROOT, 'scripts/run-unit-parallel.sh');
const SHARD_SH_SRC = resolve(REPO_ROOT, 'scripts/run-unit-shard.sh');
const SERIAL_SH_SRC = resolve(REPO_ROOT, 'scripts/run-serial-tests.sh');

let TMPROOT: string;

beforeAll(() => {
  // Build a tiny repo-shaped tempdir with the wrapper scripts copied in
  // and 4 fixture test files (3 pass, 1 fail). The wrapper's `find test`
  // expression will pick them up via cwd.
  TMPROOT = mkdtempSync(join(tmpdir(), 'gbrain-parallel-test-'));
  mkdirSync(join(TMPROOT, 'scripts'), { recursive: true });
  mkdirSync(join(TMPROOT, 'test'), { recursive: true });

  copyFileSync(PARALLEL_SH_SRC, join(TMPROOT, 'scripts', 'run-unit-parallel.sh'));
  copyFileSync(SHARD_SH_SRC, join(TMPROOT, 'scripts', 'run-unit-shard.sh'));
  copyFileSync(SERIAL_SH_SRC, join(TMPROOT, 'scripts', 'run-serial-tests.sh'));
  chmodSync(join(TMPROOT, 'scripts', 'run-unit-parallel.sh'), 0o755);
  chmodSync(join(TMPROOT, 'scripts', 'run-unit-shard.sh'), 0o755);
  chmodSync(join(TMPROOT, 'scripts', 'run-serial-tests.sh'), 0o755);

  // 3 passing + 1 failing test file. Round-robin sharding will land
  // them across 2 shards so we exercise the multi-shard merge path.
  const passing = `import { describe, it, expect } from 'bun:test';
describe('passing', () => {
  it('arithmetic works', () => { expect(1 + 1).toBe(2); });
});`;
  const failing = `import { describe, it, expect } from 'bun:test';
describe('failing-on-purpose', () => {
  it('expects 1 to equal 2 (this should fail)', () => { expect(1).toBe(2); });
});`;

  writeFileSync(join(TMPROOT, 'test', 'a-pass.test.ts'), passing);
  writeFileSync(join(TMPROOT, 'test', 'b-pass.test.ts'), passing);
  writeFileSync(join(TMPROOT, 'test', 'c-pass.test.ts'), passing);
  writeFileSync(join(TMPROOT, 'test', 'd-fail.test.ts'), failing);
});

afterAll(() => {
  if (TMPROOT) rmSync(TMPROOT, { recursive: true, force: true });
});

function runWrapper(
  extraArgs: string[] = [],
  env: Record<string, string | undefined> = {},
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(
    'bash',
    [join(TMPROOT, 'scripts', 'run-unit-parallel.sh'), '--shards', '2', ...extraArgs],
    { cwd: TMPROOT, encoding: 'utf-8', env: { ...process.env, ...env } },
  );
  return {
    code: result.status ?? -1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe('run-unit-parallel.sh bounded worker budget', () => {
  it('derives the default per-shard concurrency from the total budget', () => {
    const r = runWrapper(['--dry-run'], {
      GBRAIN_TEST_TOTAL_CONCURRENCY: '3',
      GBRAIN_TEST_MAX_CONCURRENCY: undefined,
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('--max-concurrency=1 (budgeted)');
    expect(r.stderr).toContain('total=2 | budget=3');
  });

  it('allows a deliberate explicit per-shard override and reports the total', () => {
    const r = runWrapper(['--dry-run', '--max-concurrency', '3'], {
      GBRAIN_TEST_TOTAL_CONCURRENCY: '3',
      GBRAIN_TEST_MAX_CONCURRENCY: undefined,
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('--max-concurrency=3 (explicit)');
    expect(r.stderr).toContain('total=6 | budget=3');
  });

  it('reduces shard processes when the automatic total budget is lower', () => {
    const r = runWrapper(['--dry-run'], {
      GBRAIN_TEST_TOTAL_CONCURRENCY: '1',
      GBRAIN_TEST_MAX_CONCURRENCY: undefined,
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('N=1 shards');
    expect(r.stderr).toContain('total=1 | budget=1');
  });

  it('rejects invalid concurrency values before spawning tests', () => {
    const r = runWrapper(['--dry-run', '--max-concurrency', '0']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('ERROR: invalid max concurrency: 0');
  });

  it('rejects an invalid global serial timeout before spawning tests', () => {
    const r = runWrapper(['--dry-run'], { GBRAIN_TEST_SERIAL_TIMEOUT: '0' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('ERROR: invalid serial timeout: 0');
  });
});

describe('run-unit-parallel.sh portable timeout fallback', () => {
  it('marks a timed-out shard as WEDGED even when the child traps TERM and exits zero', () => {
    const timeoutFixture = join(TMPROOT, 'test', 'z-timeout.test.ts');
    rmSync(join(TMPROOT, 'test', 'd-fail.test.ts'));
    writeFileSync(timeoutFixture, `import { test } from 'bun:test';
test('timeout fixture', async () => {
  process.once('SIGTERM', () => process.exit(0));
  await new Promise<void>(() => { setInterval(() => undefined, 1000); });
}, 20_000);`);
    try {
      const r = runWrapper([], {
        GBRAIN_TEST_FORCE_MANUAL_TIMEOUT: '1',
        GBRAIN_TEST_SHARD_TIMEOUT: '1',
        GBRAIN_TEST_TIMEOUT_GRACE: '1',
        GBRAIN_TEST_TOTAL_CONCURRENCY: '2',
        GBRAIN_TEST_MAX_CONCURRENCY: undefined,
      });
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('WEDGED after 1s (rc=124)');
      const failureLog = readFileSync(join(TMPROOT, '.context', 'test-failures.log'), 'utf-8');
      expect(failureLog).toMatch(/--- shard \d+: WEDGED after 1s ---/);
    } finally {
      rmSync(timeoutFixture, { force: true });
      const failing = `import { describe, it, expect } from 'bun:test';
describe('failing-on-purpose', () => {
  it('expects 1 to equal 2', () => { expect(1).toBe(2); });
});`;
      writeFileSync(join(TMPROOT, 'test', 'd-fail.test.ts'), failing);
    }
  }, 10_000);

  it('marks the whole serial suite WEDGED and KILLs it when it ignores TERM', () => {
    const failFixture = join(TMPROOT, 'test', 'd-fail.test.ts');
    const serialFixture = join(TMPROOT, 'test', 'serial-timeout.serial.test.ts');
    const serialScript = join(TMPROOT, 'scripts', 'run-serial-tests.sh');
    rmSync(failFixture, { force: true });
    writeFileSync(serialFixture, '// discovery sentinel; synthetic runner below owns the timeout\n');
    writeFileSync(serialScript, `#!/usr/bin/env bash
trap '' TERM
while :; do sleep 1; done
`);
    chmodSync(serialScript, 0o755);
    try {
      const r = runWrapper([], {
        GBRAIN_TEST_FORCE_MANUAL_TIMEOUT: '1',
        GBRAIN_TEST_SHARD_TIMEOUT: '10',
        GBRAIN_TEST_SERIAL_TIMEOUT: '1',
        GBRAIN_TEST_TIMEOUT_GRACE: '1',
        GBRAIN_TEST_TOTAL_CONCURRENCY: '2',
        GBRAIN_TEST_MAX_CONCURRENCY: undefined,
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('SERIAL WEDGED after 1s (rc=124)');
      const logDir = join(TMPROOT, '.context', 'test-shards');
      expect(existsSync(join(logDir, 'serial.timeout-fired'))).toBe(true);
      expect(existsSync(join(logDir, 'serial.wedged'))).toBe(true);
      const summary = readFileSync(join(TMPROOT, '.context', 'test-summary.txt'), 'utf-8');
      expect(summary).toContain('serial: WEDGED after 1s (rc=124)');
      const failureLog = readFileSync(join(TMPROOT, '.context', 'test-failures.log'), 'utf-8');
      expect(failureLog).toContain('--- serial suite: WEDGED after 1s ---');
    } finally {
      copyFileSync(SERIAL_SH_SRC, serialScript);
      chmodSync(serialScript, 0o755);
      rmSync(serialFixture, { force: true });
      const failing = `import { describe, it, expect } from 'bun:test';
describe('failing-on-purpose', () => {
  it('expects 1 to equal 2', () => { expect(1).toBe(2); });
});`;
      writeFileSync(failFixture, failing);
    }
  }, 15_000);
});

describe('run-unit-parallel.sh exit-code propagation (a)', () => {
  it('exits non-zero when any shard contains a failing test', () => {
    const r = runWrapper();
    expect(r.code).not.toBe(0);
  });

  it('exits zero when all shards pass (after removing the failing fixture)', () => {
    rmSync(join(TMPROOT, 'test', 'd-fail.test.ts'));
    try {
      const r = runWrapper();
      expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
    } finally {
      // Restore the failing fixture for any downstream tests in the same
      // describe block (afterAll cleans the whole tempdir; this is belt-
      // and-suspenders).
      const failing = `import { describe, it, expect } from 'bun:test';
describe('failing-on-purpose', () => {
  it('expects 1 to equal 2', () => { expect(1).toBe(2); });
});`;
      writeFileSync(join(TMPROOT, 'test', 'd-fail.test.ts'), failing);
    }
  });
});

describe('run-unit-parallel.sh failure-log contract (d)', () => {
  it('writes failures to .context/test-failures.log with --- shard prefix on failure', () => {
    const r = runWrapper();
    expect(r.code).not.toBe(0);

    const failureLog = join(TMPROOT, '.context/test-failures.log');
    expect(existsSync(failureLog)).toBe(true);
    const contents = readFileSync(failureLog, 'utf-8');
    expect(contents.length).toBeGreaterThan(0);
    expect(contents).toMatch(/--- shard \d+:/);
    expect(contents).toContain('failing-on-purpose');
  });

  it('prints loud stderr banner with absolute failure-log path on failure', () => {
    const r = runWrapper();
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('TEST FAILURES');
    // Banner includes the absolute path so users can `cat` it directly.
    expect(r.stderr).toContain(join(TMPROOT, '.context', 'test-failures.log'));
  });

  it('clears .context/test-failures.log to empty when all shards pass', () => {
    // Pre-seed a stale failure log to prove it gets cleared.
    mkdirSync(join(TMPROOT, '.context'), { recursive: true });
    writeFileSync(join(TMPROOT, '.context', 'test-failures.log'), 'STALE\n');
    rmSync(join(TMPROOT, 'test', 'd-fail.test.ts'));
    try {
      const r = runWrapper();
      expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
      const contents = readFileSync(join(TMPROOT, '.context', 'test-failures.log'), 'utf-8');
      expect(contents).toBe('');
    } finally {
      const failing = `import { describe, it, expect } from 'bun:test';
describe('failing-on-purpose', () => {
  it('expects 1 to equal 2', () => { expect(1).toBe(2); });
});`;
      writeFileSync(join(TMPROOT, 'test', 'd-fail.test.ts'), failing);
    }
  });

  it('writes per-shard summary lines to .context/test-summary.txt', () => {
    runWrapper();
    const summary = readFileSync(join(TMPROOT, '.context', 'test-summary.txt'), 'utf-8');
    // Format: `shard 1/2: pass=N fail=N skip=N rc=N`
    expect(summary).toMatch(/shard 1\/2: pass=\d+ fail=\d+ skip=\d+ rc=\d+/);
    expect(summary).toMatch(/shard 2\/2: pass=\d+ fail=\d+ skip=\d+ rc=\d+/);
  });
});
