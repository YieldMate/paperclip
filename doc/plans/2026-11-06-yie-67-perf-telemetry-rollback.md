# YIE-67 perf telemetry — flag and rollback

## Flag

`PAPERCLIP_PERF_TELEMETRY` (process env on the Paperclip server):

| Value | Effect |
| --- | --- |
| unset / anything other than off | **ON** (default) |
| `0` / `false` / `off` / `no` | **OFF** |

When OFF:

- No `run.phase.*` lifecycle events
- No `process_started_at` clamp (legacy OS-PID-birth behaviour returns)
- No `dispositionApplied` stamping on `heartbeat_runs.result_json`
- Hermes adapter still writes usage/disposition files and still applies harness disposition

`tool_call_events.latency_ms` population is **not** gated — filling the existing column is always safe.

## Hermes side

Local token estimates when a provider omits usage always run (needed for
`HERMES_USAGE_FILE` / cost receipts). No separate Hermes env flag.

## Rollback without redeploy

On `paperclip-sg-1`, set `PAPERCLIP_PERF_TELEMETRY=0` in the Paperclip service
environment and restart the process. Deploy of prior commits is not required
for phase/process-clock rollback.
