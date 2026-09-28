# trilium-mcp

A Model Context Protocol server for [TriliumNext Notes](https://github.com/TriliumNext/Trilium).
One implementation, two doors:

- **stdio** for local agents (Claude Code, Codex, Claude Desktop);
- **authenticated Streamable HTTP** for cloud agents (Claude, ChatGPT, Grok, scheduled tasks).

Built on the MCP TypeScript SDK v2. Serves both the 2025 protocol family and the
2026-07-28 revision from the same code. The Trilium ETAPI token stays on the
server; clients authenticate with OAuth bearer tokens and get only the tools
their scopes allow.

This is a clean-room replacement for the `triliumnext-mcp` prototype. See
[docs/PARITY.md](docs/PARITY.md) for what changed and why.

## Tools

| Tool                   | Scope | What it does                                                                                                         |
| ---------------------- | ----- | -------------------------------------------------------------------------------------------------------------------- |
| `search_notes`         | read  | Full-text, structured criteria (labels, relations, properties, hierarchy), or raw Trilium query; paginated summaries |
| `resolve_note`         | read  | Title/path/id → note id; reports ambiguity instead of guessing                                                       |
| `get_note`             | read  | Metadata, attributes, bounded content, `contentHash`, in-content find                                                |
| `get_note_context`     | read  | Note + parents + children (optional previews) in one call                                                            |
| `list_children`        | read  | Direct children in tree order, paginated                                                                             |
| `read_attributes`      | read  | Labels and relations, owned or inherited                                                                             |
| `create_note`          | write | Markdown/HTML/plain content, attributes, duplicate detection, idempotency key                                        |
| `patch_note`           | write | Hash-protected replace/append/prepend/edit with automatic revision                                                   |
| `update_note_metadata` | write | Title, type, mime                                                                                                    |
| `manage_attributes`    | write | Add/update/remove labels and relations with per-operation results                                                    |

Deletion, moves, and binary attachments are intentionally absent from this
release.

## Quick start (local stdio)

```bash
npm install
npm run build
TRILIUM_API_URL=https://trilium.example.net/etapi \
TRILIUM_API_TOKEN=... \
node dist/stdio.js
```

Claude Code / Codex configuration:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/trilium-mcp/dist/stdio.js"],
  "env": {
    "TRILIUM_API_URL": "https://trilium.example.net/etapi",
    "TRILIUM_API_TOKEN": "...",
    "TRILIUM_MCP_SCOPES": "trilium.read trilium.write"
  }
}
```

Try it with the Inspector: `npm run inspector`.

## HTTP on loopback (development)

```bash
TRILIUM_API_URL=... TRILIUM_API_TOKEN=... node dist/http.js
# POST http://127.0.0.1:3939/mcp — no auth on loopback by default
```

With dev tokens:

```bash
MCP_AUTH_MODE=static MCP_STATIC_TOKENS='dev@a-long-random-token:trilium.read+trilium.write' node dist/http.js
```

Production deployment (container, reverse proxy, OIDC with Auth0) is described
in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and [docs/AUTH0.md](docs/AUTH0.md).

## Development

```bash
npm run check            # typecheck + lint + format + unit/protocol tests
npm run test:integration # spins up a throwaway Trilium container (Docker)
npm run conformance      # official MCP conformance suite, both protocol revisions
docker build -t trilium-mcp .
```

Layout:

```
src/etapi        typed ETAPI client (fetch, timeouts, retries, normalized errors)
src/domain       services: search, notes, attributes, content normalization, query builder
src/mcp          tool definitions (Zod schemas), server factory, scopes, audit wrapper
src/auth         token verifiers (static, OIDC/JWKS)
src/transport    Hono HTTP app: auth gate, rate limit, health, RFC 9728 metadata
src/stdio.ts     stdio entry point        src/http.ts  HTTP entry point
tests/unit       against an in-memory fake Trilium (tests/helpers/fakeTrilium.ts)
tests/protocol   both protocol eras over HTTP (in-process) and stdio (spawned)
tests/integration real Trilium in Docker
```

Documentation: [configuration](docs/CONFIGURATION.md), [parity matrix](docs/PARITY.md),
[threat model](docs/THREAT_MODEL.md), [deployment](docs/DEPLOYMENT.md),
[client migration](docs/MIGRATION.md), [Auth0 setup](docs/AUTH0.md),
[conformance](docs/CONFORMANCE.md).

## License

MIT. The original prototype this repository forked from is by
[tan-yong-sheng](https://github.com/tan-yong-sheng/triliumnext-mcp); no code
from it remains.
