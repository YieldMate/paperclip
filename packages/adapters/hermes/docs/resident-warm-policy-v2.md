# Resident warm policy v2 (`resident_warm_policy_v2`)

Flag env: `PAPERCLIP_RESIDENT_WARM_POLICY_V2`

| Value | Behaviour |
|-------|-----------|
| unset / `0` / `false` / `off` / `no` | **OFF** (default) — legacy stop-on-terminal keep/stop, no eviction, inert telemetry (`n_a` / `flag_off`) |
| `1` / `true` / `on` / `yes` | **ON** — per-disposition TTL, cwd identity reuse, LRU/RSS caps, telemetry columns filled |

Enable on Test/Production: set `PAPERCLIP_RESIDENT_WARM_POLICY_V2=1` and restart. Rollback: unset or set `0` and restart. No schema rollback required; columns remain nullable and inert under flag-off.

Telemetry columns (migration with this change-set):

- `resident_start_decision`
- `resident_warm_decision`
- `resident_warm_reason`
- `resident_warm_ttl_seconds`
- `resident_cwd_identity`
