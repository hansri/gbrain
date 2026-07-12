import { execSync, execFileSync } from 'child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync, readFileSync, realpathSync,
} from 'fs';
import { basename, join, dirname, resolve } from 'path';
import { homedir } from 'node:os';
import { VERSION } from '../version.ts';
import type { UpgradeChildTransition } from '../core/upgrade-child-capability.ts';
import { gbrainPath } from '../core/config.ts';
import {
  getOrCreateDatabaseInstanceId,
  readDatabaseInstanceId,
} from '../core/database-instance-id.ts';
import { redactPgUrl } from '../core/url-redact.ts';
import {
  appendOwnedStateFile,
  readOwnedStateFile,
  withOwnedStateReadPolicy,
  writeOwnedStateFileAtomic,
} from '../core/owned-state-file.ts';
import {
  resolveCurrentGbrainInvocation,
  type CurrentReleaseRuntime,
} from './migrations/in-process.ts';
import { resolveUpgradeReleasePolicy } from '../core/upgrade-release-policy.ts';

const GBRAIN_GITHUB_REPO = 'garrytan/gbrain';
const MAX_UPGRADE_EVIDENCE_ERROR_CHARS = 4_096;
const MAX_UPGRADE_ERROR_LOG_BYTES = 4 * 1024 * 1024;
const MAX_UPGRADE_STATE_BYTES = 1 * 1024 * 1024;
const UPGRADE_STATE_LOCK_NAME = 'upgrade-state-transition';
const UPGRADE_STATE_LOCK_TTL_MS = 2 * 60 * 60 * 1000;
const UNVERIFIED_UPGRADE_TARGET = '<unverified-replacement>';
const UPGRADE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UPGRADE_BRAIN_ID_RE = /^db:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface UpgradeTransitionContext {
  transitionId: string;
  /** Null means the upgrade deliberately started without a local brain. */
  brainId: string | null;
}

export function resolveUpgradeInvocation(
  args: readonly string[],
  runtime?: CurrentReleaseRuntime,
): string[] {
  return resolveCurrentGbrainInvocation(args, runtime);
}

export interface ParsedUpgradeInvocation {
  swapOnly: boolean;
  target: string | null;
}

export function parseUpgradeInvocation(args: readonly string[]): ParsedUpgradeInvocation {
  let swapOnly = false;
  let target: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--swap-only') {
      if (swapOnly) throw new Error('Duplicate --swap-only flag.');
      swapOnly = true;
      continue;
    }
    if (arg === '--target') {
      if (target !== null) throw new Error('Duplicate --target flag.');
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--target requires one exact release version.');
      }
      target = normalizedVersion(value);
      continue;
    }
    throw new Error(`Unknown upgrade option: ${arg}`);
  }
  return { swapOnly, target };
}

export function assertInlineUpgradeTargetAllowed(
  target: string,
  currentVersion: string = VERSION,
): string {
  const normalizedTarget = normalizedVersion(target);
  if (!parseSupportedUpgradeVersion(normalizedTarget)) {
    throw new Error(`Upgrade target ${JSON.stringify(target)} is not an exact supported release version.`);
  }
  if (!isStrictUpgrade(currentVersion, normalizedTarget)) {
    throw new Error(
      `Upgrade target must be one exact forward release: ` +
      `${normalizedVersion(currentVersion)} -> ${normalizedTarget}.`,
    );
  }
  const policy = resolveUpgradeReleasePolicy(normalizedTarget);
  if (!policy.inlineAllowed) {
    throw new Error(
      `Inline upgrade to v${normalizedTarget} is denied: ${policy.reason}. ` +
      'Use a supervised staged promotion with matched database and file-state rollback.',
    );
  }
  return normalizedTarget;
}

async function resolveExactUpgradeTarget(
  requestedTarget: string | null,
  currentVersion: string,
): Promise<string> {
  let target = requestedTarget;
  if (target === null) {
    const { fetchLatestRelease } = await import('./check-update.ts');
    const release = await fetchLatestRelease();
    target = release?.tag ? normalizedVersion(release.tag) : null;
  }
  if (!target) {
    throw new Error('Upgrade could not resolve one exact release target before mutation.');
  }
  return assertInlineUpgradeTargetAllowed(target, currentVersion);
}

async function withUpgradeStateLock<T>(
  run: () => Promise<T> | T,
  lockDir: string = gbrainPath('locks'),
): Promise<T> {
  const { withPackLock } = await import('../core/schema-pack/pack-lock.ts');
  return withPackLock(
    UPGRADE_STATE_LOCK_NAME,
    { lockDir, ttlMs: UPGRADE_STATE_LOCK_TTL_MS },
    run,
  );
}

async function configuredUpgradeBrainId(createIfMissing: boolean): Promise<string | null> {
  const { loadConfig, toEngineConfig, isThinClient } = await import('../core/config.ts');
  const config = loadConfig();
  if (!config || isThinClient(config)) return null;
  const engineConfig = toEngineConfig(config);
  const {
    assertExistingPgliteDataDirForReadOnlyOpen,
    createEngine,
  } = await import('../core/engine-factory.ts');
  let pgliteReadOnlyAuthority;
  if (!createIfMissing) {
    // Resolve child-side authority without letting PGLite turn a stale/moved
    // configured path into a fresh empty store.
    pgliteReadOnlyAuthority = assertExistingPgliteDataDirForReadOnlyOpen(engineConfig);
  }
  const engine = await createEngine(engineConfig, { pgliteReadOnlyAuthority });
  try {
    await engine.connect(engineConfig);
    return createIfMissing
      ? await getOrCreateDatabaseInstanceId(engine)
      : await readDatabaseInstanceId(engine);
  } finally {
    try { await engine.disconnect(); } catch { /* best-effort */ }
  }
}

/** Parent-side authority establishment before a binary swap. */
export async function establishConfiguredUpgradeBrainId(): Promise<string | null> {
  return configuredUpgradeBrainId(true);
}

/** Child-side read-only authority resolution before touching a bound brain. */
export async function resolveConfiguredUpgradeBrainId(): Promise<string | null> {
  return configuredUpgradeBrainId(false);
}

function redactLocalUpgradePaths(value: string): string {
  const prefixes = new Map<string, string>();
  try { prefixes.set(gbrainPath(), '<gbrain-home>'); } catch { /* invalid override is sanitized below */ }
  const configuredParent = process.env.GBRAIN_HOME?.trim();
  if (configuredParent && configuredParent.length > 1) {
    prefixes.set(configuredParent, '<gbrain-home-parent>');
  }
  const home = process.env.HOME?.trim();
  if (home && home.length > 1) prefixes.set(home, '<home>');

  let redacted = value;
  for (const [prefix, replacement] of [...prefixes.entries()].sort((a, b) => b[0].length - a[0].length)) {
    redacted = redacted.split(prefix).join(replacement);
  }
  return redacted;
}

export function sanitizeUpgradeEvidenceError(error: unknown): string {
  let text = redactLocalUpgradePaths(String(error ?? 'unknown upgrade error'))
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/gu, ' ')
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, value => redactPgUrl(value))
    .replace(/\b(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) text = 'unknown upgrade error';
  return text.slice(0, MAX_UPGRADE_EVIDENCE_ERROR_CHARS);
}

