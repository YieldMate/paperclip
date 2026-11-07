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
- Per-model `cost_events.cost_status` falls back to the receipt-level status
  (priced siblings of an unpriced model are again labeled `unpriced`)
- Hermes adapter still writes usage/disposition files and still applies harness disposition

`tool_call_events.latency_ms` population is **not** gated — filling the existing column is always safe.

## DeepSeek OpenRouter rate card (Hermes)

Bundled OpenRouter rates for `deepseek/deepseek-v3.2` /
`deepseek/deepseek-v3.2-20251201` (`$0.26` / `$0.38` / `$0.13` per 1M, catalog
2026-11-06) are additive. Removing the entry restores `costStatus: unpriced`
for those parts when live `/models` also misses the id.

## Hermes side

Local token estimates when a provider omits usage always run (needed for
`HERMES_USAGE_FILE` / cost receipts). No separate Hermes env flag.

## Rollback without redeploy

On `paperclip-sg-1`, set `PAPERCLIP_PERF_TELEMETRY=0` in the Paperclip service
environment and restart the process. Deploy of prior commits is not required
for phase/process-clock rollback.
