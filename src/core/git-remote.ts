/**
 * gbrain remote-source git helpers (v0.28).
 *
 * Single source of SSRF-defensive git invocations. parseRemoteUrl delegates
 * to isInternalUrl from src/core/url-safety.ts (covers scheme allowlist,
 * IPv6 loopback, IPv4-mapped IPv6, metadata hostnames, hex/octal bypass,
 * and CGNAT 100.64/10).
 *
 * cloneRepo and pullRepo both spread GIT_SSRF_FLAGS so a future flag added
 * to one path lands on both — single source of truth.
 *
 * Tailscale 100.64/10 trips the integrations.ts allowlist (CGNAT line in
 * url-safety.ts isPrivateIpv4). For self-hosted internal git servers
 * reachable only via Tailscale, set GBRAIN_ALLOW_PRIVATE_REMOTES=1; loud
 * stderr warning at use site is the operator's signal.
 */
import { execFileSync } from 'child_process';
import { lstatSync, existsSync, readdirSync } from 'fs';
import { isIP } from 'net';
import { basename, isAbsolute, join, resolve } from 'path';
import { isInternalUrl } from './url-safety.ts';
import { cleanInheritedGitEnvironment, gitNetworkEnvironment } from './git-environment.ts';

/**
 * Git CLI accepts two flag positions:
 *   git [global -c flags] <subcommand> [subcommand flags] [args]
 *
 * Global flags (the `-c key=value` config overrides) MUST come before the
 * subcommand. Subcommand-specific flags (like `--no-recurse-submodules`)
 * MUST come after the subcommand. Mixing the two positions makes git fail
 * with `unknown option` (exit 129). Pre-v0.34 the single GIT_SSRF_FLAGS
 * constant spliced both positions before the verb; real git rejected the
 * subcommand flag but the test harness used a fake-git script that didn't
 * validate, so every remote-source clone/pull broke silently in production.
 *
 * Split into two constants so the call-site spread is unambiguous and the
 * type/name signal the position rule.
 */

/**
 * Global git config flags. Spread BEFORE the subcommand verb.
 * - http.followRedirects=false: closes DNS rebinding via redirect chains
 * - protocol.file.allow=never: no local-file URLs (defense in depth)
 * - protocol.ext.allow=never: no external helpers (`git-remote-foo`)
 */
/** Disable checkout-controlled process execution in every Git subprocess. */
export const GIT_EXECUTION_FENCE_FLAGS = [
  '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null',
  '-c', 'commit.gpgSign=false',
  '-c', 'tag.gpgSign=false',
  '-c', 'gpg.program=/usr/bin/false',
  '-c', 'gpg.ssh.program=/usr/bin/false',
  '-c', 'gpg.x509.program=/usr/bin/false',
] as const;

export const GIT_SSRF_FLAGS = [
  ...GIT_EXECUTION_FENCE_FLAGS,
  '-c', 'http.followRedirects=false',
  '-c', 'http.sslVerify=true',
  '-c', 'http.proxy=',
  '-c', 'https.proxy=',
  '-c', 'protocol.file.allow=never',
  '-c', 'protocol.ext.allow=never',
  // Empty multi-valued helper resets every repo-local helper. Authenticated
  // paths append only the owner-only GBrain store below.
  '-c', 'credential.helper=',
  '-c', 'http.extraHeader=',
  '-c', 'http.cookieFile=',
  '-c', 'http.saveCookies=false',
] as const;

/**
 * Subcommand-level flags. Spread AFTER the subcommand verb (clone/pull).
 * - --no-recurse-submodules: .gitmodules cannot become a second fetch surface
 */
export const GIT_SSRF_SUBCOMMAND_FLAGS = [
  '--no-recurse-submodules',
] as const;

export type RemoteUrlErrorCode =
  | 'invalid_url'
  | 'unsupported_scheme'
  | 'embedded_credentials'
  | 'path_traversal'
  | 'internal_target'
  | 'dns_resolution_failed';

export class RemoteUrlError extends Error {
  constructor(public code: RemoteUrlErrorCode, message: string) {
    super(message);
    this.name = 'RemoteUrlError';
  }
}

export interface ParsedRemoteUrl {
  url: string;
  hostname: string;
  port: string;
}

/** Stable identity used for registered-origin and credential-path binding. */
export function canonicalRemoteUrl(remoteUrl: string): string {
  if (process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT === '1' && isAbsolute(remoteUrl)) {
    return resolve(remoteUrl).replace(/\/+$/, '');
  }
  let parsed: URL;
  try { parsed = new URL(remoteUrl); }
  catch { throw new RemoteUrlError('invalid_url', `URL malformed: ${remoteUrl}`); }
  parsed.hash = '';
  if (parsed.protocol === 'file:') {
    if (process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT !== '1' || (parsed.hostname && parsed.hostname !== 'localhost')) {
      throw new RemoteUrlError('unsupported_scheme', 'file transport is disabled');
    }
    return parsed.href.replace(/\/$/, '');
  }
  // parseRemoteUrl enforces HTTPS, credentials, traversal, and network policy.
  parseRemoteUrl(parsed.href);
  return parsed.href.replace(/\/$/, '');
}