export async function runUpgrade(args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: gbrain upgrade [--target <version>] [--swap-only]\n\nSelf-update the CLI to one exact approved release.\n\nDetects install method, pins the requested package/tag/asset, and verifies the\ninstalled version exactly. Without --target, resolves GitHub latest before any\nmutation.\n\n--target     Exact release version approved before the swap.\n--swap-only  Perform ONLY the binary/source swap and skip post-upgrade\n             (migrations run on the next launch). Used by the autopilot\n             silent self-upgrade channel so the daemon can swap + relaunch\n             without a 30-min blocking post-upgrade inside its tick.');
    return;
  }

  const invocation = parseUpgradeInvocation(args);

  // Parent-side mutation (binary swap + durable handoff publication) is one
  // locked transition. The lock is deliberately released before spawning the
  // NEW binary: `gbrain post-upgrade` acquires the same lock in its own process.
  const handoff = await withUpgradeStateLock(async () => {
    assertNoUnresolvedUpgradeTransition();

    // --swap-only: do the swap, skip the (potentially 30-min) post-upgrade. The
    // relaunched binary runs migrations on boot (split-brain guard). v0.42.
    const swapOnly = invocation.swapOnly;
    const oldVersion = VERSION;
    const targetVersion = await resolveExactUpgradeTarget(invocation.target, oldVersion);
    const method = detectInstallMethod();
    const linkInfo = method === 'bun-link' ? detectBunLink() : null;

    console.log(`Detected install method: ${method}`);
    if (method === 'unknown') {
      console.error('Could not detect installation method.');
      console.log('Try one of:');
      console.log('  bun update gbrain');
      console.log('  clawhub update gbrain');
      console.log('  Download from https://github.com/garrytan/gbrain/releases');
      return null;
    }
    if (method === 'clawhub') {
      throw new Error(
        `ClawHub cannot prove an exact ${targetVersion} install. ` +
        'Use a supervised exact-version install, then run `gbrain post-upgrade`.',
      );
    }
    if (method === 'bun-link' && !linkInfo) {
      console.error('bun-link detected but could not resolve repo root.');
      return null;
    }

    const transitionContext: UpgradeTransitionContext = {
      transitionId: randomUUID(),
      brainId: await establishConfiguredUpgradeBrainId(),
    };
    publishUpgradeSwapWriteAhead(oldVersion, transitionContext);

    let upgraded = false;
    let failureIsKnownNoSwap = false;
    switch (method) {
      case 'bun-link': {
        if (!linkInfo) throw new Error('bun-link install authority disappeared before swap');
        console.log(`Upgrading bun-link source clone to exact v${targetVersion} at ${linkInfo.repoRoot}...`);
        try {
          const tagRef = `refs/tags/v${targetVersion}`;
          execFileSync(
            'git',
            ['-C', linkInfo.repoRoot, 'fetch', '--force', 'origin', `${tagRef}:${tagRef}`],
            { stdio: 'inherit', timeout: 120_000 },
          );
          execFileSync(
            'git',
            ['-C', linkInfo.repoRoot, 'checkout', '--detach', tagRef],
            { stdio: 'inherit', timeout: 120_000 },
          );
          execFileSync(
            'bun', ['install', '--frozen-lockfile'],
            { cwd: linkInfo.repoRoot, stdio: 'inherit', timeout: 120_000 },
          );
          upgraded = true;
        } catch {
          console.error(`Exact source upgrade to v${targetVersion} failed.`);
          console.error('Verify the checked-out tag and reinstall before running `gbrain post-upgrade`.');
        }
        break;
      }

      case 'bun': {
        console.log(`Upgrading via bun to exact ${targetVersion}...`);
        const bunGlobalRoot = resolveBunGlobalRoot();
        try {
          execFileSync(
            // The unscoped npm `gbrain` name is an unrelated package. Keep the
            // install authority on the reviewed upstream repository and bind
            // it to the exact release tag before the post-swap verification.
            'bun', ['add', '--exact', `github:${GBRAIN_GITHUB_REPO}#v${targetVersion}`],
            { cwd: bunGlobalRoot, stdio: 'inherit', timeout: 120_000 },
          );
          upgraded = true;
        } catch {
          console.error(`Exact bun upgrade to ${targetVersion} failed.`);
        }
        break;
      }

      case 'binary': {
        const { runBinarySelfUpdate } = await import('../core/binary-self-update.ts');
        console.log(`Updating gbrain binary to exact ${targetVersion} (atomic download + replace)...`);
        const result = await runBinarySelfUpdate(process.execPath, {
          expectedVersion: targetVersion,
        });
        if (result.ok) {
          upgraded = true;
        } else if (result.reason === 'unsupported_platform' || result.reason === 'no_asset') {
          failureIsKnownNoSwap = true;
          console.log('No published binary for this platform/arch.');
          console.log('Download the latest binary from GitHub Releases:');
          console.log('  https://github.com/garrytan/gbrain/releases');
        } else {
          failureIsKnownNoSwap = true;
          console.error(`Binary self-update failed (${result.reason}${result.error ? `: ${result.error}` : ''}).`);
          console.error('Your existing binary is unchanged. Download manually if needed:');
          console.error('  https://github.com/garrytan/gbrain/releases');
          recordUpgradeError({
            phase: 'binary-self-update',
            fromVersion: oldVersion,
            toVersion: '',
            error: `${result.reason}${result.error ? `: ${result.error}` : ''}`,
            hint: 'Download from https://github.com/garrytan/gbrain/releases',
          }, transitionContext);
        }
        break;
      }

      default:
        break;
    }

    if (!upgraded) {
      if (failureIsKnownNoSwap) {
        saveUpgradeState(
          oldVersion,
          oldVersion,
          'complete',
          undefined,
          transitionContext,
        );
      } else {
        // A package/source updater can fail after replacing only part of the
        // install (for bun-link, git pull may succeed before bun install
        // fails). Preserve the unverified write-ahead fence verbatim so the
        // next runnable binary can either recover it or block the old binary.
        recordUpgradeError({
          phase: 'binary-swap',
          fromVersion: oldVersion,
          toVersion: UNVERIFIED_UPGRADE_TARGET,
          error: 'binary/source update did not complete cleanly',
          hint: 'Verify or reinstall the intended release, then run: gbrain post-upgrade',
        }, transitionContext);
      }
      return null;
    }

    // Verification is authoritative. The write-ahead fence remains untrusted
    // until the same install reports a strict forward release target.
    const newVersion = verifyUpgrade(undefined, oldVersion, targetVersion);
    // Re-evaluate the policy after the swap and before trusting the handoff.
    // The exact-version check above prevents a remote/latest race from turning
    // approval for X into installation of Y.
    assertInlineUpgradeTargetAllowed(newVersion, oldVersion);
    saveUpgradeState(
      oldVersion,
      newVersion,
      swapOnly ? 'deferred' : 'post_upgrade_pending',
      undefined,
      transitionContext,
    );

    try {
      const su = await import('../core/self-upgrade.ts');
      su.writeJustUpgraded(oldVersion);
      su.clearUpdateCache();
      su.clearSnooze();
    } catch {
      /* best-effort: never block the upgrade on confirmation bookkeeping */
    }

    return { oldVersion, newVersion, swapOnly, transitionContext };
  });

  if (!handoff || handoff.swapOnly) return;

  const postUpgradeTimeoutMs = Number(
    process.env.GBRAIN_POST_UPGRADE_TIMEOUT_MS || 1_800_000,
  );
  try {
    const invocation = resolveUpgradeInvocation(['post-upgrade']);
    execFileSync(invocation[0]!, invocation.slice(1), {
      stdio: 'inherit', timeout: postUpgradeTimeoutMs,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await recordParentPostUpgradeFailureIfMissing(
      handoff.oldVersion,
      handoff.newVersion,
      message,
      handoff.transitionContext,
    );
    throw new Error(
      `Upgrade incomplete: post-upgrade migrations failed. ` +
      `The new binary is installed, but feature setup was skipped. ` +
      `Run \`gbrain post-upgrade\` to resume the full idempotent setup. ` +
      `For read-only diagnosis use \`gbrain apply-migrations --list\` or \`--dry-run\`; ` +
      `mutation recovery must stay inside \`gbrain post-upgrade\`.`,
      { cause: e },
    );
  }

  await assertUpgradeTransitionComplete(handoff);
  try {
    const invocation = resolveUpgradeInvocation(['features']);
    execFileSync(invocation[0]!, invocation.slice(1), { stdio: 'inherit', timeout: 30_000 });
  } catch {
    // features scan is best-effort
  }
}

export function resolveBunGlobalRoot(): string {
  const bunInstall = process.env.BUN_INSTALL;
  if (bunInstall) {
    return join(bunInstall, 'install', 'global');
  }

  const defaultRoot = join(process.env.HOME || '', '.bun', 'install', 'global');
  if (isBunGlobalRoot(defaultRoot)) {
    return defaultRoot;
  }

  const installRoot = findBunInstallRootFromArgv();
  return installRoot ?? defaultRoot;
}

function isBunGlobalRoot(dir: string): boolean {
  return existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'node_modules'));
}

function findBunInstallRootFromArgv(): string | null {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return null;

    let dir = dirname(realpathSync(argv1));
    for (let i = 0; i < 10; i++) {
      if (basename(dir) === 'gbrain' && basename(dirname(dir)) === 'node_modules') {
        const root = dirname(dirname(dir));
        if (isBunGlobalRoot(root)) return root;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

export function verifyUpgrade(
  run?: () => string,
  previousVersion?: string,
  expectedVersion?: string,
): string {
  const execute = run ?? (() => {
    const invocation = resolveUpgradeInvocation(['--version']);
    return execFileSync(invocation[0]!, invocation.slice(1), {
      encoding: 'utf-8', timeout: 10_000,
    });
  });
  try {
    const output = execute().trim();
    const version = normalizedVersion(output);
    if (!version) throw new Error('replacement binary returned an empty version');
    if (!parseSupportedUpgradeVersion(version)) {
      throw new Error(`replacement binary returned unsupported version ${JSON.stringify(version)}`);
    }
    if (
      expectedVersion !== undefined &&
      normalizedVersion(expectedVersion) !== version
    ) {
      throw new Error(
        `replacement binary reported ${version}, not approved target ` +
        normalizedVersion(expectedVersion),
      );
    }
    if (previousVersion !== undefined && !isStrictUpgrade(previousVersion, version)) {
      throw new Error(`replacement binary did not advance ${normalizedVersion(previousVersion)} -> ${version}`);
    }
    console.log(`Upgrade complete. Now running: ${output}`);
    return version;
  } catch (error) {
    throw new Error(
      'Binary replacement could not be verified; the write-ahead fence remains and no target was trusted.',
      { cause: error },
    );
  }
}

/**
 * Append a structured record to ~/.gbrain/upgrade-errors.jsonl when a
 * best-effort phase of the upgrade fails (e.g., `gbrain post-upgrade`
 * silently bombing). Without this trail, users end up with half-upgraded
 * brains and no signal. `gbrain doctor` reads this file and surfaces the
 * paste-ready recovery hint. Failures here are themselves best-effort.
 */
export function recordUpgradeError(record: {
  phase: string;
  fromVersion: string;
  toVersion: string;
  error: string;
  hint: string;
}, context?: UpgradeTransitionContext): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    phase: sanitizeUpgradeEvidenceError(record.phase),
    from_version: sanitizeUpgradeEvidenceError(record.fromVersion),
    to_version: sanitizeUpgradeEvidenceError(record.toVersion),
    error: sanitizeUpgradeEvidenceError(record.error),
    hint: sanitizeUpgradeEvidenceError(record.hint),
    ...(context
      ? { transition_id: context.transitionId, brain_id: context.brainId }
      : {}),
  }) + '\n';
  try {
    appendOwnedStateFile(
      gbrainPath('upgrade-errors.jsonl'),
      line,
      MAX_UPGRADE_ERROR_LOG_BYTES,
      gbrainPath(),
    );
  } catch {
    // A symlink, hardlink, oversized file, or torn prior write is not trusted.
    // Reset this best-effort evidence atomically without reading/following the
    // old target. If the directory itself is unsafe, the reset also fails.
    try {
      writeOwnedStateFileAtomic(
        gbrainPath('upgrade-errors.jsonl'),
        line,
        MAX_UPGRADE_ERROR_LOG_BYTES,
        gbrainPath(),
      );
    } catch {
      // The user still sees the underlying failure on stdout/stderr.
    }
  }
}

export type UpgradeCompletionStatus =
  | 'swap_running'
  | 'post_upgrade_pending'
  | 'deferred'
  | 'running'
  | 'complete'
  | 'incomplete';

function transitionContextFromRecord(value: unknown): UpgradeTransitionContext | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { transition_id?: unknown; brain_id?: unknown; brain_required?: unknown };
  if (typeof record.transition_id !== 'string' || !UPGRADE_UUID_RE.test(record.transition_id)) return null;
  if (!(record.brain_id === null || (
    typeof record.brain_id === 'string' && UPGRADE_BRAIN_ID_RE.test(record.brain_id)
  ))) return null;
  if (record.brain_required !== (record.brain_id !== null)) return null;
  return { transitionId: record.transition_id, brainId: record.brain_id };
}

