# Deployment

Target: one container on server.home (or any host that can reach Trilium
privately), published through the existing reverse proxy at a stable HTTPS URL,
with Auth0 (or another OIDC provider) issuing tokens. Nothing in this document
has been applied yet; it is the checklist for the cutover phase.

## 1. Build the image

```bash
docker build -t trilium-mcp:2.0.0 .
```

Multi-stage: compiles with dev dependencies, ships `dist/` plus production
`node_modules` on `node:24-alpine`, runs as user `mcp`, exposes 3939, has a
`HEALTHCHECK` on `/healthz`.

## 2. Environment

Create `/etc/trilium-mcp/env` (or the secret store of your choice) from
`.env.example`. Production shape:

```
TRILIUM_API_URL=http://trilium:8080/etapi          # private network address of Trilium
TRILIUM_API_TOKEN=<etapi token dedicated to this service>
MCP_HTTP_HOST=0.0.0.0
MCP_HTTP_PORT=3939
MCP_HTTP_PATH=/trilium/mcp
MCP_PUBLIC_URL=https://mcp.ianwalther.com/trilium/mcp
MCP_ALLOWED_HOSTS=mcp.ianwalther.com
MCP_AUTH_MODE=oidc
MCP_OIDC_ISSUER=https://<tenant>.us.auth0.com/
MCP_OIDC_AUDIENCE=https://mcp.ianwalther.com/trilium/mcp
MCP_TRUST_PROXY=true
MCP_RATE_LIMIT_PER_MINUTE=120
LOG_FORMAT=json
MCP_AUDIT_LOG_PATH=/var/log/trilium-mcp/audit.jsonl
```

Create a *separate* ETAPI token in Trilium for this service so it can be
revoked independently of the local stdio token.

## 3. Compose

```yaml
services:
  trilium-mcp:
    image: trilium-mcp:2.0.0
    restart: unless-stopped
    env_file: /etc/trilium-mcp/env
    volumes:
      - /var/log/trilium-mcp:/var/log/trilium-mcp
    networks: [proxy, trilium]      # reach Trilium privately; expose only to the proxy
    # no `ports:` — the reverse proxy talks to it on the compose network
```

## 4. Reverse proxy

Route `https://mcp.ianwalther.com/trilium/*` to `trilium-mcp:3939`, preserving
the path. Requirements:

- TLS terminated at the proxy (bearer tokens must never travel in clear).
- Pass `Host` through unchanged (`MCP_ALLOWED_HOSTS` checks it).
- Pass `X-Forwarded-For` (used only for anonymous rate-limit keys).
- No buffering of `text/event-stream` responses (SSE); disable proxy read
  timeouts below ~5 minutes for the MCP path.
- Allow `GET`, `POST`, `DELETE` on the MCP path and `GET` on
  `/.well-known/oauth-protected-resource*`.
- Do **not** expose Trilium itself.

Caddy example:

```
mcp.ianwalther.com {
  handle_path /trilium/* {
    reverse_proxy trilium-mcp:3939 {
      flush_interval -1
    }
  }
  handle /.well-known/oauth-protected-resource* {
    reverse_proxy trilium-mcp:3939
  }
}
```

Note the well-known path must reach the container with its full path
(`/.well-known/oauth-protected-resource/trilium/mcp`), which the server serves
alongside the bare `/.well-known/oauth-protected-resource`.

## 5. Identity provider

See [AUTH0.md](AUTH0.md). Summary: create an API with identifier equal to
`MCP_PUBLIC_URL`, define permissions `trilium.read`, `trilium.write`,
`trilium.admin`, enable dynamic client registration (or register each client),
set the API as the tenant's default audience.

## 6. Smoke test before cutover

```bash
curl -s https://mcp.ianwalther.com/trilium/healthz
curl -si https://mcp.ianwalther.com/trilium/mcp -X POST -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'
# expect 401 with WWW-Authenticate: Bearer resource_metadata="https://mcp.ianwalther.com/.well-known/oauth-protected-resource/trilium/mcp"
curl -s https://mcp.ianwalther.com/.well-known/oauth-protected-resource/trilium/mcp
```

Then connect Claude (Settings → Connectors → Add custom connector) with the MCP
URL, complete the OAuth flow, and run `search_notes` and `get_note` on a known
note. Repeat with Grok and ChatGPT. Compare results with the old server per
[MIGRATION.md](MIGRATION.md).

## 7. Operations

- Logs: stderr JSON lines (`docker logs`). Audit: `/var/log/trilium-mcp/audit.jsonl`.
- Rotate the ETAPI token by updating the env file and restarting; no client changes.
- Rotate signing keys at the IdP freely; JWKS is fetched and cached (30 s cooldown).
- Upgrade: build a new image, `docker compose up -d`. The server is stateless
  except for the in-memory idempotency store and rate-limit buckets.
- Rollback: the old `triliumnext-mcp` stdio configurations keep working
  throughout; nothing here touches them.
