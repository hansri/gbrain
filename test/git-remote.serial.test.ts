import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, chmodSync, mkdtempSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  GIT_SSRF_FLAGS,
  GIT_SSRF_SUBCOMMAND_FLAGS,
  GIT_EXECUTION_FENCE_FLAGS,
  parseRemoteUrl,
  canonicalRemoteUrl,
  RemoteUrlError,
  cloneRepo,
  fetchRemote,
  pullRepo,
  GitOperationError,
  isWorkingTreeDirty,
  validateRepoState,
  validateOriginRemote,
  assertRemoteNetworkTarget,
  gitRemoteAddressBindingFlags,
  divergenceSafePull,
  pushProbe,
  pushBranch,
} from '../src/core/git-remote.ts';
import { withEnv } from './helpers/with-env.ts';

// ---------------------------------------------------------------------------
// Serial fake-git harness: write a shell script that records its argv to a log file,
// then prepend its dir to PATH for the test. Lets us assert exact argv shape
// without invoking real git.
// ---------------------------------------------------------------------------

const FAKE_GIT_DIR = join(tmpdir(), `gbrain-git-remote-test-${process.pid}`);
const FAKE_GIT_LOG = join(FAKE_GIT_DIR, 'argv.log');
const FAKE_GIT_MODE = join(FAKE_GIT_DIR, 'mode');

function writeFakeGit(): void {
  mkdirSync(FAKE_GIT_DIR, { recursive: true });
  // Mode file controls fake-git behavior: "ok" = exit 0, "fail" = exit 1.
  writeFileSync(FAKE_GIT_MODE, 'ok');
  // Per-invocation argv goes into argv.log (one JSON array per line).
  writeFileSync(FAKE_GIT_LOG, '');
  const script = `#!/usr/bin/env bash
# Fake git for git-remote.serial.test.ts
{ printf '['; for arg in "$@"; do printf '%s,' "$(printf '%s' "$arg" | jq -Rs .)"; done; printf 'null]\\n'; } >> "${FAKE_GIT_LOG}"
mode=$(cat "${FAKE_GIT_MODE}" 2>/dev/null || echo ok)
case "$mode" in
  fail) exit 1 ;;
esac
if [[ " $* " == *" remote get-url "* && " $* " == *" origin "* ]]; then
  case "$mode" in
    url-drift) echo "https://github.com/different/url" ;;
    url-match) echo "https://github.com/expected/url" ;;
    *) echo "https://github.com/example/repo" ;;
  esac
fi
if [[ " $* " == *" check-ref-format --branch "* ]]; then
  printf '%s\n' "\${!#}"
fi
if [[ " $* " == *" rev-parse HEAD "* ]]; then
  echo "0123456789abcdef0123456789abcdef01234567"
fi
exit 0
`;
  const path = join(FAKE_GIT_DIR, 'git');
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

function readArgvLog(): string[][] {
  const raw = readFileSync(FAKE_GIT_LOG, 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const arr = JSON.parse(line) as (string | null)[];
      return arr.filter((x): x is string => x !== null);
    });
}

function clearArgvLog(): void {
  writeFileSync(FAKE_GIT_LOG, '');
}

function setMode(mode: 'ok' | 'fail' | 'url-drift' | 'url-match'): void {
  writeFileSync(FAKE_GIT_MODE, mode);
}

beforeAll(() => writeFakeGit());
afterAll(() => rmSync(FAKE_GIT_DIR, { recursive: true, force: true }));
beforeEach(() => {
  clearArgvLog();
  setMode('ok');
});

const fakePath = (): string => `${FAKE_GIT_DIR}:${process.env.PATH ?? ''}`;
const APPROVED_GIT_IP = '93.184.216.34';
const approveGitAddress = (): readonly string[] => [APPROVED_GIT_IP];

function expectAddressBound(call: string[], hostname: string, port = '443'): void {
  const clearAt = call.findIndex((arg, i) => arg === 'http.curloptResolve=' && call[i - 1] === '-c');
  const binding = `http.curloptResolve=${hostname}:${port}:${APPROVED_GIT_IP}`;
  const bindAt = call.findIndex((arg, i) => arg === binding && call[i - 1] === '-c');
  const verbAt = call.findIndex(arg => ['clone', 'fetch', 'push'].includes(arg));
  expect(clearAt).toBeGreaterThan(-1);
  expect(bindAt).toBeGreaterThan(clearAt);
  expect(verbAt).toBeGreaterThan(bindAt);
}

