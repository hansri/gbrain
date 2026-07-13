# Connect GBrain to ChatGPT

## Current status

Direct connection through ChatGPT's OAuth MCP connector is intentionally not
available in this release.

ChatGPT requires a browser authorization-code flow with PKCE. GBrain's built-in
HTTP server does not yet have an interactive operator-consent screen, so
`/authorize` fails closed with `access_denied`. Network client registration is
also unavailable. GBrain will not silently approve a browser client or mint a
token without operator consent merely to make the connector appear to work.

## Safe options today

- Use GBrain through Hermes, a local stdio MCP client, or another trusted client
  that supports a pre-registered `client_credentials` principal.
- Put a separately reviewed, consent-capable OAuth gateway in front of GBrain.
  The gateway must authenticate the operator, show the requested client and
  scopes, require an explicit approval, bind the redirect URI and PKCE
  challenge, and issue only source- and tool-scoped credentials.
- Wait for GBrain's built-in operator-consent flow before adding the native
  ChatGPT connector.

Do not expose Dynamic Client Registration, auto-approve `/authorize`, share the
admin bootstrap token with ChatGPT, or place a privileged bearer token in a
browser connector as a workaround.

## Verify the boundary

With the HTTP server running locally:

```bash
curl -i 'http://127.0.0.1:3131/authorize?client_id=test&response_type=code'
curl -s 'http://127.0.0.1:3131/.well-known/oauth-authorization-server'
```

The first request must return `403` with no redirect. Discovery must not
advertise a registration endpoint or `authorization_code` as a supported grant.

## See also

- [DEPLOY.md](DEPLOY.md) for the supported local and remote transports.
- [SECURITY.md](../../SECURITY.md) for the HTTP trust boundary.
- [ALTERNATIVES.md](ALTERNATIVES.md) for private-network and tunnel options.
