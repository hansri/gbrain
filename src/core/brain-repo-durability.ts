/**
 * brain-repo-durability.ts — auto-harden a brain's git working tree (v0.42.44).
 *
 * Problem: fresh headless agents (OpenClaw/Hermes) fall out of sync with their
 * knowledge-wiki git repos — writes sit local-only and never push, long-lived
 * sessions edit a stale tree. The moment gbrain is given a PAT + a GitHub URL
 * for a brain repo, `hardenBrainRepo` makes durability work, idempotently:
 *
 *   1. validate exact registered origin + executable Git config
 *   2. owner-only, URL/path-bound credential-store wiring
 *   3. pull current state (divergence-safe rebase; skip-on-dirty)
 *   4. LOCAL untracked post-commit hook (best-effort background auto-push)
 *   5. remove the retired repo-controlled commit helper
 *   6. durability rules in the ACTIVE resolver file (RESOLVER.md > AGENTS.md)
 *   7. a DB-free pull cron + authenticated push-probe
 *
 * Trust boundary (this is gbrain's FIRST push path + FIRST secret storage):
 *  - The hook is LOCAL + untracked. The managed agent instructions invoke the
 *    installed CLI directly; the committed shim contains no Git mutation logic.
 *  - Credential lives in an owner-only GBrain store. Network operations reset
 *    every repo/global helper and append this one deterministic helper only;
 *    token redaction still applies everywhere.
 *
 * CLI-only by design (writes executables + an OS cron + a credential store on
 * the host): never exposed over MCP.
 */

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync, statSync, appendFileSync,
  mkdtempSync, copyFileSync, openSync, closeSync, fsyncSync, renameSync, lstatSync,
} from 'fs';
import { join, dirname, relative, isAbsolute, resolve } from 'path';
import { execFileSync, execSync } from 'child_process';
import {
  GIT_ENV, divergenceSafePull, detectDefaultBranch, pushProbe,
  pushBranch, validateOriginRemote, canonicalRemoteUrl, GIT_EXECUTION_FENCE_FLAGS,
  type PullOutcome, type PushProbeResult,
} from './git-remote.ts';
import { findResolverFile, RESOLVER_FILENAMES } from './resolver-filenames.ts';
import { redactSecretsInText } from './minions/handlers/shell-redact.ts';
import { cleanInheritedGitEnvironment } from './git-environment.ts';
// Static import → bundled into the --compile binary so the taxonomy never drifts
// and needs no runtime skills/ directory.
import filingRulesDoc from '../../skills/_brain-filing-rules.json';

// ── Types ───────────────────────────────────────────────────────────────────

export type StepName =
  | 'pull' | 'credential' | 'hook' | 'helper' | 'agents' | 'cron' | 'verify' | 'commit';
export type StepStatus = 'ok' | 'fixed' | 'skipped' | 'needs_attention';

export interface DurabilityStep {
  step: StepName;
  status: StepStatus;
  detail: string; // ALWAYS redacted — never contains the PAT
}

export interface DurabilityReport {
  source_id: string;
  repo_path: string;
  branch: string;
  steps: DurabilityStep[];
  missing: string[];        // what was missing on entry
  fixed: string[];          // what this run changed
  needs_attention: string[];
  clean_against_origin: boolean;
}

export interface HardenOpts {
  repoPath: string;
  sourceId: string;
  branch?: string;          // default: detectDefaultBranch
  /** Registered canonical source remote; drift fails before any repo action. */
  expectedRemoteUrl: string;
  pat?: string;             // already-loaded token; never logged
  installCron?: boolean;    // default true
  verify?: boolean;         // default true
  dryRun?: boolean;
  intervalSec?: number;     // cron cadence; default 1800
  logger?: (line: string) => void;
}

export interface UnhardenOpts {
  repoPath: string;
  sourceId: string;
  expectedRemoteUrl?: string;
  logger?: (line: string) => void;
}

// ── Banners / markers (idempotency keys) ────────────────────────────────────

const HOOK_BANNER = '# gbrain brain-durability post-commit hook (v0.42.44+)';
const AGENTS_BEGIN = '<!-- BEGIN gbrain-brain-durability (managed; do not edit between markers) -->';
const AGENTS_END = '<!-- END gbrain-brain-durability -->';
const HELPER_REL = 'scripts/brain-commit-push.sh';
const CRED_MANAGED_KEY = 'gbrain.durability.managedcredential';
const CRED_URL_KEY = 'gbrain.durability.credentialurl';

function gbrainHome(): string {
  return process.env.GBRAIN_HOME || join(process.env.HOME || '', '.gbrain');
}

/** Resolve the gbrain CLI path for the cron wrapper (inlined to avoid a
 *  core→commands import). which gbrain → process.execPath → argv[1] → "gbrain". */