export interface ApprovedRemoteTarget extends ParsedRemoteUrl {
  /** Unbracketed DNS name used for resolution and CURLOPT_RESOLVE binding. */
  networkHostname: string;
  /** Every address the resolver approved for this exact operation. */
  addresses: readonly string[];
}

export type RemoteAddressResolver = (hostname: string) => readonly string[];

/** Resolve all A/AAAA answers synchronously in an isolated short-lived child. */
export const resolveRemoteAddresses: RemoteAddressResolver = (hostname) => {
  const script = [
    "const dns=require('node:dns');",
    "const host=process.argv[process.argv.length-1];",
    "dns.lookup(host,{all:true,verbatim:true},(e,a)=>{",
    "if(e){console.error(e.code||e.message);process.exit(2)}",
    "process.stdout.write(JSON.stringify(a.map(x=>x.address)));",
    "});",
  ].join('');
  const execName = basename(process.execPath).toLowerCase();
  // In source installs process.execPath is bun/node. In `bun build --compile`
  // it is the generated gbrain executable; invoking that binary with `-e`
  // re-enters the CLI rather than a JavaScript evaluator. Prefer the active JS
  // runtime only when it is one, otherwise probe the package-required Bun and
  // then Node as a compatibility fallback.
  const runtimes = /^(bun|node)(\.exe)?$/.test(execName)
    ? [process.execPath]
    : ['bun', 'node'];
  let lastError: unknown;
  for (const runtime of runtimes) {
    try {
      const output = execFileSync(runtime, ['-e', script, hostname], {
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: gitNetworkEnvironment(),
      });
      const addresses = JSON.parse(output) as unknown;
      if (!Array.isArray(addresses) || !addresses.every(a => typeof a === 'string') || addresses.length === 0) {
        throw new Error('resolver returned no addresses');
      }
      return addresses;
    } catch (error) {
      lastError = error;
    }
  }
  throw new RemoteUrlError(
    'dns_resolution_failed',
    `Could not safely resolve remote host ${hostname}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
};

export function assertRemoteNetworkTarget(
  remoteUrl: string,
  resolver: RemoteAddressResolver = resolveRemoteAddresses,
): ApprovedRemoteTarget {
  // Explicit test/operator escape for an already-local bare repository. Keep
  // this out of parseRemoteUrl so source registration remains HTTPS-only, and
  // accept only absolute paths or hostless file:// URLs (never ext::, scp-like,
  // or file://remote-host network transports).
  if (process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT === '1') {
    if (isAbsolute(remoteUrl)) {
      return { url: remoteUrl, hostname: '', port: '', networkHostname: '', addresses: [] };
    }
    try {
      const local = new URL(remoteUrl);
      if (local.protocol === 'file:' && (local.hostname === '' || local.hostname === 'localhost')) {
        return { url: remoteUrl, hostname: '', port: '', networkHostname: '', addresses: [] };
      }
    } catch {
      // Fall through to the normal HTTPS-only parser.
    }
  }
  const parsed = parseRemoteUrl(remoteUrl);
  const networkHostname = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname;
  const addresses = [...new Set(
    isIP(networkHostname) !== 0 ? [networkHostname] : resolver(networkHostname),
  )];
  if (addresses.length === 0) {
    throw new RemoteUrlError('dns_resolution_failed', `Remote host resolved to no addresses: ${parsed.hostname}`);
  }
  if (addresses.some(address => isIP(address) === 0)) {
    throw new RemoteUrlError(
      'dns_resolution_failed',
      `Remote host resolver returned a non-IP address for ${parsed.hostname}`,
    );
  }
  const internal = addresses.find(address => {
    const literal = address.includes(':') ? `[${address}]` : address;
    return isInternalUrl(`https://${literal}/`);
  });
  if (internal) {
    if (process.env.GBRAIN_ALLOW_PRIVATE_REMOTES === '1') {
      console.error(`[gbrain] WARN: accepting private resolved address for ${parsed.hostname}: ${internal}`);
    } else {
      throw new RemoteUrlError(
        'internal_target',
        `Remote host ${parsed.hostname} resolves to internal/private address ${internal}`,
      );
    }
  }
  return { ...parsed, networkHostname, addresses };
}

/**
 * Bind libcurl's actual socket destination to the exact addresses approved by
 * `assertRemoteNetworkTarget`. The empty value clears every inherited or
 * repo-local CURLOPT_RESOLVE entry before the operation-specific binding is
 * installed. Keeping the original HTTPS URL preserves Host/SNI and normal TLS
 * hostname verification; only name-to-address resolution is replaced.
 */
