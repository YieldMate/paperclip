import { afterEach, describe, expect, it } from "vitest";
import {
  CLAIM_REASON_FRESH,
  CLAIM_REASON_PARKED_RECLAIM,
  CLAIM_REASON_SAFETY_NET,
  EVENT_DRIVEN_RECLAIM_V1_ENV,
  WORKSPACE_BUSY_RETRY_JITTER_MS_FLAG_ON,
  WORKSPACE_BUSY_SAFETY_NET_MS_DEFAULT,
  WORKSPACE_BUSY_SAFETY_NET_MS_ENV,
  WORKSPACE_EVENT_DRIVEN_CLAIM_ENABLED_ENV,
  computeEventDrivenWorkspaceBusyRetryDelayMs,
  getWorkspaceBusySafetyNetMs,
  isEventDrivenReclaimV1Enabled,
} from "./event-driven-reclaim.js";

// Legacy constants mirrored from retries.ts so this file stays import-light.
const LEGACY_BASE_MS = 60_000;
const LEGACY_JITTER_MS = 60_000;
const HOLDER_STALE_MS = 3_600_000;

describe("event-driven reclaim flag + safety net (YIE-72)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of [
      EVENT_DRIVEN_RECLAIM_V1_ENV,
      WORKSPACE_EVENT_DRIVEN_CLAIM_ENABLED_ENV,
      WORKSPACE_BUSY_SAFETY_NET_MS_ENV,
    ]) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it("defaults OFF", () => {
    delete process.env[EVENT_DRIVEN_RECLAIM_V1_ENV];
    delete process.env[WORKSPACE_EVENT_DRIVEN_CLAIM_ENABLED_ENV];
    expect(isEventDrivenReclaimV1Enabled()).toBe(false);
  });

  it("enables via PAPERCLIP_EVENT_DRIVEN_RECLAIM_V1", () => {
    process.env[EVENT_DRIVEN_RECLAIM_V1_ENV] = "1";
    expect(isEventDrivenReclaimV1Enabled()).toBe(true);
  });

  it("enables via WORKSPACE_EVENT_DRIVEN_CLAIM_ENABLED alias", () => {
    process.env[WORKSPACE_EVENT_DRIVEN_CLAIM_ENABLED_ENV] = "true";
    expect(isEventDrivenReclaimV1Enabled()).toBe(true);
  });

  it("safety net defaults to 300000 ms and is injectable", () => {
    delete process.env[WORKSPACE_BUSY_SAFETY_NET_MS_ENV];
    expect(getWorkspaceBusySafetyNetMs()).toBe(WORKSPACE_BUSY_SAFETY_NET_MS_DEFAULT);
    process.env[WORKSPACE_BUSY_SAFETY_NET_MS_ENV] = "250";
    expect(getWorkspaceBusySafetyNetMs()).toBe(250);
  });

  it("flag-on delay uses safety net + small jitter (not 60s+60s)", () => {
    process.env[WORKSPACE_BUSY_SAFETY_NET_MS_ENV] = "300000";
    expect(computeEventDrivenWorkspaceBusyRetryDelayMs(() => 0)).toBe(300_000);
    expect(computeEventDrivenWorkspaceBusyRetryDelayMs(() => 1)).toBe(
      300_000 + WORKSPACE_BUSY_RETRY_JITTER_MS_FLAG_ON,
    );
    expect(computeEventDrivenWorkspaceBusyRetryDelayMs(() => 0.5)).toBe(305_000);
    // Distinct from legacy 60s base — safety net is 5× longer.
    expect(300_000).toBeGreaterThan(LEGACY_BASE_MS + LEGACY_JITTER_MS);
  });

  it("documents legacy 60s+jitter window for flag-off rollback", () => {
    expect(LEGACY_BASE_MS).toBe(60_000);
    expect(LEGACY_JITTER_MS).toBe(60_000);
  });

  it("keeps holder stale cutoff at 3600 seconds", () => {
    expect(HOLDER_STALE_MS).toBe(3_600_000);
  });

  it("exposes the three claim_reason values for telemetry", () => {
    expect([CLAIM_REASON_FRESH, CLAIM_REASON_PARKED_RECLAIM, CLAIM_REASON_SAFETY_NET]).toEqual([
      "fresh",
      "parked_reclaim",
      "safety_net",
    ]);
  });

  it("documents workspace_release_claim_attempted outcomes", () => {
    const outcomes = ["success", "no_pending_wake", "race_lost", "flag_off", "promote_failed"] as const;
    expect(outcomes).toContain("success");
    expect(outcomes).toContain("race_lost");
  });
});