function resolveGbrainCliPath(): string {
  try {
    const which = execSync('which gbrain', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (which) return which;
  } catch { /* not on PATH */ }
  const exec = process.execPath ?? '';
  if (exec.endsWith('/gbrain') || exec.endsWith('\\gbrain.exe')) return exec;
  const arg1 = process.argv[1] ?? '';
  if (arg1.endsWith('/gbrain') || arg1.endsWith('\\gbrain.exe')) return arg1;
  return 'gbrain';
}
function credStoreFile(): string {
  return join(gbrainHome(), 'git-credentials');
}
function pushLogPath(): string {
  return join(gbrainHome(), 'brain-push.log');
}

// ── Shared bash push-retry template (DRY at the TS source — D7) ──────────────
// Rendered only into the local, untracked hook. Persistent writes use the
// installed trusted CLI directly; no executable is shipped inside evidence.
const PUSH_RETRY = `# --- gbrain durability push-retry (generated; one source of truth) ---
brain_push() {
  _branch="$1"
  _remote="$2"
  _root="$3"
  _log="\${GBRAIN_HOME:-$HOME/.gbrain}/brain-push.log"
  _gbrain="$(command -v gbrain 2>/dev/null || true)"
  mkdir -p "$(dirname "$_log")" 2>/dev/null || true
  if [ -z "$_gbrain" ]; then
    echo "$(date -u +%FT%TZ) [push] gbrain CLI missing; refusing unguarded git network operation" >>"$_log"
    return 1
  fi
  _gd="$_root/.git"
  # Serialize concurrent pushes (commit bursts) so they coalesce instead of a
  # rebase-retry herd. No-op if flock is unavailable.
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$_gd/gbrain-push.lock"
    flock -w 30 9 || { echo "$(date -u +%FT%TZ) [push] lock-timeout $_branch" >>"$_log"; return 0; }
  fi
  if "$_gbrain" sources push --path "$_root" --branch "$_branch" --expected-remote "$_remote" >>"$_log" 2>&1; then
    echo "$(date -u +%FT%TZ) [push] ok $_branch" >>"$_log"; return 0
  fi
  echo "$(date -u +%FT%TZ) [push] rejected; rebase-pull $_branch" >>"$_log"
  if "$_gbrain" sources pull --path "$_root" --branch "$_branch" --expected-remote "$_remote" >>"$_log" 2>&1 && "$_gbrain" sources push --path "$_root" --branch "$_branch" --expected-remote "$_remote" >>"$_log" 2>&1; then
    echo "$(date -u +%FT%TZ) [push] ok-after-rebase $_branch" >>"$_log"; return 0
  fi
  echo "$(date -u +%FT%TZ) [push] LOCAL-ONLY, NEEDS ATTENTION: $_branch could not reach registered origin" >>"$_log"
  return 1
}`;

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function renderPostCommitHook(repoPath: string, branch: string, expectedRemoteUrl: string): string {
  const installedGbrainHome = shellSingleQuote(gbrainHome());
  const installedRepo = shellSingleQuote(repoPath);
  const installedBranch = shellSingleQuote(branch);
  const installedRemote = shellSingleQuote(expectedRemoteUrl);
  return `#!/usr/bin/env bash
${HOOK_BANNER}
# LOCAL + untracked — NEVER commit this file. Best-effort background auto-push so
# agent writes don't sit local-only. Persistent writes use the installed
# trusted gbrain sources commit-push CLI directly.
# Internal scaffolding commits set GBRAIN_DURABILITY_SKIP_HOOK=1 because they
# push synchronously before hardenBrainRepo returns.
set -euo pipefail

# Some Git launchers sanitize variables mutated by their parent process. Keep
# an install-time, shell-escaped fallback so receipts still land in the same
# GBrain home; an explicitly supplied runtime GBRAIN_HOME continues to win.
if [ -z "\${GBRAIN_HOME:-}" ]; then
  export GBRAIN_HOME=${installedGbrainHome}
fi

if [ "\${GBRAIN_DURABILITY_SKIP_HOOK:-0}" = "1" ]; then
  exit 0
fi

${PUSH_RETRY}

# Detach so the commit returns instantly; all output goes to the log.
( brain_push ${installedBranch} ${installedRemote} ${installedRepo} ) </dev/null >/dev/null 2>&1 &
disown 2>/dev/null || true
exit 0
`;
}

// ── Managed AGENTS/RESOLVER block (taxonomy from filing rules; no drift) ─────

function renderTaxonomyLines(): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const r of (filingRulesDoc as any).rules ?? []) {
    const dir = String(r.directory || '').trim();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    lines.push(`   - \`${dir}\` — ${r.kind}`);
  }
  return lines.join('\n');
}

