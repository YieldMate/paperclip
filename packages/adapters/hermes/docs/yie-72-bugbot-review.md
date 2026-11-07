# YIE-72 self-review / bugbot notes (vs main)

`/review-bugbot` is not attached to Project workers. Self-review against
`master`/`main` tip behavior. Committed so reviewers can see it on the branch
(Corin YIE-266 FAIL item 3).

## Scope reviewed

Paperclip branch `cursor/yie-72-event-driven-reclaim-e424` (Hermes: no delta,
tip pin only).

## Findings fixed during implementation

1. **Wrong lease owner in Elena module anchors** — shared-workspace busy is
   Paperclip heartbeat, not Hermes resident reap. Implemented in
   `server/src/services/heartbeat/*` + wake/run rows.
2. **Drizzle subquery aliases** — JSON projections for waiter lookup needed
   `.as(...)` or reclaim silently failed.
3. **Date bind in due-busy scan** — used `lte(column, now)` instead of raw
   `sql` Date bind (postgres.js type error).
4. **claimed_at overwrite on queue claim** — flag-on path preserves earlier
   parked_reclaim/safety_net `claimed_at` and only coalesces `claim_reason` to
   `fresh` when unset.
5. **Stale-holder test fixture** — project-workspace silent holder past 1h
   allows dispatch; execution-workspace sandbox stale path is the fail-closed
   guard (matches existing suite).

## Round-1 NO-GO follow-ups (Corin YIE-266)

6. **r1 §6 two-parked-wakes variant** — added as test `3b` alongside the
   existing event+timer race (test 3): two queued wakes for one
   `(agent, issue)`, one release → exactly one CAS claim (`parked_reclaim` on
   earliest; second stays parked).
7. **This review committed** into
   `packages/adapters/hermes/docs/yie-72-bugbot-review.md` for reviewer access.

## Elena re-RfD delta (consolidated A/B1–B4)

8. **B1 attribution** — on successful reclaim, emit both
   `workspace_release_claim_attempted` (Steve A) and
   `workspace_released_requeue` (Corin B1). Safety-net never emits the latter.
9. **B2(4) double-release** — test `3c` fires release twice; exactly one
   `workspace_released_requeue` / one `parked_reclaim`.
10. **B3 holder-still-live** — refuse reclaim while holder status is `running`
    (`outcome=holder_still_live`).

## Residual / accepted

- No AMQP `run_queue` transport — in-process release hook + Postgres
  (documented in `event-driven-reclaim-v1.md` / module header).
- First-party telemetry uses run-log events (instance-local); proposal-marker
  `track()` deferred (privacy/schema gate).
- Flag default OFF; live enablement is a separate deploy step.
- Literal single-TX of lease-clear + wake-claim: N/A for Paperclip (issue
  execution release is wake-queue TX; park-time 300s safety net closes the
  “release succeeded but nobody ever fires” window).
- Hermes “lease file” sweep: N/A — no hermes lease files; holder is a DB run
  with existing 1h stale cutoff.

## Verdict

Branch-level automated suite covers r1 §6 variants (including 3b). Live deploy
+ flag enablement remain the coordinator's next step before Corin round-2.