export function saveUpgradeState(
  oldVersion: string,
  newVersion: string,
  status: UpgradeCompletionStatus,
  error?: string,
  context?: UpgradeTransitionContext,
) {
  const statePath = gbrainPath('upgrade-state.json');
  let state: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(
      readOwnedStateFile(statePath, MAX_UPGRADE_STATE_BYTES, gbrainPath()),
    ) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('canonical upgrade state root is not an object');
    }
    state = parsed as Record<string, unknown>;
  } catch (error) {
    if (isMissingStateError(error)) {
      state = {};
    } else if (status === 'complete') {
      // A completed historical record may replace an unsafe redirect without
      // following it. Pending/incomplete evidence is never reset this way.
      state = {};
    } else {
      throw new Error(
        `Cannot publish ${status} upgrade state over unreadable or malformed canonical evidence`,
        { cause: error },
      );
    }
  }
  const prior = (state as { last_upgrade?: unknown }).last_upgrade;
  const priorRecord = prior && typeof prior === 'object'
    ? prior as { from?: unknown; to?: unknown; status?: unknown }
    : null;
  const resolvedContext = context
    ?? (priorRecord?.from === oldVersion && priorRecord?.to === newVersion
      ? transitionContextFromRecord(prior)
      : null)
    ?? { transitionId: randomUUID(), brainId: null };
  if (
    !UPGRADE_UUID_RE.test(resolvedContext.transitionId) ||
    !(resolvedContext.brainId === null || UPGRADE_BRAIN_ID_RE.test(resolvedContext.brainId))
  ) {
    throw new Error('Refusing to write upgrade state with a malformed transition or database identity');
  }

  if (priorRecord) {
    const priorStatus = priorRecord.status;
    const priorContext = transitionContextFromRecord(prior);
    const exactLegacyAdoption = priorStatus === undefined
      && priorRecord.from === oldVersion
      && priorRecord.to === newVersion
      && context !== undefined;

    if (priorStatus !== undefined && ![
      'swap_running', 'post_upgrade_pending', 'deferred', 'running', 'complete', 'incomplete',
    ].includes(String(priorStatus))) {
      throw new Error(`Refusing to overwrite upgrade state with unknown status ${String(priorStatus)}`);
    }

    if (priorStatus !== 'complete') {
      const exactSwapPromotion = priorStatus === 'swap_running'
        && priorRecord.from === oldVersion
        && priorRecord.to === UNVERIFIED_UPGRADE_TARGET
        && priorContext?.transitionId === resolvedContext.transitionId
        && priorContext.brainId === resolvedContext.brainId;
      if (!exactLegacyAdoption && !exactSwapPromotion) {
        if (!priorContext) {
          throw new Error('Refusing to overwrite unresolved upgrade state without a valid transition binding');
        }
        if (
          priorContext.transitionId !== resolvedContext.transitionId ||
          priorContext.brainId !== resolvedContext.brainId ||
          priorRecord.from !== oldVersion ||
          priorRecord.to !== newVersion
        ) {
          throw new Error(
            `Upgrade transition CAS mismatch: unresolved transition ${priorContext.transitionId} cannot be overwritten by ${resolvedContext.transitionId}`,
          );
        }
      }
    } else if (status === 'complete' && (
      !priorContext ||
      priorContext.transitionId !== resolvedContext.transitionId ||
      priorContext.brainId !== resolvedContext.brainId
    )) {
      throw new Error('Upgrade transition CAS mismatch: completed evidence is immutable across transitions');
    }
  }

  state.last_upgrade = {
    from: oldVersion,
    to: newVersion,
    ts: new Date().toISOString(),
    status,
    transition_id: resolvedContext.transitionId,
    brain_required: resolvedContext.brainId !== null,
    brain_id: resolvedContext.brainId,
    ...(status === 'incomplete'
      ? {
          safety_mode: 'migration_gate_blocked',
          recovery: 'gbrain post-upgrade',
          ...(error ? { error: sanitizeUpgradeEvidenceError(error) } : {}),
        }
      : {}),
  };
  writeOwnedStateFileAtomic(
    statePath,
    JSON.stringify(state, null, 2) + '\n',
    MAX_UPGRADE_STATE_BYTES,
    gbrainPath(),
  );
}

/** Fsynced write-ahead fence published before any updater can replace code. */
export function publishUpgradeSwapWriteAhead(
  oldVersion: string,
  context: UpgradeTransitionContext,
): void {
  saveUpgradeState(
    oldVersion,
    UNVERIFIED_UPGRADE_TARGET,
    'swap_running',
    undefined,
    context,
  );
}

/**
 * Post-upgrade feature discovery + migration application.
 *
 * Two responsibilities:
 *   1. Print feature_pitch headlines for migrations newer than the prior
 *      binary (cosmetic; runs only when upgrade-state.json is readable and
 *      has a from/to pair).
 *   2. Invoke `gbrain apply-migrations --yes` so the mechanical side of
 *      every outstanding migration actually executes (schema, smoke, prefs,
 *      host rewrites, autopilot install). This is the Codex H8 fix:
 *      previously runPostUpgrade early-returned when upgrade-state.json
 *      was missing, which meant every broken-v0.11.0 install stayed broken.
 *      apply-migrations now runs unconditionally (idempotent; cheap when
 *      nothing is pending).
 *
 * Migration enumeration uses the TS registry at
 * src/commands/migrations/index.ts (Codex K) — no filesystem walk of
 * skills/migrations/*.md, so compiled binaries see the same set source
 * installs do.
 */
/**
 * v0.42 self-upgrade setup (file plane; idempotent). Default existing installs
 * to `notify` (a nudge, not autonomy — `auto` stays an explicit opt-in), show a
 * one-time informational banner, and rewrite an existing autopilot systemd unit
 * to Restart=always so the silent channel's exit-for-relaunch respawns.
 */
async function applySelfUpgradeSetup(): Promise<void> {
  try {
    const { loadConfig, saveConfig } = await import('../core/config.ts');
    const cfg = loadConfig();
    if (cfg) {
      const su = cfg.self_upgrade ?? {};
      let changed = false;
      if (su.mode === undefined) {
        su.mode = 'notify';
        changed = true;
      }
      if (!su.mode_prompted) {
        console.log('');
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('[gbrain] Self-upgrade is ON in NOTIFY mode.');
        console.log('[gbrain] Every gbrain invocation now checks for new versions and');
        console.log('[gbrain] nudges when one is available. Apply with: gbrain self-upgrade');
        console.log('[gbrain]');
        console.log('[gbrain] Hands-off (silent quiet-hours auto-upgrade for always-on installs):');
        console.log('[gbrain]   gbrain config set self_upgrade.mode auto');
        console.log('[gbrain] Turn it off entirely: gbrain config set self_upgrade.mode off');
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('');
        su.mode_prompted = true;
        changed = true;
      }
      if (changed) {
        cfg.self_upgrade = su;
        saveConfig(cfg);
      }
    }
  } catch {
    /* best-effort */
  }
  try {
    const { migrateSystemdUnitToRestartAlways } = await import('./autopilot.ts');
    const r = migrateSystemdUnitToRestartAlways();
    if (r.rewritten) {
      console.log('[gbrain] Updated autopilot systemd unit to Restart=always (self-upgrade relaunch).');
    }
  } catch {
    /* best-effort */
  }
}

interface PendingUpgradeTransition {
  from: string;
  to: string;
  status: Exclude<UpgradeCompletionStatus, 'complete'>;
  context: UpgradeTransitionContext | null;
  tsMs: number;
  legacy: boolean;
}

interface CompletedUpgradeTransition {
  from: string;
  to: string;
  context: UpgradeTransitionContext;
  tsMs: number;
}

interface ForeignTargetUpgradeTransition {
  from: string;
  to: string;
  status: string;
  tsMs: number;
}

type UpgradeStateLoadResult =
  | { kind: 'missing' }
  | { kind: 'complete'; transition: CompletedUpgradeTransition }
  | { kind: 'pending'; transition: PendingUpgradeTransition }
  | { kind: 'legacy'; transition: PendingUpgradeTransition }
  | { kind: 'foreign'; transition: ForeignTargetUpgradeTransition; message: string }
  | { kind: 'invalid'; message: string };

function isMissingStateError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

function normalizedVersion(value: string): string {
  return value.replace(/^gbrain\s*/i, '').replace(/^v/i, '').trim();
}

function parseSupportedUpgradeVersion(value: string): {
  numbers: [number, number, number, number];
  prerelease: string | null;
} | null {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) return null;
  const numbers = match.slice(1, 5).map(Number) as [number, number, number, number];
  if (!numbers.every(Number.isSafeInteger)) return null;
  return { numbers, prerelease: match[5] ?? null };
}

function isStrictUpgrade(previous: string, next: string): boolean {
  const prior = parseSupportedUpgradeVersion(normalizedVersion(previous));
  const target = parseSupportedUpgradeVersion(next);
  if (!prior || !target) return false;
  for (let i = 0; i < 4; i++) {
    if (target.numbers[i]! > prior.numbers[i]!) return true;
    if (target.numbers[i]! < prior.numbers[i]!) return false;
  }
  // Same numeric release: only prerelease -> stable is an upgrade.
  return prior.prerelease !== null && target.prerelease === null;
}