function renderManagedBlock(expectedRemoteUrl: string): string {
  const remoteArg = expectedRemoteUrl.replace(/`/g, '');
  return `${AGENTS_BEGIN}
<!-- gbrain durability rules. This block is regenerated by \`gbrain sources harden\`.
     Do not index as user knowledge; do not edit between the markers. -->
## Brain durability rules (always on)

1. **Deterministic filing — never use /tmp as storage.** Every persistent output
   goes to its taxonomy path (canonical, from \`skills/_brain-filing-rules.json\`):
${renderTaxonomyLines()}
   Writing to /tmp, scratch dirs, or outside the repo is forbidden for anything
   meant to persist.

2. **Every write is committed AND pushed — push is never deferred.** After any
   persistent write, run the installed trusted CLI (not repository code):
   \`gbrain sources commit-push --path . --expected-remote '${remoteArg}' --message "<msg>" -- <path>\`.
   It commits through an isolated index, pushes, and fails loudly if the push
   does not land. Then confirm links resolve with \`gbrain check-resolvable\`.

3. **Pull before you touch anything.** Run \`gbrain sources pull --path . --expected-remote '${remoteArg}'\` at
   session start and again before each batch of writes, so a long-lived session
   never edits a stale tree (a cron also pulls every ~30 min).
${AGENTS_END}`;
}

/** Patch the active resolver file with the managed block (idempotent). */
function patchResolverFile(repoPath: string, expectedRemoteUrl: string, dryRun: boolean): { status: StepStatus; detail: string } {
  const existing = findResolverFile(repoPath);
  const target = existing ?? join(repoPath, RESOLVER_FILENAMES[1]); // default AGENTS.md
  const block = renderManagedBlock(expectedRemoteUrl);
  const name = relative(repoPath, target) || target;

  let current = '';
  if (existsSync(target)) current = readFileSync(target, 'utf-8');

  let next: string;
  const b = current.indexOf(AGENTS_BEGIN);
  const e = current.indexOf(AGENTS_END);
  if (b !== -1 && e !== -1 && e > b) {
    const before = current.slice(0, b);
    const after = current.slice(e + AGENTS_END.length);
    next = before + block + after;
    if (next === current) return { status: 'ok', detail: `${name}: durability rules already current` };
  } else if (current.trim().length === 0) {
    next = block + '\n';
  } else {
    next = current.replace(/\s*$/, '') + '\n\n' + block + '\n';
  }

  if (dryRun) return { status: 'fixed', detail: `${name}: would write durability rules (dry-run)` };
  writeFileSync(target, next);
  return { status: 'fixed', detail: `${name}: durability rules written` };
}

// ── Local untracked post-commit hook (D9) ───────────────────────────────────

/** Managed hooks live only in the checkout-local untracked Git directory. */
function resolveHooksDir(repoPath: string): { dir: string; tracked: boolean } {
  return { dir: join(repoPath, '.git', 'hooks'), tracked: false };
}

/** Ensure a repo-relative path is in .git/info/exclude so our hook stays untracked. */
function ensureExcluded(repoPath: string, relPath: string): void {
  const exclude = join(repoPath, '.git', 'info', 'exclude');
  try {
    mkdirSync(dirname(exclude), { recursive: true });
    let body = existsSync(exclude) ? readFileSync(exclude, 'utf-8') : '';
    if (!body.split('\n').some(l => l.trim() === relPath)) {
      if (body.length && !body.endsWith('\n')) body += '\n';
      body += `${relPath}\n`;
      writeFileSync(exclude, body);
    }
  } catch { /* best-effort */ }
}

function installLocalHook(repoPath: string, branch: string, expectedRemoteUrl: string, dryRun: boolean): { status: StepStatus; detail: string } {
  const { dir, tracked } = resolveHooksDir(repoPath);
  const hookPath = join(dir, 'post-commit');
  const script = renderPostCommitHook(repoPath, branch, expectedRemoteUrl);

  if (existsSync(hookPath)) {
    const cur = readFileSync(hookPath, 'utf-8');
    if (cur.includes(HOOK_BANNER)) {
      if (cur === script) return { status: 'ok', detail: `${relative(repoPath, hookPath)} already current` };
      if (dryRun) return { status: 'fixed', detail: `would refresh ${relative(repoPath, hookPath)} (dry-run)` };
      writeFileSync(hookPath, script); chmodSync(hookPath, 0o755);
      return { status: 'fixed', detail: `refreshed ${relative(repoPath, hookPath)}` };
    }
    // Foreign post-commit hook present — back it up, then install ours.
    if (!dryRun) writeFileSync(hookPath + '.bak', cur);
  }
  if (dryRun) return { status: 'fixed', detail: `would install ${relative(repoPath, hookPath)} (dry-run)` };
  mkdirSync(dir, { recursive: true });
  writeFileSync(hookPath, script); chmodSync(hookPath, 0o755);
  // If the hooks dir is a tracked location (.githooks via frontmatter), keep OUR
  // hook untracked so it never becomes repo-controlled code (D9).
  if (tracked) ensureExcluded(repoPath, relative(repoPath, hookPath));
  return { status: 'fixed', detail: `installed local untracked ${relative(repoPath, hookPath)}` };
}

function uninstallLocalHook(repoPath: string): boolean {
  const { dir } = resolveHooksDir(repoPath);
  const hookPath = join(dir, 'post-commit');
  if (!existsSync(hookPath)) return false;
  if (!readFileSync(hookPath, 'utf-8').includes(HOOK_BANNER)) return false;
  rmSync(hookPath);
  if (existsSync(hookPath + '.bak')) { writeFileSync(hookPath, readFileSync(hookPath + '.bak')); rmSync(hookPath + '.bak'); }
  return true;
}

// ── Retired repo-controlled helper migration ────────────────────────────────

/**
 * Remove the exact legacy executable path without reading or executing it.
 * harden used to overwrite this path, so it is reserved migration state rather
 * than user content. Directories are refused because recursive deletion would
 * broaden the boundary beyond one file/symlink.
 */
function removeLegacyHelper(repoPath: string, dryRun: boolean): { status: StepStatus; detail: string } {
  const helperPath = join(repoPath, HELPER_REL);
  let stat;
  try { stat = lstatSync(helperPath); }
  catch { return { status: 'ok', detail: `no legacy repo executable at ${HELPER_REL}` }; }
  if (stat.isDirectory()) {
    return { status: 'needs_attention', detail: `refusing recursive removal of directory at reserved path ${HELPER_REL}` };
  }
  if (dryRun) return { status: 'fixed', detail: `would remove legacy repo executable ${HELPER_REL} (dry-run)` };
  rmSync(helperPath);
  return { status: 'fixed', detail: `removed legacy repo executable ${HELPER_REL}` };
}

// ── Repo-scoped credential wiring (D11) ─────────────────────────────────────

function gitConfigGet(repoPath: string, key: string, localOnly = false): string {
  try {
    const scope = localOnly ? ['--local'] : [];
    return execFileSync('git', ['-C', repoPath, ...GIT_EXECUTION_FENCE_FLAGS, 'config', ...scope, '--get', key], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: cleanInheritedGitEnvironment(process.env, GIT_ENV),
    }).toString().trim();
  } catch { return ''; }
}
function gitConfigSet(repoPath: string, key: string, value: string): void {
  execFileSync('git', ['-C', repoPath, ...GIT_EXECUTION_FENCE_FLAGS, 'config', key, value], {
    stdio: 'ignore', timeout: 10_000, env: cleanInheritedGitEnvironment(process.env, GIT_ENV),
  });
}
function gitConfigUnset(repoPath: string, key: string): void {
  try {
    execFileSync('git', ['-C', repoPath, ...GIT_EXECUTION_FENCE_FLAGS, 'config', '--unset-all', key], {
      stdio: 'ignore', timeout: 10_000, env: cleanInheritedGitEnvironment(process.env, GIT_ENV),
    });
  } catch { /* not set */ }
}

