# Client migration and cutover

Reversible, one client at a time. The old servers stay installed until the last
step.

## Current state (2026-09-27)

| Client                                    | Entry                                   | Server                                         |
| ----------------------------------------- | --------------------------------------- | ---------------------------------------------- |
| Claude Desktop                            | `npx triliumnext-mcp`                   | upstream 0.3.17                                |
| Codex `[mcp_servers.trilium]`             | `npx -y triliumnext-mcp`                | upstream 0.3.17                                |
| Codex `[mcp_servers.triliumnext-mcp]`     | `node …/triliumnext-mcp/build/index.js` | local 0.3.13 (self-contained copy in `build/`) |
| Claude Code (project `/Users/ianwalther`) | `node …/triliumnext-mcp/build/index.js` | local 0.3.13                                   |
| Claude.ai / Grok / ChatGPT                | none                                    | —                                              |

## Step 1: local stdio in parallel (read-only pilot)

Add the new server under a name that does not exist yet (`trilium-v2`), with
read scope only, and leave every existing entry in place:

```json
"trilium-v2": {
  "command": "node",
  "args": ["/Users/ianwalther/code/triliumnext-mcp/dist/stdio.js"],
  "env": {
    "TRILIUM_API_URL": "https://trilium.ianwalther.com/etapi",
    "TRILIUM_API_TOKEN": "<token>",
    "TRILIUM_MCP_SCOPES": "trilium.read"
  }
}
```

Codex (`~/.codex/config.toml`), likewise a new table:

```toml
[mcp_servers.trilium-v2]
command = "node"
args = ["/Users/ianwalther/code/triliumnext-mcp/dist/stdio.js"]

[mcp_servers.trilium-v2.env]
TRILIUM_API_URL = "https://trilium.ianwalther.com/etapi"
TRILIUM_API_TOKEN = "<token>"
TRILIUM_MCP_SCOPES = "trilium.read"
```

Enable `trilium.write` on the pilot entry only after the parity check below
and after the concurrent-write regressions (`tests/unit/auditRegressions.test.ts`)
pass on the build you run.

Tool names and result shapes changed deliberately (see [PARITY.md](PARITY.md));
Codex per-tool approval keys move with them: `resolve_note_id` → `resolve_note`,
`list_children_notes` → `list_children`, `update_note` → `patch_note` /
`update_note_metadata`.

## Step 2: parity check

Run the same prompts against both servers on representative workflows:

- journal: `resolve_note` a day note by path, `get_note_context` on the month;
- planning: `search_notes` with `#project` criteria and a date range;
- attributes: `read_attributes` / `manage_attributes` on a test note;
- hierarchy: `list_children` of a large folder, compare counts.

Differences to expect are listed in [PARITY.md](PARITY.md).

## Step 3: remote

Deploy per [DEPLOYMENT.md](DEPLOYMENT.md), configure the IdP per
[AUTH0.md](AUTH0.md), then add the connector URL
`https://mcp.ianwalther.com/trilium/mcp` in Claude, Grok, and ChatGPT.
Grant `trilium.read` only to begin with; enable `trilium.write` after a
read-only week.

## Step 4: scheduled agents

Start with a read-only routine (e.g. weekly journal digest). For the first
write automation, give it its own IdP client with `trilium.write`, target one
subtree, and review `audit.jsonl` after the first runs.

## Step 5: retire

Rename `trilium-v2` to `trilium`, remove the four old entries above and the
duplicate `[mcp_servers.triliumnext-mcp]` entry, then the `build/` directory.
The legacy rollback reference is branch `tool_defs` (and its preserved
`build/`), not `main`; tag it before deleting anything.
