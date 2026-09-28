# Parity matrix: triliumnext-mcp 0.3.17 → trilium-mcp 2.0

The old server (upstream `tan-yong-sheng/triliumnext-mcp` 0.3.17, the version the
`npx` configurations run; the local build was 0.3.13 without `patch_note`,
`list_children_notes`, `move_note`) exposed eleven tools. This table records what
happened to each in the clean-room rewrite. The old behaviour inventory that
this is based on was produced by reading the 0.3.17 source, not its docs, which
disagreed with the code in several places (noted below).

Legend: **retained** = same job, cleaner contract; **redesigned** = same job,
different inputs/outputs; **deferred** = intentionally absent from v1;
**omitted** = removed on purpose.

| Old tool | Decision | New tool | Notes |
| --- | --- | --- | --- |
| `search_notes` | redesigned | `search_notes` | Same `text` + `criteria` model (was `searchCriteria`), plus raw `query`, `ancestorNoteId`/`ancestorDepth`, `includeArchived`, `orderBy`, cursor pagination. Fixes: OR grouping no longer loses an OR when logic flips (`A OR B AND C` is `(A OR B) AND C`); invalid criteria raise `VALIDATION` instead of being dropped; smart dates (`TODAY-7`) work for note properties; `exists` on a note property is rejected instead of ignored; `not_contains` removed because Trilium's `!*=*` matches nothing. Uses ETAPI `limit`/`orderBy` params instead of DSL suffixes. Archived notes are excluded by default (old: always included). Output is structured summaries. |
| `resolve_note_id` | redesigned | `resolve_note` | Accepts `noteId`, `title` (partial or `exact`), or `path` (`A/B/C` from root). Returns `status` resolved/ambiguous/not_found with ranked candidates. Never auto-selects among several matches (old `autoSelect` removed). Old default `maxResults` was really 3, not 10. |
| `get_note` | retained | `get_note` | Returns `note.contentHash` (Trilium blobId) plus `content`, bounded by `maxContentBytes` with `contentTruncated`. `format=plain` strips HTML. `find` replaces `searchPattern` and cannot hang (old looped forever without the `g` flag). Binary/protected content is omitted with a reason. |
| — | new | `get_note_context` | Note + attributes + parents + bounded children (optional previews) in one call. |
| `list_children_notes` | retained | `list_children` | Tree order by default (from `childNoteIds`), or `title`/`dateCreated`/`dateModified`; paginated. One search call instead of N. |
| `read_attributes` | retained | `read_attributes` | Structured output with `attributeId` (old dropped it), `inherited` flag, filters by type/name. |
| `create_note` | redesigned | `create_note` | Markdown → HTML actually works (old wrapped Markdown in `<p>` before converting). `ifTitleExists` = error/create/return_existing replaces `forceCreate`, which was never forwarded. `idempotencyKey`. Relation targets resolve by noteId or exact title, including hidden built-in templates (Board, Calendar, …); failures are reported per attribute instead of swallowed. `file`/`image` types deferred. Code notes require `mime`. |
| `update_note` | redesigned | `patch_note` + `update_note_metadata` | Content: `patch_note` with `operation` replace/append/prepend/edit and mandatory `expectedHash`; conflict is a structured `CONFLICT` error carrying `currentHash`. A revision is created by default (`createRevision=false` to skip). Title/type/mime: `update_note_metadata`, no hash needed. Old file replacement path deferred. Old title-only update no longer demands `mode`. |
| `patch_note` (0.3.17) | redesigned | `patch_note` `operation=edit` | Literal and regex find/replace with `occurrence`/`all` disambiguation, applied atomically before one write. CSS/XPath selectors and line-number modes dropped: unbounded HTML re-serialisation risked silent damage; `find` + `edit` on plain text covers the workflows. |
| `manage_attributes` | redesigned | `manage_attributes` | One `operations` array with per-op results instead of one operation per call. `update`/`remove` accept `attributeId` or a unique `name`. Relation values resolve like `create_note`. ETAPI limits are surfaced (cannot retarget a relation or change `isInheritable`). |
| `move_note` | deferred | — | Needs branch semantics under test first (the old implementation deleted and recreated branches, losing prefix/position). Planned for a later release behind `trilium.write`. |
| `delete_note` | omitted (v1) | — | Destructive; the plan puts deletion behind `trilium.admin` with explicit approval in a later release. |
| `search_and_replace_note` (0.3.13) | omitted | — | Already unreachable in 0.3.17; covered by `patch_note` edits. |
| file upload (`fileUri`) | deferred | — | Base64/data-URI uploads were broken (`require` in ESM); binary attachments are out of v1 scope. |

## Behavioural differences worth knowing

- **Errors are results, not protocol errors.** Every failure comes back as an
  `isError` tool result whose `structuredContent` is `{error:{code,message,details}}`.
  The old server mixed thrown JSON-RPC errors, emoji text, and success-shaped
  `CONFLICT:` strings.
- **Structured output everywhere.** Each tool declares an `outputSchema`; the text
  block carries the same JSON for clients that ignore `structuredContent`.
- **Permissions are scopes.** `PERMISSIONS=READ;WRITE` still works for stdio and
  maps to `trilium.read trilium.write`. Tools a principal cannot use are not
  listed at all.
- **Content type on write.** Trilium's ETAPI only accepts `text/plain` bodies on
  `PUT /notes/{id}/content` regardless of note mime; verified live.
- **Search escaping.** Values containing `'` are double-quoted (verified: `''`
  doubling, which the old `list_children_notes` used, does not work).

## Environment variable mapping

| Old | New |
| --- | --- |
| `TRILIUM_API_URL` | same (default `http://localhost:8080/etapi`; `/etapi` appended if missing) |
| `TRILIUM_API_TOKEN` | same |
| `PERMISSIONS` | still honoured; prefer `TRILIUM_MCP_SCOPES` |
| `VERBOSE=true` | `LOG_LEVEL=debug` |