function parseUpgradeState(
  raw: string,
  label: string,
  allowHistoricalForeignTarget = false,
): UpgradeStateLoadResult {
  let parsed: { last_upgrade?: unknown };
  try { parsed = JSON.parse(raw) as { last_upgrade?: unknown }; }
  catch { return { kind: 'invalid', message: `${label} upgrade state is malformed JSON` }; }
  const last = parsed.last_upgrade;
  if (!last || typeof last !== 'object') {
    return { kind: 'invalid', message: `${label} upgrade state has no last_upgrade record` };
  }
  const record = last as { from?: unknown; to?: unknown; status?: unknown; ts?: unknown };
  if (typeof record.from !== 'string' || typeof record.to !== 'string') {
    return { kind: 'invalid', message: `${label} upgrade state has invalid from/to versions` };
  }
  const tsMs = typeof record.ts === 'string' ? Date.parse(record.ts) : Number.NaN;

  if (record.status === undefined) {
    if (!Number.isFinite(tsMs)) {
      return { kind: 'invalid', message: `${label} upgrade state has an invalid timestamp` };
    }
    if (normalizedVersion(record.to) !== normalizedVersion(VERSION)) {
      const message = `${label} legacy handoff targets ${record.to || '<empty>'}, not this ${VERSION} binary`;
      if (allowHistoricalForeignTarget) {
        return {
          kind: 'foreign',
          transition: {
            from: record.from, to: record.to, status: 'legacy', tsMs,
          },
          message,
        };
      }
      return {
        kind: 'invalid',
        message,
      };
    }
    return {
      kind: 'legacy',
      transition: {
        from: record.from,
        to: record.to,
        status: 'deferred',
        context: null,
        tsMs,
        legacy: true,
      },
    };
  }

  const status = String(record.status);
  if (![
    'swap_running', 'post_upgrade_pending', 'deferred', 'running', 'complete', 'incomplete',
  ].includes(status)) {
    return { kind: 'invalid', message: `${label} upgrade state has unknown status ${status}` };
  }
  if (status === 'swap_running') {
    const context = transitionContextFromRecord(last);
    if (!context || record.to !== UNVERIFIED_UPGRADE_TARGET) {
      return { kind: 'invalid', message: `${label} interrupted binary swap state is malformed or unbound` };
    }
    if (!Number.isFinite(tsMs)) {
      return { kind: 'invalid', message: `${label} upgrade state has an invalid timestamp` };
    }
    if (!isStrictUpgrade(record.from, VERSION)) {
      return {
        kind: 'invalid',
        message: `${label} binary swap was interrupted without a verified forward target; reinstall or deliberately recover the intended newer binary before retrying`,
      };
    }
    // A different, runnable VERSION proves the replacement can execute. Bind
    // the interrupted write-ahead record to this binary and require the full
    // explicit post-upgrade gate before normal operation.
    return {
      kind: 'pending',
      transition: {
        from: record.from,
        to: VERSION,
        status: 'post_upgrade_pending',
        context,
        tsMs,
        legacy: false,
      },
    };
  }
  const targetMatchesRunning =
    normalizedVersion(record.to) === normalizedVersion(VERSION);
  if (status === 'complete' && !targetMatchesRunning) {
    const runningVersion = parseSupportedUpgradeVersion(normalizedVersion(VERSION));
    const completedTarget = parseSupportedUpgradeVersion(normalizedVersion(record.to));
    if (!runningVersion || !completedTarget) {
      return {
        kind: 'invalid',
        message: `${label} completed upgrade target ${record.to || '<empty>'} cannot be safely compared with this ${VERSION} binary`,
      };
    }
    if (isStrictUpgrade(VERSION, normalizedVersion(record.to))) {
      return {
        kind: 'invalid',
        message: `${label} completed upgrade targets newer ${record.to}, but this binary is ${VERSION}; restore the matched database and file state or reinstall the completed target binary`,
      };
    }
  }
  if (status !== 'complete' && !targetMatchesRunning) {
    const message = `${label} ${status} handoff targets ${record.to || '<empty>'}, not this ${VERSION} binary`;
    if (allowHistoricalForeignTarget) {
      return {
        kind: 'foreign',
        transition: { from: record.from, to: record.to, status, tsMs },
        message,
      };
    }
    return {
      kind: 'invalid',
      message,
    };
  }
  const context = transitionContextFromRecord(last);
  if (!context) {
    return { kind: 'invalid', message: `${label} ${status} upgrade state is not bound to a transition and brain` };
  }
  if (!Number.isFinite(tsMs)) {
    return { kind: 'invalid', message: `${label} upgrade state has an invalid timestamp` };
  }
  if (status === 'complete') {
    if (
      allowHistoricalForeignTarget &&
      !targetMatchesRunning
    ) {
      return {
        kind: 'foreign',
        transition: { from: record.from, to: record.to, status, tsMs },
        message: `${label} completed upgrade targets ${record.to || '<empty>'}, not this ${VERSION} binary`,
      };
    }
    return {
      kind: 'complete',
      transition: { from: record.from, to: record.to, context, tsMs },
    };
  }
  return {
    kind: 'pending',
    transition: {
      from: record.from,
      to: record.to,
      status: status as PendingUpgradeTransition['status'],
      context,
      tsMs,
      legacy: false,
    },
  };
}