export function gitRemoteAddressBindingFlags(target: ApprovedRemoteTarget): string[] {
  const flags = ['-c', 'http.curloptResolve='];
  if (!target.networkHostname || target.addresses.length === 0) return flags;
  // A literal IP URL is already destination-bound and has no second DNS lookup.
  if (isIP(target.networkHostname) !== 0) return flags;
  const addresses = target.addresses.map(address => isIP(address) === 6 ? `[${address}]` : address);
  flags.push(
    '-c',
    `http.curloptResolve=${target.networkHostname}:${target.port || '443'}:${addresses.join(',')}`,
  );
  return flags;
}

function assertRepoNetworkConfigSafe(repoPath: string): void {
  try {
    const output = execFileSync(
      'git',
      ['-C', repoPath, ...GIT_EXECUTION_FENCE_FLAGS, 'config', '--local', '--name-only', '--get-regexp',
        '^(include(if)?\\..*|url\\..*\\.(insteadof|pushinsteadof)|core\\.(askpass|attributesfile|fsmonitor|gitproxy|hookspath|partialclonefilter|sshcommand|worktree)|protocol\\..*\\.allow|filter\\..*\\.(clean|process|smudge)|merge\\..*\\.driver|diff\\..*\\.(command|textconv)|commit\\.gpgsign|tag\\.gpgsign|gpg(\\..*)?\\.program|gpg\\.format|user\\.signingkey|http(\\..*)?\\.(proxy|curloptresolve|followredirects|sslverify|sslbackend|sslversion|sslcipherlist|sslcert|sslkey|sslcapath|sslcapath|sslcainfo|pinnedpubkey|extraheader|cookiefile|savecookies)|https(\\..*)?\\.proxy|remote\\..*\\.(proxy|promisor|partialclonefilter)|extensions\\.partialclone)$'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: gitNetworkEnvironment() },
    ).trim();
    if (output) throw new Error(`unsafe repo-local executable/network config: ${output.split('\n')[0]}`);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 1) {
      if (error instanceof Error && error.message.startsWith('unsafe repo-local')) throw error;
      throw new Error(`Cannot validate repo-local Git network config in ${repoPath}`);
    }
    // status 1 = no matching key; continue into credential-helper validation.
  }

  // `!command` credential helpers are arbitrary shell execution. Normal named
  // helpers are still ignored by the command-line reset above, but rejecting
  // shell helpers explicitly makes a poisoned checkout fail before any fetch or
  // push subprocess is started.
  try {
    const records = execFileSync(
      'git',
      ['-C', repoPath, ...GIT_EXECUTION_FENCE_FLAGS, 'config', '--local', '--null', '--get-regexp', '^credential(\\..*)?\\.helper$'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: gitNetworkEnvironment() },
    ).split('\0').filter(Boolean);
    const shellHelper = records.find(record => {
      const value = record.slice(record.indexOf('\n') + 1).trimStart();
      return value.startsWith('!');
    });
    if (shellHelper) throw new Error('unsafe repo-local shell credential helper');
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 1) return;
    if (error instanceof Error && error.message.startsWith('unsafe repo-local')) throw error;
    throw new Error(`Cannot validate repo-local Git credential config in ${repoPath}`);
  }
}

/**
 * Validate a remote git URL for clone safety. https:// only.
 * Rejects: non-https schemes, embedded credentials, path traversal, and
 * internal/private targets via isInternalUrl.
 *
 * GBRAIN_ALLOW_PRIVATE_REMOTES=1 lets the URL through with a stderr warning.
 * Needed for self-hosted git over Tailscale (CGNAT 100.64/10) and similar.
 */
export function parseRemoteUrl(s: string): ParsedRemoteUrl {
  if (!s || typeof s !== 'string') {
    throw new RemoteUrlError('invalid_url', 'URL is empty or not a string');
  }
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new RemoteUrlError('invalid_url', `URL malformed: ${s}`);
  }
  if (url.protocol !== 'https:') {
    throw new RemoteUrlError(
      'unsupported_scheme',
      `URL scheme not supported (https:// only): ${url.protocol}`,
    );
  }
  if (url.username || url.password) {
    throw new RemoteUrlError(
      'embedded_credentials',
      'URL must not contain embedded credentials (https://user:pass@host)',
    );
  }
  if (s.includes('..')) {
    throw new RemoteUrlError('path_traversal', 'URL must not contain path-traversal (..)');
  }
  if (isInternalUrl(s)) {
    if (process.env.GBRAIN_ALLOW_PRIVATE_REMOTES === '1') {
      console.error(
        `[gbrain] WARN: GBRAIN_ALLOW_PRIVATE_REMOTES=1, accepting internal/private URL: ${url.hostname}`,
      );
    } else {
      throw new RemoteUrlError(
        'internal_target',
        `URL targets internal/private network: ${url.hostname} ` +
          `(set GBRAIN_ALLOW_PRIVATE_REMOTES=1 for self-hosted git over Tailscale or similar)`,
      );
    }
  }
  return { url: s, hostname: url.hostname, port: url.port || '443' };
}

