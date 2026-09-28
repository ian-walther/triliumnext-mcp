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

| Variable                    | Default                      | Meaning                                                                                                                                                                                                                     |
| --------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_HTTP_HOST`             | `127.0.0.1`                  | Bind address. Loopback binds enable Host/Origin validation automatically.                                                                                                                                                   |
| `MCP_HTTP_PORT`             | `3939`                       | Port.                                                                                                                                                                                                                       |
| `MCP_HTTP_PATH`             | `/mcp`                       | Endpoint path.                                                                                                                                                                                                              |
| `MCP_PUBLIC_URL`            | —                            | Externally visible endpoint URL, e.g. `https://mcp.example.net/trilium/mcp`. Required for `oidc`; used as the OAuth resource identifier and in the `WWW-Authenticate` challenge.                                            |
| `MCP_ALLOWED_HOSTS`         | —                            | Comma-separated hostnames accepted in `Host` when bound to a non-loopback address. Set this behind a reverse proxy.                                                                                                         |
| `MCP_ALLOWED_ORIGINS`       | Host allow-list off loopback | Comma-separated origin hostnames accepted in `Origin`. Off loopback this defaults to the Host allow-list (public URL hostname), so a page on another origin gets 403. Non-browser clients send no `Origin` and always pass. |
| `MCP_MAX_BODY_BYTES`        | `4194304`                    | Request body cap (413 above).                                                                                                                                                                                               |
| `MCP_RATE_LIMIT_PER_MINUTE` | `120`                        | Token bucket refill per principal (0 disables).                                                                                                                                                                             |
| `MCP_RATE_LIMIT_BURST`      | `30`                         | Bucket size.                                                                                                                                                                                                                |
| `MCP_TRUST_PROXY`           | `false`                      | Believe `X-Forwarded-For` for anonymous rate-limit keys. When false, the socket peer address is used and forwarding headers (including `X-Real-IP`) are ignored.                                                            |
| `MCP_HTTP_LEGACY`           | `stateless`                  | `reject` makes the endpoint 2026-07-28-only.                                                                                                                                                                                |

## Authentication

| Variable                           | Default                              | Meaning                                                                                                                                                                                                                                                                                                                |
| ---------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_AUTH_MODE`                    | `none` on loopback, `oidc` otherwise | `none`, `static`, or `oidc`. `none` off loopback needs `MCP_DANGEROUSLY_ALLOW_UNAUTHENTICATED=true` (only behind an authenticating proxy).                                                                                                                                                                             |
| `MCP_ANONYMOUS_SCOPES`             | same as `TRILIUM_MCP_SCOPES`         | Scopes granted when `MCP_AUTH_MODE=none`.                                                                                                                                                                                                                                                                              |
| `MCP_STATIC_TOKENS`                | —                                    | `id@token:scope+scope,token2:scope`. Tokens must be ≥16 chars. Development only.                                                                                                                                                                                                                                       |
| `MCP_OIDC_ISSUER`                  | —                                    | Issuer URL (Auth0: `https://<tenant>.<region>.auth0.com/`).                                                                                                                                                                                                                                                            |
| `MCP_OIDC_AUDIENCE`                | `MCP_PUBLIC_URL`                     | Expected `aud` claim (the API identifier).                                                                                                                                                                                                                                                                             |
| `MCP_OIDC_JWKS_URL`                | `<issuer>/.well-known/jwks.json`     | Signing keys.                                                                                                                                                                                                                                                                                                          |
| `MCP_OIDC_SCOPE_CLAIMS`            | `scope,scp`                          | Ordered preference of claims that carry the client's delegated scopes; the first claim present decides and the rest are ignored (never unioned). A token with none of them gets no scopes (fail closed). Auth0's user-wide `permissions` claim is not a delegation and is not read unless you list it here explicitly. |
| `MCP_OIDC_ALGORITHMS`              | RS*/ES*/PS*/EdDSA                    | Accepted JWT algorithms.                                                                                                                                                                                                                                                                                               |
| `MCP_OIDC_AUTHORIZATION_SERVER`    | issuer                               | Advertised in protected-resource metadata.                                                                                                                                                                                                                                                                             |
| `MCP_OIDC_CLOCK_TOLERANCE_SECONDS` | `60`                                 | Leeway for `exp`/`nbf`.                                                                                                                                                                                                                                                                                                |

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

Fixed bounds: cursors address at most offset 10 000; ascending `orderBy` covers the first 1 000 matches (`truncated: true` beyond); `find` searches the returned content window and matches are cut to 500 characters with 80 characters of context each side; caller regexes run in a worker thread with a 2 s budget and are terminated on overrun; `patch_note` edits are assembled under the write byte budget and fail with `TOO_LARGE` before any scan, revision or write once they exceed it; each call also has a replacement work budget of 5 000 000 token evaluations (template tokens × matches, summed over its edits), charged before expansion, so CPU time is bounded even when substitutions produce no bytes.

## Logging and audit

| Variable             | Default                        | Meaning                                                             |
| -------------------- | ------------------------------ | ------------------------------------------------------------------- |
| `LOG_LEVEL`          | `info`                         | `debug`, `info`, `warn`, `error`.                                   |
| `LOG_FORMAT`         | `pretty` on a TTY, else `json` | JSON lines go to stderr; stdout is reserved for the stdio protocol. |
| `MCP_AUDIT_ENABLED`  | `true`                         | Emit one audit record per tool call.                                |
| `MCP_AUDIT_LOG_PATH` | —                              | Append audit JSON lines to this file instead of the logger.         |

Audit lines are written to stderr (or the file) directly and are not filtered by
`LOG_LEVEL`. An audit record looks like:

```json
{
  "time": "2026-09-28T03:20:00.000Z",
  "type": "audit",
  "principal": "clientA:auth0|ian",
  "client": "clientA",
  "subject": "auth0|ian",
  "transport": "http",
  "tool": "patch_note",
  "noteIds": ["BWf42IBwfgM6"],
  "ok": false,
  "code": "CONFLICT",
  "durationMs": 42,
  "era": "modern"
}
```

`principal` is `client` or `client:subject`: the OAuth client (`azp` /
`client_id`, or the static token id) and the user it acts for (`sub`). Rate
limits and idempotency keys are scoped by `principal`.

Outcome codes beyond the domain error codes: `PARTIAL` (a batch tool finished
with some per-operation failures), `ALL_FAILED` (every operation in the batch
failed), `INCOMPLETE` (an idempotent replay of a create that failed after the
note existed), and `INVALID_ARGUMENTS` (the SDK rejected the arguments against
the tool's schema; `details.invalidFields` names the offending argument names,
never their values). A successful `create_note` lists the created id in
`noteIds`.

Note bodies, titles, search terms and tokens are never logged. Fields whose
names look like secrets are redacted from any log line.
