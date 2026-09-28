# Configuration

All configuration is environment variables. Validation runs at startup and a bad
value exits with code 2 and a message naming the variable. `.env.example` lists
everything with defaults.

## Trilium backend

| Variable                 | Default                       | Meaning                                                                             |
| ------------------------ | ----------------------------- | ----------------------------------------------------------------------------------- |
| `TRILIUM_API_URL`        | `http://localhost:8080/etapi` | ETAPI base URL. `/etapi` is appended when missing.                                  |
| `TRILIUM_API_TOKEN`      | required                      | ETAPI token (Trilium → Options → ETAPI). Never leaves the server.                   |
| `TRILIUM_API_NO_AUTH`    | `false`                       | Skip the token for a test instance started with `TRILIUM_GENERAL_NOAUTHENTICATION`. |
| `TRILIUM_API_TIMEOUT_MS` | `30000`                       | Per-request timeout.                                                                |
| `TRILIUM_API_RETRIES`    | `2`                           | Retries for idempotent GETs on network errors and 502/503/504.                      |

## stdio entry point (`dist/stdio.js`)

| Variable             | Default                      | Meaning                                                                                      |
| -------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| `TRILIUM_MCP_SCOPES` | `trilium.read trilium.write` | Scopes for the local process. `PERMISSIONS=READ;WRITE` is accepted as an alias.              |
| `MCP_STDIO_LEGACY`   | `serve`                      | `reject` refuses 2025-era clients. Keep `serve`: Claude Code and Codex speak that era today. |

## HTTP entry point (`dist/http.js`)

| Variable                    | Default     | Meaning                                                                                                                                                                          |
| --------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_HTTP_HOST`             | `127.0.0.1` | Bind address. Loopback binds enable Host/Origin validation automatically.                                                                                                        |
| `MCP_HTTP_PORT`             | `3939`      | Port.                                                                                                                                                                            |
| `MCP_HTTP_PATH`             | `/mcp`      | Endpoint path.                                                                                                                                                                   |
| `MCP_PUBLIC_URL`            | —           | Externally visible endpoint URL, e.g. `https://mcp.example.net/trilium/mcp`. Required for `oidc`; used as the OAuth resource identifier and in the `WWW-Authenticate` challenge. |
| `MCP_ALLOWED_HOSTS`         | —           | Comma-separated hostnames accepted in `Host` when bound to a non-loopback address. Set this behind a reverse proxy.                                                              |
| `MCP_ALLOWED_ORIGINS`       | —           | Comma-separated origin hostnames accepted in `Origin`. Non-browser clients send no `Origin` and always pass.                                                                     |
| `MCP_MAX_BODY_BYTES`        | `4194304`   | Request body cap (413 above).                                                                                                                                                    |
| `MCP_RATE_LIMIT_PER_MINUTE` | `120`       | Token bucket refill per principal (0 disables).                                                                                                                                  |
| `MCP_RATE_LIMIT_BURST`      | `30`        | Bucket size.                                                                                                                                                                     |
| `MCP_TRUST_PROXY`           | `false`     | Key anonymous rate limits by `X-Forwarded-For`.                                                                                                                                  |
| `MCP_HTTP_LEGACY`           | `stateless` | `reject` makes the endpoint 2026-07-28-only.                                                                                                                                     |

## Authentication

| Variable                           | Default                              | Meaning                                                                                                                                    |
| ---------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `MCP_AUTH_MODE`                    | `none` on loopback, `oidc` otherwise | `none`, `static`, or `oidc`. `none` off loopback needs `MCP_DANGEROUSLY_ALLOW_UNAUTHENTICATED=true` (only behind an authenticating proxy). |
| `MCP_ANONYMOUS_SCOPES`             | same as `TRILIUM_MCP_SCOPES`         | Scopes granted when `MCP_AUTH_MODE=none`.                                                                                                  |
| `MCP_STATIC_TOKENS`                | —                                    | `id@token:scope+scope,token2:scope`. Tokens must be ≥16 chars. Development only.                                                           |
| `MCP_OIDC_ISSUER`                  | —                                    | Issuer URL (Auth0: `https://<tenant>.<region>.auth0.com/`).                                                                                |
| `MCP_OIDC_AUDIENCE`                | `MCP_PUBLIC_URL`                     | Expected `aud` claim (the API identifier).                                                                                                 |
| `MCP_OIDC_JWKS_URL`                | `<issuer>/.well-known/jwks.json`     | Signing keys.                                                                                                                              |
| `MCP_OIDC_SCOPE_CLAIMS`            | `scope,permissions,scp`              | Claims read for scopes; strings are split on whitespace/commas, arrays used as is.                                                         |
| `MCP_OIDC_ALGORITHMS`              | RS*/ES*/PS*/EdDSA                    | Accepted JWT algorithms.                                                                                                                   |
| `MCP_OIDC_AUTHORIZATION_SERVER`    | issuer                               | Advertised in protected-resource metadata.                                                                                                 |
| `MCP_OIDC_CLOCK_TOLERANCE_SECONDS` | `60`                                 | Leeway for `exp`/`nbf`.                                                                                                                    |

Scopes: `trilium.read` (search, resolve, get, context, list, read attributes),
`trilium.write` (create, patch, metadata, manage attributes), `trilium.admin`
(reserved for future destructive tools; grants nothing today).

## Limits

| Variable                         | Default   | Meaning                                              |
| -------------------------------- | --------- | ---------------------------------------------------- |
| `MCP_MAX_WRITE_CONTENT_BYTES`    | `2097152` | Largest content accepted by create/patch.            |
| `MCP_DEFAULT_READ_CONTENT_BYTES` | `262144`  | Default truncation for `get_note` content.           |
| `MCP_MAX_READ_CONTENT_BYTES`     | `4194304` | Upper bound a caller may request.                    |
| `MCP_MAX_SEARCH_LIMIT`           | `200`     | Page size cap.                                       |
| `MCP_MAX_CHILDREN`               | `500`     | Children cap for `list_children`/`get_note_context`. |

## Logging and audit

| Variable             | Default                        | Meaning                                                             |
| -------------------- | ------------------------------ | ------------------------------------------------------------------- |
| `LOG_LEVEL`          | `info`                         | `debug`, `info`, `warn`, `error`.                                   |
| `LOG_FORMAT`         | `pretty` on a TTY, else `json` | JSON lines go to stderr; stdout is reserved for the stdio protocol. |
| `MCP_AUDIT_ENABLED`  | `true`                         | Emit one audit record per tool call.                                |
| `MCP_AUDIT_LOG_PATH` | —                              | Append audit JSON lines to this file instead of the logger.         |

An audit record looks like:

```json
{
  "time": "2026-09-28T03:20:00.000Z",
  "type": "audit",
  "principal": "auth0|ian",
  "transport": "http",
  "tool": "patch_note",
  "noteIds": ["BWf42IBwfgM6"],
  "ok": false,
  "code": "CONFLICT",
  "durationMs": 42,
  "era": "modern"
}
```

Note bodies, titles, search terms and tokens are never logged. Fields whose
names look like secrets are redacted from any log line.
