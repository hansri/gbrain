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
printf '%s\t%s\t%s\n' "$HOME" "$GBRAIN_HOME" "${'${@: -1}'}" >> "$E2E_RUNNER_OBSERVED"
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
});