function credentialLine(remoteUrl: string, pat: string): string | null {
  const canonical = canonicalRemoteUrl(remoteUrl);
  if (isAbsolute(canonical) || canonical.startsWith('file:')) return null;
  const parsed = new URL(canonical);
  parsed.username = 'x-access-token';
  parsed.password = pat;
  return parsed.href;
}

function credentialTarget(line: string): string | null {
  try {
    const parsed = new URL(line);
    parsed.username = '';
    parsed.password = '';
    return canonicalRemoteUrl(parsed.href);
  } catch {
    return null;
  }
}

/**
 * Wire the owner-only credential store consumed explicitly by git-remote.ts.
 * Repo-local helpers are deliberately neither trusted nor executed: a checkout
 * can edit .git/config, and `credential.helper=!command` is shell execution.
 * The token is never returned or logged.
 */
function wireRepoCredential(repoPath: string, remoteUrl: string, pat: string, dryRun: boolean): { status: StepStatus; detail: string } {
  const existing = gitConfigGet(repoPath, 'credential.helper', /*localOnly*/ true);
  const ours = gitConfigGet(repoPath, CRED_MANAGED_KEY, true) === 'true';
  const canonical = canonicalRemoteUrl(remoteUrl);
  const store = credStoreFile();
  const line = credentialLine(canonical, pat);
  // Already fully wired by us with this credential present → idempotent no-op.
  if (
    ours
    && gitConfigGet(repoPath, CRED_URL_KEY, true) === canonical
    && (line === null || (existsSync(store) && readFileSync(store, 'utf-8').split('\n').includes(line)))
  ) {
    return { status: 'ok', detail: 'owner-only credential store already wired for exact source URL/path' };
  }
  if (dryRun) return { status: 'fixed', detail: 'would wire owner-only credential store (dry-run)' };

  mkdirSync(dirname(store), { recursive: true, mode: 0o700 });
  try { chmodSync(gbrainHome(), 0o700); } catch { /* */ }
  const current = existsSync(store) ? readFileSync(store, 'utf-8').split('\n').filter(Boolean) : [];
  if (line !== null) {
    // One credential per exact canonical remote. Rotation replaces only that
    // source; sibling repositories on the same host remain untouched.
    const next = current.filter(candidate => credentialTarget(candidate) !== canonical);
    next.push(line);
    writeFileSync(store, `${next.join('\n')}\n`, { mode: 0o600 });
  } else if (!existsSync(store)) writeFileSync(store, '', { mode: 0o600 });
  try { chmodSync(store, 0o600); } catch { /* */ }
  gitConfigSet(repoPath, CRED_MANAGED_KEY, 'true');
  gitConfigSet(repoPath, CRED_URL_KEY, canonical);
  return {
    status: 'fixed',
    detail: `wired owner-only credential store for exact source URL/path (0600; repo helper${existing ? ' ignored' : ' absent'})`,
  };
}

function removeCredentialWiring(repoPath: string, expectedRemoteUrl?: string): boolean {
  const repoAvailable = isGitRepo(repoPath);
  const ours = repoAvailable && gitConfigGet(repoPath, CRED_MANAGED_KEY, true) === 'true';
  const configured = repoAvailable ? gitConfigGet(repoPath, CRED_URL_KEY, true) : '';
  const target = expectedRemoteUrl ? canonicalRemoteUrl(expectedRemoteUrl) : configured;
  // Without a trusted registered URL, only a surviving marker may authorize
  // removal. With the DB-bound URL, teardown remains possible after a clone is
  // deleted or its Git metadata is corrupt.
  if (!target || (!expectedRemoteUrl && !ours)) return false;
  if (target && configured && target !== configured) {
    throw new Error('Refusing to remove credential: registered source URL differs from hardened credential URL');
  }
  let removed = false;
  const store = credStoreFile();
  if (existsSync(store)) {
    const current = readFileSync(store, 'utf-8').split('\n').filter(Boolean);
    const next = current.filter(line => credentialTarget(line) !== target);
    if (next.length !== current.length) {
      if (next.length === 0) rmSync(store);
      else writeFileSync(store, `${next.join('\n')}\n`, { mode: 0o600 });
      removed = true;
    }
  }
  if (ours) {
    gitConfigUnset(repoPath, CRED_MANAGED_KEY);
    gitConfigUnset(repoPath, CRED_URL_KEY);
    removed = true;
  }
  return removed;
}

// ── Minimal DB-free pull cron (D2 + D12) ────────────────────────────────────