function readUpgradeStateCandidate(
  path: string,
  root: string,
  label: string,
  allowHistoricalForeignTarget = false,
): UpgradeStateLoadResult {
  try {
    return parseUpgradeState(
      readOwnedStateFile(path, MAX_UPGRADE_STATE_BYTES, root),
      label,
      allowHistoricalForeignTarget,
    );
  } catch (error) {
    if (isMissingStateError(error)) return { kind: 'missing' };
    return {
      kind: 'invalid',
      message: `${label} upgrade state is unreadable or unsafe: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function markLegacyStateForCanonicalAdoption(
  state: UpgradeStateLoadResult,
): UpgradeStateLoadResult {
  if (state.kind === 'pending' || state.kind === 'legacy') {
    return {
      kind: 'legacy',
      transition: { ...state.transition, legacy: true },
    };
  }
  return state;
}

function upgradeStateRecordsEqual(
  left: Extract<UpgradeStateLoadResult, { kind: 'complete' | 'pending' | 'legacy' }>,
  right: Extract<UpgradeStateLoadResult, { kind: 'complete' | 'pending' | 'legacy' }>,
): boolean {
  const descriptor = (state: typeof left | typeof right) => {
    if (state.kind === 'complete') {
      return {
        status: 'complete',
        from: state.transition.from,
        to: state.transition.to,
        transitionId: state.transition.context.transitionId,
        brainId: state.transition.context.brainId,
      };
    }
    return {
      status: state.transition.status,
      from: state.transition.from,
      to: state.transition.to,
      transitionId: state.transition.context?.transitionId ?? null,
      brainId: state.transition.context?.brainId ?? null,
    };
  };
  return JSON.stringify(descriptor(left)) === JSON.stringify(descriptor(right));
}

function upgradeStateTimestamp(state: UpgradeStateLoadResult): number {
  if (
    state.kind === 'complete' || state.kind === 'pending' ||
    state.kind === 'legacy' || state.kind === 'foreign'
  ) return state.transition.tsMs;
  return Number.NaN;
}

function loadUpgradeState(): UpgradeStateLoadResult {
  const canonicalRoot = gbrainPath();
  const canonicalPath = gbrainPath('upgrade-state.json');
  const canonical = readUpgradeStateCandidate(canonicalPath, canonicalRoot, 'Canonical');
  const legacyRoot = join(process.env.HOME || homedir(), '.gbrain');
  const legacyPath = join(legacyRoot, 'upgrade-state.json');
  if (resolve(legacyPath) === resolve(canonicalPath)) return canonical;

  // Read both authorities together. A prior binary wrote only to HOME, so a
  // rollback/re-upgrade can create a fresh legacy handoff while a stale
  // canonical completion still exists under GBRAIN_HOME.
  const legacy = readUpgradeStateCandidate(
    legacyPath,
    legacyRoot,
    'Legacy HOME',
    true,
  );
  if (canonical.kind === 'invalid') return canonical;
  if (canonical.kind === 'foreign') {
    return { kind: 'invalid', message: canonical.message };
  }
  if (legacy.kind === 'invalid') return legacy;
  if (canonical.kind === 'missing') {
    return legacy.kind === 'foreign'
      ? { kind: 'invalid', message: legacy.message }
      : markLegacyStateForCanonicalAdoption(legacy);
  }
  if (legacy.kind === 'missing') return canonical;

  if (legacy.kind === 'foreign') {
    const canonicalTs = upgradeStateTimestamp(canonical);
    if (
      Number.isFinite(canonicalTs) &&
      Number.isFinite(legacy.transition.tsMs) &&
      canonicalTs >= legacy.transition.tsMs
    ) return canonical;
    return {
      kind: 'invalid',
      message: `${legacy.message}; it is not older than canonical state`,
    };
  }

  if (upgradeStateRecordsEqual(canonical, legacy)) return canonical;

  // Once a statusless HOME handoff is adopted, canonical state advances
  // deferred -> running -> complete while the immutable old breadcrumb stays
  // behind. Same versions + a newer bound canonical record prove that lineage.
  if (
    legacy.kind === 'legacy' &&
    (canonical.kind === 'pending' || canonical.kind === 'complete') &&
    canonical.transition.from === legacy.transition.from &&
    canonical.transition.to === legacy.transition.to &&
    Number.isFinite(canonical.transition.tsMs) &&
    Number.isFinite(legacy.transition.tsMs) &&
    canonical.transition.tsMs >= legacy.transition.tsMs
  ) return canonical;

  // The one deliberate reconciliation: complete and pending records for the
  // current target are ordered by their durable timestamps. The newer pending
  // legacy handoff must not be hidden; after adoption/completion, the newer
  // canonical completion in turn suppresses the stale legacy breadcrumb.
  if (
    canonical.kind === 'complete' &&
    (legacy.kind === 'pending' || legacy.kind === 'legacy') &&
    normalizedVersion(legacy.transition.to) === normalizedVersion(VERSION) &&
    Number.isFinite(canonical.transition.tsMs) &&
    Number.isFinite(legacy.transition.tsMs)
  ) {
    if (legacy.transition.tsMs > canonical.transition.tsMs) {
      return markLegacyStateForCanonicalAdoption(legacy);
    }
    if (
      canonical.transition.tsMs >= legacy.transition.tsMs &&
      canonical.transition.from === legacy.transition.from &&
      canonical.transition.to === legacy.transition.to
    ) return canonical;
  }

  return {
    kind: 'invalid',
    message: 'Canonical and Legacy HOME upgrade states disagree; no migration was started',
  };
}

export type ReconciledUpgradeState =
  | { kind: 'missing' }
  | {
      kind: 'complete'; from: string; to: string; status: 'complete';
      transitionId: string; brainId: string | null; tsMs: number;
    }
  | {
      kind: 'pending'; from: string; to: string;
      status: Exclude<UpgradeCompletionStatus, 'complete'>;
      transitionId: string | null; brainId: string | null; legacy: boolean;
      tsMs: number;
    }
  | { kind: 'invalid'; message: string };

export type PostUpgradeInvocation =
  | { kind: 'resume' }
  | { kind: 'help' }
  | { kind: 'recover-migration'; version: string }
  | {
      kind: 'repair-ownership';
      sourceId: string;
      sourcePath: string;
      keepSlug: string;
    };

const ORCHESTRATOR_VERSION_RE = /^\d+\.\d+\.\d+(?:\.\d+)?$/;

/**
 * Parse the complete post-upgrade surface. Recovery is intentionally two
 * fixed commands rather than an argv passthrough to apply-migrations or
 * upgrade-preflight, so an unresolved handoff cannot become a generic gate
 * bypass when those commands gain new flags later.
 */
export function parsePostUpgradeInvocation(args: readonly string[]): PostUpgradeInvocation {
  if (args.length === 0) return { kind: 'resume' };
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    return { kind: 'help' };
  }
  if (
    args.length === 3
    && args[0] === 'recover-migration'
    && args[1] === '--force-retry'
    && ORCHESTRATOR_VERSION_RE.test(args[2] ?? '')
  ) {
    return { kind: 'recover-migration', version: args[2]! };
  }
  if (
    args.length === 8
    && args[0] === 'repair-ownership'
    && args[1] === '--source'
    && Boolean(args[2]) && !args[2]!.startsWith('-')
    && args[3] === '--path'
    && args[4] !== undefined
    && args[5] === '--keep'
    && Boolean(args[6]) && !args[6]!.startsWith('-')
    && args[7] === '--yes'
  ) {
    return {
      kind: 'repair-ownership',
      sourceId: args[2]!,
      sourcePath: args[4]!,
      keepSlug: args[6]!,
    };
  }
  throw new Error(
    'Invalid post-upgrade invocation. Run `gbrain post-upgrade --help`; ' +
    'arbitrary migration and preflight arguments are not accepted.',
  );
}

/** Read-only canonical+legacy authority view shared with doctor/health checks. */
export function loadReconciledUpgradeState(
  opts: { repairPermissions?: boolean } = {},
): ReconciledUpgradeState {
  return withOwnedStateReadPolicy(opts.repairPermissions === true, () => {
    const state = loadUpgradeState();
    if (state.kind === 'missing') return state;
    if (state.kind === 'invalid' || state.kind === 'foreign') {
      return { kind: 'invalid', message: state.message };
    }
    if (state.kind === 'complete') {
      return {
        kind: 'complete',
        from: state.transition.from,
        to: state.transition.to,
        status: 'complete',
        transitionId: state.transition.context.transitionId,
        brainId: state.transition.context.brainId,
        tsMs: state.transition.tsMs,
      };
    }
    return {
      kind: 'pending',
      from: state.transition.from,
      to: state.transition.to,
      status: state.transition.status,
      transitionId: state.transition.context?.transitionId ?? null,
      brainId: state.transition.context?.brainId ?? null,
      legacy: state.transition.legacy,
      tsMs: state.transition.tsMs,
    };
  });
}

function isExplicitUpgradeGateCommand(command: string, args: readonly string[]): boolean {
  if (command === 'doctor') {
    // Full doctor goes through connectEngine(), whose compatibility probe may
    // apply schema migrations. Only the filesystem-only diagnostic is safe
    // outside the bound post-upgrade transition.
    return args.includes('--fast')
      && !args.includes('--fix')
      && !args.includes('--remediate')
      && !args.includes('--remediation-plan');
  }
  if (command === 'apply-migrations') {
    return args.length === 1 && (args[0] === '--list' || args[0] === '--dry-run');
  }
  if (command === 'upgrade-preflight') {
    return args.length === 0 || (args.length === 1 && args[0] === '--json');
  }
  if (command === 'post-upgrade') {
    try {
      parsePostUpgradeInvocation(args);
      return true;
    } catch {
      return false;
    }
  }
  return command === 'upgrade' || command === 'check-update';
}

export function isAutopilotDaemonStartInvocation(args: readonly string[]): boolean {
  return !args.some(arg => [
    '--install', '--uninstall', '--status', '--help', '-h',
  ].includes(arg));
}

/**
 * Global pre-dispatch fence: no ordinary CLI path may connect to a brain or
 * perform file-plane work while the binary handoff is unresolved. Keep the
 * allow-list deliberately small and explicit so new commands fail closed.
 */
export function assertUpgradeStateAllowsCliCommand(
  command: string,
  args: readonly string[],
  state?: ReconciledUpgradeState,
): void {
  if (isExplicitUpgradeGateCommand(command, args)) return;
  // Routine CLI dispatch may safely tighten current-owner state permissions.
  // Doctor/list inspection calls loadReconciledUpgradeState() directly and
  // retains the no-metadata-mutation default.
  const reconciled = state ?? loadReconciledUpgradeState({ repairPermissions: true });
  if (reconciled.kind === 'missing' || reconciled.kind === 'complete') return;
  if (
    command === 'autopilot'
    && reconciled.kind === 'pending'
    && (reconciled.status === 'deferred' || reconciled.status === 'running')
    && isAutopilotDaemonStartInvocation(args)
  ) return;

  if (reconciled.kind === 'invalid') {
    throw new Error(
      'Upgrade authority is invalid or contradictory; normal commands are blocked before database connect. ' +
      'Run `gbrain doctor --fast`, then recover the handoff with `gbrain post-upgrade`.',
    );
  }

  const transition = reconciled.transitionId ?? '<legacy>';
  throw new Error(
    `Upgrade transition ${transition} is ${reconciled.status}; normal commands are blocked before database connect. ` +
    'Run `gbrain post-upgrade`.',
  );
}

function loadPendingUpgradeTransition(): PendingUpgradeTransition | null {
  const loaded = loadUpgradeState();
  if (loaded.kind === 'invalid') throw new Error(loaded.message);
  if (loaded.kind === 'pending' || loaded.kind === 'legacy') return loaded.transition;
  return null;
}

function assertNoUnresolvedUpgradeTransition(): void {
  const loaded = loadUpgradeState();
  if (loaded.kind === 'invalid') throw new Error(loaded.message);
  if (loaded.kind === 'pending' || loaded.kind === 'legacy') {
    throw new Error(
      `Upgrade transition ${loaded.transition.context?.transitionId ?? '<legacy>'} is still ` +
      `${loaded.transition.status}; complete or recover it before starting another upgrade.`,
    );
  }
}

async function bindPendingUpgradeTransition(
  transition: PendingUpgradeTransition,
  resolveBrainId: () => Promise<string | null>,
  establishBrainId: () => Promise<string | null>,
): Promise<PendingUpgradeTransition> {
  // A bound handoff is a read-only authority check. Only an unbound legacy
  // breadcrumb may establish identity while it is being deliberately adopted.
  const currentBrainId = transition.legacy && !transition.context
    ? await establishBrainId()
    : await resolveBrainId();
  if (transition.legacy) {
    if (transition.context && currentBrainId !== transition.context.brainId) {
      throw new Error(
        `Legacy HOME upgrade is bound to ${transition.context.brainId ?? 'no local brain'}, ` +
        `but the active configuration resolves to ${currentBrainId ?? 'no local brain'}.`,
      );
    }
    const context: UpgradeTransitionContext = transition.context ?? {
      transitionId: randomUUID(), brainId: currentBrainId,
    };
    // Publish the canonical, bound handoff before any post-upgrade side effect.
    saveUpgradeState(transition.from, transition.to, transition.status, undefined, context);
    return { ...transition, context, legacy: false };
  }
  if (!transition.context) {
    throw new Error('Pending upgrade state is not bound to a database; no migration was started.');
  }
  if (currentBrainId !== transition.context.brainId) {
    throw new Error(
      `Pending upgrade is bound to ${transition.context.brainId ?? 'no local brain'}, ` +
      `but the active configuration resolves to ${currentBrainId ?? 'no local brain'}. ` +
      'No migration was started; restore the original brain configuration or re-run the upgrade deliberately.',
    );
  }
  return transition;
}

function recordParentPostUpgradeFailureIfMissingLocked(
  fromVersion: string,
  toVersion: string,
  error: string,
  context?: UpgradeTransitionContext,
): boolean {
  const loaded = loadUpgradeState();
  if (loaded.kind === 'invalid' || loaded.kind === 'foreign') {
    throw new Error(loaded.message);
  }
  if (loaded.kind === 'complete') {
    const exactCompletion = context !== undefined
      && loaded.transition.from === fromVersion
      && loaded.transition.to === toVersion
      && loaded.transition.context.transitionId === context.transitionId
      && loaded.transition.context.brainId === context.brainId;
    if (exactCompletion) return false;
    throw new Error(
      'Refusing to downgrade completed upgrade evidence after a mismatched parent failure.',
    );
  }
  if (loaded.kind === 'pending' || loaded.kind === 'legacy') {
    const exactVersions = loaded.transition.from === fromVersion
      && loaded.transition.to === toVersion;
    const exactContext = context === undefined
      ? true
      : loaded.transition.context?.transitionId === context.transitionId
        && loaded.transition.context?.brainId === context.brainId;
    if (!exactVersions || !exactContext) {
      throw new Error(
        'Refusing to attach a parent failure to a different unresolved upgrade transition.',
      );
    }
    if (loaded.transition.status === 'incomplete') return false;
  }
  recordUpgradeError({
    phase: 'post-upgrade',
    fromVersion,
    toVersion,
    error,
    hint: 'Run: gbrain post-upgrade',
  }, context);
  saveUpgradeState(fromVersion, toVersion, 'incomplete', error, context);
  return true;
}

/** Parent fallback when the child failed before its own durable transition ran. */
export async function recordParentPostUpgradeFailureIfMissing(
  fromVersion: string,
  toVersion: string,
  error: string,
  context?: UpgradeTransitionContext,
): Promise<boolean> {
  return withUpgradeStateLock(() => recordParentPostUpgradeFailureIfMissingLocked(
    fromVersion,
    toVersion,
    error,
    context,
  ));
}

async function assertUpgradeTransitionComplete(handoff: {
  oldVersion: string;
  newVersion: string;
  transitionContext: UpgradeTransitionContext;
}): Promise<void> {
  await withUpgradeStateLock(() => {
    const loaded = loadUpgradeState();
    if (loaded.kind === 'invalid') throw new Error(loaded.message);
    if (
      loaded.kind !== 'complete' ||
      loaded.transition.from !== handoff.oldVersion ||
      loaded.transition.to !== handoff.newVersion ||
      loaded.transition.context.transitionId !== handoff.transitionContext.transitionId ||
      loaded.transition.context.brainId !== handoff.transitionContext.brainId
    ) {
      throw new Error(
        `Post-upgrade child exited without completing transition ${handoff.transitionContext.transitionId}`,
      );
    }
  });
}

async function runPostUpgradeStateTransitionLocked(
  run: (transition: PendingUpgradeTransition | null) => Promise<void>,
  resolveBrainId: () => Promise<string | null>,
  establishBrainId: () => Promise<string | null>,
): Promise<void> {
  let transition = loadPendingUpgradeTransition();
  try {
    if (transition) {
      transition = await bindPendingUpgradeTransition(
        transition,
        resolveBrainId,
        establishBrainId,
      );
    }
    await run(transition);
    if (transition?.context) {
      saveUpgradeState(transition.from, transition.to, 'complete', undefined, transition.context);
    }
  } catch (error) {
    if (transition) {
      const message = error instanceof Error ? error.message : String(error);
      recordUpgradeError({
        phase: 'post-upgrade',
        fromVersion: transition.from,
        toVersion: transition.to,
        error: message,
        hint: 'Run: gbrain post-upgrade',
      }, transition.context ?? undefined);
      if (transition.context) {
        saveUpgradeState(transition.from, transition.to, 'incomplete', message, transition.context);
      }
    }
    throw error;
  }
}

/** Durable state boundary shared by upgrade-spawned and direct recovery runs. */
export async function runPostUpgradeStateTransition(
  run: (transition: PendingUpgradeTransition | null) => Promise<void>,
  resolveBrainId: () => Promise<string | null> = resolveConfiguredUpgradeBrainId,
  opts: { lockDir?: string; establishBrainId?: () => Promise<string | null> } = {},
): Promise<void> {
  const establishBrainId = opts.establishBrainId
    ?? (resolveBrainId === resolveConfiguredUpgradeBrainId
      ? establishConfiguredUpgradeBrainId
      : resolveBrainId);
  return withUpgradeStateLock(
    () => runPostUpgradeStateTransitionLocked(run, resolveBrainId, establishBrainId),
    opts.lockDir,
  );
}

function printPostUpgradeHelp(): void {
  console.log(`Usage: gbrain post-upgrade [recovery]

Resume the exact pending upgrade transition and run its migration/schema gates.

Recovery commands (available only inside an unresolved, bound transition):
  gbrain post-upgrade recover-migration --force-retry <version>
  gbrain post-upgrade repair-ownership --source <id> --path <path> --keep <slug> --yes

Recovery performs only the named repair, then resumes the normal post-upgrade
gate in the same invocation. Direct mutating apply-migrations and
upgrade-preflight repair commands stay blocked while a handoff is unresolved.`);
}

export async function runPostUpgrade(args: string[] = []): Promise<void> {
  const invocation = parsePostUpgradeInvocation(args);
  if (invocation.kind === 'help') {
    printPostUpgradeHelp();
    return;
  }
  return runPostUpgradeStateTransition(async transition => {
    const authority = toUpgradeChildTransition(transition);
    if (invocation.kind !== 'resume') {
      await runPostUpgradeRecoveryAction(invocation, authority);
    }
    await runPostUpgradeCore([], authority);
  });
}

function toUpgradeChildTransition(
  transition: PendingUpgradeTransition | null,
): UpgradeChildTransition | undefined {
  if (!transition) return undefined;
  if (!transition.context) {
    throw new Error('Pending upgrade state is not bound; no migration child was authorized.');
  }
  return {
    transitionId: transition.context.transitionId,
    brainId: transition.context.brainId,
    fromVersion: transition.from,
    toVersion: transition.to,
  };
}

type PostUpgradeRecoveryInvocation = Extract<
  PostUpgradeInvocation,
  { kind: 'recover-migration' | 'repair-ownership' }
>;

function assertBoundPostUpgradeRecoveryAuthority(
  transition: UpgradeChildTransition | undefined,
): asserts transition is UpgradeChildTransition & { brainId: string } {
  if (
    !transition
    || !UPGRADE_UUID_RE.test(transition.transitionId)
    || typeof transition.brainId !== 'string'
    || !UPGRADE_BRAIN_ID_RE.test(transition.brainId)
    || transition.fromVersion.length === 0
    || transition.fromVersion.length > 128
    || transition.toVersion !== VERSION
  ) {
    throw new Error(
      'Recovery requires one exact unresolved upgrade transition bound to this release and configured brain; no repair ran.',
    );
  }
}

/**
 * Execute one narrowly named recovery action under the caller's canonical
 * upgrade-state lock. The authority is rechecked here and again at the
 * database mutation boundary; no arbitrary argv or generic bypass exists.
 */
export async function runPostUpgradeRecoveryAction(
  invocation: PostUpgradeRecoveryInvocation,
  transition: UpgradeChildTransition | undefined,
): Promise<void> {
  assertBoundPostUpgradeRecoveryAuthority(transition);

  if (invocation.kind === 'recover-migration') {
    const { runApplyMigrations } = await import('./apply-migrations.ts');
    const result = await runApplyMigrations(
      ['--force-retry', invocation.version],
      {
        expectedBrainId: transition.brainId,
        upgradeTransition: transition,
      },
    );
    if (result.exitCode !== 0 || result.reason !== 'force_retry_recorded') {
      throw new Error(
        `Bound migration recovery for ${invocation.version} was refused` +
        `${result.message ? `: ${result.message}` : ''}`,
      );
    }
    console.log(`Bound recovery accepted for migration ${invocation.version}; resuming post-upgrade.`);
    return;
  }

  const {
    escapeTerminalText,
    repairSourcePathOwnershipForUpgrade,
  } = await import('./upgrade-preflight.ts');
  const receipt = await repairSourcePathOwnershipForUpgrade(
    {
      sourceId: invocation.sourceId,
      sourcePath: invocation.sourcePath,
      keepSlug: invocation.keepSlug,
    },
    {
      expectedBrainId: transition.brainId,
      upgradeTransition: transition,
    },
  );
  console.log(
    `Bound ownership repair kept ` +
    `[${escapeTerminalText(receipt.sourceId)}:${escapeTerminalText(receipt.keepSlug)}] and cleared ` +
    `${receipt.cleared_slugs.length} competing claim(s); resuming post-upgrade.`,
  );
}

/**
 * Consume the swap-only handoff before autopilot opens its ordinary engine.
 *
 * The local O_EXCL lock makes concurrent relaunches single-flight. State moves
 * deferred → running before side effects; a crash leaves running visible and a
 * later boot can replay the idempotent post-upgrade path. Incomplete states are
 * not retried in a boot loop—they remain fail-closed for explicit recovery.
 */
export async function resumeDeferredPostUpgradeAtBoot(opts: {
  run?: (transition: PendingUpgradeTransition | null) => Promise<void>;
  resolveBrainId?: () => Promise<string | null>;
  establishBrainId?: () => Promise<string | null>;
  lockDir?: string;
} = {}): Promise<'none' | 'complete'> {
  const initial = loadPendingUpgradeTransition();
  if (!initial) return 'none';
  if (initial.status === 'incomplete' || initial.status === 'post_upgrade_pending') {
    throw new Error(
      `Upgrade handoff is ${initial.status}; run \`gbrain post-upgrade\` before starting autopilot.`,
    );
  }

  return withUpgradeStateLock(
    async () => {
      const transition = loadPendingUpgradeTransition();
      if (!transition) return 'none';
      if (transition.status === 'incomplete' || transition.status === 'post_upgrade_pending') {
        throw new Error(
          `Upgrade handoff is ${transition.status}; run \`gbrain post-upgrade\` before starting autopilot.`,
        );
      }
      const bound = await bindPendingUpgradeTransition(
        transition,
        opts.resolveBrainId ?? resolveConfiguredUpgradeBrainId,
        opts.establishBrainId ?? (opts.resolveBrainId ?? establishConfiguredUpgradeBrainId),
      );
      saveUpgradeState(
        bound.from,
        bound.to,
        'running',
        undefined,
        bound.context!,
      );
      await runPostUpgradeStateTransitionLocked(
        opts.run ?? (current => runPostUpgradeCore([], toUpgradeChildTransition(current))),
        opts.resolveBrainId ?? resolveConfiguredUpgradeBrainId,
        opts.establishBrainId ?? (opts.resolveBrainId ?? establishConfiguredUpgradeBrainId),
      );
      return 'complete';
    },
    opts.lockDir ?? gbrainPath('locks'),
  );
}