export interface CloneOpts {
  depth?: number; // default 1; 0 means full clone
  branch?: string;
  timeoutMs?: number; // default 600_000 (10 min)
  /** Test seam; production resolves all A/AAAA answers immediately pre-op. */
  resolveAddresses?: RemoteAddressResolver;
}

export class GitOperationError extends Error {
  constructor(
    public op: 'clone' | 'pull' | 'fetch' | 'push' | 'remote_get_url',
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = 'GitOperationError';
  }
}

export const GIT_ENV = {
  GIT_NO_REPLACE_OBJECTS: '1',
  // Confine to the gbrain SSRF model — no credential helpers, no SSH askpass,
  // no GUI prompts. Inherit PATH so git itself is findable.
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '/bin/false',
  SSH_ASKPASS: '/bin/false',
} as const;

/**
 * Auth-capable git env for the durability push/probe paths (v0.42.44).
 *
 * Read-only clone/pull keep the strict GIT_ENV (askpass=/bin/false) so they can
 * never prompt. Push, push-probe, and the durability cron's authenticated fetch
 * may consult only the validated owner-only GBrain credential store appended by
 * `trustedCredentialFlags`; repo/global helpers remain reset. A false askpass
 * remains as the final fallback so a missing credential fails fast without
 * executing config-selected prompt programs or hanging a cron.
 */
export const GIT_ENV_AUTH = {
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  // The audited credential-store helper runs before askpass. A false askpass
  // only closes the fallback prompt/program surface when the store has no hit.
  GIT_ASKPASS: '/bin/false',
  SSH_ASKPASS: '/bin/false',
} as const;

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Return the only credential helper an authenticated GBrain Git operation may
 * execute. The deterministic store is written by `sources harden`; it must be a
 * single-link, owner-only regular file. Repo/global helpers stay reset even when
 * this store is absent, so missing auth fails closed instead of executing code
 * selected by the checkout.
 */
function trustedCredentialFlags(): string[] {
  const home = process.env.GBRAIN_HOME || join(process.env.HOME || '', '.gbrain');
  const store = join(home, 'git-credentials');
  try {
    const stat = lstatSync(store);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
    if (
      !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      stat.uid !== currentUid || (stat.mode & 0o077) !== 0
    ) return [];
  } catch {
    return [];
  }
  return [
    '-c', 'credential.useHttpPath=true',
    '-c', `credential.helper=store --file=${shellSingleQuote(store)}`,
  ];
}

/**
 * Clone a remote git repo with SSRF-defensive flags.
 * - destDir must NOT exist or must be empty.
 * - Default --depth=1 (no history); pass {depth: 0} for full clone.
 * - Throws GitOperationError on failure; caller is responsible for cleanup.
 */
export function cloneRepo(url: string, destDir: string, opts: CloneOpts = {}): void {
  // Defense in depth: callers normally validate during source registration,
  // but the transport helper itself is the final authority before networking.
  const target = assertRemoteNetworkTarget(url, opts.resolveAddresses);
  if (existsSync(destDir)) {
    let entries: string[];
    try {
      entries = readdirSync(destDir);
    } catch (e) {
      throw new GitOperationError(
        'clone',
        `Cannot inspect destination ${destDir}: ${(e as Error).message}`,
        e,
      );
    }
    if (entries.length > 0) {
      throw new GitOperationError(
        'clone',
        `Destination ${destDir} exists and is not empty; refusing to clone`,
      );
    }
  }

  const args: string[] = [
    ...GIT_SSRF_FLAGS,
    ...gitRemoteAddressBindingFlags(target),
    'clone',
    ...GIT_SSRF_SUBCOMMAND_FLAGS,
  ];
  if (opts.depth !== 0) {
    args.push(`--depth=${opts.depth ?? 1}`);
  }
  if (opts.branch) {
    args.push('--branch', opts.branch);
  }
  args.push(url, destDir);

  try {
    execFileSync('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeoutMs ?? 600_000,
      env: gitNetworkEnvironment(process.env, GIT_ENV),
    });
  } catch (e) {
    throw new GitOperationError(
      'clone',
      `git clone failed for ${url}: ${(e as Error).message}`,
      e,
    );
  }
}

/**
 * Resolve and validate origin before any network operation. This prevents a
 * locally rewritten `.git/config` from bypassing the source-registration URL
 * policy during cost preview, fetch, or pull.
 */
