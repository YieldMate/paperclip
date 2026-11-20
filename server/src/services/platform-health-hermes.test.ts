import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateHermesSessionUsage,
  extractHermesSessionIdFromRunLog,
  extractHermesSessionIdFromText,
  resolveAgentHermesHome,
  type HermesSessionUsageRow,
} from "./platform-health-hermes.js";

const SESSION = "local-9a22278f80f610df8e79d0780d7b425bdacfe7affc039e430830c660196b01a4";

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

  it("parses non-quiet Session footers from text", () => {
    const text = [
      "Resume this session with:",
      `  hermes --resume ${SESSION}`,
      `Session:        ${SESSION}`,
      "Title:          Inspect focused Penpot page via MEDIC",
    ].join("\n");
    expect(extractHermesSessionIdFromText(text)).toBe(SESSION);
  });

  it("recovers session ids from ndjson run logs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-logs-"));
    const prev = process.env.RUN_LOG_BASE_PATH;
    process.env.RUN_LOG_BASE_PATH = dir;
    const companyId = "company-1";
    const agentId = "agent-1";
    const runId = "run-1";
    const logDir = path.join(dir, companyId, agentId);
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, `${runId}.ndjson`),
      [
        JSON.stringify({ chunk: "working...\n" }),
        JSON.stringify({
          chunk: `Resume this session with:\n  hermes --resume ${SESSION}\n\nSession:        ${SESSION}\n`,
        }),
      ].join("\n"),
    );
    try {
      expect(extractHermesSessionIdFromRunLog({ companyId, agentId, runId })).toBe(SESSION);
    } finally {
      if (prev === undefined) delete process.env.RUN_LOG_BASE_PATH;
      else process.env.RUN_LOG_BASE_PATH = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