async function runPostUpgradeCore(
  args: string[] = [],
  upgradeTransition?: UpgradeChildTransition,
): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printPostUpgradeHelp();
    return;
  }

  // The data-plane migration/preflight gate is the first side-effecting phase.
  // File-plane setup (.gitignore, config defaults, systemd rewrites) cannot
  // make a blocked upgrade look partially successful.
  const expectedBrainId = upgradeTransition?.brainId;
  try {
    await runPostUpgradeSetupBoundary(
      () => runPostUpgradeMigrationGate(undefined, expectedBrainId, upgradeTransition),
      () => runPostUpgradeSchemaGate(expectedBrainId),
      async () => {
        // v0.35.8.0: lay down ~/.gbrain/.gitignore retroactively.
        try {
          const { ensureGitignore } = await import('../core/config.ts');
          ensureGitignore();
        } catch {
          // Best-effort hygiene after the hard gate.
        }
        await applySelfUpgradeSetup();
      },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`\napply-migrations failed: ${msg}`);
    console.error('Run `gbrain post-upgrade` to retry the full idempotent setup.');
    console.error(
      'For read-only diagnosis use `gbrain apply-migrations --list` or `--dry-run`; ' +
      'mutation recovery must stay inside `gbrain post-upgrade`.',
    );
    throw e;
  }

  // Cosmetic: print feature pitches for migrations newer than the prior binary.
  try {
    const statePath = gbrainPath('upgrade-state.json');
    if (existsSync(statePath)) {
      const state = JSON.parse(readOwnedStateFile(statePath, MAX_UPGRADE_STATE_BYTES, gbrainPath()));
      const from = state?.last_upgrade?.from;
      if (from) {
        const { migrations } = await import('./migrations/index.ts');
        for (const m of migrations) {
          if (isNewerThan(m.version, from)) {
            console.log('');
            console.log(`NEW: ${m.featurePitch.headline}`);
            if (m.featurePitch.description) console.log(m.featurePitch.description);
            if (m.featurePitch.recipe) {
              console.log(`Run \`gbrain integrations show ${m.featurePitch.recipe}\` to set it up.`);
            }
            console.log('');
          }
        }
      }
    }
  } catch {
    // Pitch printing is cosmetic — don't gate migrations on it.
  }

  // Reconnect to the schema-verified brain for post-gate feature setup. The
  // actual initSchema call already completed before file-plane setup above;
  // do not run it twice or move DDL behind those host mutations again.
  try {
    const { loadConfig: lcSchema, toEngineConfig: toCfgSchema } = await import('../core/config.ts');
    const { createEngine } = await import('../core/engine-factory.ts');
    const cfgSchema = lcSchema();
    if (expectedBrainId === null && cfgSchema) {
      throw new Error('A local brain became configured during a binary-only upgrade handoff; schema setup was not started.');
    }
    if (typeof expectedBrainId === 'string' && !cfgSchema) {
      throw new Error(`Configured brain disappeared before schema setup; expected ${expectedBrainId}.`);
    }
    if (cfgSchema) {
      const engine = await createEngine(toCfgSchema(cfgSchema));
      try {
        await engine.connect(toCfgSchema(cfgSchema));
        if (expectedBrainId !== undefined) {
          const actualBrainId = await readDatabaseInstanceId(engine);
          if (actualBrainId !== expectedBrainId) {
            throw new Error(
              `Configured brain ${actualBrainId} does not match pending upgrade brain ${expectedBrainId}; ` +
              'schema setup was not started.',
            );
          }
        }
        // v0.32.3 search-lite mode banner. One-shot: fires at most once per
        // install (state persisted via `search.mode_upgrade_notice_shown`).
        // Reframes from "behavior is regressing" to "named modes available"
        // per [CDX-1+2+3]: the production query op still defaults expand=true
        // and limit=20 — Garry's behavior is NOT regressing.
        try {
          const shown = await engine.getConfig('search.mode_upgrade_notice_shown');
          const existingMode = await engine.getConfig('search.mode');
          if (shown !== 'true' && !existingMode) {
            console.log('');
            console.log('═══════════════════════════════════════════════════════════════');
            console.log('[gbrain] v0.32.3 added named search modes (conservative/balanced/tokenmax).');
            console.log('[gbrain] Your current behavior is unchanged — the `query` op still defaults');
            console.log('[gbrain] expand=true and limit=20, same as v0.31.x.');
            console.log('═══════════════════════════════════════════════════════════════');
            console.log('');
            console.log('[AGENT] Relay this matrix to your operator and ask which mode they want.');
            console.log('[AGENT] Recommended default: tokenmax (preserves current retrieval shape).');
            console.log('[AGENT] Run `gbrain config set search.mode <mode>` after they decide.');
            console.log('');
            console.log('Per-query cost @ 10K queries/mo (typical single-user volume):');
            console.log('');
            console.log('                  Haiku 4.5    Sonnet 4.6   Opus 4.7');
            console.log('                  ($1/M)       ($3/M)       ($5/M)');
            console.log('  conservative    $40/mo       $120/mo      $200/mo');
            console.log('  balanced        $100/mo      $300/mo      $500/mo');
            console.log('  tokenmax        $200/mo      $600/mo      $1,000/mo');
            console.log('');
            console.log('  (scales linearly — multiply by 10 for 100K/mo)');
            console.log('  25x corner-to-corner spread. Natural diagonal pairings span ~4x.');
            console.log('');
            console.log('To pick:');
            console.log('  gbrain search modes              # see what is running');
            console.log('  gbrain config set search.mode <conservative|balanced|tokenmax>');
            console.log('  gbrain search tune               # data-driven recommendations');
            console.log('');
            console.log('tokenmax bumps limit to 50 (current default is 20). To preserve');
            console.log('your EXACT current shape:');
            console.log('  gbrain config set search.mode tokenmax');
            console.log('  gbrain config set search.searchLimit 20');
            console.log('');
            await engine.setConfig('search.mode_upgrade_notice_shown', 'true');
          }
        } catch {
          // Banner is cosmetic; never block the upgrade.
        }

        // PR1: skill-catalog publish consent. New installs default ON at
        // `gbrain init`; EXISTING installs stay OFF (default-OFF runtime = no
        // silent capability grant on upgrade) until the owner opts in HERE.
        // One-time, gated by `mcp.publish_skills_prompted`. Strongly recommended.
        try {
          const prompted = await engine.getConfig('mcp.publish_skills_prompted');
          const current = await engine.getConfig('mcp.publish_skills');
          if (prompted !== 'true' && current == null) {
            const { autoDetectSkillsDir } = await import('../core/repo-root.ts');
            const det = autoDetectSkillsDir();
            const dirLine = det.dir
              ? `Skills dir: ${det.dir} (source: ${det.source})`
              : 'Skills dir: not auto-detected — set $GBRAIN_SKILLS_DIR or mcp.skills_dir before enabling.';
            console.log('');
            console.log('═══════════════════════════════════════════════════════════════');
            console.log('[gbrain] Publish your skills to MCP clients?');
            console.log('[gbrain] Codex desktop, Claude Code/Cowork, and Perplexity can then');
            console.log("[gbrain] DISCOVER and FOLLOW your agent's skills over `gbrain serve`.");
            console.log('[gbrain] This makes your MCP server dramatically more useful.');
            console.log('[gbrain]');
            console.log(`[gbrain] ${dirLine}`);
            console.log('[gbrain] Effect: the CONTENTS of your SKILL.md files become readable by');
            console.log('[gbrain] remote MCP callers you have authorized. Source code is NOT exposed.');
            console.log('═══════════════════════════════════════════════════════════════');
            const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
            let enabled = false;
            if (isTty) {
              const { createInterface } = await import('readline');
              enabled = await new Promise<boolean>((resolveAns) => {
                const rl = createInterface({ input: process.stdin, output: process.stdout });
                rl.question('[gbrain] Enable skill publishing now? (recommended) [Y/n] ', (answer) => {
                  rl.close();
                  const a = answer.trim().toLowerCase();
                  resolveAns(a === '' || a === 'y' || a === 'yes');
                });
                rl.on('close', () => resolveAns(false));
              });
            } else {
              console.log('[AGENT] Relay this to your operator. Recommended: enable it.');
              console.log('[AGENT] Enable with: gbrain config set mcp.publish_skills true');
            }
            if (enabled) {
              await engine.setConfig('mcp.publish_skills', 'true');
              console.log('[gbrain] Skill publishing ENABLED. Disable anytime: gbrain config set mcp.publish_skills false');
            } else if (isTty) {
              console.log('[gbrain] Left disabled. Enable later: gbrain config set mcp.publish_skills true');
            }
            await engine.setConfig('mcp.publish_skills_prompted', 'true');
          }
        } catch {
          // Consent prompt is best-effort; never block the upgrade.
        }

        // v0.32.7 CJK wave: chunker-version bump → re-embed sweep.
        // Idempotent — `runReindex` short-circuits when no pages are pending.
        try {
          const { runPostUpgradeReembedPrompt } = await import('../core/post-upgrade-reembed.ts');
          const { getEmbeddingModel } = await import('../core/ai/gateway.ts');
          let modelString = 'openai:text-embedding-3-large';
          try { modelString = getEmbeddingModel(); } catch { /* gateway not configured — keep default */ }
          const promptResult = await runPostUpgradeReembedPrompt(engine, modelString);
          if (promptResult.proceeded) {
            const { runReindex } = await import('./reindex.ts');
            await runReindex(engine, ['--markdown']);
          }
        } catch (re) {
          const msg = re instanceof Error ? re.message : String(re);
          console.warn(`\nChunker-bump reindex skipped: ${msg}`);
          console.warn('Run `gbrain reindex --markdown` manually when ready.');
        }
      } finally {
        try { await engine.disconnect(); } catch { /* best-effort */ }
      }
    }
  } catch (e) {
    // A schema error means the upgrade is incomplete. Stop before later
    // feature setup and return non-zero through the CLI's single exit seam.
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`\nSchema auto-apply failed: ${msg}`);
    console.error(
      'Fix the reported gate, then run `gbrain post-upgrade`; direct schema mutation stays blocked ' +
      'while the upgrade handoff is unresolved.',
    );
    throw e;
  }

  // v0.25.1: agent-readable advisory listing recommended skills the
  // workspace hasn't installed yet. No-op when everything is installed.
  try {
    const { printAdvisoryIfRecommended } = await import('../core/skillpack/post-install-advisory.ts');
    const { VERSION } = await import('../version.ts');
    printAdvisoryIfRecommended({ version: VERSION, context: 'upgrade' });
  } catch {
    // Best-effort cosmetic surface; never block post-upgrade.
  }

  // v0.36 DX: skillpack reference sweep. After an upgrade, the gbrain bundle
  // may have shipped changes to scaffolded skills the host already has on
  // disk. Run `reference --all` automatically and print a one-line-per-skill
  // summary so the agent + operator see what drifted without manually
  // running the sweep. Skipped silently when:
  //   - GBRAIN_SKIP_REFERENCE_SWEEP=1 in env
  //   - no target workspace can be auto-detected (gbrain installed but
  //     never scaffolded anywhere)
  //   - the detected workspace IS the gbrain repo (dev-mode, would just
  //     compare gbrain against itself)
  //   - every scaffolded skill is identical (nothing to say)
  await postUpgradeReferenceSweep();

  // v0.41.18.0 (A4 + A18, T14): post-upgrade onboard banner. Fail-open;
  // doesn't engine-connect (lightweight TTY check only). The actual
  // recommendations need engine access via `gbrain onboard --check`;
  // the banner just nudges the user to run it.
  try {
    const { runUpgradeBanner } = await import('../core/onboard/init-nudge.ts');
    // The banner doesn't actually use the engine today; passing null-equivalent
    // would require a type widening. Skip the engine arg and let the banner
    // print the static nudge text.
    await runUpgradeBanner(null as never);
  } catch {
    // Fail-open per A18: never crash post-upgrade from the banner.
  }
}

