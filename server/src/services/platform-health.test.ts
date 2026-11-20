import { describe, expect, it } from "vitest";
import {
  PLATFORM_HEALTH_AGENT_NAME,
  platformHealthApplyDeskTriageSchema,
  platformHealthAutoHealSchema,
  platformHealthEnsureMedicSchema,
  platformHealthSettlePendingRunSchema,
} from "@paperclipai/shared";
import { buildMedicAgentsMd } from "./platform-health.js";

describe("platform-health schemas", () => {
  it("defaults settle mode to auto and dryRun false", () => {
    const parsed = platformHealthSettlePendingRunSchema.parse({
      runId: "aa327ca1-25ba-499d-8268-0d6ec19f855e",
    });
    expect(parsed.mode).toBe("auto");
    expect(parsed.dryRun).toBe(false);
  });

  it("defaults auto-heal to dry-run detect-only with desk triage enabled", () => {
    const parsed = platformHealthAutoHealSchema.parse({});
    expect(parsed.dryRun).toBe(true);
    expect(parsed.maxHealsPerFingerprint).toBe(3);
    expect(parsed.pendingAgeMinutes).toBe(5);
    expect(parsed.applyDeskTriage).toBe(true);
    expect(parsed.maxDeskActions).toBe(10);
  });

  it("defaults apply-desk-triage to live apply with retries and resolves", () => {
    const parsed = platformHealthApplyDeskTriageSchema.parse({});
    expect(parsed.dryRun).toBe(false);
    expect(parsed.maxActions).toBe(10);
    expect(parsed.applyRetries).toBe(true);
    expect(parsed.applyResolves).toBe(true);
  });

  it("defaults MEDIC ensure budget and interval", () => {
    const parsed = platformHealthEnsureMedicSchema.parse({});
    expect(parsed.budgetMonthlyCents).toBe(5_000);
    expect(parsed.intervalSec).toBe(180);
    expect(PLATFORM_HEALTH_AGENT_NAME).toBe("MEDIC");
  });

  it("builds a non-empty MEDIC AGENTS.md with wake protocol", () => {
    const md = buildMedicAgentsMd();
    expect(md).toContain("# MEDIC — Platform Health");
    expect(md).toContain("ops/health/snapshot");
    expect(md).toContain("auto-heal");
    expect(md).toContain("apply-desk-triage");
    expect(md).toContain("Invent $0 receipts when billable evidence exists");
    expect(md).toContain("also loads `$HERMES_DISPOSITION_FILE`");
    expect(md).toContain("Ignore unrelated Connection instructions");
  });
});
