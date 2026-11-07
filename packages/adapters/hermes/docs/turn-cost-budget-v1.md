# Turn/cost budget v1 (`turn_cost_budget_v1`)

Flag env: `PAPERCLIP_TURN_COST_BUDGET_V1`

| Value | Behaviour |
|-------|-----------|
| unset / `0` / `false` / `off` / `no` | **OFF** (default): no soft `--max-turns` override, no checkpoint/hard-limit dispositions, no budget telemetry |
| `1` / `true` / `on` / `yes` | Flag on; still requires `adapterConfig.budget.enabled=true` before any enforcement |

Enable on Test/Production only after coordinator OK: set `PAPERCLIP_TURN_COST_BUDGET_V1=1`, set `budget.enabled` on the target agent(s), restart. Rollback: unset/`0` the env flag and/or set `budget.enabled=false` and restart — prior behaviour restored completely (no schema migration).

Do **not** enable alongside a live regression of prior flags: `PAPERCLIP_RESIDENT_WARM_POLICY_V2`, `PAPERCLIP_PER_ISSUE_EXECUTION_CWD`, `PAPERCLIP_HOT_TOOL_PINNING_V1` (and `PAPERCLIP_EVENT_DRIVEN_RECLAIM_V1` if later enabled).

## Defaults (Elena decision)

| Knob | Default |
|------|---------|
| `budget.turns` | 40 |
| `budget.costUsd` | 1.5 (advisory in v1) |
| `budget.tokenTurns` | 8_000_000 (guideline / telemetry) |
| `budget.checkpointThreshold` | 0.8 → soft stop at 32 turns |
| `budget.enforceHardCost` | false |

Nested `budget: { … }` objects are also accepted; nested wins over dotted keys.

## Soft checkpoint (R1/R2)

When flag + `budget.enabled` are on:

1. Hermes `--max-turns` is clamped to `floor(turns * checkpointThreshold)` (min 1).
2. After the child/resident exits, if usage `api_calls` ≥ soft max and the disposition is not already terminal (`done` / `in_review` / `blocked` / `cancelled`):
   - Atomically write disposition `{ status: "in_progress", comment: "Checkpoint before budget limit…" }` to the **resolved absolute** `$HERMES_DISPOSITION_FILE` path.
   - PATCH the issue with `executionPolicy.monitor.{ nextCheckAt: now, notes: "budget checkpoint" }` (registered wait target — not a comment-named child).
   - Keep the same `{companyId,agentId,issueId}` resident warm (`in_progress` TTL, typically 900s); never re-key or evict on checkpoint.
   - Exit 0 so the harness applies disposition and re-wakes promptly.
3. Emit run-log phase `budget_checkpoint_fired` with budget/measured turns, cost fields, and agent/issue/run ids.

## Hard limit (R4)

When measured turns ≥ `budget.turns`, or when `budget.enforceHardCost` is on and cost is over the bar / untrustworthy:

1. Write terminal `blocked` disposition naming the budget reason (atomic write-temp-then-rename).
2. **Stop** the resident (no auto-continue).
3. Non-zero exit + `budget_hard_limit_hit` event.
4. Cost alone never auto-continues; bad cost data fails safe to blocked when hard cost is enforced.

## Out of scope on this ticket

- Cheap-preflight `smartModelRouting.separatePreflight=false` is a config-only platform-maintenance change — not pushed from YIE-73.
- Live Test multi-turn promotion checklist (Corin §1.3) remains a separate gate after coordinator deploy OK.

## Code

- `packages/adapters/hermes/src/server/turn-cost-budget.ts` — flag, config resolve, decision, atomic disposition write, monitor PATCH helper
- `packages/adapters/hermes/src/server/execute.ts` — soft max-turns, post-exit checkpoint/hard-limit, telemetry in `resultJson.budget`
- `server/src/services/heartbeat/run-completion.ts` — harness applies `disposition.monitor` when present
