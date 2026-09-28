# Threat model

Scope: the trilium-mcp server as deployed in two shapes: a local stdio child
process, and an internet-reachable Streamable HTTP service behind a reverse
proxy. Trilium itself stays on a private network; only this facade is exposed.

## Assets

1. The Trilium ETAPI token. It grants full read/write on the whole knowledge base.
2. Note content and metadata (personal, sometimes sensitive).
3. Integrity of notes (no silent overwrites, no lost edits).
4. Availability of Trilium (the MCP server must not become an amplifier).
5. Audit trail integrity.

## Trust boundaries

```
cloud agent ──HTTPS──▶ reverse proxy ──▶ trilium-mcp (HTTP) ──private──▶ Trilium ETAPI
local agent ──stdio──▶ trilium-mcp (stdio) ────────────────────private──▶ Trilium ETAPI
```

- Everything arriving over HTTP is untrusted until the bearer token verifies.
- Everything inside notes and search results is *data*. It is never interpreted
  as instructions by the server, and the server instructions tell the model the
  same. The server has no code paths that evaluate note content.
- The stdio process trusts its parent (the agent host) and gets scopes from its
  environment; there is no network authentication because the process boundary
  is the boundary.

## Threats and mitigations

| # | Threat | Mitigation | Residual risk |
| --- | --- | --- | --- |
| T1 | Token leakage to clients | The ETAPI token is read from the environment, sent only to `TRILIUM_API_URL`, never included in tool output, and redacted from logs by key-name matching (`token`, `secret`, `password`, `authorization`). | Misconfigured `TRILIUM_API_URL` pointing at an attacker host would leak it; validated as http(s) URL only. Keep it in the deployment secret store. |
| T2 | Unauthenticated remote access | `MCP_AUTH_MODE=none` is refused on non-loopback binds unless `MCP_DANGEROUSLY_ALLOW_UNAUTHENTICATED=true`. OIDC mode verifies signature (JWKS), issuer, audience, expiry; static mode uses constant-time comparison and ≥16-char tokens. Missing/invalid tokens get RFC 6750 challenges pointing at RFC 9728 metadata. | Token theft from a client. Short-lived access tokens (Auth0 default 24h; set lower) and refresh at the IdP. |
| T3 | Scope escalation | Tools are registered per request from the verified scopes, so an unauthorised tool is not even listed; the handler re-checks scope before running. `trilium.admin` grants nothing yet. | Scope claims are trusted from the IdP; configure the IdP so only intended clients can request `trilium.write`. |
| T4 | Prompt injection via note content | Content is returned as data in `structuredContent`; server never acts on it. Instructions to the model say so. Tool descriptions never reference dynamic data. | The *model* may still follow injected text. Out of scope for the server; mitigated by read-only scopes for exploratory agents. |
| T5 | Lost updates / concurrent overwrite | `patch_note` requires `expectedHash` (Trilium blobId), re-checks it immediately before writing, creates a revision by default, and returns the new hash. Conflicts are machine-readable (`CONFLICT` + `currentHash`). | ETAPI has no conditional PUT, so a microsecond race window remains between the re-check and the write. Revisions make it recoverable. |
| T6 | Duplicate creation on retries | `idempotencyKey` (per principal, 24h, in-memory) and `ifTitleExists=error` default. | In-memory store: a multi-instance or restarted deployment forgets keys. Run one instance, or accept `DUPLICATE` errors as the backstop. |
| T7 | Oversized requests / memory exhaustion | Body cap (`MCP_MAX_BODY_BYTES`, 413), content write cap, read truncation with explicit `contentTruncated`, children and page-size caps, regex edits reject zero-length patterns and cap match counts. | Trilium search itself can be expensive; the rate limiter bounds call volume. |
| T8 | Request flooding (DoS on Trilium) | Per-principal token bucket (`MCP_RATE_LIMIT_*`), anonymous keyed by client address; ETAPI timeouts and bounded retries (GET only). | Distributed flooding needs proxy-level limits; document at the proxy. |
| T9 | DNS rebinding / browser-originated abuse | Host and Origin validation (SDK middleware): automatic on loopback binds, `MCP_ALLOWED_HOSTS`/`MCP_ALLOWED_ORIGINS` otherwise. | Requires the proxy to pass the public `Host` through. |
| T10 | Injection into Trilium search DSL | Values are quoted with the rule verified live (single quotes, double quotes when the value contains `'`, backslash-escaped otherwise); attribute names are validated; note ids match `[A-Za-z0-9_]{1,64}`; the raw `query` escape hatch is limited to callers who already have read scope and can only run searches. | A read-scoped caller can craft arbitrary *searches* via `query`. That is the intended capability; there is no write path through search. |
| T11 | Path traversal in ETAPI paths | Every entity id is validated before URL construction. | — |
| T12 | Log-based leakage | Audit records carry principal, tool, note ids, outcome, latency; never titles, bodies, search terms, or tokens. Redaction applies to all log fields. | Note ids are quasi-identifiers; protect log storage accordingly. |
| T13 | Replay of captured bearer tokens | Expiry enforced; audience bound to `MCP_PUBLIC_URL` so a token for another API is rejected. | Tokens are bearer tokens; TLS at the proxy is mandatory. DPoP not implemented. |
| T14 | Cross-user data access | Single-tenant by design: every principal reaches the same Trilium. Authorization is "may this client call this tool", not per-note ACLs. | Do not grant `trilium.write` to automations you would not trust with the whole knowledge base. |
| T15 | Supply chain | Small dependency set (SDK packages, hono, jose, marked, zod); lockfile committed; container built from `node:24-alpine`, runs as non-root, production deps only. | Keep `npm audit` in CI. |
| T16 | Health endpoint leakage | `/healthz` returns only status, reachability, and server version. | — |

## Non-goals

- Per-note authorization or multi-user isolation.
- Protecting against a compromised agent host running the stdio process.
- Hiding the existence of the endpoint (it is authenticated, not secret).
