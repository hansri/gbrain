import { VERSION } from '../version.ts';
import { isMinorOrMajorBump, isValidVersionString } from '../core/semver.ts';
import { fetchChangelog, fetchLatestRelease } from './check-update.ts';
import {
  assertInlineUpgradeTargetAllowed,
  detectInstallMethod,
  runUpgrade,
} from './upgrade.ts';
import { writeUpdateCache } from '../core/self-upgrade.ts';

export function assertInlineSelfUpgradeReleaseAllowed(target: string | null): asserts target is string {
  if (!target || !isValidVersionString(target)) {
    throw new Error(
      'Self-upgrade could not determine an exact valid release target; inline replacement is denied.',
    );
  }
  assertInlineUpgradeTargetAllowed(target, VERSION);
}

/**
 * `gbrain self-upgrade [--check-only] [--force] [--json]`
 *
 * The universal substrate every agent ecosystem (Codex / Claude Code / Hermes /
 * OpenClaw / Perplexity-server) can call to stay current. The CLI startup hook
 * emits a marker; the agent skill / autopilot daemon act on it by running THIS
 * command. The action is always the hardcoded `gbrain upgrade --target X`,
 * where X came from validated release metadata and passed the local compiled
 * release policy; free-form marker content is never executed.
 *
 *   --check-only  Report whether an upgrade is available; never apply.
 *   --force       Apply even if not behind (re-run the install-method swap).
 *   --json        Machine-readable output for the check.
 */
export async function runSelfUpgrade(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: gbrain self-upgrade [--check-only] [--force] [--json]\n\n' +
        'Check for and apply gbrain updates. The shared entry point used by the\n' +
        'CLI startup marker, the gbrain-upgrade agent skill, and the autopilot\n' +
        'silent channel.\n\n' +
        '  --check-only  Report whether an upgrade is available; do not apply.\n' +
        '  --force       Apply even when not behind.\n' +
        '  --json        Machine-readable output (with --check-only).',
    );
    return;
  }

  const checkOnly = args.includes('--check-only');
  const force = args.includes('--force');
  const json = args.includes('--json');

  const release = await fetchLatestRelease();
  const latest = release ? release.tag.replace(/^v/, '') : null;
  const behind = !!latest && isValidVersionString(latest) && isMinorOrMajorBump(VERSION, latest);

  // Warm the cache so the next invocation's startup hook can emit without a fetch.
  try {
    if (latest && isValidVersionString(latest)) {
      writeUpdateCache(
        behind
          ? { kind: 'upgrade_available', current: VERSION, latest }
          : { kind: 'up_to_date', current: VERSION },
      );
    }
  } catch {
    /* best-effort */
  }

  if (checkOnly) {
    // Tell the operator WHAT they'd get: fetch the changelog only when actually
    // behind (so an up-to-date check stays a single release fetch). The agent
    // skill surfaces these "what's new" bullets in the notify prompt.
    let changelogDiff = '';
    if (behind && latest) {
      try {
        changelogDiff = await fetchChangelog(VERSION, latest);
      } catch {
        /* best-effort: an unavailable changelog must not block the check */
      }
    }
    if (json) {
      console.log(
        JSON.stringify(
          {
            current_version: VERSION,
            latest_version: latest ?? '',
            update_available: behind,
            install_method: detectInstallMethod(),
            release_url: release?.url ?? '',
            changelog_diff: changelogDiff,
          },
          null,
          2,
        ),
      );
    } else if (behind) {
      console.log(`Update available: ${VERSION} -> ${latest}. Run: gbrain self-upgrade`);
      if (changelogDiff) {
        console.log('\nWhat changed:\n');
        console.log(changelogDiff);
      }
      if (release?.url) console.log(`\nRelease: ${release.url}`);
    } else {
      console.log(`gbrain ${VERSION} is up to date.`);
    }
    return;
  }

  if (!behind && !force) {
    console.log(`gbrain ${VERSION} is up to date.`);
    return;
  }

  // The exact target must be approved by policy compiled into this running
  // binary before any inline swap. Remote release metadata can identify a
  // target, but it cannot grant itself permission to bypass a supervised
  // staged release. `--force` deliberately does not weaken this boundary.
  assertInlineSelfUpgradeReleaseAllowed(latest);

  // Carry the exact locally approved target into the updater. The upgrade
  // command pins and re-verifies this version; it never re-resolves latest.
  await runUpgrade(['--target', latest]);
}