function validateOriginRemoteTarget(
  repoPath: string,
  expectedRemoteUrl?: string,
  opts: { push?: boolean; resolveAddresses?: RemoteAddressResolver } = {},
): ApprovedRemoteTarget {
  assertRepoNetworkConfigSafe(repoPath);
  let remoteUrl: string;
  try {
    remoteUrl = execFileSync('git', ['-C', repoPath, ...GIT_EXECUTION_FENCE_FLAGS, 'remote', 'get-url', ...(opts.push ? ['--push'] : []), 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      env: gitNetworkEnvironment(process.env, GIT_ENV),
    }).trim();
  } catch (e) {
    throw new GitOperationError(
      'remote_get_url',
      `Cannot validate origin in ${repoPath}`,
      e,
    );
  }

  let target: ApprovedRemoteTarget;
  try {
    target = assertRemoteNetworkTarget(remoteUrl, opts.resolveAddresses);
    if (expectedRemoteUrl !== undefined) assertRemoteNetworkTarget(expectedRemoteUrl, opts.resolveAddresses);
  } catch (e) {
    throw new GitOperationError(
      'remote_get_url',
      `Origin in ${repoPath} violates the remote URL policy`,
      e,
    );
  }
  if (expectedRemoteUrl !== undefined && canonicalRemoteUrl(remoteUrl) !== canonicalRemoteUrl(expectedRemoteUrl)) {
    throw new GitOperationError(
      'remote_get_url',
      `Origin in ${repoPath} differs from the configured source URL`,
    );
  }
  return target;
}

/** Validate origin policy for callers that only need the canonical URL. */
export function validateOriginRemote(
  repoPath: string,
  expectedRemoteUrl?: string,
  opts: { push?: boolean; resolveAddresses?: RemoteAddressResolver } = {},
): string {
  return validateOriginRemoteTarget(repoPath, expectedRemoteUrl, opts).url;
}

/** Pull a repo with --ff-only and the same SSRF-defensive flags as cloneRepo. */
export function pullRepo(
  repoPath: string,
  opts: { timeoutMs?: number; expectedRemoteUrl?: string; resolveAddresses?: RemoteAddressResolver } = {},
): void {
  const target = validateOriginRemoteTarget(repoPath, opts.expectedRemoteUrl, { resolveAddresses: opts.resolveAddresses });
  const remoteUrl = target.url;
  const branch = resolvePullBranch(repoPath);
  // Supplying an explicit URL to `git pull` without a refspec is not a valid
  // replacement for `git pull origin`: Git no longer has a remote name from
  // which to infer the tracked branch. Make the one network hop an explicit,
  // validated fetch, then perform the ff-only integration locally.
  runGit(
    repoPath,
    [...GIT_SSRF_FLAGS, ...gitRemoteAddressBindingFlags(target)],
    'fetch',
    [...GIT_SSRF_SUBCOMMAND_FLAGS, remoteUrl, `${branch}:refs/remotes/origin/${branch}`],
    'pull',
    { timeoutMs: opts.timeoutMs ?? 300_000, env: { ...GIT_ENV } },
  );
  runGit(
    repoPath,
    [],
    'merge',
    ['--ff-only', `refs/remotes/origin/${branch}`],
    'pull',
    { timeoutMs: opts.timeoutMs ?? 300_000 },
  );
}

function resolvePullBranch(repoPath: string): string {
  const candidates: string[] = [];
  try {
    const upstream = runGit(
      repoPath,
      [],
      'rev-parse',
      ['--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      'pull',
      { timeoutMs: 10_000 },
    );
    if (upstream.startsWith('origin/')) candidates.push(upstream.slice('origin/'.length));
    else if (upstream.startsWith('refs/remotes/origin/')) {
      candidates.push(upstream.slice('refs/remotes/origin/'.length));
    }
  } catch {
    // No upstream is normal for a newly cloned or manually initialized repo.
  }
  try {
    const current = runGit(repoPath, [], 'rev-parse', ['--abbrev-ref', 'HEAD'], 'pull', { timeoutMs: 10_000 });
    if (current && current !== 'HEAD') candidates.push(current);
  } catch {
    // Fall through to the default-branch resolver.
  }
  candidates.push(detectDefaultBranch(repoPath));
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      runGit(repoPath, [], 'check-ref-format', ['--branch', candidate], 'pull', { timeoutMs: 10_000 });
      return candidate;
    } catch {
      // Try the next locally derived candidate; never interpolate an invalid ref.
    }
  }
  throw new GitOperationError('pull', `Cannot resolve a safe branch to pull in ${repoPath}`);
}

/**
 * Fetch a single remote branch with the SAME SSRF-defensive flags + no-prompt
 * env as cloneRepo/pullRepo (GIT_SSRF_FLAGS, --no-recurse-submodules,
 * GIT_TERMINAL_PROMPT=0). Used by the sync cost-estimator's fetch-first path
 * (#2139) so a cost preview / dry-run never hits a remote through a
 * less-protected route than real sync. Throws GitOperationError on failure;
 * the estimator catches and falls back to local HEAD.
 */
