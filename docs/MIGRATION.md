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

## Step 1: local stdio in parallel

Add the new server under a new name so both are available:

```json
"trilium": {
  "command": "node",
  "args": ["/Users/ianwalther/code/triliumnext-mcp/dist/stdio.js"],
  "env": {
    "TRILIUM_API_URL": "https://trilium.ianwalther.com/etapi",
    "TRILIUM_API_TOKEN": "<token>",
    "TRILIUM_MCP_SCOPES": "trilium.read trilium.write"
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.trilium]
command = "node"
args = ["/Users/ianwalther/code/triliumnext-mcp/dist/stdio.js"]

[mcp_servers.trilium.env]
TRILIUM_API_URL = "https://trilium.ianwalther.com/etapi"
TRILIUM_API_TOKEN = "<token>"
TRILIUM_MCP_SCOPES = "trilium.read trilium.write"
```

Codex per-tool approval keys change with the tool names: `resolve_note_id` →
`resolve_note`, `list_children_notes` → `list_children`, `update_note` →
`patch_note` / `update_note_metadata`.

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

Remove the four old entries above, the duplicate `[mcp_servers.triliumnext-mcp]`
entry, and the `build/` directory. Archive the `main` branch state as a tag.
