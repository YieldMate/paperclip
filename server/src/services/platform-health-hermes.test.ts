import { describe, expect, it } from "vitest";
import {
  aggregateHermesSessionUsage,
  resolveAgentHermesHome,
  type HermesSessionUsageRow,
} from "./platform-health-hermes.js";

describe("platform-health-hermes", () => {
  it("resolves HERMES_HOME from adapter env", () => {
    expect(resolveAgentHermesHome({ env: { HERMES_HOME: "/tmp/hermes-home" } })).toBe("/tmp/hermes-home");
  });

  it("aggregates multi-model session usage", () => {
    const rows: HermesSessionUsageRow[] = [
      {
        sessionId: "local-1",
        model: "z-ai/glm-5.3",
        billingProvider: "nous",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        estimatedCostUsd: 0.2,
        costStatus: "estimated",
        occurredAt: 1,
      },
      {
        sessionId: "local-1",
        model: "z-ai/glm-5.3",
        billingProvider: "nous",
        inputTokens: 20,
        outputTokens: 10,
        cacheReadTokens: 0,
        estimatedCostUsd: 0.05,
        costStatus: "estimated",
        occurredAt: 2,
      },
      {
        sessionId: "local-1",
        model: "other/model",
        billingProvider: "nous",
        inputTokens: 5,
        outputTokens: 1,
        cacheReadTokens: 0,
        estimatedCostUsd: 0.01,
        costStatus: "estimated",
        occurredAt: 3,
      },
    ];
    const aggregated = aggregateHermesSessionUsage(rows);
    expect(aggregated).toMatchObject({
      model: "z-ai/glm-5.3",
      inputTokens: 125,
      outputTokens: 61,
      cacheReadTokens: 10,
      costUsd: 0.26,
    });
    expect(aggregated?.usageByModel).toHaveLength(2);
  });

  it("returns null for empty rows", () => {
    expect(aggregateHermesSessionUsage([])).toBeNull();
  });
});
