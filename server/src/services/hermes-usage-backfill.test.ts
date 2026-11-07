import { describe, expect, it } from "vitest";
import { hermesUsageBackfillSchema } from "@paperclipai/shared";
import { parseNousPortalCsv } from "./nous-portal-billing.js";

describe("hermesUsageBackfillSchema", () => {
  it("accepts session usage rows for dry-run payloads", () => {
    const parsed = hermesUsageBackfillSchema.parse({
      agentId: "00000000-0000-4000-8000-000000000001",
      from: "2026-11-01T00:00:00.000Z",
      to: "2026-11-08T00:00:00.000Z",
      rows: [
        {
          sessionId: "20261103_abc",
          model: "deepseek/deepseek-v3.2-20251201",
          inputTokens: 1000,
          outputTokens: 50,
          estimatedCostUsd: 0.025,
          occurredAt: 1762128000,
        },
      ],
    });
    expect(parsed.dryRun).toBe(true);
    expect(parsed.rows[0].model).toContain("deepseek");
  });
});

describe("parseNousPortalCsv", () => {
  it("parses day/amount rows including tools and credits", () => {
    const lines = parseNousPortalCsv(`day,amount_usd,description,kind
2026-11-01,12.50,Inference,inference
2026-11-02,3.00,Tool gateway,tools
2026-11-03,-1.25,Credit,credit
`);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({
      amountCents: "1250.0000000",
      kind: "inference",
      occurredAt: "2026-11-01T12:00:00.000Z",
    });
    expect(lines[2].kind).toBe("credit");
  });
});
