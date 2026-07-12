#!/usr/bin/env bun

import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveReleasePublicationPolicy } from '../src/core/upgrade-release-policy.ts';

export interface ReleaseChannelDecision {
  schema_version: 1;
  tag: string;
  target: string;
  channel: 'latest' | 'prerelease';
  prerelease: boolean;
  make_latest: boolean;
  reason: string;
}

export function evaluateReleaseChannel(
  tag: string,
  expectedVersion: string,
): ReleaseChannelDecision {
  const match = /^v(\d+\.\d+\.\d+(?:\.\d+)?)$/.exec(tag);
  if (!match) throw new Error(`invalid release tag: ${tag}`);
  const target = match[1]!;
  if (target !== expectedVersion) {
    throw new Error(`release tag ${target} does not match VERSION ${expectedVersion}`);
  }

  const policy = resolveReleasePublicationPolicy(target);
  if (!policy) throw new Error(`release target is not a valid version: ${target}`);
  return {
    schema_version: 1,
    tag,
    target,
    channel: policy.channel,
    prerelease: policy.prerelease,
    make_latest: policy.makeLatest,
    reason: policy.reason,
  };
}

function currentVersion(): string {
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  return readFileSync(resolve(repoRoot, 'VERSION'), 'utf8').trim();
}

function main(): void {
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? '';
  const decision = evaluateReleaseChannel(tag, currentVersion());
  process.stdout.write(`${JSON.stringify(decision)}\n`);

  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    appendFileSync(
      outputPath,
      [
        `target=${decision.target}`,
        `channel=${decision.channel}`,
        `prerelease=${String(decision.prerelease)}`,
        `make_latest=${String(decision.make_latest)}`,
        '',
      ].join('\n'),
      { encoding: 'utf8', mode: 0o600 },
    );
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[release-policy] blocked: ${message}\n`);
    process.exit(2);
  }
}