// ---------------------------------------------------------------------------
// GIT_SSRF_FLAGS — pinned shape (snapshot test). If a future flag is added,
// update the expected list here AND verify both cloneRepo + pullRepo pick it
// up via the GIT_SSRF_FLAGS spread (the codex finding that motivated this).
// ---------------------------------------------------------------------------

describe('GIT_SSRF_FLAGS', () => {
  test('exact shape — global -c config flags only (spread BEFORE the verb)', () => {
    expect([...GIT_SSRF_FLAGS]).toEqual([
      ...GIT_EXECUTION_FENCE_FLAGS,
      '-c', 'http.followRedirects=false',
      '-c', 'http.sslVerify=true',
      '-c', 'http.proxy=',
      '-c', 'https.proxy=',
      '-c', 'protocol.file.allow=never',
      '-c', 'protocol.ext.allow=never',
      '-c', 'credential.helper=',
      '-c', 'http.extraHeader=',
      '-c', 'http.cookieFile=',
      '-c', 'http.saveCookies=false',
    ]);
  });
});

describe('GIT_SSRF_SUBCOMMAND_FLAGS', () => {
  test('exact shape — subcommand-level flags only (spread AFTER the verb)', () => {
    // v0.34 fix wave: --no-recurse-submodules is a clone/pull subcommand
    // flag, not a global flag. Real git exits 129 with "unknown option"
    // when it appears before the verb. The pre-v0.34 single-constant
    // spread baked the bug in.
    expect([...GIT_SSRF_SUBCOMMAND_FLAGS]).toEqual([
      '--no-recurse-submodules',
    ]);
  });
});

// ---------------------------------------------------------------------------
// parseRemoteUrl
// ---------------------------------------------------------------------------

describe('parseRemoteUrl — happy path', () => {
  test('accepts plain https URL', () => {
    const r = parseRemoteUrl('https://github.com/garrytan/dummy.git');
    expect(r.url).toBe('https://github.com/garrytan/dummy.git');
    expect(r.hostname).toBe('github.com');
  });
});

describe('resolved-address network boundary (hermetic)', () => {
  test('accepts only public resolver answers', () => {
    const target = assertRemoteNetworkTarget(
      'https://git.example/repo',
      () => ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'],
    );
    expect(target.hostname).toBe('git.example');
    expect(target.addresses).toEqual([
      '93.184.216.34',
      '2606:2800:220:1:248:1893:25c8:1946',
    ]);
  });

  test('rejects non-IP resolver output instead of letting curl resolve it again', () => {
    expect(() => assertRemoteNetworkTarget(
      'https://git.example/repo',
      () => ['attacker-controlled-name.example'],
    )).toThrow(/non-IP address/);
  });

  test('binding keeps the TLS hostname and exact custom port while pinning all approved IPs', () => {
    const target = assertRemoteNetworkTarget(
      'https://git.example:8443/repo',
      () => [APPROVED_GIT_IP, '2606:2800:220:1:248:1893:25c8:1946'],
    );
    expect(gitRemoteAddressBindingFlags(target)).toEqual([
      '-c', 'http.curloptResolve=',
      '-c',
      `http.curloptResolve=git.example:8443:${APPROVED_GIT_IP},[2606:2800:220:1:248:1893:25c8:1946]`,
    ]);
    expect(target.url).toBe('https://git.example:8443/repo');
  });

  test('rejects private, link-local, and metadata answers before git runs', () => {
    for (const address of ['10.0.0.7', '169.254.169.254', 'fd00::7', 'fe80::1']) {
      expect(() => assertRemoteNetworkTarget('https://git.example/repo', () => [address]))
        .toThrow(/internal\/private/);
    }
  });

  test('local file transport requires the explicit escape and stays host-local', async () => {
    const localPath = join(tmpdir(), 'gbrain-local-origin.git');
    expect(() => assertRemoteNetworkTarget(localPath)).toThrow(RemoteUrlError);
    await withEnv({ GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' }, async () => {
      expect(assertRemoteNetworkTarget(localPath).url).toBe(localPath);
      expect(assertRemoteNetworkTarget(`file://${localPath}`).url).toBe(`file://${localPath}`);
      expect(() => assertRemoteNetworkTarget('file://remote.example/repo.git'))
        .toThrow(/https:\/\/ only/);
    });
  });
});