export function fetchRemote(
  repoPath: string,
  branch: string,
  opts: { timeoutMs?: number; expectedRemoteUrl?: string; resolveAddresses?: RemoteAddressResolver } = {},
): void {
  const target = validateOriginRemoteTarget(repoPath, opts.expectedRemoteUrl, { resolveAddresses: opts.resolveAddresses });
  const remoteUrl = target.url;
  const args: string[] = [
    '-C', repoPath,
    ...GIT_SSRF_FLAGS,
    ...gitRemoteAddressBindingFlags(target),
    'fetch', ...GIT_SSRF_SUBCOMMAND_FLAGS,
    remoteUrl, `${branch}:refs/remotes/origin/${branch}`,
  ];
  try {
    execFileSync('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeoutMs ?? 30_000,
      env: gitNetworkEnvironment(process.env, GIT_ENV),
    });
  } catch (e) {
    throw new GitOperationError(
      'fetch',
      `git fetch failed in ${repoPath}: ${(e as Error).message}`,
      e,
    );
  }
}

export type RepoState =
  | 'healthy'
  | 'missing'
  | 'not-a-dir'
  | 'no-git'
  | 'url-drift'
  | 'corrupted';

/**
 * Classify the on-disk state of a clone. Used by performSync to decide
 * whether to run pull (healthy), re-clone (missing/no-git/not-a-dir),
 * refuse with corruption error (corrupted), or refuse with rebase-clone
 * hint (url-drift).
 */
export function validateRepoState(
  repoPath: string,
  expectedRemoteUrl?: string,
): RepoState {
  let stat;
  try {
    stat = lstatSync(repoPath);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return 'missing';
    return 'not-a-dir';
  }
  if (!stat.isDirectory()) return 'not-a-dir';
  if (!existsSync(join(repoPath, '.git'))) return 'no-git';

  let remoteUrl: string;
  try {
    assertRepoNetworkConfigSafe(repoPath);
    const out = execFileSync('git', ['-C', repoPath, ...GIT_EXECUTION_FENCE_FLAGS, 'remote', 'get-url', 'origin'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      env: cleanInheritedGitEnvironment(process.env, GIT_ENV),
    });
    remoteUrl = out.toString().trim();
  } catch {
    return 'corrupted';
  }

  if (expectedRemoteUrl !== undefined && canonicalRemoteUrl(remoteUrl) !== canonicalRemoteUrl(expectedRemoteUrl)) {
    return 'url-drift';
  }
  return 'healthy';
}

// ── Durability helpers (v0.42.44) ───────────────────────────────────────────
// Used by the brain-repo durability feature (`gbrain sources harden/pull`) and
// the DB-free pull cron. These are the auth-capable, rebase-aware counterparts
// to the strict read-only `pullRepo` (which stays `--ff-only` for `sync.ts`).

/**
 * Global SSRF flags for the durability fetch/pull/push paths. Identical to
 * GIT_SSRF_FLAGS except `protocol.file.allow` honors the env escape hatch
 * `GBRAIN_GIT_ALLOW_FILE_TRANSPORT=1` (mirrors GBRAIN_ALLOW_PRIVATE_REMOTES) so
 * self-hosted local-filesystem remotes — and the test suite — can use the file
 * transport. Default stays `never`. These ops act on an ALREADY-validated origin
 * (set + checked at clone time); `http.followRedirects=false` is the live guard.
 */
function durableSsrfFlags(): string[] {
  const fileAllow = process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT === '1' ? 'always' : 'never';
  return [
    ...GIT_EXECUTION_FENCE_FLAGS,
    '-c', 'http.followRedirects=false',
    '-c', 'http.sslVerify=true',
    '-c', 'http.proxy=',
    '-c', 'https.proxy=',
    '-c', `protocol.file.allow=${fileAllow}`,
    '-c', 'protocol.ext.allow=never',
    '-c', 'credential.helper=',
    '-c', 'credential.useHttpPath=true',
    '-c', 'http.extraHeader=',
    '-c', 'http.cookieFile=',
    '-c', 'http.saveCookies=false',
  ];
}

/** Run a git subcommand, returning trimmed stdout. Throws GitOperationError. */
function runGit(
  repoPath: string,
  globalFlags: readonly string[],
  subcommand: string,
  subArgs: readonly string[],
  op: GitOperationError['op'],
  opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): string {
  try {
    const out = execFileSync(
      'git',
      [
        '-C', repoPath,
        ...GIT_EXECUTION_FENCE_FLAGS,
        ...globalFlags,
        subcommand,
        ...subArgs,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: opts.timeoutMs ?? 120_000,
        env: gitNetworkEnvironment(process.env, opts.env ?? GIT_ENV),
      },
    );
    return out.toString().trim();
  } catch (e) {
    throw new GitOperationError(op, `git ${subcommand} failed in ${repoPath}: ${(e as Error).message}`, e);
  }
}

