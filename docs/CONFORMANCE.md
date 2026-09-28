# Protocol conformance

`npm run conformance` builds the server, starts the HTTP entry point on
loopback against an in-memory fake Trilium, and runs the official
`@modelcontextprotocol/conformance` suite (pinned to 0.2.0-alpha.11, the
line that knows the 2026-07-28 revision) with `--requirements` for each revision.
`conformance-baseline.yml` lists scenarios that cannot pass against this server
and says why; any other failure fails the run.

Last run: 2026-09-28 against `@modelcontextprotocol/server` 2.1.0.

## What passes

| Revision   | Scenario                                                                                                                                                                                                                                                                                            | Checks                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 2025-11-25 | server-initialize, ping, tools-list, resources-list, prompts-list, dns-rebinding-protection, server-session-lifecycle, server-sse-polling, server-sse-multiple-streams                                                                                                                              | all                                                                                    |
| 2026-07-28 | tools-list, resources-list, prompts-list, sep-2164-resource-not-found, dns-rebinding-protection, caching, http-header-validation, server-sse-multiple-streams, input-required-result-{missing-input-response, unsupported-methods, ignore-extra-params, validate-input}, tasks-status-notifications | all                                                                                    |
| 2026-07-28 | server-stateless                                                                                                                                                                                                                                                                                    | 24 of 28; the 4 failing checks are "not testable" (they need diagnostic fixture tools) |

Both stdio and HTTP are additionally covered by the SDK client in
`tests/protocol`, which negotiates each era explicitly (`versionNegotiation`
auto vs. the 2025 `initialize` handshake) and asserts on the wire-level era.

## What is baselined, and why

The conformance server suite was written against the reference "everything"
server. Many scenarios call fixture tools by name (`test_simple_text`,
`test_sampling`, `json_schema_2020_12_tool`, tools with `x-mcp-header`
annotations) or exercise capabilities this server deliberately does not offer.
They are listed in `conformance-baseline.yml` under four headings:

1. **Fixture tools**: tools-call-_, json-schema-2020-12,
   http-custom-header-server-validation, elicitation-_, tools-call-sampling /
   -elicitation / -with-logging. A Trilium server has no reason to expose
   image/audio/sampling test tools.
2. **Capabilities not offered**: completion-complete, logging-set-level,
   resources-read-* / templates-read / subscribe / unsubscribe, prompts-get-*.
   `prompts/list` and `resources/list` are answered (empty, cacheable) so
   clients that probe them do not error; reads and subscriptions are reported
   as method-not-found, which the spec allows for undeclared sub-capabilities.
3. **input_required** (2026 server→client round trips): no tool needs user
   input mid-call. The four input-required scenarios that only verify the
   server rejects malformed or unsupported input requests pass.
4. **Tasks extension**: not implemented; optional by definition (SEP-1730).

Three scenarios (`server-sse-multiple-streams`,
`input-required-result-missing-input-response`,
`input-required-result-ignore-extra-params`) pass every check but emit a
warning. The alpha CLI reports them as unexpected failures on one revision and
as stale baseline entries on the other, so `scripts/conformance.ts` keeps them
in the baseline and tolerates the CLI's complaint only for those names and
only when their failed-check count is zero.

## Compatibility gaps recorded honestly

- **Legacy `logging/setLevel`** is answered method-not-found; the server does
  not emit `notifications/message`. Structured errors carry all diagnostics.
- **Tool list change notifications** (`notifications/tools/list_changed`) are
  not sent. The tool set is fixed per principal for the lifetime of a
  connection, and `tools/list` carries a 5-minute private cache hint on the
  2026 wire.
- **Sessions**: the HTTP endpoint is stateless for both eras (`legacy:
'stateless'`), so 2025-era `GET` streams and `DELETE` session termination
  answer 405. Every client tested (SDK client both eras, Inspector, Claude
  Code stdio) works statelessly. If a client turns out to require sessionful
  2025 behaviour, `isLegacyRequest` routing in front of the handler is the
  documented SDK path.

## Re-running one scenario

```bash
npx tsx scripts/conformance.ts -- --scenario server-stateless --verbose
```