function cronLabel(sourceId: string): string {
  return `com.gbrain.brain-pull.${sourceId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}
function cronWrapperPath(sourceId: string): string {
  return join(gbrainHome(), `brain-pull-${sourceId.replace(/[^A-Za-z0-9._-]/g, '_')}.sh`);
}
function launchdPlistPath(sourceId: string): string {
  return join(process.env.HOME || '', 'Library', 'LaunchAgents', `${cronLabel(sourceId)}.plist`);
}

/** Pure cron-wrapper renderer (DB-free pull; secret-free — sources the shell
 *  profile rather than baking keys in). Exported for tests. */
export function renderCronWrapper(sourceId: string, repoPath: string, branch: string, expectedRemoteUrl: string, cli: string, logPath: string): string {
  const q = (s: string) => s.replace(/'/g, "'\\''");
  return `#!/bin/bash
# Auto-generated by gbrain sources harden — DB-free durability pull (${sourceId}).
# Sources the shell profile for secrets, then runs the hardened, DB-free pull.
[ -f ~/.zshenv ] && source ~/.zshenv 2>/dev/null
source ~/.zshrc 2>/dev/null || source ~/.bashrc 2>/dev/null || true
# Self-disable if the captured checkout is gone (rename/relocation).
if [ ! -d '${q(repoPath)}/.git' ]; then
  echo "$(date -u +%FT%TZ) [cron] path gone, skipping: ${q(repoPath)}" >> "${q(logPath)}" 2>/dev/null || true
  exit 0
fi
exec '${q(cli)}' sources pull --path '${q(repoPath)}' --branch '${q(branch)}' --expected-remote '${q(expectedRemoteUrl)}'
`;
}

function writeCronWrapper(sourceId: string, repoPath: string, branch: string, expectedRemoteUrl: string): string {
  const wrapper = cronWrapperPath(sourceId);
  const body = renderCronWrapper(sourceId, repoPath, branch, expectedRemoteUrl, resolveGbrainCliPath(), pushLogPath());
  mkdirSync(dirname(wrapper), { recursive: true });
  writeFileSync(wrapper, body, { mode: 0o755 });
  return wrapper;
}

export function generateBrainPullPlist(label: string, wrapperPath: string, home: string, intervalSec: number): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(label)}</string>
  <key>ProgramArguments</key><array><string>${esc(wrapperPath)}</string></array>
  <key>StartInterval</key><integer>${intervalSec}</integer>
  <key>StandardOutPath</key><string>${esc(home)}/.gbrain/brain-pull.log</string>
  <key>StandardErrorPath</key><string>${esc(home)}/.gbrain/brain-pull.err</string>
</dict>
</plist>`;
}

function installDurabilityCron(sourceId: string, repoPath: string, branch: string, expectedRemoteUrl: string, intervalSec: number, dryRun: boolean): { status: StepStatus; detail: string } {
  const wrapper = dryRun ? cronWrapperPath(sourceId) : writeCronWrapper(sourceId, repoPath, branch, expectedRemoteUrl);
  const home = process.env.HOME || '';
  if (process.platform === 'darwin') {
    const plistPath = launchdPlistPath(sourceId);
    if (dryRun) return { status: 'fixed', detail: `would install launchd ${cronLabel(sourceId)} every ${intervalSec}s (dry-run)` };
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, generateBrainPullPlist(cronLabel(sourceId), wrapper, home, intervalSec));
    try { execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: 'ignore' }); } catch { /* */ }
    try { execSync(`launchctl load "${plistPath}"`, { stdio: 'ignore' }); } catch { /* loaded best-effort */ }
    return { status: 'fixed', detail: `launchd ${cronLabel(sourceId)} every ${intervalSec}s` };
  }
  // Linux: crontab line, deduped on the label marker.
  const minutes = Math.max(1, Math.round(intervalSec / 60));
  const marker = `# ${cronLabel(sourceId)}`;
  const cronLine = `*/${minutes} * * * * ${wrapper} ${marker}`;
  if (dryRun) return { status: 'fixed', detail: `would install crontab (every ${minutes}m) (dry-run)` };
  let existingCron = '';
  try { existingCron = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8' }); } catch { /* none */ }
  const kept = existingCron.split('\n').filter(l => l && !l.includes(marker));
  const next = [...kept, cronLine, ''].join('\n');
  try {
    execSync('crontab -', { input: next, stdio: ['pipe', 'ignore', 'ignore'] });
    return { status: 'fixed', detail: `crontab every ${minutes}m` };
  } catch (e) {
    return { status: 'needs_attention', detail: `crontab install failed: ${(e as Error).message.slice(0, 120)}` };
  }
}

function removeDurabilityCron(sourceId: string): boolean {
  let removed = false;
  if (process.platform === 'darwin') {
    const plistPath = launchdPlistPath(sourceId);
    if (existsSync(plistPath)) {
      try { execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: 'ignore' }); } catch { /* */ }
      rmSync(plistPath); removed = true;
    }
  } else {
    const marker = `# ${cronLabel(sourceId)}`;
    try {
      const cur = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8' });
      if (cur.includes(marker)) {
        const next = cur.split('\n').filter(l => l && !l.includes(marker)).join('\n') + '\n';
        execSync('crontab -', { input: next, stdio: ['pipe', 'ignore', 'ignore'] });
        removed = true;
      }
    } catch { /* none */ }
  }
  const wrapper = cronWrapperPath(sourceId);
  if (existsSync(wrapper)) { rmSync(wrapper); removed = true; }
  return removed;
}

// ── PAT acceptance (D8) ─────────────────────────────────────────────────────

export interface AcceptPatResult { token: string; source: string; warnings: string[]; }

/**
 * Resolve a PAT: --pat-file (preferred) > GBRAIN_GITHUB_PAT env. Never a bare CLI
 * arg (process-listing leak). Validates non-empty; WARNs loudly on loose perms
 * but continues (mirrors GBRAIN_ALLOW_PRIVATE_REMOTES). Returns null if none.
 */
export function acceptPat(opts: { patFile?: string }): AcceptPatResult | null {
  const warnings: string[] = [];
  if (opts.patFile) {
    if (!existsSync(opts.patFile)) throw new Error(`--pat-file not found: ${opts.patFile}`);
    try {
      const mode = statSync(opts.patFile).mode;
      if (mode & 0o077) warnings.push(`WARN: PAT file ${opts.patFile} is group/other-readable (mode ${(mode & 0o777).toString(8)}); chmod 600 it`);
    } catch { /* */ }
    const token = readFileSync(opts.patFile, 'utf-8').trim();
    if (!token) throw new Error(`--pat-file is empty: ${opts.patFile}`);
    return { token, source: 'pat-file', warnings };
  }
  const env = (process.env.GBRAIN_GITHUB_PAT || '').trim();
  if (env) return { token: env, source: 'env:GBRAIN_GITHUB_PAT', warnings };
  return null;
}

