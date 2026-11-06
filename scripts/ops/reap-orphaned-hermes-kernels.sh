#!/usr/bin/env bash
# One-shot operator backstop (YIE-75 / R4): reap orphaned hermes_kernel_runner.py
# processes that were re-parented to PID 1 and have been running >24h.
#
# Live kernels of running chats are never touched — those stay under the
# in-process session reaper + parent watchdog. This script only kills:
#   ppid == 1  AND  process start age > 24h
#
# Usage (on the Paperclip host):
#   bash scripts/ops/reap-orphaned-hermes-kernels.sh
#   DRY_RUN=1 bash scripts/ops/reap-orphaned-hermes-kernels.sh
set -euo pipefail

MAX_AGE_SEC="${MAX_AGE_SEC:-86400}"
DRY_RUN="${DRY_RUN:-0}"

process_age_sec() {
  local pid="$1"
  local uptime_sec starttime ticks
  uptime_sec="$(awk '{print $1}' /proc/uptime 2>/dev/null || true)"
  [[ -n "$uptime_sec" ]] || return 1
  # Strip comm (may contain spaces/parens), then field 20 is starttime.
  starttime="$(sed -e 's/^.*) //' "/proc/${pid}/stat" 2>/dev/null | awk '{print $20}')"
  [[ -n "$starttime" ]] || return 1
  ticks=100
  if command -v getconf >/dev/null 2>&1; then
    ticks="$(getconf CLK_TCK 2>/dev/null || echo 100)"
  fi
  awk -v u="$uptime_sec" -v s="$starttime" -v t="$ticks" 'BEGIN { printf "%.0f", u - (s / t) }'
}

reaped=0
skipped=0
while read -r pid; do
  [[ -n "$pid" ]] || continue
  ppid="$(sed -e 's/^.*) //' "/proc/${pid}/stat" 2>/dev/null | awk '{print $2}')"
  if [[ "$ppid" != "1" ]]; then
    skipped=$((skipped + 1))
    continue
  fi
  age="$(process_age_sec "$pid" || echo 0)"
  if [[ "$age" -le "$MAX_AGE_SEC" ]]; then
    skipped=$((skipped + 1))
    continue
  fi
  echo "reap orphan hermes_kernel_runner.py pid=$pid age_sec=$age ppid=1"
  if [[ "$DRY_RUN" == "1" ]]; then
    reaped=$((reaped + 1))
    continue
  fi
  kill -TERM "$pid" 2>/dev/null || true
  sleep 2
  if [[ -e "/proc/$pid" ]]; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  reaped=$((reaped + 1))
done < <(pgrep -f 'hermes_kernel_runner\.py' || true)

echo "done reaped=$reaped skipped=$skipped dry_run=$DRY_RUN max_age_sec=$MAX_AGE_SEC"
