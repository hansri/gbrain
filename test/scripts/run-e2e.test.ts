import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SOURCE_SCRIPT = resolve(import.meta.dir, '../../scripts/run-e2e.sh');
const CI_LOCAL_SCRIPT = resolve(import.meta.dir, '../../scripts/ci-local.sh');
const RESET_POSTGRES_SCRIPT = resolve(import.meta.dir, '../../scripts/reset-e2e-postgres.ts');
const roots: string[] = [];

interface Sandbox {
  root: string;
  script: string;
  home: string;
  observed: string;
  bin: string;
}

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'run-e2e-test-'));
  roots.push(root);
  const scripts = join(root, 'scripts');
  const bin = join(root, 'bin');
  const home = join(root, 'operator-home');
  const observed = join(root, 'observed.tsv');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, 'test/e2e'), { recursive: true });
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(root, 'test/e2e/first.test.ts'), '');
  writeFileSync(join(root, 'test/e2e/second.test.ts'), '');

  const script = join(scripts, 'run-e2e.sh');
  copyFileSync(SOURCE_SCRIPT, script);
  chmodSync(script, 0o755);

  executable(join(bin, 'gtimeout'), `#!/usr/bin/env bash
shift
exec "$@"
`);
  executable(join(bin, 'bun'), `#!/usr/bin/env bash
printf '%s\t%s\t%s\t%s\t%s\n' "$HOME" "$GBRAIN_HOME" "${'${@: -1}'}" "$GBRAIN_TEST_DB" "${'${GBRAIN_SOURCE-<unset>}'}" >> "$E2E_RUNNER_OBSERVED"
if [ -n "${'${E2E_BREACH_TARGET:-}'}" ]; then
  printf 'changed-by-fixture\n' > "$E2E_BREACH_TARGET"
fi
printf ' 1 pass\n 0 fail\n'
`);

  return { root, script, home, observed, bin };
}

function run(sb: Sandbox, extraEnv: Record<string, string> = {}) {
  const env = { ...process.env } as Record<string, string>;
  delete env.DATABASE_URL;
  delete env.SHARD;
  env.HOME = sb.home;
  env.PATH = `${sb.bin}:${env.PATH ?? ''}`;
  env.E2E_RUNNER_OBSERVED = sb.observed;
  Object.assign(env, extraEnv);
  return spawnSync(
    'bash',
    [sb.script, 'test/e2e/first.test.ts', 'test/e2e/second.test.ts'],
    { cwd: sb.root, encoding: 'utf8', env },
  );
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('run-e2e.sh HOME isolation', () => {
  it('gives every file a distinct private HOME and GBRAIN_HOME', () => {
    const sb = makeSandbox();
    const result = run(sb);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const rows = readFileSync(sb.observed, 'utf8').trim().split('\n').map((line) => line.split('\t'));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row[2])).toEqual([
      'test/e2e/first.test.ts',
      'test/e2e/second.test.ts',
    ]);
    expect(rows[0][0]).toBe(rows[0][1]);
    expect(rows[1][0]).toBe(rows[1][1]);
    expect(rows[0][0]).not.toBe(rows[1][0]);
    expect(rows[0][0]).not.toBe(sb.home);
    expect(existsSync(rows[0][0])).toBe(false);
    expect(existsSync(rows[1][0])).toBe(false);
  });

  it('retains the outer real-config breach detector', () => {
    const sb = makeSandbox();
    const config = join(sb.home, '.gbrain/config.json');
    writeFileSync(config, '{"before":true}\n');

    const result = run(sb, { E2E_BREACH_TARGET: config });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('ERROR: HOME isolation breach detected.');
    expect(result.stderr).toContain('config md5 changed during run');
  });

  it('retains the hard-gated test DB topology flag but scrubs operator overrides', () => {
    const sb = makeSandbox();
    const result = run(sb, {
      GBRAIN_TEST_DB: '1',
      GBRAIN_SOURCE: 'must-not-leak',
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const rows = readFileSync(sb.observed, 'utf8').trim().split('\n').map((line) => line.split('\t'));
    expect(rows.every((row) => row[3] === '1')).toBe(true);
    expect(rows.every((row) => row[4] === '<unset>')).toBe(true);
  });
});

describe('ci-local.sh destructive test-database authorization', () => {
  it('opts every non-local gbrain_test E2E invocation into the hard-gated reset', () => {
    const lines = readFileSync(CI_LOCAL_SCRIPT, 'utf8').split('\n');
    let invocations = 0;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line.startsWith('DATABASE_URL=postgresql://postgres:postgres@postgres-') ||
          !line.includes(':5432/gbrain_test')) {
        continue;
      }
      invocations += 1;
      expect(lines[index + 1]?.trim()).toMatch(/^GBRAIN_TEST_DB=1 /);
    }

    expect(invocations).toBe(4);
  });

  it('verifies the literal test authority before resetting warm schemas', () => {
    const script = readFileSync(CI_LOCAL_SCRIPT, 'utf8');
    expect(script).toContain("SELECT current_database()");
    expect(script).toContain('if [ "$actual_db" != "gbrain_test" ]');
    expect(script).toContain("SET client_min_messages=warning; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  });

  it('applies the test DB environment to xargs children in no-shard diff mode', () => {
    const script = readFileSync(CI_LOCAL_SCRIPT, 'utf8');
    const noShardDiff = script.slice(
      script.indexOf('e2e (unsharded, --diff selected)'),
      script.indexOf("echo \"[runner] e2e (unsharded)\""),
    );
    expect(noShardDiff).toContain('echo "$SELECTED" | xargs env \\');
    expect(noShardDiff).toMatch(/xargs env \\\n\s+DATABASE_URL=.*gbrain_test \\\n\s+GBRAIN_TEST_DB=1/);
    expect(noShardDiff).not.toMatch(/GBRAIN_TEST_DB=1 \\\n\s+.*echo "\$SELECTED" \| xargs bash/);
  });

  it('passes only the guarded gbrain_test base authority to PgBouncer E2E', () => {
    const script = readFileSync(CI_LOCAL_SCRIPT, 'utf8');
    const assignments = script.match(/GBRAIN_PGBOUNCER_URL=[^\s]+\/gbrain_test/g) ?? [];
    expect(assignments).toHaveLength(4);
    expect(script).not.toMatch(/GBRAIN_PGBOUNCER_URL=[^\s]+\/gbrain_pgbouncer/);
  });
});

describe('run-e2e.sh Postgres schema isolation', () => {
  it('resets the guarded test schema before each Bun test process', () => {
    const wrapper = readFileSync(SOURCE_SCRIPT, 'utf8');
    const resetCall = wrapper.indexOf('bun run scripts/reset-e2e-postgres.ts');
    const testCall = wrapper.indexOf('bun test --timeout=60000 "$f"');
    expect(resetCall).toBeGreaterThan(0);
    expect(testCall).toBeGreaterThan(resetCall);
  });

  it('uses the shared fail-closed authority guard and removes all prior schema state', () => {
    const reset = readFileSync(RESET_POSTGRES_SCRIPT, 'utf8');
    expect(reset).toContain('requirePostgresTestUrl()');
    expect(reset).toContain('pg_terminate_backend');
    expect(reset).toContain('DROP SCHEMA IF EXISTS public CASCADE');
    expect(reset).toContain('CREATE SCHEMA public');
  });
});