// ── Orchestration ───────────────────────────────────────────────────────────

function isGitRepo(repoPath: string): boolean {
  return existsSync(join(repoPath, '.git'));
}

function currentBranch(repoPath: string): string {
  try {
    return execFileSync('git', ['-C', repoPath, ...GIT_EXECUTION_FENCE_FLAGS, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: cleanInheritedGitEnvironment(process.env, GIT_ENV),
    }).toString().trim();
  } catch { return 'HEAD'; }
}

function headSha(repoPath: string): string {
  try {
    return execFileSync('git', ['-C', repoPath, ...GIT_EXECUTION_FENCE_FLAGS, 'rev-parse', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: cleanInheritedGitEnvironment(process.env, GIT_ENV),
    }).toString().trim();
  } catch { return ''; }
}

function pullDetail(o: PullOutcome): { status: StepStatus; detail: string } {
  switch (o.status) {
    case 'up_to_date': return { status: 'ok', detail: 'already up to date with origin' };
    case 'advanced': return { status: 'fixed', detail: `advanced ${o.from.slice(0, 7)}→${o.to.slice(0, 7)}` };
    case 'skipped_dirty': return { status: 'skipped', detail: 'working tree dirty — pull skipped (in-progress edits preserved)' };
    case 'conflict_aborted': return { status: 'needs_attention', detail: o.detail };
  }
}

/**
 * Harden a brain repo for durability. Idempotent: a second run on an
 * already-hardened repo produces all ok/skipped and NO new commit.
 */
export async function hardenBrainRepo(opts: HardenOpts): Promise<DurabilityReport> {
  const { repoPath, sourceId } = opts;
  const dryRun = !!opts.dryRun;
  const installCron = opts.installCron !== false;
  const verify = opts.verify !== false;
  const intervalSec = opts.intervalSec ?? 1800;
  const redact = opts.pat ? (s: string) => redactSecretsInText(s, new Map([['github_pat', opts.pat!]])) : (s: string) => s;
  const log = (l: string) => opts.logger?.(redact(l));

  if (!opts.expectedRemoteUrl) throw new Error('registered expectedRemoteUrl is required for hardening');
  if (!isGitRepo(repoPath)) throw new Error(`not a git repo: ${repoPath}`);

  // First Git boundary: validate executable config and exact registered origin
  // before branch/status/rev-parse can consult checkout-controlled config.
  validateOriginRemote(repoPath, opts.expectedRemoteUrl);
  const expectedRemoteUrl = canonicalRemoteUrl(opts.expectedRemoteUrl);
  const branch = opts.branch || detectDefaultBranch(repoPath);
  const steps: DurabilityStep[] = [];
  const push = (step: StepName, r: { status: StepStatus; detail: string }) => {
    const s: DurabilityStep = { step, status: r.status, detail: redact(r.detail) };
    steps.push(s); log(`[${step}] ${s.status}: ${s.detail}`);
    return s;
  };

  // Authentication is bound only after exact origin validation, but before
  // the first pull so a newly registered private source does not falsely fail
  // its own hardening pass for lack of credentials.
  const credentialResult = opts.pat
    ? wireRepoCredential(repoPath, expectedRemoteUrl, opts.pat, dryRun)
    : { status: 'skipped' as const, detail: 'no PAT provided — relying on existing git auth' };

  // Refuse on detached HEAD — pushing to a wrong ref is worse than not pushing.
  if (currentBranch(repoPath) === 'HEAD') {
    push('pull', { status: 'needs_attention', detail: 'detached HEAD — checkout a branch before hardening' });
  } else {
    // 1. pull current state
    try { push('pull', pullDetail(divergenceSafePull(repoPath, branch, { expectedRemoteUrl }))); }
    catch (e) { push('pull', { status: 'needs_attention', detail: `fetch/pull failed: ${(e as Error).message.slice(0, 140)}` }); }
  }

  // 2. credential
  push('credential', credentialResult);

  // 3. local untracked hook
  push('hook', installLocalHook(repoPath, branch, expectedRemoteUrl, dryRun));
  // 4. remove the retired repo-controlled executable. The installed CLI is
  // the sole persistent-write boundary.
  push('helper', removeLegacyHelper(repoPath, dryRun));
  // 5. resolver/AGENTS rules
  push('agents', patchResolverFile(repoPath, expectedRemoteUrl, dryRun));
  // 6. cron
  if (installCron) push('cron', installDurabilityCron(sourceId, repoPath, branch, expectedRemoteUrl, intervalSec, dryRun));
  else push('cron', { status: 'skipped', detail: '--no-cron' });

  // 7. verify (push-probe) + commit scaffolding if push works
  let clean = false;
  if (verify && !dryRun) {
    const probe: PushProbeResult = pushProbe(repoPath, branch, { redactDetail: redact, expectedRemoteUrl });
    if (!probe.ok) {
      push('verify', { status: 'needs_attention', detail: `push-probe failed (${probe.reason}): ${probe.detail}` });
    } else {
      push('verify', { status: 'ok', detail: 'push-probe ok — push auth confirmed' });
      // Commit the durability rules and any legacy-helper deletion — real
      // content, the genuine end-to-end proof. No-op when unchanged.
      const committed = commitScaffolding(repoPath, branch, expectedRemoteUrl, redact);
      if (committed) push('commit', committed);
      clean = headMatchesOrigin(repoPath, branch);
    }
  } else if (dryRun) {
    push('verify', { status: 'skipped', detail: 'dry-run' });
  } else {
    push('verify', { status: 'skipped', detail: '--no-verify' });
  }

  const missing = steps.filter(s => s.status === 'fixed').map(s => s.step);
  const fixed = missing;
  const needs_attention = steps.filter(s => s.status === 'needs_attention').map(s => `${s.step}: ${s.detail}`);
  return { source_id: sourceId, repo_path: repoPath, branch, steps, missing, fixed, needs_attention, clean_against_origin: clean };
}

