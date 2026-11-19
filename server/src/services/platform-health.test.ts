import { describe, expect, it } from "vitest";
import {
  PLATFORM_HEALTH_AGENT_NAME,
  platformHealthAutoHealSchema,
  platformHealthEnsureMedicSchema,
  platformHealthSettlePendingRunSchema,
} from "@paperclipai/shared";

describe("platform-health schemas", () => {
  it("defaults settle mode to auto and dryRun false", () => {
    const parsed = platformHealthSettlePendingRunSchema.parse({
      runId: "aa327ca1-25ba-499d-8268-0d6ec19f855e",
    });
    expect(parsed.mode).toBe("auto");
    expect(parsed.dryRun).toBe(false);
  });

  it("defaults auto-heal to dry-run detect-only", () => {
    const parsed = platformHealthAutoHealSchema.parse({});
    expect(parsed.dryRun).toBe(true);
    expect(parsed.maxHealsPerFingerprint).toBe(3);
    expect(parsed.pendingAgeMinutes).toBe(5);
  });

  it("defaults MEDIC ensure budget and interval", () => {
    const parsed = platformHealthEnsureMedicSchema.parse({});
    expect(parsed.budgetMonthlyCents).toBe(5_000);
    expect(parsed.intervalSec).toBe(180);
    expect(PLATFORM_HEALTH_AGENT_NAME).toBe("MEDIC");
  });
});