describe('parseRemoteUrl — rejection cases', () => {
  test('rejects empty input', () => {
    expect(() => parseRemoteUrl('')).toThrow(RemoteUrlError);
  });
  test('rejects malformed URL', () => {
    expect(() => parseRemoteUrl('not a url')).toThrow(/malformed|invalid_url/i);
  });
  test('rejects query strings and fragments that could carry secrets', () => {
    for (const remote of [
      'https://github.com/example/repo.git?access_token=SECRET',
      'https://github.com/example/repo.git#SECRET',
    ]) {
      expect(() => parseRemoteUrl(remote)).toThrow(/query strings or fragments/);
      expect(() => canonicalRemoteUrl(remote)).toThrow(/query strings or fragments/);
    }
  });
  test('rejects ssh:// scheme', () => {
    try {
      parseRemoteUrl('ssh://git@github.com/foo/bar.git');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteUrlError);
      expect((e as RemoteUrlError).code).toBe('unsupported_scheme');
    }
  });
  test('rejects git:// scheme', () => {
    expect(() => parseRemoteUrl('git://github.com/foo/bar')).toThrow(/scheme not supported/i);
  });
  test('rejects file:// scheme', () => {
    expect(() => parseRemoteUrl('file:///etc/passwd')).toThrow(/scheme not supported/i);
  });
  test('rejects embedded credentials', () => {
    try {
      parseRemoteUrl('https://user:pass@github.com/foo');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteUrlError);
      expect((e as RemoteUrlError).code).toBe('embedded_credentials');
    }
  });
  test('rejects path traversal (..)', () => {
    try {
      parseRemoteUrl('https://github.com/foo/../etc/passwd');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteUrlError);
      expect((e as RemoteUrlError).code).toBe('path_traversal');
    }
  });
  test('rejects RFC1918 192.168.x.x', () => {
    try {
      parseRemoteUrl('https://192.168.1.1/repo.git');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteUrlError);
      expect((e as RemoteUrlError).code).toBe('internal_target');
    }
  });
  test('rejects loopback 127.0.0.1', () => {
    expect(() => parseRemoteUrl('https://127.0.0.1/repo')).toThrow(/internal/i);
  });
  test('rejects localhost', () => {
    expect(() => parseRemoteUrl('https://localhost/repo')).toThrow(/internal/i);
  });
  test('rejects metadata.google.internal', () => {
    expect(() => parseRemoteUrl('https://metadata.google.internal/foo')).toThrow(
      /internal/i,
    );
  });
  test('rejects 169.254.x.x AWS metadata range', () => {
    expect(() => parseRemoteUrl('https://169.254.169.254/foo')).toThrow(/internal/i);
  });

  // Codex v0.28.1 finding: IPv6 ULA + link-local were not blocked.
  test('rejects IPv6 ULA fc00::/7 (fd-prefix)', () => {
    expect(() => parseRemoteUrl('https://[fd00:1234::1]/repo')).toThrow(/internal/i);
  });
  test('rejects IPv6 ULA fc00::/7 (fc-prefix)', () => {
    expect(() => parseRemoteUrl('https://[fc01:2345::abcd]/repo')).toThrow(/internal/i);
  });
  test('rejects IPv6 link-local fe80::/10', () => {
    expect(() => parseRemoteUrl('https://[fe80::1]/repo')).toThrow(/internal/i);
  });
  test('does NOT reject public IPv6', () => {
    // 2606:4700:4700::1111 is Cloudflare DNS — public IPv6
    const r = parseRemoteUrl('https://[2606:4700:4700::1111]/repo');
    expect(r.hostname).toBe('[2606:4700:4700::1111]');
  });
});

