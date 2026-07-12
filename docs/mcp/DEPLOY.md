# Deploy GBrain MCP Safely

GBrain has two supported agent transports:

- Local stdio for a process on the same trusted machine.
- Authenticated HTTP for pre-registered machine clients.

The built-in HTTP server supports scoped `client_credentials`, refresh-token
renewal for existing grants, and legacy scoped bearer tokens. It does not expose
network Dynamic Client Registration and it does not approve browser
authorization-code requests. `/authorize` stays fail-closed until GBrain has a
real interactive operator-consent screen.

## Local stdio

```bash
gbrain serve
```

Use stdio for Hermes, Claude Code, Cursor, or another trusted client that can
spawn GBrain locally. No listening port or network credential is required. The
routine stdio profile is source-bound and exposes only its configured tool
allowlist; broad maintenance remains an explicit local profile.

## Remote machine client

### 1. Register the principal locally

Create one principal per agent or integration. Give it one write source and only
the read sources it needs:

```bash
gbrain auth register-client local-agent \
  --grant-types client_credentials \
  --scopes "read write" \
  --source local-agent \
  --federated-read local-agent,shared
```

Save the returned client ID and secret in the deployment's secret store. The
secret is shown once and stored hashed. Do not share one principal between
agents, put credentials in Git, or accept a caller-provided actor/source as
authority.

`--source` is the sole write authority. `--federated-read` is the exact read
set. A caller cannot widen either boundary with MCP arguments, webhook headers,
or retrieval IPC.

Trusted client registration is also available through the authenticated admin
API. There is no public `/register` workflow.

### 2. Set a stable admin credential for supervised operation

For a service or any non-interactive start, provide a strong secret through the
environment or your service manager:

```bash
export GBRAIN_ADMIN_BOOTSTRAP_TOKEN='replace-with-a-random-32-plus-character-secret'
```

GBrain never echoes an environment-provided admin credential. A generated
credential prints only on a loopback, interactive terminal start. Public or
non-interactive starts deliberately suppress generated credentials so they do
not enter logs.

### 3. Start on loopback first

```bash
gbrain serve --http --port 3131
```

The default bind is `127.0.0.1`. Confirm liveness and OAuth discovery before
adding a private proxy or tunnel:

```bash
curl -fsS http://127.0.0.1:3131/health
curl -fsS http://127.0.0.1:3131/.well-known/oauth-authorization-server
```

Discovery must not advertise a registration endpoint or
`authorization_code`. `/register` must return `404`; `/authorize` must return
`403` without a redirect.

### 4. Expose it only through a protected edge

Prefer Tailscale or another private network. If a reverse proxy or tunnel is
required, terminate TLS there, keep the application port firewalled, and pass
the exact public issuer URL:

```bash
gbrain serve --http \
  --port 3131 \
  --bind 0.0.0.0 \
  --public-url https://brain.example.com
```

Set `GBRAIN_HTTP_CORS_ORIGIN` to the exact trusted browser origin if the admin
surface is used across origins. Configure `GBRAIN_HTTP_TRUST_PROXY` for the
known proxy hop count rather than trusting arbitrary forwarded headers. Do not
publish port 3131 directly to the internet.

### 5. Authenticate the client

Exchange the pre-registered client ID and secret at `/token` using the
`client_credentials` grant, then send the access token as:

```text
Authorization: Bearer <access-token>
```

Missing, expired, revoked, or scope-inadequate tokens fail closed. Public OAuth
errors are intentionally generic and do not reveal whether a client exists or
why its database row failed.

## Remote capability boundary

Remote discovery is the intersection of:

1. The principal's exact tool allowlist.
2. Its OAuth scopes.
3. Operations that are safe for remote execution.
4. Its source grant.

Local filesystem operations such as `sync_brain`, `file_upload`, `file_list`,
and `file_url` are never exposed over HTTP. Shell, Docker, unrestricted jobs,
schema/source administration, and other maintenance functions stay in local
maintenance profiles. A remote `read write` token is not a host-maintenance
credential.

Webhook `/ingest` requires an authenticated write principal. GBrain derives the
destination source from that principal, rejects a different
`X-Gbrain-Source-Id`, and stores the payload as remote, untrusted evidence with
provenance. Imported text is never an executable instruction queue.

## Legacy bearer tokens

Existing deployments may keep their scoped legacy token during migration:

```bash
gbrain auth create legacy-client
gbrain auth list
gbrain auth revoke legacy-client
```

New deployments should prefer one pre-registered OAuth machine principal per
integration. Audit old tokens and revoke broad or unused credentials instead of
sharing a grandfathered token.

## ChatGPT browser connector

The native ChatGPT MCP connector is not directly supported by the built-in HTTP
server in this release because it requires browser authorization code + PKCE.
See [CHATGPT.md](CHATGPT.md). Do not work around this by auto-approving
`/authorize`, opening DCR, or giving a browser the admin bootstrap token.

## Operational checks

- `/health` is a bounded liveness probe and intentionally exposes no full brain
  statistics.
- Full statistics, client provisioning, and request history are admin-only.
- Green health stays silent. Alert on data loss, security exposure, full outage,
  or critical delivery failure; deduplicate lower-priority warnings.
- Keep request payload logging redacted. `--log-full-params` is a loud local
  debugging exception, not a production default.
- Test token revocation, source isolation, wrong-scope denial, tunnel recovery,
  and restart behavior before promotion.

## Troubleshooting

**`invalid_client` or `invalid_grant`:** Verify the stored client credentials,
grant type, expiry, and revocation state locally. The HTTP response is generic by
design.

**`cors_origin_denied`:** Use the same origin as the declared issuer or add only
the exact trusted origin to `GBRAIN_HTTP_CORS_ORIGIN`.

**Remote client cannot connect:** Confirm the process is intentionally bound for
the proxy, the edge can reach loopback/application port, the public URL matches
OAuth discovery, and the application port is not publicly exposed.

**Tool missing from discovery:** Check the principal's tool allowlist, OAuth
scope, source grant, and whether the operation is local-only. Do not broaden the
whole agent to fix one missing capability.

See [SECURITY.md](../../SECURITY.md) for the complete trust model and
[ALTERNATIVES.md](ALTERNATIVES.md) for private-network options.