/**
 * Fail-closed library seam between post-upgrade and the orchestrator runner.
 * `runApplyMigrations` deliberately returns an outcome rather than exiting the
 * process: an empty/list/dry-run plan must not terminate the rest of
 * post-upgrade. Conversely, partial, wedged, ambiguous, and failed outcomes
 * must stop schema/feature setup from making the upgrade look green.
 */
async function runPostUpgradeSchemaGate(expectedBrainId?: string | null): Promise<void> {
  const { loadConfig, toEngineConfig } = await import('../core/config.ts');
  const { createEngine } = await import('../core/engine-factory.ts');
  const config = loadConfig();
  if (expectedBrainId === null && config) {
    throw new Error('A local brain became configured during a binary-only upgrade handoff; schema setup was not started.');
  }
  if (typeof expectedBrainId === 'string' && !config) {
    throw new Error(`Configured brain disappeared before schema setup; expected ${expectedBrainId}.`);
  }
  if (!config) return;

  const engineConfig = toEngineConfig(config);
  const engine = await createEngine(engineConfig);
  try {
    await engine.connect(engineConfig);
    if (expectedBrainId !== undefined) {
      const actualBrainId = await readDatabaseInstanceId(engine);
      if (actualBrainId !== expectedBrainId) {
        throw new Error(
          `Configured brain ${actualBrainId} does not match pending upgrade brain ${expectedBrainId}; ` +
          'schema setup was not started.',
        );
      }
    } else {
      await getOrCreateDatabaseInstanceId(engine);
    }
    await engine.initSchema();
    console.log('  Schema up to date.');
  } finally {
    try { await engine.disconnect(); } catch { /* best-effort */ }
  }
}