// T3 — Tailscale CGNAT regression cases.
describe('parseRemoteUrl — CGNAT 100.64/10 (Tailscale)', () => {
  test('rejected by default', async () => {
    await withEnv({ GBRAIN_ALLOW_PRIVATE_REMOTES: undefined }, async () => {
      try {
        parseRemoteUrl('https://100.64.0.1/repo.git');
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(RemoteUrlError);
        expect((e as RemoteUrlError).code).toBe('internal_target');
      }
    });
  });
  test('accepted with GBRAIN_ALLOW_PRIVATE_REMOTES=1', async () => {
    await withEnv({ GBRAIN_ALLOW_PRIVATE_REMOTES: '1' }, async () => {
      const r = parseRemoteUrl('https://100.64.0.1/repo.git');
      expect(r.hostname).toBe('100.64.0.1');
    });
  });
  test('also covers 100.127.x (upper end of CGNAT range)', async () => {
    await withEnv({ GBRAIN_ALLOW_PRIVATE_REMOTES: undefined }, async () => {
      expect(() => parseRemoteUrl('https://100.127.255.1/x')).toThrow(/internal/i);
    });
  });
  test('does NOT reject 100.0.x (just below CGNAT range)', () => {
    // 100.0.0.0/8 is regular public IP space outside CGNAT
    const r = parseRemoteUrl('https://100.63.255.1/repo');
    expect(r.hostname).toBe('100.63.255.1');
  });
});

// ---------------------------------------------------------------------------
// cloneRepo — fake-git harness
// ---------------------------------------------------------------------------

describe('cloneRepo', () => {
  test('happy path: invokes git with GIT_SSRF_FLAGS + --depth=1 + url + dest', async () => {
    const dest = join(FAKE_GIT_DIR, 'clone-target');
    rmSync(dest, { recursive: true, force: true });
    await withEnv({ PATH: fakePath() }, async () => {
      cloneRepo('https://example.com/repo', dest, { resolveAddresses: approveGitAddress });
    });
    const calls = readArgvLog();
    expect(calls.length).toBe(1);
    const argv = calls[0];
    // Global -c config flags must appear BEFORE the 'clone' verb.
    expect(argv.slice(0, GIT_SSRF_FLAGS.length)).toEqual([...GIT_SSRF_FLAGS]);
    expect(argv).toContain('clone');
    expect(argv).toContain('--depth=1');
    expect(argv).toContain('https://example.com/repo');
    expect(argv[argv.length - 1]).toBe(dest);
    expectAddressBound(argv, 'example.com');
    // v0.34 fix wave: subcommand flags MUST appear after the verb. Real
    // git rejects `git --no-recurse-submodules clone ...` with exit 129.
    // The fake-git harness returned 0 for any argv shape, so this
    // position-anchored assertion is the structural regression test.
    const cloneIdx = argv.indexOf('clone');
    expect(cloneIdx).toBeGreaterThan(-1);
    for (const subFlag of GIT_SSRF_SUBCOMMAND_FLAGS) {
      const flagIdx = argv.indexOf(subFlag);
      expect(flagIdx).toBeGreaterThan(cloneIdx);
    }
  });

  test('depth=0 means no --depth flag (full clone)', async () => {
    const dest = join(FAKE_GIT_DIR, 'clone-full');
    rmSync(dest, { recursive: true, force: true });
    await withEnv({ PATH: fakePath() }, async () => {
      cloneRepo('https://example.com/repo', dest, { depth: 0 });
    });
    const argv = readArgvLog()[0];
    expect(argv.find(a => a.startsWith('--depth'))).toBeUndefined();
  });

  test('passes --branch when provided', async () => {
    const dest = join(FAKE_GIT_DIR, 'clone-branch');
    rmSync(dest, { recursive: true, force: true });
    await withEnv({ PATH: fakePath() }, async () => {
      cloneRepo('https://example.com/repo', dest, { branch: 'main' });
    });
    const argv = readArgvLog()[0];
    const branchIdx = argv.indexOf('--branch');
    expect(branchIdx).toBeGreaterThan(-1);
    expect(argv[branchIdx + 1]).toBe('main');
  });

  test('refuses non-empty destDir', async () => {
    const dest = join(FAKE_GIT_DIR, 'clone-nonempty');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'sentinel'), 'hi');
    await withEnv({ PATH: fakePath() }, async () => {
      try {
        cloneRepo('https://example.com/repo', dest);
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(GitOperationError);
        expect((e as GitOperationError).op).toBe('clone');
      }
    });
    expect(readArgvLog().length).toBe(0); // never invoked git
    rmSync(dest, { recursive: true, force: true });
  });

  test('throws GitOperationError when git exits non-zero', async () => {
    const dest = join(FAKE_GIT_DIR, 'clone-fails');
    rmSync(dest, { recursive: true, force: true });
    setMode('fail');
    await withEnv({ PATH: fakePath() }, async () => {
      try {
        cloneRepo('https://example.com/repo', dest);
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(GitOperationError);
        expect((e as GitOperationError).op).toBe('clone');
      }
    });
  });

});

