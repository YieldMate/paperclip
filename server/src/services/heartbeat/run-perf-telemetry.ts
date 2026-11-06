/**
 * YIE-67 run lifecycle phase telemetry (run-log only).
 *
 * Flag: PAPERCLIP_PERF_TELEMETRY — default ON. Set to 0/false/off to roll back
 * phase emissions, dispositionApplied stamping, and process_started_at clamping
 * without redeploying a prior binary. Tool-call latency_ms writes stay on
 * (schema column fill; zero risk) and are not gated here.
 */

export const RUN_PERF_PHASES = [
  "claim",
  "spawn",
  "context_ready",
  "first_token",
  "turn_n",
  "disposition_applied",
  "comment_posted",
] as const;

export type RunPerfPhase = (typeof RUN_PERF_PHASES)[number];

const PHASE_SET = new Set<string>(RUN_PERF_PHASES);

export function isPerfTelemetryEnabled(): boolean {
  const raw = process.env.PAPERCLIP_PERF_TELEMETRY?.trim().toLowerCase();
  if (!raw) return true;
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

export function isRunPerfPhase(phase: string): phase is RunPerfPhase {
  return PHASE_SET.has(phase);
}

export function runPerfPhaseEvent(phase: RunPerfPhase, payload: Record<string, unknown> = {}) {
  return {
    eventType: "lifecycle" as const,
    stream: "system" as const,
    level: "info" as const,
    message: `run.phase.${phase}`,
    payload: {
      phase,
      ...payload,
    },
  };
}

/** Clamp process start so it never precedes the run's claim/start clock. */
export function resolveProcessStartedAtForRun(input: {
  runStartedAt: Date | string | null | undefined;
  spawnStartedAt: string;
  observedProcessBirthAt: string | null | undefined;
}): Date {
  const spawn = new Date(input.spawnStartedAt);
  const floorRaw = input.runStartedAt ? new Date(input.runStartedAt) : null;
  const floor =
    floorRaw && !Number.isNaN(floorRaw.getTime()) ? floorRaw : spawn;
  const observed = input.observedProcessBirthAt
    ? new Date(input.observedProcessBirthAt)
    : null;
  // Prefer OS birth only when it is at/after claim (fresh process for this run).
  // Resident reuse reports an older PID birth; keep spawn wall-clock instead.
  let candidate = spawn;
  if (observed && !Number.isNaN(observed.getTime()) && observed.getTime() >= floor.getTime()) {
    candidate = observed;
  }
  if (Number.isNaN(candidate.getTime())) candidate = new Date();
  if (candidate.getTime() < floor.getTime()) return floor;
  return candidate;
}
