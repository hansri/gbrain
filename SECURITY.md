# Security

## Reporting Vulnerabilities

If you discover a security issue in GBrain, please report it privately by opening
a [private security advisory](https://github.com/garrytan/gbrain/security/advisories/new)
on GitHub.

Do not open a public issue for security vulnerabilities.

## Remote MCP Security

### Recommended: pre-registered principals on `gbrain serve --http`

The built-in HTTP server accepts trusted machine clients registered locally or
through the authenticated admin API. It supports scoped
`client_credentials`, existing refresh grants, and legacy scoped bearer tokens.
It does not expose network Dynamic Client Registration, and `/authorize` fails
closed until GBrain has an interactive operator-consent flow.

Use one principal per integration, one write source, an explicit federated read
set, and the smallest OAuth/tool scope that works. Prefer a private network such
as Tailscale; if a proxy or tunnel is required, keep the application port
firewalled and terminate TLS at the reviewed edge.

Never open `/register`, auto-approve `/authorize`, share an admin bootstrap
credential, or accept a request's actor/source fields as authority. An attacker
who can mint its own client or redirect a write source can otherwise read or
pollute brain data while appearing to be a trusted agent.

### If you use a custom OAuth gateway

1. Authenticate the operator before any client registration or authorization.
2. Show the client, redirect URI, requested scopes, tools, and source boundary.
3. Require explicit consent and bind the authorization code to redirect URI and
   PKCE challenge.
4. Make credentials short-lived, scoped, revocable, rate-limited, and audited.
5. Never log raw credentials or pass provider/database errors to the caller.

### Pre-registering trusted clients (v0.41.3+)

`gbrain serve --http` does not expose network Dynamic Client Registration.
Pre-register machine clients locally (or through the authenticated admin API):

```bash
# Confidential machine client
gbrain auth register-client trusted-agent \
  --grant-types client_credentials \
  --scopes "read write" \
  --source default
```

Auth methods (`--token-endpoint-auth-method`):

- `client_secret_post` (default) — confidential client, secret in body
- `client_secret_basic` — confidential client, secret in `Authorization` header
- `none` — public PKCE client record with no secret. The built-in server cannot
  authorize it until the operator-consent flow exists, so this is not a current
  ChatGPT connector path.

The validator rejects unknown methods at the trusted registration boundary;
the same gate applies to `POST /admin/api/register-client`.

### Network registration and authorization-code consent

`POST /register` is unavailable. `/authorize` fails closed until GBrain ships
a real interactive operator-consent surface; it never auto-approves an OAuth
code request. Consequently, browser connectors that require an authorization-
code redirect are not supported by the built-in HTTP server yet. Do not add a
wrapper that silently approves them. Use a pre-registered confidential
`client_credentials` client, a legacy scoped bearer token, or a separately
reviewed consent-capable OAuth gateway. Existing refresh tokens remain
renewable during migration.

### Token Management

```bash
gbrain auth create "claude-desktop"   # Create a new token
gbrain auth list                       # List all tokens
gbrain auth revoke "claude-desktop"    # Revoke a token
gbrain auth test <url> --token <tok>   # Smoke-test a remote server
```

Tokens are stored as SHA-256 hashes in the `access_tokens` table. The
plaintext token is shown once at creation and never stored.

## `gbrain serve --http` hardening (v0.22.7+)

The built-in HTTP transport ships with several layers of hardening on by
default. All env vars below are optional; the defaults are intentionally
conservative.

### Bind address (v0.34: loopback by default)

`gbrain serve --http` listens on `127.0.0.1` by default. Personal-laptop
installs cannot accidentally publish the brain to the LAN. Self-hosted
deployments that need remote access pass `--bind 0.0.0.0` (all
interfaces) or `--bind <interface-ip>` (specific NIC). A stderr WARN
fires when `--public-url` is set without `--bind` so the operator sees
the binding before the first request — common cause of "ngrok forwards
to me but the agent can't reach the upstream" misconfigurations.

### Postgres-only

`gbrain serve --http` requires a Postgres engine. PGLite is local-only by
design and the `access_tokens` / `mcp_request_log` tables don't exist in
the PGLite schema. Local agents continue to use stdio (`gbrain serve`).
Running `--http` against a PGLite-backed install fails fast with a clear
error message at startup.

### CORS

Default-deny: no `Access-Control-Allow-Origin` header is sent unless an
allowlist is configured. To allow browser-based MCP clients:

```bash
GBRAIN_HTTP_CORS_ORIGIN=https://claude.ai gbrain serve --http --port 8787
# Multiple origins: comma-separated
GBRAIN_HTTP_CORS_ORIGIN=https://claude.ai,https://your.app gbrain serve --http
```

When the request `Origin` matches the allowlist, the server echoes it
back in `Access-Control-Allow-Origin` (with `Vary: Origin`). Otherwise no
CORS header is sent and the browser blocks the request.

**v0.41.3:** the same allowlist now gates every OAuth endpoint (`/mcp`,
`/token`, `/authorize`, `/register`, `/revoke`). Pre-v0.41.3 these used
default-wide-open `cors()` middleware, leaking
`Access-Control-Allow-Origin: *` on every response — any web origin could
complete a token exchange from a logged-in operator's browser. The CORS
preflight handler in the legacy bearer transport was also asymmetric
(actual-request path correctly default-deny, but OPTIONS preflight leaked
`Access-Control-Allow-Methods` + `Access-Control-Allow-Headers` to every
Origin); both are now consolidated through a single allowlist-gated path.
A startup stderr WARN fires when `--bind 0.0.0.0` is set without
`GBRAIN_HTTP_CORS_ORIGIN`, surfacing the default-deny posture before the
first request.

The Express server also enforces the allowlist as a hard request gate
*before* the MCP SDK router. This matters because some SDK OAuth handlers
install their own permissive CORS middleware: merely omitting the outer
header would let a nested handler add `Access-Control-Allow-Origin: *`
again. An unlisted browser Origin now receives `403 cors_origin_denied`
before token, registration, or MCP handling. Same-origin calls and
non-browser clients remain compatible.

### Browser and response hardening

The Express surface disables `X-Powered-By` and emits a restrictive CSP,
`X-Content-Type-Options: nosniff`, clickjacking protection, a no-referrer
policy, and a restrictive Permissions Policy. It deliberately does not set
HSTS: transport pinning belongs at the explicitly managed HTTPS edge, where
the operator controls certificate renewal and the long-lived lockout risk.

Admin sessions remain HttpOnly, host-only, `SameSite=Strict` cookies.
Cookie-authenticated admin writes additionally validate Origin/Referer and
Fetch Metadata, rejecting cross-origin and sibling-site requests with
`403 csrf_origin_denied`. Supervised non-browser clients that explicitly
carry the admin cookie remain compatible when no browser metadata exists.
Unknown routes, malformed bodies, oversized bodies, and unexpected
middleware errors return generic JSON envelopes rather than Express HTML
or stack details.

### Rate limiting

Two buckets, both stored in a bounded LRU map (default 10K keys, evicts
least-recently-used on overflow, prunes entries older than 2× the
window):

| Bucket | When it fires | Default | Env var |
|---|---|---|---|
| Pre-auth IP | Before the DB lookup, on every `/mcp` request | 30 req / 60s | `GBRAIN_HTTP_RATE_LIMIT_IP` |
| Post-auth token | After a valid token is resolved | 60 req / 60s | `GBRAIN_HTTP_RATE_LIMIT_TOKEN` |
| LRU cap | Maximum distinct keys across both buckets | 10000 | `GBRAIN_HTTP_RATE_LIMIT_LRU` |

On exhaustion the server returns `429 Too Many Requests` with a
`Retry-After` header.

**Caveat for tunneled deployments (ngrok, Tailscale Funnel, Cloudflare
Tunnel):** all requests share one egress IP, so the pre-auth IP bucket
becomes effectively shared by all clients on that tunnel. The
post-auth token-id bucket is the load-bearing limiter for tunnel-fronted
deployments.

### Reverse-proxy trust

**Loopback-only by default** (v0.41.3+ Express server agrees with the
legacy transport; pre-v0.41.3 the Express server hardcoded `'loopback'`
while docs claimed "disabled by default" — that disagreement is gone).
The default trusts only same-host proxies (127.0.0.1, ::1, fc00::/7);
external forwarded-for headers are ignored regardless. To widen or
narrow trust:

```bash
# Trust exactly one hop — Fly.io, Render, Vercel, single-layer nginx
GBRAIN_HTTP_TRUST_PROXY=1 gbrain serve --http --port 8787

# Trust N hops — Cloudflare → nginx → gbrain
GBRAIN_HTTP_TRUST_PROXY=2 gbrain serve --http --port 8787

# Disable entirely — direct-exposure deployment with no proxy
GBRAIN_HTTP_TRUST_PROXY=0 gbrain serve --http --port 8787

# Named Express modes (uniquelocal, linklocal) or CIDR lists pass through
GBRAIN_HTTP_TRUST_PROXY=uniquelocal gbrain serve --http --port 8787
GBRAIN_HTTP_TRUST_PROXY="10.0.0.0/8,192.168.1.0/24" gbrain serve --http --port 8787
```

Both transports (Express OAuth server in `src/commands/serve-http.ts` and
the legacy bearer transport in `src/mcp/http-transport.ts`) read the same
env var, so single source of truth.

**Critical safety contract:** only widen past `'loopback'` when **both**
of these are true:

1. gbrain is reachable only via a trusted reverse proxy (not directly
   exposed to the internet on the configured port). As of v0.34
   `gbrain serve --http` binds `127.0.0.1` by default, so the
   reverse-proxy-only posture is the out-of-the-box shape; only
   override with `--bind 0.0.0.0` (or a specific interface IP) when
   gbrain itself needs to accept remote connections directly.
2. The proxy strips any client-supplied `X-Forwarded-For` and `X-Real-IP`
   headers, then sets them itself. (nginx with `proxy_set_header
   X-Forwarded-For $remote_addr` does this; Cloudflare and most cloud
   load balancers handle it automatically.)

If gbrain is reachable directly AND `GBRAIN_HTTP_TRUST_PROXY=1` (or any
non-loopback value) is set, clients can spoof their IP by sending
arbitrary `X-Forwarded-For` headers, defeating the pre-auth IP rate
limit. The `'loopback'` default protects against this by ignoring all
forwarded-for headers and using the socket peer address.

### Body size cap

Default 1 MiB, stream-counted (chunked transfers without
`Content-Length` are still capped). Override:

```bash
GBRAIN_HTTP_MAX_BODY_BYTES=2097152 gbrain serve --http   # 2 MiB
```

Over-cap requests get `413 Payload Too Large` immediately, before any
body is materialized in memory.

The Express OAuth/admin server has explicit route ceilings as well:

- OAuth forms and dynamic-registration JSON: 32 KiB
- Admin JSON: 32 KiB
- MCP JSON: 1 MiB
- Webhook ingestion and GitHub webhook payloads: 1 MiB by default

These limits are independent of implicit Express/MCP SDK defaults and map
over-cap requests to the stable JSON envelope
`{"error":"payload_too_large"}`.

### Audit log

Every `/mcp` request writes one row to `mcp_request_log`:

```bash
psql "$DATABASE_URL" -c \
  "SELECT created_at, token_name, operation, status, latency_ms
   FROM mcp_request_log
   ORDER BY created_at DESC LIMIT 100"
```

`status` is one of: `success`, `error`, `auth_failed`, `rate_limited`,
`body_too_large`, `parse_error`, `unknown_method`. Failed-auth rows have
`token_name = NULL`. Inserts are fire-and-forget so audit failures
never block requests.

**v0.26.9 redaction default.** The `params` column now stores
`{redacted, kind, declared_keys, unknown_key_count, approx_bytes}` instead
of raw JSON-RPC payloads. Declared keys (intersected against the operation's
spec) preserve for debug visibility; unknown keys are counted but never
named so attackers can't probe key existence; byte sizes bucket to 1KB so
content sizes can't be binary-searched. The same shape is broadcast on the
admin SSE feed at `/admin/events`. Operators on a personal laptop who want
raw payloads back can pass `gbrain serve --http --log-full-params` (loud
stderr warning at startup). Multi-tenant deployments should leave it
on the redacted default.