/**
 * Bring only automation-owned, still-unchanged paths in the real index forward
 * to the commit created through the alternate index. The real index lock is
 * acquired before it is copied and held through atomic replacement, so a
 * concurrent `git add` either lands before the snapshot (and is preserved) or
 * after the replacement. A concurrently staged managed path is detected
 * against baseHead and deliberately left untouched.
 */
function reconcileRealIndexAfterIsolatedCommit(
  repoPath: string,
  baseHead: string,
  committed: string,
  paths: readonly string[],
  baseEnv: NodeJS.ProcessEnv,
): void {
  const gitPath = execFileSync(
    'git',
    ['-C', repoPath, ...GIT_EXECUTION_FENCE_FLAGS, 'rev-parse', '--git-path', 'index'],
    { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: baseEnv },
  ).toString().trim();
  if (!gitPath) throw new Error('Cannot resolve the real Git index path');
  const indexPath = isAbsolute(gitPath) ? gitPath : resolve(repoPath, gitPath);
  const lockPath = `${indexPath}.lock`;
  let lockFd: number | null = null;
  let ownsLock = false;
  let reconcileDir: string | null = null;
  try {
    try {
      lockFd = openSync(lockPath, 'wx', 0o600);
      ownsLock = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('Refusing real-index reconciliation while another Git index writer is active');
      }
      throw error;
    }

    reconcileDir = mkdtempSync(join(dirname(indexPath), '.gbrain-index-reconcile-'));
    const reconcileIndex = join(reconcileDir, 'index');
    const reconcileEnv = cleanInheritedGitEnvironment(process.env, {
      ...baseEnv,
      GIT_INDEX_FILE: reconcileIndex,
      GIT_LITERAL_PATHSPECS: '1',
    });
    const run = (args: string[]): void => {
      execFileSync('git', ['-C', repoPath, ...GIT_EXECUTION_FENCE_FLAGS, ...args], {
        stdio: 'ignore', timeout: 30_000, env: reconcileEnv,
      });
    };

    if (existsSync(indexPath)) copyFileSync(indexPath, reconcileIndex);
    else run(['read-tree', baseHead]);

    const unchanged: string[] = [];
    for (const path of paths) {
      try {
        run(['diff-index', '--cached', '--quiet', '--no-ext-diff', baseHead, '--', path]);
        unchanged.push(path);
      } catch (error) {
        if ((error as { status?: number }).status !== 1) {
          throw new Error(`Cannot compare real-index path before reconciliation: ${path}`);
        }
        // Exit 1 means this path was staged concurrently. Preserve it exactly.
      }
    }
    if (unchanged.length > 0) run(['reset', '-q', committed, '--', ...unchanged]);

    writeFileSync(lockFd, readFileSync(reconcileIndex));
    fsyncSync(lockFd);
    closeSync(lockFd);
    lockFd = null;
    renameSync(lockPath, indexPath);
    ownsLock = false;
  } finally {
    if (lockFd !== null) closeSync(lockFd);
    if (ownsLock) rmSync(lockPath, { force: true });
    if (reconcileDir) rmSync(reconcileDir, { recursive: true, force: true });
  }
}

