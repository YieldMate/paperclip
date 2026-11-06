import { describe, expect, it, afterEach } from "vitest";
import {
  isPerfTelemetryEnabled,
  resolveProcessStartedAtForRun,
  runPerfPhaseEvent,
} from "./run-perf-telemetry.js";

describe("run-perf-telemetry", () => {
  const previous = process.env.PAPERCLIP_PERF_TELEMETRY;
  afterEach(() => {
    if (previous === undefined) delete process.env.PAPERCLIP_PERF_TELEMETRY;
    else process.env.PAPERCLIP_PERF_TELEMETRY = previous;
  });

  it("defaults enabled and rolls back on 0/false/off", () => {
    delete process.env.PAPERCLIP_PERF_TELEMETRY;
    expect(isPerfTelemetryEnabled()).toBe(true);
    process.env.PAPERCLIP_PERF_TELEMETRY = "0";
    expect(isPerfTelemetryEnabled()).toBe(false);
    process.env.PAPERCLIP_PERF_TELEMETRY = "false";
    expect(isPerfTelemetryEnabled()).toBe(false);
  });

  it("builds closed-phase lifecycle events", () => {
    expect(runPerfPhaseEvent("claim")).toMatchObject({
      eventType: "lifecycle",
      message: "run.phase.claim",
      payload: { phase: "claim" },
    });
  });

  it("clamps process_started_at to run startedAt for resident PID birth", () => {
    const runStarted = new Date("2026-11-06T03:00:00.000Z");
    const spawn = "2026-11-06T03:00:05.000Z";
    const oldBirth = "2026-11-06T01:00:00.000Z";
    const resolved = resolveProcessStartedAtForRun({
      runStartedAt: runStarted,
      spawnStartedAt: spawn,
      observedProcessBirthAt: oldBirth,
    });
    expect(resolved.toISOString()).toBe(spawn);
    expect(resolved.getTime()).toBeGreaterThanOrEqual(runStarted.getTime());
  });

  it("keeps OS birth when the process started after claim", () => {
    const runStarted = new Date("2026-11-06T03:00:00.000Z");
    const spawn = "2026-11-06T03:00:05.000Z";
    const birth = "2026-11-06T03:00:04.500Z";
    const resolved = resolveProcessStartedAtForRun({
      runStartedAt: runStarted,
      spawnStartedAt: spawn,
      observedProcessBirthAt: birth,
    });
    expect(resolved.toISOString()).toBe(birth);
  });
});