export async function runPostUpgradeSetupBoundary(
  migrationGate: () => Promise<unknown>,
  schemaGate: () => Promise<unknown>,
  setup: () => Promise<void>,
): Promise<void> {
  await migrationGate();
  await schemaGate();
  await setup();
}

export async function runPostUpgradeMigrationGate(
  runner?: (
    args: string[],
    authority: {
      expectedBrainId?: string | null;
      upgradeTransition?: UpgradeChildTransition;
    },
  ) => Promise<import('./apply-migrations.ts').ApplyMigrationsOutcome>,
  expectedBrainId?: string | null,
  upgradeTransition?: UpgradeChildTransition,
): Promise<import('./apply-migrations.ts').ApplyMigrationsOutcome> {
  const run = runner ?? (async (
    args: string[],
    authority: {
      expectedBrainId?: string | null;
      upgradeTransition?: UpgradeChildTransition;
    },
  ) => {
    const { runApplyMigrations } = await import('./apply-migrations.ts');
    return runApplyMigrations(args, authority);
  });
  const result = await run(
    ['--yes', '--non-interactive'],
    { expectedBrainId, upgradeTransition },
  );
  if (typeof expectedBrainId === 'string' && result.reason === 'no_config') {
    throw new Error(`apply-migrations lost configured brain ${expectedBrainId} before execution`);
  }
  if (expectedBrainId === null && result.reason !== 'no_config') {
    throw new Error('apply-migrations found a local brain during a binary-only upgrade handoff');
  }
  if (result.exitCode !== 0) {
    const blocked = result.blockedVersions?.length
      ? ` (blocked: ${result.blockedVersions.join(', ')})`
      : '';
    throw new Error(`apply-migrations ${result.reason}${blocked}${result.message ? `: ${result.message}` : ''}`);
  }
  return result;
}

/**
 * Run `reference --all` against the auto-detected host workspace and print
 * a one-line-per-skill summary of any drift. Best-effort; failures are
 * swallowed so a broken sweep never blocks post-upgrade.
 *
 * Exported (with optional `opts` test seam) for unit testing the gate
 * logic + output shape. Production callers pass no args — both paths are
 * auto-detected.
 */
export async function postUpgradeReferenceSweep(
  opts: { gbrainRoot?: string; targetWorkspace?: string } = {},
): Promise<void> {
  if (process.env.GBRAIN_SKIP_REFERENCE_SWEEP) return;
  try {
    const { autoDetectSkillsDirReadOnly } = await import('../core/repo-root.ts');
    const { findGbrainRoot } = await import('../core/skillpack/bundle.ts');
    const { runReferenceAll } = await import('../core/skillpack/reference.ts');
    const path = await import('path');

    // Allow tests to inject; default to auto-detection.
    let targetWorkspace = opts.targetWorkspace;
    if (!targetWorkspace) {
      const detected = autoDetectSkillsDirReadOnly();
      if (!detected.dir) return;
      targetWorkspace = path.resolve(detected.dir, '..');
    }

    const gbrainRoot = opts.gbrainRoot ?? findGbrainRoot();
    if (!gbrainRoot) return;

    // Dev-mode guard: the detected workspace IS the gbrain repo. Sweeping
    // gbrain against itself is always identical — print nothing.
    if (path.resolve(targetWorkspace) === path.resolve(gbrainRoot)) return;

    const result = runReferenceAll({ gbrainRoot, targetWorkspace });
    // Print only skills that (a) the host has actually scaffolded, AND
    // (b) have at least one differs or missing entry. Pure-`missing`
    // skills the host never scaffolded are noise; skip them.
    const drifted = result.skills.filter(
      s =>
        s.summary.identical + s.summary.differs > 0 &&
        (s.summary.differs > 0 || s.summary.missing > 0),
    );
    if (drifted.length === 0) return;

    console.log('');
    console.log('Skillpack reference sweep (post-upgrade):');
    for (const s of drifted) {
      console.log(
        `  ${s.slug.padEnd(40)} differs:${s.summary.differs} missing:${s.summary.missing}`,
      );
    }
    console.log('');
    console.log(
      'Run `gbrain skillpack reference <slug>` to inspect per-skill diffs.\nSee `skills/_AGENT_README.md` for what your agent should do on update.\nSkip this sweep: `GBRAIN_SKIP_REFERENCE_SWEEP=1`.',
    );
  } catch {
    // Best-effort. Never block post-upgrade.
  }
}

// findMigrationsDir + extractFeaturePitch removed in v0.11.1: migration data
// now lives in the TS registry at src/commands/migrations/index.ts so
// compiled binaries don't depend on filesystem skills/migrations/*.md
// (Codex K).

function isNewerThan(version: string, baseline: string): boolean {
  const v = version.split('.').map(Number);
  const b = baseline.split('.').map(Number);
  for (let i = 0; i < Math.max(v.length, b.length); i++) {
    if ((v[i] || 0) > (b[i] || 0)) return true;
    if ((v[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

export function detectInstallMethod(): 'bun' | 'bun-link' | 'binary' | 'clawhub' | 'unknown' {
  const execPath = process.execPath || '';

  // v0.28.5 cluster D: bun-link signal first.
  // bun link puts a symlink at ~/.bun/bin/gbrain → either the source's bin
  // entry (compiled CLI) OR src/cli.ts directly. Either way, realpath
  // resolves into a directory we can walk up from to find a .git/config
  // pointing at our repo.
  const bunLinkResult = detectBunLink();
  if (bunLinkResult) return 'bun-link';

  // Check if running from node_modules (bun/npm install). Could be canonical
  // (we publish under garrytan/gbrain) OR the squatter (npm `gbrain@1.3.x`).
  // Sub-classify and warn loudly on suspect installs (#658).
  if (execPath.includes('node_modules') || process.argv[1]?.includes('node_modules')) {
    const verdict = classifyBunInstall();
    if (verdict === 'suspect') {
      printSquatterRecovery();
    }
    return 'bun';
  }

  // Check if running as compiled binary
  if (execPath.endsWith('/gbrain') || execPath.endsWith('\\gbrain.exe')) {
    return 'binary';
  }

  // Check if clawhub is available (use --version, not which, to avoid false positives)
  try {
    execSync('clawhub --version', { stdio: 'pipe', timeout: 5_000 });
    return 'clawhub';
  } catch {
    // not available
  }

  return 'unknown';
}

/**
 * Detect bun-link source-clone installs (closes #656, fixes #368).
 *
 * Walk up from argv[1] looking for a `.git/config` whose remote url
 * contains `garrytan/gbrain` (case-insensitive substring).
 *
 * v0.28.5 gated on lstatSync(argv1).isSymbolicLink(), but bun resolves
 * the entire symlink chain before setting process.argv[1], so the check
 * always returned false and short-circuited detection. Now we skip the
 * symlink check and use argv[1] directly — it is already the real path
 * inside the checkout, which is exactly what the git-config walk needs.
 *
 * Returns { repoRoot } when confident; null otherwise (caller falls
 * through to the existing detection chain).
 */
function detectBunLink(): { repoRoot: string } | null {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return null;

    let dir = dirname(resolve(argv1));
    for (let i = 0; i < 6; i++) {
      const gitConfigPath = join(dir, '.git', 'config');
      if (existsSync(gitConfigPath)) {
        try {
          const cfg = readFileSync(gitConfigPath, 'utf-8');
          if (cfg.toLowerCase().includes(GBRAIN_GITHUB_REPO.toLowerCase())) {
            return { repoRoot: dir };
          }
        } catch { /* unreadable config — not our case */ }
        return null;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * v0.28.5 cluster D, signal 2 — bun install authenticity check (closes #658).
 *
 * When `bun add -g gbrain` (or `npm install -g gbrain`) installs from
 * npm, the package is the squatter — an unrelated `gbrain@1.3.x` that
 * silently overwrites our binary. This function reads the install
 * directory's package.json and checks two non-spoofable signals:
 *   - `repository.url` contains `garrytan/gbrain` (case-insensitive)
 *   - the install dir contains a `src/cli.ts` file (squatter ships
 *     compiled binary, not source)
 *
 * If neither matches, returns 'suspect' and the caller surfaces a loud
 * recovery message. Codex's plan-review noted these signals are spoofable
 * by a determined squatter — accepted; this is best-effort warning, not
 * an assertion. The right structural fix is publishing under a scoped
 * name like `@garrytan/gbrain` (tracked v0.29 follow-up).
 */
function classifyBunInstall(): 'canonical' | 'suspect' {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return 'suspect';

    // Walk up from argv1 looking for the package.json that owns this install.
    let dir = dirname(realpathSync(argv1));
    for (let i = 0; i < 6; i++) {
      const pkgPath = join(dir, 'package.json');
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
          const repoUrl = (typeof pkg.repository === 'string'
            ? pkg.repository
            : pkg.repository?.url) ?? '';
          if (repoUrl.toLowerCase().includes(GBRAIN_GITHUB_REPO.toLowerCase())) {
            return 'canonical';
          }
          // Source-marker fallback: our published-as-source install always
          // ships src/cli.ts next to package.json. The squatter ships dist/.
          if (existsSync(join(dir, 'src', 'cli.ts'))) {
            return 'canonical';
          }
          return 'suspect';
        } catch {
          return 'suspect';
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return 'suspect';
  } catch {
    return 'suspect';
  }
}

function printSquatterRecovery(): void {
  console.warn('');
  console.warn('  WARNING: gbrain install does not appear to be from garrytan/gbrain.');
  console.warn('  This is likely the npm-name collision tracked in issue #658:');
  console.warn('    https://www.npmjs.com/package/gbrain (an unrelated package).');
  console.warn('');
  console.warn('  Recovery options:');
  console.warn('    1. Install from source:');
  console.warn('         bun remove -g gbrain');
  console.warn('         git clone https://github.com/garrytan/gbrain.git');
  console.warn('         cd gbrain && bun install && bun link');
  console.warn('');
  console.warn('    2. Download a release binary:');
  console.warn('         https://github.com/garrytan/gbrain/releases');
  console.warn('');
  console.warn('  See docs/INSTALL_FOR_AGENTS.md for the canonical install paths.');
  console.warn('');
}
