/**
 * Locally compiled release policy for unattended/inline upgrades.
 *
 * A binary that contains this policy cannot safely infer a NEW release's
 * migration contract from remote prose. It therefore fails closed from the
 * first release that requires a supervised staged cutover. A later binary may
 * explicitly allowlist a known-safe target after reviewing its migration
 * contract.
 *
 * This does NOT retroactively protect older binaries that predate this module.
 * The release workflow separately keeps the supervised floor and unknown
 * future versions out of GitHub's normal `latest` channel.
 */

export const UPGRADE_RELEASE_POLICY = Object.freeze({
  schema_version: 1 as const,
  supervised_staged_floor: '0.42.59.0',
  inline_safe_targets: [] as readonly string[],
  /** Versions at/after this boundary publish as prerelease, not normal latest. */
  normal_latest_max_exclusive: '0.42.59.0',
});

export interface ResolvedUpgradeReleasePolicy {
  target: string;
  inlineAllowed: boolean;
  requiresSupervisedStagedRelease: boolean;
  reason: string;
}

export interface ResolvedReleasePublicationPolicy {
  target: string;
  channel: 'latest' | 'prerelease';
  prerelease: boolean;
  makeLatest: boolean;
  reason: string;
}

function parseVersion(value: string): [number, number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const parts = [match[1], match[2], match[3], match[4] ?? '0'].map(Number);
  if (!parts.every(Number.isSafeInteger)) return null;
  return parts as [number, number, number, number];
}

function compareVersions(
  left: [number, number, number, number],
  right: [number, number, number, number],
): number {
  for (let i = 0; i < 4; i++) {
    if (left[i]! !== right[i]!) return left[i]! > right[i]! ? 1 : -1;
  }
  return 0;
}

export function resolveUpgradeReleasePolicy(target: string): ResolvedUpgradeReleasePolicy {
  const parsedTarget = parseVersion(target);
  const floor = parseVersion(UPGRADE_RELEASE_POLICY.supervised_staged_floor)!;
  if (!parsedTarget) {
    return {
      target,
      inlineAllowed: false,
      requiresSupervisedStagedRelease: true,
      reason: 'target version is malformed; unattended upgrade is denied',
    };
  }

  if (UPGRADE_RELEASE_POLICY.inline_safe_targets.includes(target)) {
    return {
      target,
      inlineAllowed: true,
      requiresSupervisedStagedRelease: false,
      reason: 'target is explicitly approved by this running binary',
    };
  }

  if (compareVersions(parsedTarget, floor) >= 0) {
    return {
      target,
      inlineAllowed: false,
      requiresSupervisedStagedRelease: true,
      reason:
        `target ${target} is at/after supervised floor ` +
        `${UPGRADE_RELEASE_POLICY.supervised_staged_floor} and is not locally allowlisted`,
    };
  }

  return {
    target,
    inlineAllowed: true,
    requiresSupervisedStagedRelease: false,
    reason: 'target predates the supervised staged-release boundary',
  };
}

/**
 * Protect clients that are too old to contain resolveUpgradeReleasePolicy().
 * Unknown future versions remain prereleases until operators deliberately
 * revise this boundary after a safe compatibility bridge is deployed.
 */
export function resolveReleasePublicationPolicy(
  target: string,
): ResolvedReleasePublicationPolicy | null {
  const parsedTarget = parseVersion(target);
  const latestBoundary = parseVersion(UPGRADE_RELEASE_POLICY.normal_latest_max_exclusive)!;
  if (!parsedTarget) return null;

  if (compareVersions(parsedTarget, latestBoundary) >= 0) {
    return {
      target,
      channel: 'prerelease',
      prerelease: true,
      makeLatest: false,
      reason:
        `target ${target} is at/after the normal-latest boundary ` +
        `${UPGRADE_RELEASE_POLICY.normal_latest_max_exclusive}`,
    };
  }

  return {
    target,
    channel: 'latest',
    prerelease: false,
    makeLatest: true,
    reason: 'target predates the supervised publication boundary',
  };
}
