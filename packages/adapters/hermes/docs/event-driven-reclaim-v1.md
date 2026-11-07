# Event-driven workspace reclaim (YIE-72)

Flag-gated reclaim so a parked `workspace_busy` wake is claimed as soon as the
shared-workspace holder releases, instead of waiting for the legacy
60 s + 60 s jitter blind retry.

## Flag

```bash
PAPERCLIP_EVENT_DRIVEN_RECLAIM_V1=1
```

Alias (Elena): `WORKSPACE_EVENT_DRIVEN_CLAIM_ENABLED=1`

**Default: OFF.** Enable only after In Review evidence is posted.

Optional injectable safety-net delay for tests:

```bash
PAPERCLIP_WORKSPACE_BUSY_SAFETY_NET_MS=300000   # default when flag on
```

## Behavior (flag ON)

1. On `WORKSPACE_BUSY` park, schedule the retry with a **300 s** safety-net due
   time (optional 10 s jitter), not 60 s + 60 s jitter.
2. When a holder run releases issue/workspace execution, emit an in-process
   `workspace_released` reclaim (Postgres wake/run path; no AMQP bus today) and
   CAS-claim the earliest queued wake for the waiter `(agentId, issueId)`.
3. Winner stamps `agent_wakeup_requests.claim_reason = parked_reclaim` and
   promotes the linked `scheduled_retry` to `queued` immediately.
4. If the release hook misses, the safety-net timer promotes with
   `claim_reason = safety_net`.
5. Fresh (non-parked) claims stamp `claim_reason = fresh`.
6. `workspace_busy_retries` counts contention; cohort for p95 is
   `workspace_busy_retries >= 1`.
7. `HOLDER_STALE_CUTOFF` / `WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS` remains **3600 s**.

## Rollback (flag OFF)

Unset or set `PAPERCLIP_EVENT_DRIVEN_RECLAIM_V1=0` and restart:

- Release-hook reclaim is skipped.
- Park delay restores `WORKSPACE_BUSY_RETRY_BASE_DELAY_MS = 60000` + 60 s jitter.
- No new `claim_reason` values are written; prior rows are inert.
- No residual subscriptions or parked-wake map state (state is Postgres only).

## Measurement

Canonical latency: `agent_wakeup_requests.requested_at → claimed_at`.

Run-log lifecycle events (holder run):

| Message | When |
| --- | --- |
| `workspace_release_claim_attempted` | Every release-hook attempt (`outcome ∈ {success, no_pending_wake, race_lost, holder_still_live, …}`) — Steve §A |
| `workspace_released_requeue` | **Only** on successful event-driven reclaim (`claim_reason=parked_reclaim`) — Corin B1 attribution |

Safety-net promotions stamp `claim_reason=safety_net` and never emit
`workspace_released_requeue`, so the two promotion paths are distinguishable.

B3: if the holder run is still `running`, the hook records
`outcome=holder_still_live` and does not promote waiters.