function commitPathsWithIsolatedIndex(
  repoPath: string,
  message: string,
  paths: readonly string[],
): string | null {
  if (paths.length === 0) throw new Error('Refusing blind commit: at least one explicit path is required');
  for (const path of paths) {
    if (!path || isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
      throw new Error(`Refusing unsafe commit path: ${path || '(empty)'}`);
    }
  }
  const baseEnv = cleanInheritedGitEnvironment(process.env, {
    ...GIT_ENV,
    GBRAIN_DURABILITY_SKIP_HOOK: '1',
  });
  const preStaged = execFileSync(
    'git',
    ['-C', repoPath, ...GIT_EXECUTION_FENCE_FLAGS, 'diff', '--cached', '--name-only', '-z'],
    { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: baseEnv },
  ).toString().split('\0').filter(Boolean);
  if (preStaged.length > 0) {
    throw new Error(
      `Refusing durability commit while the user index has pre-staged paths ` +
      `(first: ${preStaged[0]}); staging was left unchanged`,
    );
  }
  mkdirSync(gbrainHome(), { recursive: true, mode: 0o700 });
  const temp = mkdtempSync(join(gbrainHome(), 'git-index-'));
  const index = join(temp, 'index');
  const env = cleanInheritedGitEnvironment(process.env, {
    ...baseEnv,
    GIT_INDEX_FILE: index,
    GIT_LITERAL_PATHSPECS: '1',
    GBRAIN_DURABILITY_SKIP_HOOK: '1',
  });
  const run = (args: string[], stdio: 'ignore' | ['ignore', 'pipe', 'ignore'] = 'ignore'): string => {
    const output = execFileSync('git', ['-C', repoPath, ...GIT_EXECUTION_FENCE_FLAGS, ...args], {
      stdio,
      timeout: 30_000,
      env,
    });
    return output?.toString() ?? '';
  };
  try {
    const baseHead = run(['rev-parse', 'HEAD'], ['ignore', 'pipe', 'ignore']).trim();
    run(['read-tree', 'HEAD']);
    const stageable = paths.filter(path => {
      try { lstatSync(join(repoPath, path)); return true; }
      catch { /* absent in the worktree; include only a tracked deletion */ }
      try {
        run(['ls-files', '--error-unmatch', '--', path]);
        return true;
      } catch (error) {
        if ((error as { status?: number }).status === 1) return false;
        throw error;
      }
    });
    if (stageable.length > 0) run(['add', '--', ...stageable]);
    const staged = run(['diff', '--cached', '--name-only', '-z'], ['ignore', 'pipe', 'ignore'])
      .split('\0').filter(Boolean);
    if (staged.length === 0) return null;
    const allowed = new Set(paths);
    const unexpected = staged.find(path => !allowed.has(path));
    if (unexpected) throw new Error(`Isolated index staged unexpected path: ${unexpected}`);
    run(['commit', '--no-gpg-sign', '-m', message]);
    const committed = run(['rev-parse', 'HEAD'], ['ignore', 'pipe', 'ignore']).trim();
    reconcileRealIndexAfterIsolatedCommit(repoPath, baseHead, committed, paths, baseEnv);
    return committed;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export interface CommitPushResult {
  committed: boolean;
  commit: string;
  pullStatus: PullOutcome['status'];
}

/** Trusted CLI implementation used instead of executing repository helpers. */
export function commitAndPushPaths(opts: {
  repoPath: string;
  branch?: string;
  expectedRemoteUrl: string;
  message: string;
  paths: readonly string[];
}): CommitPushResult {
  const remote = validateOriginRemote(opts.repoPath, opts.expectedRemoteUrl);
  const branch = opts.branch || detectDefaultBranch(opts.repoPath);
  if (currentBranch(opts.repoPath) !== branch) {
    throw new Error(`Refusing commit on unexpected branch (expected ${branch})`);
  }
  const pull = divergenceSafePull(opts.repoPath, branch, { expectedRemoteUrl: remote });
  if (pull.status === 'conflict_aborted') throw new Error(pull.detail);
  const commit = commitPathsWithIsolatedIndex(opts.repoPath, opts.message, opts.paths);
  pushBranch(opts.repoPath, branch, { expectedRemoteUrl: remote, timeoutMs: 120_000 });
  return { committed: commit !== null, commit: commit ?? headSha(opts.repoPath), pullStatus: pull.status };
}

function commitScaffolding(repoPath: string, branch: string, expectedRemoteUrl: string, redact: (s: string) => string): { status: StepStatus; detail: string } | null {
  // Stage only the durability artifacts we manage — the legacy helper path is
  // included so an existing tracked executable is removed by the migration.
  const paths: string[] = [HELPER_REL];
  const resolver = findResolverFile(repoPath);
  if (resolver) paths.push(relative(repoPath, resolver));
  try {
    const commit = commitPathsWithIsolatedIndex(
      repoPath,
      'chore(gbrain): install brain durability scaffolding',
      paths,
    );
    if (!commit) return { status: 'ok', detail: 'scaffolding already committed' };
    pushBranch(repoPath, branch, { timeoutMs: 120_000, expectedRemoteUrl });
    return { status: 'fixed', detail: 'committed + pushed durability scaffolding' };
  } catch (e) {
    return { status: 'needs_attention', detail: redact(`scaffolding commit/push failed: ${(e as Error).message.slice(0, 500)}`) };
  }
}

function headMatchesOrigin(repoPath: string, branch: string): boolean {
  try {
    const local = headSha(repoPath);
    const remote = execFileSync('git', ['-C', repoPath, ...GIT_EXECUTION_FENCE_FLAGS, 'rev-parse', `origin/${branch}`], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: cleanInheritedGitEnvironment(process.env, GIT_ENV),
    }).toString().trim();
    return !!local && local === remote;
  } catch { return false; }
}

/** Remove durability scaffolding: cron, local hook, retired helper, and exact
 * credential wiring. The non-executable resolver block stays. Idempotent. */
export async function unhardenBrainRepo(opts: UnhardenOpts): Promise<DurabilityStep[]> {
  const { repoPath, sourceId } = opts;
  const steps: DurabilityStep[] = [];
  const cronRemoved = removeDurabilityCron(sourceId);
  steps.push({ step: 'cron', status: cronRemoved ? 'fixed' : 'skipped', detail: cronRemoved ? 'cron removed' : 'no cron' });
  const hookRemoved = isGitRepo(repoPath) ? uninstallLocalHook(repoPath) : false;
  steps.push({ step: 'hook', status: hookRemoved ? 'fixed' : 'skipped', detail: hookRemoved ? 'hook removed' : 'no gbrain hook' });
  // Remove the retired evidence-resident executable whenever the checkout is
  // still present. This never reads or executes its contents.
  const helperResult = repoPath && existsSync(repoPath)
    ? removeLegacyHelper(repoPath, false)
    : { status: 'skipped' as const, detail: 'no checkout for legacy helper removal' };
  steps.push({
    step: 'helper',
    status: helperResult.status === 'ok' ? 'skipped' : helperResult.status,
    detail: helperResult.detail,
  });
  // The registered remote URL is sufficient authority to remove only this
  // source's credential even after the checkout was deleted or corrupted.
  const credRemoved = removeCredentialWiring(repoPath, opts.expectedRemoteUrl);
  steps.push({ step: 'credential', status: credRemoved ? 'fixed' : 'skipped', detail: credRemoved ? 'credential wiring removed' : 'no gbrain credential wiring' });
  opts.logger?.(steps.map(s => `[${s.step}] ${s.status}: ${s.detail}`).join('\n'));
  return steps;
}
