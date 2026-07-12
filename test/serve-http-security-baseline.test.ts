import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  HTTP_BODY_LIMITS,
  buildHttpSecurityHeaders,
  buildIngestBackpressureKey,
  classifyHttpError,
  authenticatedClientRateLimitKey,
  isAdminMutationOriginAllowed,
  isHttpOriginAllowed,
  oauthTokenErrorEnvelope,
  shouldPrintGeneratedBootstrapToken,
} from '../src/commands/serve-http.ts';

describe('serve-http Express security baseline', () => {
  test('emits the stable security-header set without application-level HSTS', () => {
    const headers = buildHttpSecurityHeaders();
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('no-referrer');
    expect(headers['Permissions-Policy']).toContain('camera=()');
    expect(headers['Content-Security-Policy']).toContain("default-src 'none'");
    expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(headers['Content-Security-Policy']).toContain("connect-src 'self'");
    expect(headers['Strict-Transport-Security']).toBeUndefined();
  });

  test('hard CORS gate allows non-browser, same-origin, canonical, and configured origins', () => {
    const allowed = new Set(['https://connector.example']);
    expect(isHttpOriginAllowed(undefined, undefined, 'https://brain.example', allowed)).toBe(true);
    expect(isHttpOriginAllowed('http://127.0.0.1:8787', 'http://127.0.0.1:8787', 'http://localhost:8787', null)).toBe(true);
    expect(isHttpOriginAllowed('https://brain.example', 'http://127.0.0.1:8787', 'https://brain.example', null)).toBe(true);
    expect(isHttpOriginAllowed('https://connector.example', undefined, 'https://brain.example', allowed)).toBe(true);
  });

  test('hard CORS gate rejects an unlisted browser origin before SDK middleware', () => {
    expect(isHttpOriginAllowed(
      'https://evil.example',
      'https://brain.example',
      'https://brain.example',
      new Set(['https://connector.example']),
    )).toBe(false);
  });

  test('admin mutation origin policy rejects cross-origin and sibling-site writes', () => {
    const base = {
      method: 'POST',
      requestOrigin: 'https://brain.example',
      canonicalOrigin: 'https://brain.example',
    };
    expect(isAdminMutationOriginAllowed({ ...base, fetchSite: 'cross-site' })).toBe(false);
    expect(isAdminMutationOriginAllowed({ ...base, fetchSite: 'same-site', origin: 'https://evil.brain.example' })).toBe(false);
    expect(isAdminMutationOriginAllowed({ ...base, fetchSite: 'same-site' })).toBe(false);
    expect(isAdminMutationOriginAllowed({ ...base, referer: 'not a URL' })).toBe(false);
  });

  test('admin mutation origin policy preserves same-origin browser and supervised script calls', () => {
    const base = {
      method: 'POST',
      requestOrigin: 'https://brain.example',
      canonicalOrigin: 'https://brain.example',
    };
    expect(isAdminMutationOriginAllowed({ ...base, origin: 'https://brain.example' })).toBe(true);
    expect(isAdminMutationOriginAllowed({ ...base, referer: 'https://brain.example/admin/' })).toBe(true);
    expect(isAdminMutationOriginAllowed({ ...base, fetchSite: 'same-origin' })).toBe(true);
    expect(isAdminMutationOriginAllowed(base)).toBe(true);
    expect(isAdminMutationOriginAllowed({ ...base, method: 'GET', fetchSite: 'cross-site' })).toBe(true);
  });

  test('parser errors map to generic JSON envelopes without internal details', () => {
    expect(classifyHttpError({ status: 413, type: 'entity.too.large', message: 'secret path' })).toEqual({
      status: 413,
      body: { error: 'payload_too_large' },
    });
    expect(classifyHttpError({ status: 400, type: 'entity.parse.failed', message: 'raw body' })).toEqual({
      status: 400,
      body: { error: 'invalid_request_body' },
    });
    expect(classifyHttpError(new Error('database password leaked here'))).toEqual({
      status: 500,
      body: { error: 'internal_error' },
    });
  });

  test('OAuth/provider/database failures map to opaque public envelopes', () => {
    expect(oauthTokenErrorEnvelope('client_authentication')).toEqual({
      status: 401,
      body: { error: 'invalid_client', error_description: 'Client authentication failed.' },
    });
    expect(oauthTokenErrorEnvelope('grant_exchange')).toEqual({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Authorization grant is invalid or expired.' },
    });
  });

  test('post-auth rate limits derive identity only from verified authInfo', () => {
    expect(authenticatedClientRateLimitKey({ auth: { clientId: 'client-a' } } as never))
      .toBe('oauth-client:client-a');
    expect(authenticatedClientRateLimitKey({ headers: { 'x-client-id': 'forged' } } as never))
      .toBe('oauth-client:missing-auth');
  });

  test('ingest backpressure tuple encoding cannot prefix-collide on legacy colon names', () => {
    const victim = buildIngestBackpressureKey('victim', 'default');
    const longerLegacyName = buildIngestBackpressureKey('victim:default:worker', 'default');
    expect(victim).toMatch(/^ingest:webhook:v2:[a-f0-9]{64}:$/);
    expect(longerLegacyName).toMatch(/^ingest:webhook:v2:[a-f0-9]{64}:$/);
    expect(victim).not.toBe(longerLegacyName);
    expect(victim.startsWith(longerLegacyName)).toBe(false);
    expect(longerLegacyName.startsWith(victim)).toBe(false);
    expect(buildIngestBackpressureKey('victim', 'default')).toBe(victim);
  });

  test('generated admin token prints only for a local interactive start', () => {
    const local = {
      fromEnv: false,
      suppressRequested: false,
      bind: '127.0.0.1',
      stderrIsTty: true,
    };
    expect(shouldPrintGeneratedBootstrapToken(local)).toBe(true);
    expect(shouldPrintGeneratedBootstrapToken({ ...local, stderrIsTty: false })).toBe(false);
    expect(shouldPrintGeneratedBootstrapToken({ ...local, bind: '0.0.0.0' })).toBe(false);
    expect(shouldPrintGeneratedBootstrapToken({ ...local, publicUrl: 'https://brain.example' })).toBe(false);
    expect(shouldPrintGeneratedBootstrapToken({ ...local, fromEnv: true })).toBe(false);
    expect(shouldPrintGeneratedBootstrapToken({ ...local, suppressRequested: true })).toBe(false);
  });

  test('server wiring disables fingerprinting, pins body limits, and installs tails last', () => {
    const source = readFileSync('src/commands/serve-http.ts', 'utf8');
    expect(source).toContain("app.disable('x-powered-by')");
    expect(source).not.toContain('express.json()');
    expect(source).not.toContain('express.urlencoded({ extended: false })');
    expect(HTTP_BODY_LIMITS).toEqual({ oauth: '32kb', admin: '32kb', mcp: '1mb' });

    const originGate = source.indexOf('if (!isHttpOriginAllowed(');
    const sdkRouter = source.indexOf('app.use(authRouter)');
    const registerBlocker = source.indexOf("app.all('/register'");
    const authorizeBlocker = source.indexOf("app.all('/authorize'");
    const mcpIpLimit = source.indexOf('mcpIpRateLimiter,');
    const mcpAuth = source.indexOf('requireBearerAuth({ verifier: oauthProvider })', mcpIpLimit);
    const mcpClientLimit = source.indexOf('mcpClientRateLimiter,', mcpAuth);
    const mcpParser = source.indexOf("express.json({ limit: HTTP_BODY_LIMITS.mcp })", mcpClientLimit);
    const ingestIpLimit = source.indexOf('ingestRateLimiter,');
    const ingestAuth = source.indexOf("requireBearerAuth({ verifier: oauthProvider, requiredScopes: ['write'] })", ingestIpLimit);
    const ingestClientLimit = source.indexOf('ingestClientRateLimiter,', ingestAuth);
    const ingestParser = source.indexOf("express.raw({ type: '*/*', limit: ingestMaxBytes })", ingestClientLimit);
    const githubRoute = source.indexOf("'/webhooks/github'");
    const notFoundTail = source.lastIndexOf("res.status(404).json({ error: 'not_found' })");
    const errorTail = source.indexOf('const envelope = classifyHttpError(error)');
    expect(originGate).toBeGreaterThan(-1);
    expect(originGate).toBeLessThan(sdkRouter);
    expect(registerBlocker).toBeGreaterThan(originGate);
    expect(registerBlocker).toBeLessThan(sdkRouter);
    expect(authorizeBlocker).toBeGreaterThan(originGate);
    expect(authorizeBlocker).toBeLessThan(sdkRouter);
    expect(mcpIpLimit).toBeLessThan(mcpAuth);
    expect(mcpAuth).toBeLessThan(mcpClientLimit);
    expect(mcpClientLimit).toBeLessThan(mcpParser);
    expect(ingestIpLimit).toBeLessThan(ingestAuth);
    expect(ingestAuth).toBeLessThan(ingestClientLimit);
    expect(ingestClientLimit).toBeLessThan(ingestParser);
    expect(notFoundTail).toBeGreaterThan(githubRoute);
    expect(errorTail).toBeGreaterThan(notFoundTail);
  });
});
