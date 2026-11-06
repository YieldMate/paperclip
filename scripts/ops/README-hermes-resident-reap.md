# Hermes resident / kernel reap (YIE-75)

## Adapter sweep (always on after deploy)

`packages/adapters/hermes/src/server/resident.ts`:

- Per-issue state: `hermes-runtime/residents/<issueId>.json` with `lastUsedAt`
- `sweepStaleResidents(runtimeDir)` on every Hermes wake + hourly `setInterval`
- Reaps when `now - (lastUsedAt ?? startedAt) > 24h` (strictly greater)
- Pid-reuse guard before SIGTERM

## One-shot host backstop

`scripts/ops/reap-orphaned-hermes-kernels.sh` — kill only `hermes_kernel_runner.py`
with **ppid == 1** and age **> 24h**. Live chat kernels (non-orphaned) are untouched.

```bash
DRY_RUN=1 bash scripts/ops/reap-orphaned-hermes-kernels.sh
bash scripts/ops/reap-orphaned-hermes-kernels.sh
```
