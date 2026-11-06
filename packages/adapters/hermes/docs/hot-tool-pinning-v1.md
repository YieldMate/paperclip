# Hot tool pinning v1 (`hot_tool_pinning_v1`)

Flag env: `PAPERCLIP_HOT_TOOL_PINNING_V1`

| Value | Behaviour |
|-------|-----------|
| unset / `0` / `false` / `off` / `no` | **OFF** (default): no refresh job, no overlay read, no pinning env on the Hermes child, no telemetry fields in `resultJson` |
| `1` / `true` / `on` / `yes` | **ON**: hourly hot-set refresh, per-run pinned-tools file, Hermes flag + file injected, telemetry merged into `resultJson` |

Enable on Test/Production: set `PAPERCLIP_HOT_TOOL_PINNING_V1=1` and restart (the refresh job is only scheduled at boot when the flag is on). Rollback: unset or set `0` and restart; no schema change, nothing to migrate. Committed `overlays/` files are inert while the flag is off.

Hermes counterpart: `tools/hot_tool_pinning.py` in `hermes-agent` (same flag, `HERMES_PINNED_TOOLS_FILE`, the 10 tool / 10k token caps, the usage-report counters).

## Hot set

Per agent: the top **10** tools by call count over a rolling **7 days** of `tool_call_events`, refreshed **hourly**.

- Counts use `event_type = 'call_completed'`. An agent with no completed calls in the window falls back to `call_started` counts (that agent only).
- Ties: the lexicographically earlier tool name ranks higher (so the later one is dropped first).
- Token cap: schemas come from the connection's catalog entry (`tool_catalog_entries.input_schema`, wire shape `{"type":"function","function":{name,description,parameters}}`). While the summed estimate exceeds **10,000**, the least-used tool is dropped and a warning is logged. Tools with no known schema count as 0 tokens.
- The token estimate is `ceil(len(json.dumps(wire)) / 4)` (Python `json.dumps` spacing), which equals Hermes' no-tiktoken fallback. Hermes re-measures with cl100k_base at run time and applies the same drop rule, so a tool near the boundary can still be dropped Hermes-side.

Code: `packages/adapters/hermes/src/server/hot-tool-pinning.ts` (`deriveHotSet`, flag, env wiring, telemetry merge) and `server/src/services/hot-tool-pinning.ts` (`queryAgentToolCounts`, `refreshPinnedToolsOverlays`, `ensureHourlyPinnedToolsRefresh`).

## Overlays

`overlays/<agentId>/pinned-tools.json` under the repo root, or under `PAPERCLIP_OVERLAYS_ROOT` when set. The refresh writes it atomically and leaves it untouched when the tool list is unchanged (no `updatedAt` churn). See `overlays/README.md` for the format.

## Per-run wiring (`execute.ts`)

Flag on, after the run directory exists:

1. Read `overlays/<agentId>/pinned-tools.json`, re-apply the 10 / 10k caps, write a run-local copy `…/runs/<runId>/mcp/pinned-tools.json` (mode `0600`, removed with the run directory).
2. Child env: `PAPERCLIP_HOT_TOOL_PINNING_V1=1`, `HERMES_HOT_TOOL_PINNING_V1=1`, `HERMES_PINNED_TOOLS_FILE=<run-local path>`.
3. No manifest (or no run id) means the flags are set but no file path; Hermes then pins nothing.
4. Resident turns re-send the same three variables per turn because the run directory of the turn that started the resident is gone by the next turn.

Flag off: `PAPERCLIP_HOT_TOOL_PINNING_V1`, `HERMES_HOT_TOOL_PINNING_V1`, `HERMES_PINNED_TOOLS_FILE` and `HERMES_PINNED_TOOLS` are explicitly unset, including values from the host environment or the agent's configured `env`. They are set to `undefined` rather than deleted because `runChildProcess` re-merges the host `process.env` under the run env.

## Telemetry

Hermes writes the counters into its usage JSON (`HERMES_USAGE_FILE`). Paperclip merges the preflight and primary reports into `executionResult.resultJson`:

| Field | Merge |
|-------|-------|
| `tool_search_calls` | sum |
| `tool_describe_calls` | sum |
| `tool_calls_total` | sum |
| `pinned_schema_tokens` | max |

Flag off: the four keys are absent. Flag on and Hermes reported nothing (older Hermes, crashed child): the keys are present as `null`. Hermes counters are process-wide, so a resident process reports cumulative values across its turns.

## CI: `pinned-tools-token-cap`

`.github/workflows/pinned-tools-token-cap.yml` runs on changes under `overlays/**` (and the checker itself):

```sh
node scripts/check-pinned-tools-token-cap.mjs --engine node
```

- Fails (exit 1) when a manifest has more than 10 tools or more than 10,000 estimated schema tokens.
- Fails loudly (exit 2) on an unreadable manifest or a tool without a schema, because its size cannot be checked (`--allow-missing-schemas` opts out).
- `--engine hermes` (or the default `auto` when `../hermes-agent` / `HERMES_AGENT_DIR` has it) runs Hermes' `scripts/ci/pinned_tools_token_cap.py` for an exact cl100k_base count; `auto` falls back to the Node estimate when that script cannot run (for example Python deps missing). No tiktoken dependency exists in this repo, so the Node estimate is chars/4 and can undercount.

Local: `pnpm check:pinned-tools-token-cap`, `pnpm test:pinned-tools-token-cap`.

## Known limits

- Tool names are stored as recorded in `tool_call_events.tool_name` (the provider tool name). Hermes matches pins against its registry names (for MCP tools, `mcp_<server>_<tool>`); until the two naming schemes are reconciled, a pin only takes effect for tools whose recorded name equals the Hermes registry name.
- The hourly refresh is a recurring job that queries the database, opt-in behind the flag; it skips ticks during idle drain and warm standby (`shouldRun`) and is not scheduled at all with the flag off.