/** True if the working tree has staged or unstaged changes (untracked too). */
export function isWorkingTreeDirty(repoPath: string): boolean {
  const out = runGit(repoPath, [], 'status', ['--porcelain'], 'pull', { timeoutMs: 30_000 });
  return out.length > 0;
}

/**
 * Resolve the repo's default branch, local-only (no network):
 *   origin/HEAD symbolic-ref → current branch (if not detached) → 'main'.
 */
export function detectDefaultBranch(repoPath: string): string {
  try {
    const sym = execFileSync('git', ['-C', repoPath, ...GIT_EXECUTION_FENCE_FLAGS, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: cleanInheritedGitEnvironment(process.env, GIT_ENV),
    }).toString().trim();
    if (sym.startsWith('origin/')) return sym.slice('origin/'.length);
    if (sym) return sym;
  } catch { /* origin/HEAD not set — fall through */ }
  try {
    const cur = execFileSync('git', ['-C', repoPath, ...GIT_EXECUTION_FENCE_FLAGS, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: cleanInheritedGitEnvironment(process.env, GIT_ENV),
    }).toString().trim();
    if (cur && cur !== 'HEAD') return cur;
  } catch { /* detached or no commits */ }
  return 'main';
}

/** True if a rebase is mid-flight (rebase-merge or rebase-apply state dir exists). */
function rebaseInProgress(repoPath: string): boolean {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    try {
      const p = execFileSync('git', ['-C', repoPath, ...GIT_EXECUTION_FENCE_FLAGS, 'rev-parse', '--git-path', name], {
        stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: cleanInheritedGitEnvironment(process.env, GIT_ENV),
      }).toString().trim();
      const abs = p.startsWith('/') ? p : join(repoPath, p);
      if (existsSync(abs)) return true;
    } catch { /* ignore */ }
  }
  return false;
}

export type PullOutcome =
  | { status: 'up_to_date' }
  | { status: 'advanced'; from: string; to: string }
  | { status: 'skipped_dirty' }
  | { status: 'conflict_aborted'; detail: string };

/**
 * Divergence-safe pull: `fetch` + `pull --rebase`, never leaving a mid-rebase.
 *
 *  - Dirty working tree  → `skipped_dirty` (NORMAL mid-session state, not an
 *    error; never auto-stashes, never touches in-progress edits).
 *  - Rebase conflict     → `git rebase --abort`, verify no rebase state remains,
 *    return `conflict_aborted` ("manual attention needed"). Never throws past
 *    this — the repo is always left clean (possibly un-advanced).
 *
 * Auth-capable (GIT_ENV_AUTH) so it works against private remotes via the
 * validated owner-only GBrain credential store. SSRF flags apply on every call.
 */
export function divergenceSafePull(
  repoPath: string,
  branch: string,
  opts: { timeoutMs?: number; expectedRemoteUrl?: string; resolveAddresses?: RemoteAddressResolver } = {},
): PullOutcome {
  const timeoutMs = opts.timeoutMs ?? 300_000;

  // Exact registered origin and executable-config policy are the first Git
  // boundary. `status` can run clean filters/fsmonitor, so it must not precede
  // this validation.
  const target = validateOriginRemoteTarget(repoPath, opts.expectedRemoteUrl, { resolveAddresses: opts.resolveAddresses });

  if (isWorkingTreeDirty(repoPath)) return { status: 'skipped_dirty' };

  const before = runGit(repoPath, [], 'rev-parse', ['HEAD'], 'pull', { timeoutMs: 10_000 });
  const ssrf = [
    ...durableSsrfFlags(),
    ...trustedCredentialFlags(),
    ...gitRemoteAddressBindingFlags(target),
  ];
  const remoteUrl = target.url;

  runGit(repoPath, ssrf, 'fetch', [...GIT_SSRF_SUBCOMMAND_FLAGS, remoteUrl, `${branch}:refs/remotes/origin/${branch}`], 'pull', {
    timeoutMs, env: { ...GIT_ENV_AUTH },
  });

  try {
    // Fetch above is the sole network operation. Rebase the validated result
    // locally so a repo-local remote rewrite cannot create a second URL path.
    runGit(
      repoPath,
      ['-c', 'core.hooksPath=/dev/null'],
      'rebase',
      [`refs/remotes/origin/${branch}`],
      'pull',
      { timeoutMs },
    );
  } catch (e) {
    // Abort any half-applied rebase so the tree is never left mid-rebase.
    try {
      runGit(repoPath, [], 'rebase', ['--abort'], 'pull', { timeoutMs: 30_000 });
    } catch { /* best-effort */ }
    // If state STILL remains, try once more, then report regardless.
    if (rebaseInProgress(repoPath)) {
      try {
        runGit(repoPath, [], 'rebase', ['--abort'], 'pull', { timeoutMs: 30_000 });
      } catch { /* best-effort */ }
    }
    return {
      status: 'conflict_aborted',
      detail: `pull --rebase on ${branch} conflicted; rebase aborted — manual attention needed (${(e as Error).message.slice(0, 120)})`,
    };
  }

  const after = runGit(repoPath, [], 'rev-parse', ['HEAD'], 'pull', { timeoutMs: 10_000 });
  return before === after ? { status: 'up_to_date' } : { status: 'advanced', from: before, to: after };
}

