import { afterEach, describe, expect, it } from "vitest";

import {
  applyDispositionWarmReason,
  DEFAULT_RESIDENT_WARM_CONFIG,
  inertResidentTelemetry,
  isPreservedDispatchWarmReason,
  isResidentWarmPolicyV2Enabled,
  normalizeCwdIdentity,
  residentWarmTtlForDisposition,
  RESIDENT_WARM_POLICY_V2_ENV,
  shouldKeepResidentForDispositionLegacy,
} from "./resident-warm-policy.js";

describe("isResidentWarmPolicyV2Enabled", () => {
  const previous = process.env[RESIDENT_WARM_POLICY_V2_ENV];
  afterEach(() => {
    if (previous === undefined) delete process.env[RESIDENT_WARM_POLICY_V2_ENV];
    else process.env[RESIDENT_WARM_POLICY_V2_ENV] = previous;
  });

  it("defaults off; enables on 1/true/on/yes", () => {
    delete process.env[RESIDENT_WARM_POLICY_V2_ENV];
    expect(isResidentWarmPolicyV2Enabled()).toBe(false);
    process.env[RESIDENT_WARM_POLICY_V2_ENV] = "0";
    expect(isResidentWarmPolicyV2Enabled()).toBe(false);
    process.env[RESIDENT_WARM_POLICY_V2_ENV] = "1";
    expect(isResidentWarmPolicyV2Enabled()).toBe(true);
    process.env[RESIDENT_WARM_POLICY_V2_ENV] = "true";
    expect(isResidentWarmPolicyV2Enabled()).toBe(true);
    process.env[RESIDENT_WARM_POLICY_V2_ENV] = "on";
    expect(isResidentWarmPolicyV2Enabled()).toBe(true);
  });
});

describe("residentWarmTtlForDisposition matrix", () => {
  it("in_progress → 900s disposition_in_progress", () => {
    expect(residentWarmTtlForDisposition({ status: "in_progress" })).toEqual({
      ttlSec: 900,
      reason: "disposition_in_progress",
      keep: true,
    });
  });

  it("done → 180s disposition_done", () => {
    expect(residentWarmTtlForDisposition({ status: "done" })).toMatchObject({
      ttlSec: 180,
      reason: "disposition_done",
      keep: true,
    });
  });

  it("in_review → 180s disposition_in_review", () => {
    expect(residentWarmTtlForDisposition({ status: "in_review" })).toMatchObject({
      ttlSec: 180,
      reason: "disposition_in_review",
      keep: true,
    });
  });

  it("blocked → 900s disposition_blocked", () => {
    expect(residentWarmTtlForDisposition({ status: "blocked" })).toMatchObject({
      ttlSec: 900,
      reason: "disposition_blocked",
      keep: true,
    });
  });

  it("cancelled → 0s disposition_cancelled", () => {
    expect(residentWarmTtlForDisposition({ status: "cancelled" })).toEqual({
      ttlSec: 0,
      reason: "disposition_cancelled",
      keep: false,
    });
  });

  it("failed with scheduled retry → 900s disposition_failed_retry", () => {
    expect(
      residentWarmTtlForDisposition({ status: "failed" }, { hasScheduledRetry: true }),
    ).toEqual({
      ttlSec: 900,
      reason: "disposition_failed_retry",
      keep: true,
    });
  });

  it("failed without scheduled retry → 180s disposition_failed_no_retry", () => {
    expect(residentWarmTtlForDisposition({ status: "failed" })).toEqual({
      ttlSec: 180,
      reason: "disposition_failed_no_retry",
      keep: true,
    });
  });

  it("null disposition → 180s disposition_unknown", () => {
    expect(residentWarmTtlForDisposition(null)).toEqual({
      ttlSec: 180,
      reason: "disposition_unknown",
      keep: true,
    });
  });

  it("empty / whitespace / missing status → disposition_unknown", () => {
    expect(residentWarmTtlForDisposition({})).toMatchObject({
      reason: "disposition_unknown",
      ttlSec: 180,
    });
    expect(residentWarmTtlForDisposition({ status: "" })).toMatchObject({
      reason: "disposition_unknown",
    });
    expect(residentWarmTtlForDisposition({ status: "   " })).toMatchObject({
      reason: "disposition_unknown",
    });
  });

  it("honours config overrides", () => {
    expect(
      residentWarmTtlForDisposition(
        { status: "done" },
        { config: { residentWarmTtlTerminalSec: 120 } },
      ),
    ).toMatchObject({ ttlSec: 120, reason: "disposition_done" });
  });
});

describe("applyDispositionWarmReason", () => {
  it("preserves dispatch-rejection / sticky reasons over disposition codes", () => {
    for (const rejection of [
      "cwd_mismatch",
      "ttl_expired",
      "model_mismatch",
      "session_mismatch",
      "cap_evicted",
    ] as const) {
      expect(isPreservedDispatchWarmReason(rejection)).toBe(true);
      expect(applyDispositionWarmReason(rejection, "disposition_done")).toBe(rejection);
    }
  });

  it("does not preserve no_live_resident (cold-start must record disposition_*)", () => {
    expect(isPreservedDispatchWarmReason("no_live_resident")).toBe(false);
    expect(applyDispositionWarmReason("no_live_resident", "disposition_done")).toBe(
      "disposition_done",
    );
  });

  it("assigns disposition reason when no rejection was recorded", () => {
    expect(applyDispositionWarmReason("n/a", "disposition_done")).toBe("disposition_done");
    expect(applyDispositionWarmReason("disposition_in_progress", "disposition_done")).toBe(
      "disposition_done",
    );
  });
});

describe("legacy stop-on-terminal", () => {
  it("keeps missing status and stops terminal statuses", () => {
    expect(shouldKeepResidentForDispositionLegacy(null)).toBe(true);
    expect(shouldKeepResidentForDispositionLegacy({ status: "done" })).toBe(false);
    expect(shouldKeepResidentForDispositionLegacy({ status: "blocked" })).toBe(false);
    expect(shouldKeepResidentForDispositionLegacy({ status: "in_progress" })).toBe(true);
  });
});

describe("normalizeCwdIdentity", () => {
  it("resolves absolute paths stably", async () => {
    const a = await normalizeCwdIdentity(".");
    const b = await normalizeCwdIdentity(process.cwd());
    expect(a).toBe(b);
    expect(a.startsWith("/")).toBe(true);
  });
});

describe("inertResidentTelemetry", () => {
  it("returns n_a fields for flag-off rollback", () => {
    expect(inertResidentTelemetry()).toEqual({
      resident_start_decision: "n_a",
      resident_warm_decision: "n_a",
      resident_warm_reason: "flag_off",
      resident_warm_ttl_seconds: null,
      resident_cwd_identity: null,
    });
    expect(DEFAULT_RESIDENT_WARM_CONFIG.residentWarmMaxLiveResidents).toBe(8);
  });
});
