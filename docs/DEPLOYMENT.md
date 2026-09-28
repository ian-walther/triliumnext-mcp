# Deployment

Target, as built on 2026-09-28: one container on **server.home** (Ubuntu, Docker
Compose, `~/docker` layout), published at **https://trilium-mcp.ianwalther.com/mcp**
through the **OPNsense nginx plugin**, which terminates TLS for every public
hostname with one shared Let's Encrypt certificate. Auth0 issues tokens.

```
Claude / ChatGPT / Grok ── HTTPS ──▶ OPNsense nginx (TLS, one cert for *.ianwalther.com names)
                                         │ http, Host/X-Forwarded-* preserved
                                         ▼
                              server.home:3939  (trilium-mcp container)
                                         │ http://trilium:8080/etapi on server_default
                                         ▼
                              server-trilium-1  (TriliumNext, private)
```

## 1. server.home: compose layout

Every service lives in `~/docker/<service>/` with its own `docker-compose.yml`
and data directories, and the parent `~/docker/docker-compose.yml` (`name:
server`) includes each file so all services share the `server_default` network.
trilium-mcp follows the same pattern, building from a clone of this repository:

```
~/docker/trilium-mcp/
  docker-compose.yml     # below
  .env                   # secrets (chmod 600), never in git
  data/                  # audit.jsonl (owned by uid 1000)
  trilium-mcp/           # git clone, branch v2
```

`~/docker/trilium-mcp/docker-compose.yml`:

```yaml
services:
  trilium-mcp:
    build: ./trilium-mcp
    image: trilium-mcp:local
    container_name: trilium-mcp
    restart: unless-stopped
    user: '1000:1000'
    env_file: .env
    environment:
      - TRILIUM_API_URL=http://trilium:8080/etapi
      - MCP_HTTP_HOST=0.0.0.0
      - MCP_HTTP_PORT=3939
      - MCP_HTTP_PATH=/mcp
      - MCP_PUBLIC_URL=https://trilium-mcp.ianwalther.com/mcp
      - MCP_ALLOWED_HOSTS=trilium-mcp.ianwalther.com,trilium-mcp.home,server.home
      - MCP_TRUST_PROXY=true
      - MCP_HTTP_RESPONSE_MODE=json
      - MCP_AUDIT_LOG_PATH=/var/log/trilium-mcp/audit.jsonl
      - LOG_FORMAT=json
    ports:
      - '3939:3939'
    volumes:
      - ./data:/var/log/trilium-mcp
```

`.env` holds `TRILIUM_API_TOKEN` (a dedicated ETAPI token, revocable on its
own), `MCP_AUTH_MODE`, and in `oidc` mode `MCP_OIDC_ISSUER`. Before Auth0 exists
the service runs with `MCP_AUTH_MODE=static` and one long random
`MCP_STATIC_TOKENS` entry for smoke tests; that is development auth, not the
end state.

Add `- ./trilium-mcp/docker-compose.yml` to the parent file's `include:` list,
then from `~/docker`:

```bash
docker compose build trilium-mcp
docker compose up -d trilium-mcp
curl -s http://127.0.0.1:3939/healthz          # {"status":"ok",...}
```

Update: `git -C ~/docker/trilium-mcp/trilium-mcp pull`, rebuild, `up -d`.

`MCP_HTTP_RESPONSE_MODE=json` makes 2026-era answers plain JSON; 2025-era
answers are short SSE streams that close with the result, which a buffering
proxy delivers intact (the OPNsense location has buffering off regardless). `user: '1000:1000'`
runs the process as your uid so `./data` stays writable; the image's own `mcp`
user is only the default.

LAN access follows the existing `*.home` convention on server.home's nginx
(`~/docker/nginx/conf.d/trilium-mcp.home.conf`, plain HTTP, proxied to
`127.0.0.1:3939`), which is why `trilium-mcp.home` is in the Host allow-list.

## 2. OPNsense: certificate and nginx

The ACME client holds one certificate (`ianwalther.com`, HTTP-01 through the
firewall's own challenge port, auto-renewal, "Restart Nginx" action). Adding a
hostname means adding it to that certificate's alt names and re-signing.

Nginx plugin objects, cloned from the Trilium entries (created 2026-09-28
through the API; note the API model keys differ from the settings dump:
`httpserver`, `location`, `upstream`, `upstream_server`, and the ACME
certificate is changed with `certificates/update/<uuid>`, since `set` reports
success without applying):

| Object          | Value                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Upstream server | `server.home`, port `3939`                                                                                              |
| Upstream pool   | `Trilium-MCP Pool` → that server                                                                                        |
| Location        | `/`, match `^~`, upstream the pool, **proxy buffering off**, websocket on (harmless), security rules off (as elsewhere) |
| HTTP server     | `trilium-mcp.ianwalther.com`, certificate `ianwalther.com`, HTTPS only, HTTP/2, **bot protection disabled**             |

Bot protection is the per-server user-agent blocklist that answers `418` and
bans the source IP for `ban_ttl`. Cloud MCP clients share egress IPs across
customers; one unlucky user agent would ban a vendor, so it stays off for this
host only.

Headers OPNsense already forwards (`Host`, `X-Real-IP`, `X-Forwarded-For`,
`X-Forwarded-Proto`) are what `MCP_TRUST_PROXY=true` and the Host allow-list
expect. Its default `proxy_read_timeout` (60 s) exceeds every bound in this
server (ETAPI 30 s, regex 2 s).

## 3. Smoke test from outside

```bash
curl -s https://trilium-mcp.ianwalther.com/healthz
curl -si https://trilium-mcp.ianwalther.com/mcp -X POST -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'
# 401 with WWW-Authenticate: Bearer resource_metadata="https://trilium-mcp.ianwalther.com/.well-known/oauth-protected-resource/mcp"
curl -s https://trilium-mcp.ianwalther.com/.well-known/oauth-protected-resource/mcp
```

With a static token, add `-H 'authorization: Bearer <token>'` to the `ping` and
expect a JSON-RPC result. The protected-resource metadata document is served
only in `oidc` mode; in `static` mode it answers 404 while the `401` challenge
still names it.

## 4. Identity provider

See [AUTH0.md](AUTH0.md). API identifier = `https://trilium-mcp.ianwalther.com/mcp`.
Then set `MCP_AUTH_MODE=oidc`, `MCP_OIDC_ISSUER=https://<tenant>.us.auth0.com/`
in `.env`, drop the static token, and `docker compose up -d trilium-mcp`.

## 5. Clients

Claude (Settings → Connectors → Add custom connector) with the MCP URL, complete
the OAuth flow, run `search_notes` and `get_note` on a known note; then Grok and
ChatGPT. Compare with the old server per [MIGRATION.md](MIGRATION.md).

## 6. Operations

- Logs: `docker logs trilium-mcp` (JSON lines). Audit: `~/docker/trilium-mcp/data/audit.jsonl`.
- Rotate the ETAPI token by editing `.env` and restarting; clients are unaffected.
- Signing keys rotate at Auth0 freely; JWKS is fetched and cached (30 s cooldown).
- One replica only: idempotency keys, per-note write locks and rate limits are process-local.
- Rollback: the legacy reference is branch `tool_defs` (0.3.13 plus output
  schemas) and the preserved local `build/`, not `main`; the old stdio
  configurations keep working throughout.