export type PushProbeResult =
  | { ok: true }
  | { ok: false; reason: 'auth' | 'protected' | 'unreachable' | 'other'; detail: string };

/**
 * Authenticated `git push --dry-run` against origin/<branch>. Proves push auth
 * works AND surfaces read-only PATs / branch protection BEFORE harden declares
 * "hardened" — with zero history pollution (no commit). Auth-capable env.
 *
 * `redactDetail` (e.g. shell-redact's value scrubber bound to the PAT) is
 * applied to the captured stderr so a token echoed by git never reaches a log.
 */
export function pushProbe(
  repoPath: string,
  branch: string,
  opts: { timeoutMs?: number; redactDetail?: (s: string) => string; expectedRemoteUrl?: string; resolveAddresses?: RemoteAddressResolver } = {},
): PushProbeResult {
  const redact = opts.redactDetail ?? ((s: string) => s);
  try {
    const target = validateOriginRemoteTarget(repoPath, opts.expectedRemoteUrl, { push: true, resolveAddresses: opts.resolveAddresses });
    const remoteUrl = target.url;
    execFileSync(
      'git',
      [
        '-C', repoPath,
        ...durableSsrfFlags(),
        ...trustedCredentialFlags(),
        ...gitRemoteAddressBindingFlags(target),
        'push', '--dry-run', remoteUrl, `HEAD:${branch}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeoutMs ?? 60_000, env: gitNetworkEnvironment(process.env, GIT_ENV_AUTH) },
    );
    return { ok: true };
  } catch (e) {
    const raw = redact((e as Error).message || '');
    const low = raw.toLowerCase();
    let reason: 'auth' | 'protected' | 'unreachable' | 'other' = 'other';
    if (low.includes('authentication') || low.includes('403') || low.includes('permission') || low.includes('could not read')) reason = 'auth';
    else if (low.includes('protected') || low.includes('pre-receive') || low.includes('hook declined')) reason = 'protected';
    else if (low.includes('could not resolve') || low.includes('unable to access') || low.includes('timed out') || low.includes('network')) reason = 'unreachable';
    return { ok: false, reason, detail: raw.slice(0, 200) };
  }
}

/** Push one branch through the same validated URL/DNS/config boundary. */
export function pushBranch(
  repoPath: string,
  branch: string,
  opts: { timeoutMs?: number; expectedRemoteUrl?: string; resolveAddresses?: RemoteAddressResolver } = {},
): void {
  const target = validateOriginRemoteTarget(repoPath, opts.expectedRemoteUrl, {
    push: true,
    resolveAddresses: opts.resolveAddresses,
  });
  const checkedBranch = runGit(repoPath, [], 'check-ref-format', ['--branch', branch], 'push', {
    timeoutMs: 10_000,
  });
  const pushedHead = runGit(repoPath, [], 'rev-parse', ['HEAD'], 'push', { timeoutMs: 10_000 });
  const remoteUrl = target.url;
  runGit(
    repoPath,
    [
      ...durableSsrfFlags(),
      ...trustedCredentialFlags(),
      ...gitRemoteAddressBindingFlags(target),
    ],
    'push',
    [remoteUrl, `HEAD:refs/heads/${checkedBranch}`],
    'push',
    {
    timeoutMs: opts.timeoutMs ?? 120_000,
    env: { ...GIT_ENV_AUTH },
    },
  );
  // Pushing an explicit validated URL deliberately bypasses the remote name,
  // so Git does not refresh refs/remotes/origin/* for us. Mirror the exact SHA
  // that the successful push just installed; verification surfaces a failed
  // best-effort mirror without misreporting an already-landed remote push as
  // failed/ambiguous.
  try {
    runGit(
      repoPath,
      [],
      'update-ref',
      [`refs/remotes/origin/${checkedBranch}`, pushedHead],
      'push',
      { timeoutMs: 10_000 },
    );
  } catch {
    // The network mutation succeeded. Callers that need tracking-ref parity
    // (for example hardenBrainRepo) will report clean_against_origin=false.
  }
}
