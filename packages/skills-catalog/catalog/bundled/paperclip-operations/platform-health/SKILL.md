---
name: platform-health
description: Detect and remediate Paperclip fleet health issues — budget hard-stops from pending/unpriced accounting, stuck lifecycle resumes, stranded decisions-desk recoveries, and unhealthy/expired tool connectors.
key: paperclipai/bundled/paperclip-operations/platform-health
recommendedForRoles:
  - devops
  - ceo
  - engineer
tags:
  - paperclip
  - ops
  - budget
  - accounting
  - health
  - connectors
---

# Platform Health

Keep the company fleet runnable. Prefer the ops APIs below over one-off database edits. Exit immediately when the accounting snapshot is empty **and** there are no due connector findings **and** the wake is not an operator diagnose request.

## Auth

If `$HERMES_PAPERCLIP_ENV_FILE` is set, run `set -a && . "$HERMES_PAPERCLIP_ENV_FILE" && set +a` before any curl (Hermes terminal children may scrub `$PAPERCLIP_API_KEY`).
Use Paperclip REST with `$PAPERCLIP_API_URL` (append `/api` if missing), `Authorization: Bearer $PAPERCLIP_API_KEY`, and `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID`. Never use MCP gateway overlay bearers for `/api` REST calls.

## Every wake

1. `GET /api/companies/{companyId}/ops/health/snapshot`
2. If `empty: false`, classify with the snapshot `findings[]` and the rules below.
3. While metadata `detectOnly` / `autoHeal: false` is set, only report proposals (comment or activity). Do not mutate.
4. When auto-heal is enabled and `empty: false`, call `POST /api/companies/{companyId}/ops/health/auto-heal` with `{ "dryRun": false, "maxActions": 10 }` for auto-safe classes, then re-check the snapshot.
5. **Connectors (hourly cadence):** Read `connectorFindings[]`. Escalate only rows with `reportDue: true`. Then `POST .../ops/health/connectors/acknowledge` with those fingerprints so the next wakes stay quiet for an hour. Never auto-reconnect OAuth.
6. **Operator diagnose:** When the wake prompt names an agent and a connector (example: Steve cannot access Linear), call `POST .../ops/health/connectors/diagnose` with `{ "agentName": "Steve", "applicationKey": "linear", "probe": true }` (or `connectionId` / `connectionName`). Report the `verdict` — connection unhealthy vs agent access gap while the connector itself is fine.
7. If `empty: true`, no due connector findings, and no diagnose request — stop. No comment beyond disposition `healthy`.

## Auto-safe classes

| Class | Action |
| --- | --- |
| `pre_provider_failure` | `POST .../ops/accounting/settle-pending-run` with `{ "runId", "mode": "pre_provider" }` |
| `pending_incomplete_receipt` with Hermes session | settle with `{ "mode": "hermes_estimate" }` (or `auto`) |
| `bad_unpriced_event` | settle with `{ "mode": "clear_unpriced", "costEventId" }` |
| `stuck_resuming` | `POST .../ops/agents/{agentId}/reconcile-and-resume` |
| Budget pause without true overspend | reconcile-and-resume after pending/unpriced heals |
| `workspace_validation_stranded` with project `repoUrl` | auto-heal action `repair_project_workspace_git` (materialize managed checkout, bind `cwd`, clear bad execution workspace, retry/wake). Do **not** desk-resolve as restored. |

Never invent a $0 receipt when billable evidence exists. Never resume `manual` / `setup` pauses or true overspend.

## Connector classes

| Class | Meaning | Action |
| --- | --- | --- |
| `connector_unhealthy` | Active connection `healthStatus` needs attention (`error`, `failed`, `degraded`, `missing_secret`) — often expired OAuth | Escalate for human reconnect; optional `POST .../connectors/probe` to refresh evidence |
| `connector_stale_probe` | Active connection has not been health-checked recently | Prefer `POST .../connectors/probe`; escalate only if probe stays bad |

System worker already probes eligible connections about every 15 minutes. MEDIC reports due connector findings about every hour (`metadata.connectorCheckIntervalSec`, default 3600) so wakes do not spam.

## Escalate

- True overspend (`spent >= budget`)
- Unpriced usage with no Hermes/provider evidence
- `workspace_validation_stranded` without a repairable project `repoUrl`
- Same fingerprint healed ≥ 3 times today (loop cap)
- Cross-company or destructive requests
- `connector_unhealthy` / OAuth reconnect required
- Diagnose verdict `agent_missing_tools` / `agent_policy_blocks_tools` while the connection is healthy (operator/platform assignment issue, not expired token)

Post one short comment naming the agent, run id / connection id, class, and why it needs a human. Prefer Decisions desk verbs over silent force-resume.

## Decisions desk follow-up

Auto-heal applies safe desk work when `applyDeskTriage` is true (default). Prefer the privileged ops endpoints — agents cannot board-retry or board-resolve directly.

1. `GET /api/companies/{companyId}/ops/health/desk-triage` — proposals include complete bodies and `autoApplySafe`.
2. `POST /api/companies/{companyId}/ops/health/apply-desk-triage` with `{ "dryRun": false, "maxActions": 10 }` — board-privileged retries (`retry_failed_run`) and safe resolves (`resolve_recovery_action` with `outcome` + `sourceIssueStatus`).
3. Skip proposals with `autoApplySafe: false` (budget-paused assignees, reconciliation/workspace causes including `workspace_validation_failed`, human blockers).
4. For `blocker_attention`, inspect heartbeat-context; do not invent unblockers.
5. For `workspace_validation_stranded`, rely on auto-heal `repair_project_workspace_git` — never call `recovery-actions/resolve` yourself for that cause.

Do not call `/api/agents/{id}/wakeup` with `failedRunId` or `/recovery-actions/resolve` yourself from MEDIC — use apply-desk-triage / auto-heal.
Do not retry paid work while a budget hold remains.

## Audit

Every applied heal should leave `platform_health.heal` activity with fingerprint, class, run id, and evidence. Prefer the auto-heal endpoint so loop caps are enforced server-side.
Connector escalations leave `platform_health.connector_alert` via diagnose/acknowledge.

## Don't

- Delete non-zero unpriced events
- Bypass `unpriced_usage_policy` by inserting fake reported costs
- Wake stranded issue recovery while the assignee is still budget-paused
- Auto-reconnect OAuth or invent connector credentials
- Overload CHO/GOMEZ/Atlas with this role — MEDIC owns platform health
