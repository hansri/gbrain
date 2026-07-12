import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateReleaseChannel } from '../scripts/check-release-channel-policy.ts';

describe('release channel publication gate', () => {
  test('v0.42.59.0 and unknown future targets are prerelease-only', () => {
    for (const version of ['0.42.59.0', '0.42.60.0', '1.0.0.0']) {
      expect(evaluateReleaseChannel(`v${version}`, version)).toMatchObject({
        channel: 'prerelease',
        prerelease: true,
        make_latest: false,
      });
    }
  });

  test('pre-boundary target can remain normal latest', () => {
    expect(evaluateReleaseChannel('v0.42.58.0', '0.42.58.0')).toMatchObject({
      channel: 'latest',
      prerelease: false,
      make_latest: true,
    });
  });

  test('tag/version mismatch and malformed tags fail closed', () => {
    expect(() => evaluateReleaseChannel('v0.42.59.0', '0.42.58.0'))
      .toThrow('does not match VERSION');
    expect(() => evaluateReleaseChannel('latest', '0.42.59.0'))
      .toThrow('invalid release tag');
  });

  test('script writes prerelease-only GitHub outputs for the current release', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-release-policy-'));
    const output = join(root, 'github-output');
    try {
      const result = Bun.spawnSync(
        [process.execPath, join(import.meta.dir, '../scripts/check-release-channel-policy.ts'), 'v0.42.59.0'],
        {
          env: { ...process.env, GITHUB_OUTPUT: output },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toMatchObject({
        channel: 'prerelease',
        prerelease: true,
        make_latest: false,
      });
      expect(readFileSync(output, 'utf8')).toContain('prerelease=true');
      expect(readFileSync(output, 'utf8')).toContain('make_latest=false');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('workflow consumes the gate outputs instead of publishing normal latest', () => {
    const workflow = readFileSync(join(import.meta.dir, '../.github/workflows/release.yml'), 'utf8');
    expect(workflow).toContain('bun scripts/check-release-channel-policy.ts "$GITHUB_REF_NAME"');
    expect(workflow).toContain('prerelease: ${{ steps.release_policy.outputs.prerelease }}');
    expect(workflow).toContain('make_latest: ${{ steps.release_policy.outputs.make_latest }}');
  });

  test('tag publication requires the tagged commit to be reachable from master', () => {
    const workflow = readFileSync(join(import.meta.dir, '../.github/workflows/release.yml'), 'utf8');
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('git fetch --no-tags origin master');
    expect(workflow).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/master');
    expect(workflow).toContain('tagged commit is not reachable from origin/master');
  });

  test('tag publication and pull requests share the exact Postgres authority gate', () => {
    const releaseWorkflow = readFileSync(
      join(import.meta.dir, '../.github/workflows/release.yml'),
      'utf8',
    );
    const e2eWorkflow = readFileSync(
      join(import.meta.dir, '../.github/workflows/e2e.yml'),
      'utf8',
    );
    const authorityWorkflow = readFileSync(
      join(import.meta.dir, '../.github/workflows/postgres-schema-authority.yml'),
      'utf8',
    );
    const sharedGate = 'uses: ./.github/workflows/postgres-schema-authority.yml';

    expect(releaseWorkflow).toContain(sharedGate);
    expect(e2eWorkflow).toContain(sharedGate);
    expect(releaseWorkflow).toContain('needs: [quality, postgres-schema-authority]');

    expect(authorityWorkflow).toContain('workflow_call:');
    expect(authorityWorkflow).toContain('postgres-1 postgres-2 pgbouncer');
    expect(authorityWorkflow).toContain(
      'GBRAIN_PGBOUNCER_WRONG_DIRECT_URL: postgresql://postgres:postgres@127.0.0.1:5435/gbrain_test',
    );
    expect(authorityWorkflow).toContain(
      'bun test --max-concurrency=1 test/e2e/postgres-bootstrap.test.ts',
    );
    expect(authorityWorkflow).toContain(
      'env -u DATABASE_URL bun test --max-concurrency=1 test/e2e/pgbouncer-teardown.test.ts',
    );

    // The exact topology and command list have one owner. Inline copies in a
    // caller would let pull-request and tag-release gates drift independently.
    expect(releaseWorkflow).not.toContain('GBRAIN_PGBOUNCER_WRONG_DIRECT_URL');
    expect(e2eWorkflow).not.toContain('GBRAIN_PGBOUNCER_WRONG_DIRECT_URL');
  });
});
