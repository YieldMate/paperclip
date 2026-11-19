---
name: platform-health
description: Detect and remediate Paperclip fleet health issues — budget hard-stops from pending/unpriced accounting, stuck lifecycle resumes, and stranded decisions-desk recoveries.
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
---

# Platform Health

Keep the company fleet runnable. Prefer the ops APIs below over one-off database edits. Exit immediately when the health snapshot is empty.

## Auth

If `$HERMES_PAPERCLIP_ENV_FILE` is set, run `set -a && . "$HERMES_PAPERCLIP_ENV_FILE" && set +a` before any curl (Hermes terminal children may scrub `$PAPERCLIP_API_KEY`).
Use Paperclip REST with `$PAPERCLIP_API_URL` (append `/api` if missing), `Authorization: Bearer $PAPERCLIP_API_KEY`, and `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID`. Never use MCP gateway overlay bearers for `/api` REST calls.

## Every wake

1. `GET /api/companies/{companyId}/ops/health/snapshot`
2. If `empty: true`, stop. No comment.
3. Otherwise classify with the snapshot `findings[]` and the rules below.
4. While metadata `detectOnly` / `autoHeal: false` is set, only report proposals (comment or activity). Do not mutate.
5. When auto-heal is enabled, call `POST /api/companies/{companyId}/ops/health/auto-heal` with `{ "dryRun": false, "maxActions": 10 }` for auto-safe classes, then re-check the snapshot.

## Auto-safe classes

| Class | Action |
| --- | --- |
| `pre_provider_failure` | `POST .../ops/accounting/settle-pending-run` with `{ "runId", "mode": "pre_provider" }` |
| `pending_incomplete_receipt` with Hermes session | settle with `{ "mode": "hermes_estimate" }` (or `auto`) |
| `bad_unpriced_event` | settle with `{ "mode": "clear_unpriced", "costEventId" }` |
| `stuck_resuming` | `POST .../ops/agents/{agentId}/reconcile-and-resume` |
| Budget pause without true overspend | reconcile-and-resume after pending/unpriced heals |

Never invent a $0 receipt when billable evidence exists. Never resume `manual` / `setup` pauses or true overspend.

## Escalate

- True overspend (`spent >= budget`)
- Unpriced usage with no Hermes/provider evidence
- Same fingerprint healed ≥ 3 times today (loop cap)
- Cross-company or destructive requests

Post one short comment naming the agent, run id, class, and why it needs a human. Prefer Decisions desk verbs over silent force-resume.

## Decisions desk follow-up

Auto-heal applies safe desk work when `applyDeskTriage` is true (default). Prefer the privileged ops endpoints — agents cannot board-retry or board-resolve directly.

1. `GET /api/companies/{companyId}/ops/health/desk-triage` — proposals include complete bodies and `autoApplySafe`.
2. `POST /api/companies/{companyId}/ops/health/apply-desk-triage` with `{ "dryRun": false, "maxActions": 10 }` — board-privileged retries (`retry_failed_run`) and safe resolves (`resolve_recovery_action` with `outcome` + `sourceIssueStatus`).
3. Skip proposals with `autoApplySafe: false` (budget-paused assignees, reconciliation/workspace causes, human blockers).
4. For `blocker_attention`, inspect heartbeat-context; do not invent unblockers.

Do not call `/api/agents/{id}/wakeup` with `failedRunId` or `/recovery-actions/resolve` yourself from MEDIC — use apply-desk-triage.
Do not retry paid work while a budget hold remains.

## Audit

Every applied heal should leave `platform_health.heal` activity with fingerprint, class, run id, and evidence. Prefer the auto-heal endpoint so loop caps are enforced server-side.

## Don't

- Delete non-zero unpriced events
- Bypass `unpriced_usage_policy` by inserting fake reported costs
- Wake stranded issue recovery while the assignee is still budget-paused
- Overload CHO/GOMEZ/Atlas with this role — MEDIC owns platform health
