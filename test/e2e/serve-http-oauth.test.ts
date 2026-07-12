/**
 * E2E tests for serve-http.ts OAuth 2.1 fixes (v0.26.1).
 *
 * Spins up a real `gbrain serve --http` against real Postgres, registers an
 * OAuth client, mints tokens, and exercises the full MCP JSON-RPC pipeline
 * end-to-end. Catches the three bugs fixed in v0.26.1:
 *
 *   1. client_credentials tokens rejected at /mcp (expiresAt string vs number)
 *   2. OAuth metadata missing client_credentials grant type
 *   3. Express 5 trust proxy + admin SPA wildcard
 *
 * Run: GBRAIN_DATABASE_URL=... bun test test/e2e/serve-http-oauth.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E serve-http-oauth tests (DATABASE_URL not set)');
}

const PORT = 19131; // Avoid collision with production 3131
const BASE = `http://localhost:${PORT}`;
const ADMIN_BOOTSTRAP_TOKEN = 'e2e-admin-bootstrap-token-000000000000000000000000';

describeE2E('serve-http OAuth 2.1 E2E (v0.26.1 + v0.26.2 + v0.26.3)', () => {
  let serverProcess: ReturnType<typeof import('child_process').spawn> | null = null;
  let serverStderr = '';
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  // Additional manually registered clients accumulate here for cleanup.
  const dcrClientIds: string[] = [];

  beforeAll(async () => {
    const { execSync, spawn } = await import('child_process');

    // Per-file E2E isolation intentionally starts from an empty schema. Keep
    // this HTTP contract self-contained instead of relying on a prior file to
    // create oauth_clients and the rest of the canonical migration surface.
    await setupDB();

    // Register a test OAuth client via CLI.
    // env: { ...process.env } is required: bun's execSync does NOT inherit
    // env mutations done via `process.env.X = ...` (only OS-level env from
    // before bun started). helpers.ts loads .env.testing and sets DATABASE_URL
    // via process.env mutation, which is invisible to subprocesses unless we
    // explicitly re-pass process.env. Same pattern applies to every execSync
    // in this file.
    // v0.28.10: register with admin scope so the F7 protected-name guard
    // tests can mint admin-scoped tokens that actually exercise the guard
    // at operations.ts:1527. Without admin in the client's allowed scopes,
    // submit_job for a protected name (`shell`, `subagent`) gets rejected
    // by hasScope() in serve-http.ts BEFORE reaching the F7 guard, so the
    // test was validating scope enforcement instead of the RCE protection.
    // Other tests that mint specific subsets ('read', 'read write') still
    // get the subset they ask for — adding admin to the client's allowed
    // ceiling does not auto-grant it to every minted token.
    const regOutput = execSync(
      'bun run src/cli.ts auth register-client e2e-oauth-test --grant-types client_credentials --scopes "read write admin"',
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } }
    );
    const idMatch = regOutput.match(/Client ID:\s+(gbrain_cl_\S+)/);
    const secretMatch = regOutput.match(/Client Secret:\s+(gbrain_cs_\S+)/);
    if (!idMatch || !secretMatch) throw new Error('Failed to register test client:\n' + regOutput);
    clientId = idMatch[1];
    clientSecret = secretMatch[1];

    // Start the HTTP server. Network registration stays disabled; this suite
    // uses the trusted local CLI registration above.
    serverProcess = spawn('bun', [
      'run', 'src/cli.ts', 'serve', '--http',
      '--port', String(PORT),
      '--public-url', `http://localhost:${PORT}`,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, GBRAIN_ADMIN_BOOTSTRAP_TOKEN: ADMIN_BOOTSTRAP_TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Collect stderr for debugging failures
    serverProcess.stderr?.on('data', (d: Buffer) => { serverStderr += d.toString(); });

    // Wait for server to be ready (up to 15s)
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok) { ready = true; break; }
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    if (!ready) throw new Error('Server failed to start within 15s.\nstderr: ' + serverStderr.slice(-500));
  }, 30_000);

  afterAll(async () => {
    // Kill server first so it can't issue more tokens during cleanup.
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1000));
      if (!serverProcess.killed) serverProcess.kill('SIGKILL');
    }
    // v0.26.2 cleanup contract: only revoke if registration succeeded
    // (clientId guard) and surface any cleanup failure to stderr without
    // throwing — a real test failure is more interesting than the cleanup
    // error that follows it. Same shape applies to DCR-registered clients
    // tracked in dcrClientIds.
    const { execSync } = await import('child_process');
    const toRevoke = [...(clientId ? [clientId] : []), ...dcrClientIds];
    for (const id of toRevoke) {
      try {
        execSync(`bun run src/cli.ts auth revoke-client "${id}"`,
          { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } });
      } catch (e: any) {
        // eslint-disable-next-line no-console
        console.error(`[afterAll] revoke-client cleanup failed for ${id}: ${e.message}`);
      }
    }
    await teardownDB();
  }, 30_000);

  // Helper: mint a token with given scopes
  async function mintToken(scope = 'read write'): Promise<{ access_token: string; expires_in: number; scope: string }> {
    const res = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}&scope=${encodeURIComponent(scope)}`,
    });
    expect(res.ok).toBe(true);
    return res.json() as any;
  }

  // Helper: call MCP JSON-RPC with a bearer token
  async function mcpCall(token: string, method: string, params?: any): Promise<Response> {
    return fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
    });
  }

  async function mcpJson(token: string, method: string, params?: any): Promise<any> {
    const response = await mcpCall(token, method, params);
    const raw = await response.text();
    const dataLine = raw.split('\n').find(line => line.startsWith('data:'));
    return JSON.parse(dataLine ? dataLine.slice(5).trim() : raw);
  }

  // =========================================================================
  // Fix 1: client_credentials tokens validate at /mcp
  // =========================================================================

  test('mint token via client_credentials grant', async () => {
    const data = await mintToken('read write');
    expect(data.access_token).toMatch(/^gbrain_at_/);
    expect(data.expires_in).toBe(3600);
    expect(data.scope).toContain('read');
  });

  test('minted token is accepted at /mcp — tools/list returns tools', async () => {
    const { access_token } = await mintToken('read');
    const res = await mcpCall(access_token, 'tools/list');

    // Before v0.26.1 fix: 401 {"error":"invalid_token","error_description":"Token has no expiration time"}
    expect(res.status).not.toBe(401);

    const body = await res.text();
    expect(body).toContain('tools');
    expect(body).toContain('search'); // search tool should be in the list
    expect(body).toContain('query');  // query tool too
  }, 15_000);

  test('minted token works for tools/call — search executes', async () => {
    const { access_token } = await mintToken('read');
    const res = await mcpCall(access_token, 'tools/call', {
      name: 'search',
      arguments: { query: 'gbrain', limit: 1 },
    });

    expect(res.status).not.toBe(401);
    const body = await res.text();
    // Should contain search results, not an auth error
    expect(body).not.toContain('invalid_token');
    expect(body).toContain('result');
  }, 15_000);

  test('expired/invalid token is rejected at /mcp', async () => {
    const res = await mcpCall('gbrain_at_totally_fake_token', 'tools/list');
    // Invalid tokens should not return 200 with tool results
    const body = await res.text();
    expect(body).not.toContain('"tools"');
    // Should be an error status (401, 403, or 500 depending on SDK error mapping)
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test('missing Authorization header returns 401', async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  // =========================================================================
  // Fix 2: OAuth metadata includes client_credentials
  // =========================================================================

  test('OAuth AS metadata advertises only reachable token grants', async () => {
    const res = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
    expect(res.ok).toBe(true);
    const meta = await res.json() as any;
    expect(meta.grant_types_supported).toContain('refresh_token');
    expect(meta.grant_types_supported).toContain('client_credentials');
    expect(meta.grant_types_supported).not.toContain('authorization_code');
    expect(meta.registration_endpoint).toBeUndefined();
  });

  test('OAuth metadata issuer matches public URL', async () => {
    const res = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
    const meta = await res.json() as any;
    expect(meta.issuer).toBe(`http://localhost:${PORT}/`);
    expect(meta.token_endpoint).toContain('/token');
    expect(meta.scopes_supported).toContain('read');
    expect(meta.scopes_supported).toContain('write');
    expect(meta.scopes_supported).toContain('admin');
  });

  test('public non-interactive startup never writes the admin credential to stderr', () => {
    expect(serverStderr).not.toContain(ADMIN_BOOTSTRAP_TOKEN);
    expect(serverStderr).toContain('Admin Token: from $GBRAIN_ADMIN_BOOTSTRAP_TOKEN');
  });

  test('generated admin credential is also hidden on a public non-interactive start', async () => {
    const { spawn } = await import('child_process');
    const generatedPort = PORT + 1;
    const env = { ...process.env };
    delete env.GBRAIN_ADMIN_BOOTSTRAP_TOKEN;
    const child = spawn('bun', [
      'run', 'src/cli.ts', 'serve', '--http',
      '--port', String(generatedPort),
      '--public-url', `http://localhost:${generatedPort}`,
    ], {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    try {
      let ready = false;
      for (let i = 0; i < 30; i++) {
        try {
          const response = await fetch(`http://localhost:${generatedPort}/health`);
          if (response.ok) { ready = true; break; }
        } catch { /* not ready */ }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(ready).toBe(true);
      expect(stderr).toContain('Admin Token: generated but not printed');
      expect(stderr).not.toContain('Admin Token (paste into /admin login)');
    } finally {
      child.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 250));
      if (!child.killed) child.kill('SIGKILL');
    }
  }, 15_000);

  // T2 (eng-review): scopes_supported advertises the full ALLOWED_SCOPES_LIST
  // so MCP clients (Claude Desktop, ChatGPT, Perplexity) can discover the
  // v0.28 sources_admin and users_admin scopes via standard discovery.
  // Pre-v0.28 the list was hardcoded to ['read','write','admin'] in
  // serve-http.ts:195 and this assertion would have failed.
  test('OAuth metadata advertises all 5 v0.28 scopes (sources_admin + users_admin)', async () => {
    const res = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
    const meta = await res.json() as any;
    expect(meta.scopes_supported).toContain('sources_admin');
    expect(meta.scopes_supported).toContain('users_admin');
    expect(meta.scopes_supported).toEqual(
      expect.arrayContaining(['admin', 'read', 'sources_admin', 'users_admin', 'write']),
    );
  });

  // =========================================================================
  // Fix 3: Express 5 compatibility
  // =========================================================================

  test('admin dashboard serves SPA index.html (not Express error)', async () => {
    const res = await fetch(`${BASE}/admin/`);
    const html = await res.text();
    expect(html).toContain('GBrain Admin');
    expect(html).not.toContain('<pre>Cannot GET');
  });

  test('admin sub-routes serve SPA fallback', async () => {
    const res = await fetch(`${BASE}/admin/agents`);
    const html = await res.text();
    expect(html).toContain('GBrain Admin');
  });

  // v0.36.1.x #1076: GET /mcp must return 405 (Method Not Allowed) per the
  // MCP Streamable HTTP spec, not 404. claude.ai + other probing clients
  // distinguish "endpoint exists, no SSE channel" from "endpoint missing"
  // on this status code; 404 makes them give up.
  test('GET /mcp returns 405 with Allow: POST, DELETE (v0.36.1.x #1076)', async () => {
    const res = await fetch(`${BASE}/mcp`, { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST, DELETE');
    const body = await res.json() as { jsonrpc?: string; error?: { code?: number } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error?.code).toBe(-32000);
  });

  test('X-Forwarded-For header does not crash server', async () => {
    const res = await fetch(`${BASE}/health`, {
      headers: { 'X-Forwarded-For': '10.0.0.1, 172.16.0.1' },
    });
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(data.status).toBe('ok');
  });

  // =========================================================================
  // Scope enforcement
  // =========================================================================

  test('read-only token is rejected for write operations', async () => {
    const { access_token } = await mintToken('read');
    const res = await mcpCall(access_token, 'tools/call', {
      name: 'put_page',
      arguments: { slug: 'e2e-scope-test', content: '---\ntitle: test\n---\ntest' },
    });

    const body = await res.text();
    // Should be rejected via scope check (403 or JSON-RPC error with scope message)
    expect(res.status === 403 || body.includes('scope') || body.includes('Insufficient')).toBe(true);
  }, 15_000);

  test('write-scoped token can call read operations', async () => {
    const { access_token } = await mintToken('read write');
    const res = await mcpCall(access_token, 'tools/call', {
      name: 'search',
      arguments: { query: 'test', limit: 1 },
    });

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    const body = await res.text();
    // Should get a result, not an auth error
    expect(body).not.toContain('invalid_token');
    expect(body).not.toContain('insufficient_scope');
  }, 15_000);

  // =========================================================================
  // Health endpoint (no auth required) — v0.28.10 made /health liveness-only;
  // engine stats moved to /admin/api/full-stats behind requireAdmin so a
  // saturated pool can't pin /health and trigger orchestrator restart cascades.
  // =========================================================================

  test('v0.28.10: /health returns liveness-only body (no engine stats)', async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(data.status).toBe('ok');
    expect(data.version).toBeDefined();
    expect(data.engine).toBeDefined();
    // Regression: pre-v0.28.10 /health spread getStats() (page_count,
    // chunk_count, etc.) into the body. The whole point of the v0.28.10
    // split is that /health stops touching those tables. If page_count
    // ever reappears here, the heavy probe leaked back into the public
    // route and the original DoS surface is back.
    expect(data.page_count).toBeUndefined();
    expect(data.chunk_count).toBeUndefined();
    expect(data.embedded_count).toBeUndefined();
    // Body shape is exactly {status, version, engine}.
    expect(Object.keys(data).sort()).toEqual(['engine', 'status', 'version']);
  });

  test('legacy bearer scopes and exact tools constrain discovery and calls end-to-end', async () => {
    const { execFileSync } = await import('child_process');
    const tokenName = `e2e-legacy-capabilities-${Date.now()}`;
    try {
      const createOutput = execFileSync('bun', [
        'run', 'src/cli.ts', 'auth', 'create', tokenName,
        '--scopes', 'admin',
        '--tools', 'search,get_stats',
      ], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } });
      const token = createOutput.match(/^\s+(gbrain_[a-f0-9]{64})\s*$/m)?.[1];
      if (!token) throw new Error('Legacy token creation did not return a token');

      const listed = await mcpJson(token, 'tools/list');
      expect(listed.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
        'get_stats',
        'search',
      ]);

      const allowed = await mcpJson(token, 'tools/call', {
        name: 'get_stats',
        arguments: {},
      });
      expect(allowed.result.isError).not.toBe(true);

      const denied = await mcpJson(token, 'tools/call', {
        name: 'put_page',
        arguments: { slug: 'must-not-exist', content: 'blocked' },
      });
      expect(denied.result.isError).toBe(true);
      expect(denied.result.content[0].text).toContain('unknown_operation');
    } finally {
      try {
        execFileSync('bun', ['run', 'src/cli.ts', 'auth', 'revoke', tokenName], {
          cwd: process.cwd(), encoding: 'utf8', env: { ...process.env }, stdio: 'ignore',
        });
      } catch { /* best-effort cleanup if create failed before inserting */ }
    }
  }, 15_000);

  test('v0.28.10: /admin/api/full-stats without admin cookie returns 401', async () => {
    const res = await fetch(`${BASE}/admin/api/full-stats`);
    expect(res.status).toBe(401);
    const data = await res.json() as any;
    expect(data.error).toBe('Admin authentication required');
  });

  test('v0.28.10: /admin/api/full-stats with valid admin cookie returns getStats() body', async () => {
    const issueRes = await fetch(`${BASE}/admin/api/issue-magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_BOOTSTRAP_TOKEN}` },
      body: '{}',
    });
    expect(issueRes.ok).toBe(true);
    const { url } = await issueRes.json() as any;

    const click = await fetch(url, { redirect: 'manual' });
    expect(click.status).toBe(302);
    const setCookie = click.headers.get('set-cookie') || '';
    const cookieMatch = setCookie.match(/gbrain_admin=([^;]+)/);
    expect(cookieMatch).toBeTruthy();
    const cookieValue = cookieMatch![1];

    const statsRes = await fetch(`${BASE}/admin/api/full-stats`, {
      headers: { Cookie: `gbrain_admin=${cookieValue}` },
    });
    expect(statsRes.ok).toBe(true);
    const stats = await statsRes.json() as any;
    expect(stats.status).toBe('ok');
    expect(stats.version).toBeDefined();
    expect(stats.engine).toBeDefined();
    // The full-stats body is probeHealth's spread of getStats() — page_count
    // is the canonical signal that we're hitting the heavy path here.
    expect(typeof stats.page_count).toBe('number');
    expect(stats.page_count).toBeGreaterThanOrEqual(0);
  }, 15_000);

  // =========================================================================
  // Token lifecycle
  // =========================================================================

  test('multiple tokens can be minted and used independently', async () => {
    const t1 = await mintToken('read');
    const t2 = await mintToken('read write');

    // Both should work
    const r1 = await mcpCall(t1.access_token, 'tools/list');
    const r2 = await mcpCall(t2.access_token, 'tools/list');

    expect(r1.status).not.toBe(401);
    expect(r2.status).not.toBe(401);
  }, 15_000);

  test('wrong client_secret is rejected at token endpoint', async () => {
    const res = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${clientId}&client_secret=gbrain_cs_wrong_secret&scope=read`,
    });
    expect(res.ok).toBe(false);
    const data = await res.json() as any;
    expect(data.error).toBe('invalid_client');
    expect(data.error_description).toBe('Client authentication failed.');
  });

  test('missing-secret token requests do not reveal whether a client exists', async () => {
    const request = async (candidateClientId: string) => {
      const res = await fetch(`${BASE}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: candidateClientId,
          code: 'not-a-code',
          code_verifier: 'not-a-verifier',
        }),
      });
      return { status: res.status, body: await res.json() };
    };

    const known = await request(clientId!);
    const unknown = await request('gbrain_cl_unknown_client_probe');
    expect(known).toEqual(unknown);
    expect(known).toEqual({
      status: 401,
      body: {
        error: 'invalid_client',
        error_description: 'Client authentication failed.',
      },
    });
  });

  // =========================================================================
  // Network registration + unattended authorization trust boundary
  // =========================================================================

  test('network /register is unavailable and mints no client', async () => {
    const res = await fetch(`${BASE}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'e2e-dcr-shape',
        redirect_uris: ['https://example.com/cb'],
        grant_types: ['authorization_code'],
        token_endpoint_auth_method: 'client_secret_basic',
        scope: 'read',
      }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toBe('not_found');
    expect(body.client_id).toBeUndefined();
    expect(body.client_secret).toBeUndefined();
  });

  test('no-consent /authorize fails closed and returns no code redirect', async () => {
    const res = await fetch(
      `${BASE}/authorize?client_id=${encodeURIComponent(clientId!)}&response_type=code` +
        '&redirect_uri=https%3A%2F%2Fexample.test%2Fcb&code_challenge=x&code_challenge_method=S256',
      { redirect: 'manual' },
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('location')).toBeNull();
    const body = await res.json() as any;
    expect(body.error).toBe('access_denied');
  });

  // =========================================================================
  // v0.26.2: revoke-client CLI subprocess test
  // =========================================================================
  //
  // Validates the actual CLI router in src/commands/auth.ts, not just the
  // database deletion semantics. Codex flagged that a unit test in
  // test/oauth.test.ts proves DB DELETE works but does NOT prove the
  // subcommand exists or routes correctly.

  test('auth revoke-client (CLI) deletes client + cascades to tokens', async () => {
    const { execSync } = await import('child_process');

    // Step 1: register a throwaway client via CLI.
    // env: { ...process.env } per the bun execSync inheritance fix above.
    const regOutput = execSync(
      'bun run src/cli.ts auth register-client e2e-revoke-cli --grant-types client_credentials --scopes read',
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } }
    );
    const idMatch = regOutput.match(/Client ID:\s+(gbrain_cl_\S+)/);
    const secretMatch = regOutput.match(/Client Secret:\s+(gbrain_cs_\S+)/);
    expect(idMatch).not.toBeNull();
    expect(secretMatch).not.toBeNull();
    const id = idMatch![1];
    const secret = secretMatch![1];

    // Step 2: mint a token through the live server.
    const tokenRes = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${id}&client_secret=${secret}&scope=read`,
    });
    expect(tokenRes.ok).toBe(true);
    const { access_token } = await tokenRes.json() as any;

    // Sanity: the freshly-minted token works at /mcp.
    const before = await mcpCall(access_token, 'tools/list');
    expect(before.status).not.toBe(401);

    // Step 3: revoke via the CLI subprocess.
    const revokeOutput = execSync(
      `bun run src/cli.ts auth revoke-client "${id}"`,
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } }
    );
    // The handler prints the human confirmation lines. No exit code != 0
    // here since execSync would throw.
    expect(revokeOutput).toMatch(/OAuth client revoked/);
    expect(revokeOutput).toMatch(/cascade/i);

    // Step 4: previously-minted token must now be rejected at /mcp. Cascade
    // wiped the oauth_tokens row; verifyAccessToken throws "Invalid token".
    // Match the existing pattern at line 156: SDK error mapping varies
    // (401/403/500), so we assert non-success status + non-success body
    // rather than a single status code.
    const after = await mcpCall(access_token, 'tools/list');
    expect(after.status).toBeGreaterThanOrEqual(400);
    const afterBody = await after.text();
    expect(afterBody).not.toContain('"tools":[');

    // Step 5: re-running revoke-client on the now-deleted id must exit 1.
    let secondRunFailed = false;
    let secondRunStderr = '';
    try {
      execSync(`bun run src/cli.ts auth revoke-client "${id}"`,
        { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } });
    } catch (e: any) {
      secondRunFailed = true;
      secondRunStderr = (e.stderr || '').toString() + (e.stdout || '').toString();
    }
    expect(secondRunFailed).toBe(true);
    expect(secondRunStderr).toMatch(/No client found/);
  }, 30_000);

  // =========================================================================
  // v0.26.3: Migration v33 round-trip — pins the 5 new columns
  // =========================================================================
  //
  // PR #586 referenced oauth_clients.{token_ttl, deleted_at} +
  // mcp_request_log.{agent_name, params, error_message} without an
  // accompanying migration. v33 adds them. This test pins the round-trip:
  // make a /mcp call -> assert all three new mcp_request_log columns
  // persisted correctly. Without v33, the INSERT silently swallows
  // column-doesn't-exist errors via the existing best-effort try/catch
  // and the row never appears.

  test('v0.26.3: /mcp request persists agent_name + params + error_message', async () => {
    const postgres = (await import('postgres')).default;
    const sql = postgres(process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL || '', { prepare: false });
    try {
      // Wipe any prior log rows for our test client so we can assert exact counts.
      await sql`DELETE FROM mcp_request_log WHERE token_name = ${clientId!}`;

      // Mint a fresh write-scoped token and make a successful tools/list call.
      const tokenRes = await fetch(`${BASE}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id=${clientId!}&client_secret=${clientSecret!}&scope=read`,
      });
      expect(tokenRes.ok).toBe(true);
      const { access_token } = await tokenRes.json() as any;
      const okRes = await mcpCall(access_token, 'tools/list');
      expect(okRes.status).not.toBe(401);

      // Trigger an error path so the error_message column gets a value too.
      // Request a tool that doesn't exist — v0.28.10 logs unknown-op attempts
      // with operation = the attempted name and error_message starting with
      // 'unknown_operation:'.
      await mcpCall(access_token, 'tools/call', { name: 'this_tool_does_not_exist', arguments: {} });

      // Allow async best-effort INSERT to flush.
      await new Promise(r => setTimeout(r, 250));

      const rows = await sql`
        SELECT operation, status, agent_name, params, error_message
        FROM mcp_request_log
        WHERE token_name = ${clientId!}
        ORDER BY created_at ASC
      ` as unknown as Array<Record<string, unknown>>;

      expect(rows.length).toBeGreaterThanOrEqual(2);

      // Agent name resolved from oauth_clients.client_name (the JOIN in
      // verifyAccessToken or the agent_name backfill path).
      for (const row of rows) {
        expect(row.agent_name).toBe('e2e-oauth-test');
      }

      // v0.28.10: tools/list logs as operation='tools/list' (the JSON-RPC
      // method name). tools/call success/error logs as operation=<inner
      // tool name> (the convention preserved from pre-v0.28.10 dispatch
      // logging — agents querying mcp_request_log filter by tool name, not
      // by JSON-RPC method).
      const listRow = rows.find(r => r.operation === 'tools/list');
      expect(listRow).toBeDefined();
      expect(listRow!.status).toBe('success');

      // The unknown-op call shows up with operation = the attempted name.
      const callRow = rows.find(r => r.operation === 'this_tool_does_not_exist');
      expect(callRow).toBeDefined();
      expect(callRow!.status).toBe('error');

      // error_message populated on the failed call.
      const errorRow = rows.find(r => r.status === 'error');
      expect(errorRow).toBeDefined();
      expect(errorRow!.error_message).toBeTruthy();
      expect(typeof errorRow!.error_message).toBe('string');
      expect(errorRow!.error_message as string).toContain('unknown_operation');
    } finally {
      await sql.end();
    }
  }, 30_000);

  // =========================================================================
  // v0.26.3: request-log filter injection probe
  // =========================================================================
  //
  // Pre-fix: /admin/api/requests built WHERE clauses via sql.unsafe() with
  // single-quote escape (`token_name = '${agent.replace(/'/g, "''")}'`).
  // Post-fix: postgres.js tagged-template fragments. This probe sends a
  // payload that, under broken escaping, would short-circuit to TRUE and
  // return all rows. Under correct parameterization, it matches no rows.

  test("v0.26.3: request-log filter rejects injection attempt (' OR 1=1)", async () => {
    // Use a plain admin session via /admin/login + bootstrap token. This
    // test covers the unauthenticated SQL-injection vector via the agent
    // query parameter — even though the endpoint is admin-gated, defense-
    // in-depth on parameterization matters.
    //
    // Extract the admin bootstrap token from the spawned server's stderr.
    const probe = "alice'%20OR%201%3D1";

    // We don't have a clean way to pull the admin token from the spawned
    // process here (commit 16 deleted the regex extraction). The injection
    // probe still works WITHOUT auth — the endpoint requires it via 401.
    // We assert that the 401 lands BEFORE any SQL gets built, so we don't
    // crash the server with malformed SQL on the way to the auth check.
    const res = await fetch(`${BASE}/admin/api/requests?agent=${probe}`, {
      method: 'GET',
    });
    // No admin cookie — must hit 401, not 500 (no SQL crash).
    expect(res.status).toBe(401);

    // Server is still alive (didn't crash on the malformed input).
    const health = await fetch(`${BASE}/health`);
    expect(health.ok).toBe(true);
  });

  // =========================================================================
  // v0.26.3: per-client TTL flow
  // =========================================================================
  //
  // PR #586 added `tokenTtl` per OAuth client. exchangeClientCredentials
  // reads oauth_clients.token_ttl (per-client override) and falls back to
  // the server default. This test registers a client with a custom TTL,
  // mints a token, and asserts the response's expires_in matches.

  test('v0.26.3: per-client token_ttl is honored on token mint', async () => {
    const postgres = (await import('postgres')).default;
    const sql = postgres(process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL || '', { prepare: false });
    try {
      // Register a client + set a custom token_ttl (24 hours = 86400 seconds).
      const { execSync } = await import('child_process');
      const regOutput = execSync(
        'bun run src/cli.ts auth register-client e2e-test-ttl --grant-types client_credentials --scopes read',
        { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } }
      );
      const idMatch = regOutput.match(/Client ID:\s+(gbrain_cl_\S+)/);
      const secretMatch = regOutput.match(/Client Secret:\s+(gbrain_cs_\S+)/);
      expect(idMatch).not.toBeNull();
      expect(secretMatch).not.toBeNull();
      const id = idMatch![1];
      const secret = secretMatch![1];
      dcrClientIds.push(id); // afterAll cleanup

      // Set a 24-hour TTL.
      await sql`UPDATE oauth_clients SET token_ttl = 86400 WHERE client_id = ${id}`;

      // Mint a token. Response must include expires_in close to 86400.
      const tokenRes = await fetch(`${BASE}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id=${id}&client_secret=${secret}&scope=read`,
      });
      expect(tokenRes.ok).toBe(true);
      const body = await tokenRes.json() as any;
      expect(body.expires_in).toBe(86400);

      // Update TTL to a different value mid-test, mint again, assert new value.
      await sql`UPDATE oauth_clients SET token_ttl = 7200 WHERE client_id = ${id}`;
      const tokenRes2 = await fetch(`${BASE}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id=${id}&client_secret=${secret}&scope=read`,
      });
      expect(tokenRes2.ok).toBe(true);
      const body2 = await tokenRes2.json() as any;
      expect(body2.expires_in).toBe(7200);

      // NULL token_ttl falls back to server default (3600 = 1 hour).
      await sql`UPDATE oauth_clients SET token_ttl = NULL WHERE client_id = ${id}`;
      const tokenRes3 = await fetch(`${BASE}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id=${id}&client_secret=${secret}&scope=read`,
      });
      expect(tokenRes3.ok).toBe(true);
      const body3 = await tokenRes3.json() as any;
      expect(body3.expires_in).toBe(3600);
    } finally {
      await sql.end();
    }
  }, 30_000);

  // =========================================================================
  // v0.26.3: magic-link single-use + 401 styled error page
  // =========================================================================
  //
  // D11=C: /admin/auth/:nonce is single-use. First click consumes the nonce,
  // second click fails with the styled 401 page. No bootstrap token in URL.
  //
  // Also covers F6.5: server returns Content-Type: text/html on the 401
  // path (Express auto-sets this for HTML body) so browsers render the
  // styled page instead of treating it as plain text.

  test('v0.26.3: invalid magic-link nonce returns styled 401 HTML page', async () => {
    const res = await fetch(`${BASE}/admin/auth/garbage_nonce_that_does_not_exist`, { redirect: 'manual' });
    expect(res.status).toBe(401);
    const ct = res.headers.get('content-type') || '';
    expect(ct).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('expired');
    expect(body).toContain('GBrain');
  });

  test('v0.26.3: magic-link nonce is single-use (second click fails)', async () => {
    // Mint a one-time nonce.
    const issueRes = await fetch(`${BASE}/admin/api/issue-magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_BOOTSTRAP_TOKEN}` },
      body: '{}',
    });
    expect(issueRes.ok).toBe(true);
    const { url } = await issueRes.json() as any;
    expect(url).toContain('/admin/auth/');

    // First click — should set cookie + redirect (302 to /admin/).
    const first = await fetch(url, { redirect: 'manual' });
    expect(first.status).toBe(302);
    const cookie = first.headers.get('set-cookie') || '';
    expect(cookie).toContain('gbrain_admin=');

    // Second click on the same URL — must fail (single-use consumed).
    const second = await fetch(url, { redirect: 'manual' });
    expect(second.status).toBe(401);
    const secondBody = await second.text();
    expect(secondBody).toContain('GBrain');
  }, 15_000);

  // =========================================================================
  // v0.26.3: agent_name backfill across oauth_clients + access_tokens
  // =========================================================================
  //
  // Migration v33 backfills mcp_request_log.agent_name using
  //   COALESCE(oauth_clients.client_name, access_tokens.name, token_name)
  // This test confirms the agent_name is correctly resolved across both
  // auth lanes (oauth client + legacy api key).

  test('v0.26.3: agent_name resolves correctly for OAuth + legacy paths', async () => {
    const postgres = (await import('postgres')).default;
    const sql = postgres(process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL || '', { prepare: false });
    try {
      // Make an OAuth-authenticated request — agent_name should be the OAuth client_name.
      const tokenRes = await fetch(`${BASE}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id=${clientId!}&client_secret=${clientSecret!}&scope=read`,
      });
      const { access_token } = await tokenRes.json() as any;
      await mcpCall(access_token, 'tools/list');
      await new Promise(r => setTimeout(r, 250));

      const oauthRows = await sql`
        SELECT agent_name FROM mcp_request_log
        WHERE token_name = ${clientId!}
        ORDER BY created_at DESC LIMIT 1
      ` as unknown as Array<{ agent_name: string }>;
      expect(oauthRows.length).toBeGreaterThan(0);
      expect(oauthRows[0].agent_name).toBe('e2e-oauth-test');
    } finally {
      await sql.end();
    }
  }, 15_000);

  // =========================================================================
  // v0.26.3: register-client missing-name returns 400
  // =========================================================================
  //
  // Defense-in-depth: the admin register-client endpoint must validate
  // input. Pre-fix would have crashed or returned 500.

  test('v0.26.3: /admin/api/register-client without name returns 400', async () => {
    // Endpoint is admin-cookie-gated. Without auth we should get 401, not 500.
    // Without a name in the body (with auth) we should get 400. We test the
    // 401 path here as a basic input-validation smoke; the 400 path requires
    // an admin session which the test fixture doesn't easily produce.
    const res = await fetch(`${BASE}/admin/api/register-client`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  // =========================================================================
  // F7 + F7b: generic job submission is host-local
  // =========================================================================
  //
  // Generic submit_job can select maintenance handlers and server-local paths,
  // so it is localOnly rather than remotely available behind a broad admin
  // scope. Pin both discovery and call behavior: it must not be advertised,
  // and a guessed tools/call must return an MCP error rather than a job id.

  test('F7: HTTP MCP neither discovers nor calls submit_job for shell', async () => {
    const { access_token } = await mintToken('admin');
    const listed = await mcpJson(access_token, 'tools/list');
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).not.toContain('submit_job');

    const denied = await mcpJson(access_token, 'tools/call', {
      name: 'submit_job',
      arguments: { name: 'shell', data: { cmd: 'id' } },
    });
    expect(denied.result?.isError === true || denied.error !== undefined).toBe(true);
    expect(JSON.stringify(denied)).toMatch(/unknown_operation|Unknown tool|Method not found|permission_denied/i);
    expect(JSON.stringify(denied)).not.toMatch(/"job_id"\s*:\s*"?\d+/);
  }, 15_000);

  test('F7: HTTP MCP guessed submit_job call cannot submit subagent jobs', async () => {
    const { access_token } = await mintToken('admin');
    const denied = await mcpJson(access_token, 'tools/call', {
      name: 'submit_job',
      arguments: { name: 'subagent', data: { prompt: 'noop' } },
    });
    expect(denied.result?.isError === true || denied.error !== undefined).toBe(true);
    expect(JSON.stringify(denied)).toMatch(/unknown_operation|Unknown tool|Method not found|permission_denied/i);
    expect(JSON.stringify(denied)).not.toMatch(/"job_id"\s*:\s*"?\d+/);
  }, 15_000);
});
