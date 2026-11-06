# Pinned-tool overlays (hot tool pinning v1, YIE-70)

```
overlays/
  <agentId>/pinned-tools.json   # one manifest per agent, written by the hourly refresh
  _example/pinned-tools.json    # fixture: tiny schemas, well under the cap
```

Each manifest lists the agent's **hot set**: the top 10 tools by `call_completed` count in
`tool_call_events` over the last 7 days (ties: lexicographically earlier tool name). The set is
refreshed hourly by `ensureHourlyPinnedToolsRefresh` (`server/src/services/hot-tool-pinning.ts`) and
capped at 10 tools and 10,000 schema tokens (least-used tools are dropped, and logged, past the cap).

```json
{
  "version": 1,
  "agentId": "<agentId>",
  "updatedAt": "2026-11-06T00:00:00.000Z",
  "window": { "days": 7, "eventType": "call_completed" },
  "tools": [{
    "name": "mcp__paperclip_assigned__mcp_linear_abc12345_get_issue",
    "gatewayToolName": "mcp.linear-abc12345:get_issue",
    "callCount": 42,
    "schema": { "name": "mcp__paperclip_assigned__mcp_linear_abc12345_get_issue", "description": "...", "parameters": {} }
  }]
}
```

## Flag

Everything is behind `PAPERCLIP_HOT_TOOL_PINNING_V1` (default **off**; `1`/`true`/`on`/`yes` enables).
Off: no refresh job, no manifest read, and the Hermes child gets none of `PAPERCLIP_HOT_TOOL_PINNING_V1`,
`HERMES_HOT_TOOL_PINNING_V1`, `HERMES_PINNED_TOOLS_FILE`, `HERMES_PINNED_TOOLS`. On: a run-local copy of
the agent's manifest is written to the run directory and passed as `HERMES_PINNED_TOOLS_FILE`.

## Location

`PAPERCLIP_OVERLAYS_ROOT` overrides the root; otherwise it is `overlays/` at the repository root (nearest
ancestor of the working directory with `pnpm-workspace.yaml`). Folder names must be a plain agent id
(`[A-Za-z0-9._-]`, no `..`), so `_example` is never read at run time.

## CI

`pinned-tools-token-cap` runs `node scripts/check-pinned-tools-token-cap.mjs` when anything under
`overlays/` changes. With `../hermes-agent` present the script can instead call Hermes'
`scripts/ci/pinned_tools_token_cap.py` (`--engine hermes`, exact cl100k_base); CI uses the built-in
estimate. See `packages/adapters/hermes/docs/hot-tool-pinning-v1.md`.