describe('fetchRemote', () => {
  test('validates origin before the SSRF-hardened fetch', async () => {
    const repo = join(FAKE_GIT_DIR, 'fetch-target');
    mkdirSync(repo, { recursive: true });
    await withEnv({ PATH: fakePath() }, async () => {
      fetchRemote(repo, 'main', {
        expectedRemoteUrl: 'https://github.com/example/repo',
        resolveAddresses: approveGitAddress,
      });
    });
    const calls = readArgvLog();
    expect(calls.some(call => call.includes('get-url'))).toBe(true);
    const fetch = calls.find(call => call.includes('fetch'))!;
    expect(fetch).toContain('https://github.com/example/repo');
    expect(fetch).toContain('main:refs/remotes/origin/main');
    expectAddressBound(fetch, 'github.com');
    rmSync(repo, { recursive: true, force: true });
  });
});

describe('validateOriginRemote', () => {
  test('returns only a policy-valid matching HTTPS origin', async () => {
    const repo = join(FAKE_GIT_DIR, 'origin-valid');
    mkdirSync(repo, { recursive: true });
    await withEnv({ PATH: fakePath() }, async () => {
      expect(validateOriginRemote(repo, 'https://github.com/example/repo'))
        .toBe('https://github.com/example/repo');
    });
    rmSync(repo, { recursive: true, force: true });
  });

  test('rejects repo-local URL rewrites and proxies before a network operation', () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-git-rewrite-'));
    try {
      execFileSync('git', ['init', '-q', repo]);
      execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo']);
      execFileSync('git', ['-C', repo, 'config', 'url.https://127.0.0.1/.insteadOf', 'https://github.com/']);
      expect(() => validateOriginRemote(repo, undefined, {
        resolveAddresses: () => ['93.184.216.34'],
      })).toThrow(/unsafe repo-local executable\/network/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('rejects a repo-local curloptResolve private-address override', () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-git-curl-resolve-'));
    try {
      execFileSync('git', ['init', '-q', repo]);
      execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo']);
      execFileSync('git', [
        '-C', repo, 'config',
        'http.curloptResolve',
        'github.com:443:169.254.169.254',
      ]);
      expect(() => validateOriginRemote(repo, undefined, {
        resolveAddresses: approveGitAddress,
      })).toThrow(/unsafe repo-local executable\/network/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('rejects shell credential helpers before any network operation', () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-git-helper-'));
    const sentinel = join(repo, 'credential-helper-ran');
    try {
      execFileSync('git', ['init', '-q', repo]);
      execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo']);
      execFileSync('git', ['-C', repo, 'config', 'credential.https://github.com.helper', `!touch '${sentinel}'`]);
      expect(() => validateOriginRemote(repo, undefined, {
        resolveAddresses: approveGitAddress,
      })).toThrow(/shell credential helper/);
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('rejects repo-local TLS/header/cookie and promisor lazy-fetch config', () => {
    const unsafe: Array<[string, string]> = [
      ['http.extraHeader', 'Authorization: injected'],
      ['http.cookieFile', '/tmp/cookies'],
      ['http.sslCAInfo', '/tmp/attacker-ca.pem'],
      ['http.sslVersion', 'sslv3'],
      ['remote.origin.promisor', 'true'],
      ['remote.origin.partialCloneFilter', 'blob:none'],
      ['core.hooksPath', '/tmp/attacker-hooks'],
      ['core.fsmonitor', '!touch /tmp/fsmonitor-ran'],
      ['filter.evil.process', 'touch /tmp/filter-ran'],
      ['merge.evil.driver', 'touch /tmp/merge-ran'],
      ['diff.evil.command', 'touch /tmp/diff-ran'],
      ['commit.gpgSign', 'true'],
      ['gpg.program', '/tmp/attacker-gpg'],
      ['gpg.ssh.program', '/tmp/attacker-ssh-signer'],
    ];
    for (const [key, value] of unsafe) {
      const repo = mkdtempSync(join(tmpdir(), 'gbrain-git-config-'));
      try {
        execFileSync('git', ['init', '-q', repo]);
        execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo']);
        execFileSync('git', ['-C', repo, 'config', key, value]);
        expect(() => validateOriginRemote(repo, undefined, {
          resolveAddresses: approveGitAddress,
        })).toThrow(/unsafe repo-local executable\/network config/);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  });

  test('push validates the push URL, not only the fetch URL', async () => {
    const repo = join(FAKE_GIT_DIR, 'push-url-policy');
    mkdirSync(repo, { recursive: true });
    await withEnv({ PATH: fakePath() }, async () => {
      const result = pushProbe(repo, 'main', { resolveAddresses: approveGitAddress });
      expect(result.ok).toBe(true);
    });
    const getUrl = readArgvLog().find(call => call.includes('get-url'))!;
    expect(getUrl).toContain('--push');
    const push = readArgvLog().find(call => call.includes('HEAD:main'))!;
    expect(push).toContain('https://github.com/example/repo');
    expect(push).not.toContain('origin');
    expectAddressBound(push, 'github.com');
    rmSync(repo, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// pullRepo — fake-git harness
// ---------------------------------------------------------------------------

describe('pullRepo', () => {
  test('happy path: fetches the validated URL then fast-forwards locally', async () => {
    const repo = join(FAKE_GIT_DIR, 'pull-target');
    mkdirSync(repo, { recursive: true });
    await withEnv({ PATH: fakePath() }, async () => {
      pullRepo(repo, { resolveAddresses: approveGitAddress });
    });
    const calls = readArgvLog();
    expect(calls.some(call => call.includes('get-url'))).toBe(true);
    const fetch = calls.find(call => call.includes('fetch'))!;
    expect(fetch.slice(0, 2)).toEqual(['-C', repo]);
    expect(fetch.slice(2, 2 + GIT_EXECUTION_FENCE_FLAGS.length)).toEqual([...GIT_EXECUTION_FENCE_FLAGS]);
    const ssrfStart = 2 + GIT_EXECUTION_FENCE_FLAGS.length;
    expect(fetch.slice(ssrfStart, ssrfStart + GIT_SSRF_FLAGS.length)).toEqual([...GIT_SSRF_FLAGS]);
    expect(fetch).toContain('https://github.com/example/repo');
    expect(fetch).toContain('main:refs/remotes/origin/main');
    expectAddressBound(fetch, 'github.com');
    // v0.34 fix wave: subcommand flag position assertion.
    const fetchIdx = fetch.indexOf('fetch');
    expect(fetchIdx).toBeGreaterThan(-1);
    for (const subFlag of GIT_SSRF_SUBCOMMAND_FLAGS) {
      const flagIdx = fetch.indexOf(subFlag);
      expect(flagIdx).toBeGreaterThan(fetchIdx);
    }
    const merge = calls.find(call => call.includes('merge'))!;
    expect(merge).toContain('--ff-only');
    expect(merge).toContain('refs/remotes/origin/main');
    expect(merge).not.toContain('https://github.com/example/repo');
    rmSync(repo, { recursive: true, force: true });
  });

  test('throws GitOperationError when git exits non-zero', async () => {
    const repo = join(FAKE_GIT_DIR, 'pull-fails');
    mkdirSync(repo, { recursive: true });
    setMode('fail');
    await withEnv({ PATH: fakePath() }, async () => {
      expect(() => pullRepo(repo)).toThrow(GitOperationError);
    });
    rmSync(repo, { recursive: true, force: true });
  });

  test('refuses configured origin drift before invoking fetch or merge', async () => {
    const repo = join(FAKE_GIT_DIR, 'pull-drift');
    mkdirSync(repo, { recursive: true });
    setMode('url-drift');
    await withEnv({ PATH: fakePath() }, async () => {
      expect(() => pullRepo(repo, {
        expectedRemoteUrl: 'https://github.com/expected/url',
      })).toThrow(/differs from the configured source URL/);
    });
    expect(readArgvLog().some(call => call.includes('fetch') || call.includes('merge'))).toBe(false);
    rmSync(repo, { recursive: true, force: true });
  });
});

describe('durability network paths', () => {
  test('divergence-safe pull binds its fetch to the approved address', async () => {
    const repo = join(FAKE_GIT_DIR, 'durable-pull-target');
    mkdirSync(repo, { recursive: true });
    await withEnv({ PATH: fakePath() }, async () => {
      expect(divergenceSafePull(repo, 'main', {
        resolveAddresses: approveGitAddress,
      }).status).toBe('up_to_date');
    });
    const fetch = readArgvLog().find(call => call.includes('fetch'))!;
    expectAddressBound(fetch, 'github.com');
    expect(fetch).toContain('https://github.com/example/repo');
    const rebase = readArgvLog().find(call => call.includes('rebase') && !call.includes('--abort'))!;
    expect(rebase.slice(2, 2 + GIT_EXECUTION_FENCE_FLAGS.length))
      .toEqual([...GIT_EXECUTION_FENCE_FLAGS]);
    expect(rebase).toContain('core.hooksPath=/dev/null');
    expect(rebase).toContain('refs/remotes/origin/main');
    rmSync(repo, { recursive: true, force: true });
  });

  test('real push binds its destination to the approved address', async () => {
    const repo = join(FAKE_GIT_DIR, 'push-branch-target');
    mkdirSync(repo, { recursive: true });
    await withEnv({ PATH: fakePath() }, async () => {
      pushBranch(repo, 'main', { resolveAddresses: approveGitAddress });
    });
    const push = readArgvLog().find(call =>
      call.includes('push') && call.includes('HEAD:refs/heads/main'))!;
    expectAddressBound(push, 'github.com');
    expect(push).toContain('https://github.com/example/repo');
    expect(push).toContain('core.hooksPath=/dev/null');
    expect(push).toContain('credential.helper=');
    expect(push).toContain('credential.useHttpPath=true');
    rmSync(repo, { recursive: true, force: true });
  });

});

// ---------------------------------------------------------------------------
// validateRepoState — 6-state decision tree
// ---------------------------------------------------------------------------

describe('validateRepoState', () => {
  const fixtureDir = join(FAKE_GIT_DIR, 'state-fixtures');

  beforeEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
    mkdirSync(fixtureDir, { recursive: true });
  });

  test("returns 'missing' for nonexistent path", () => {
    expect(validateRepoState(join(fixtureDir, 'nope'))).toBe('missing');
  });

  test("returns 'not-a-dir' when path is a file", () => {
    const p = join(fixtureDir, 'a-file');
    writeFileSync(p, 'hi');
    expect(validateRepoState(p)).toBe('not-a-dir');
  });

  test("returns 'no-git' for directory without .git/", () => {
    const p = join(fixtureDir, 'no-git-dir');
    mkdirSync(p, { recursive: true });
    expect(validateRepoState(p)).toBe('no-git');
  });

  test("returns 'corrupted' when git remote get-url fails", async () => {
    const p = join(fixtureDir, 'corrupted-repo');
    mkdirSync(join(p, '.git'), { recursive: true });
    setMode('fail');
    await withEnv({ PATH: fakePath() }, async () => {
      expect(validateRepoState(p)).toBe('corrupted');
    });
  });

  test("returns 'url-drift' when remote differs from expected", async () => {
    const p = join(fixtureDir, 'drift-repo');
    mkdirSync(join(p, '.git'), { recursive: true });
    setMode('url-drift');
    await withEnv({ PATH: fakePath() }, async () => {
      expect(validateRepoState(p, 'https://github.com/expected/url')).toBe('url-drift');
    });
  });

  test("returns 'healthy' when remote matches expected", async () => {
    const p = join(fixtureDir, 'healthy-repo');
    mkdirSync(join(p, '.git'), { recursive: true });
    setMode('url-match');
    await withEnv({ PATH: fakePath() }, async () => {
      expect(validateRepoState(p, 'https://github.com/expected/url')).toBe('healthy');
    });
  });

  test("returns 'healthy' when no expected URL provided (just probe)", async () => {
    const p = join(fixtureDir, 'healthy-no-expect');
    mkdirSync(join(p, '.git'), { recursive: true });
    setMode('ok');
    await withEnv({ PATH: fakePath() }, async () => {
      expect(validateRepoState(p)).toBe('healthy');
    });
  });
});

describe('local Git environment boundary', () => {
  test('working-tree probe ignores inherited repository/config poisoning', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-git-env-'));
    try {
      execFileSync('git', ['init', '-q', repo]);
      await withEnv({
        GIT_DIR: '/dev/null',
        GIT_WORK_TREE: '/dev/null',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.repositoryformatversion',
        GIT_CONFIG_VALUE_0: '999',
      }, async () => {
        expect(isWorkingTreeDirty(repo)).toBe(false);
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
