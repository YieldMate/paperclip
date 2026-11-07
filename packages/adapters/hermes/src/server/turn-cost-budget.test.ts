import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BUDGET_CHECKPOINT_MONITOR_NOTES,
  BUDGET_CHECKPOINT_PHASE,
  BUDGET_HARD_LIMIT_PHASE,
  DEFAULT_BUDGET_TURNS,
  TURN_COST_BUDGET_V1_ENV,
  buildBudgetCheckpointDisposition,
  buildBudgetHardLimitDisposition,
  buildBudgetTelemetryPayload,
  decideBudgetAction,
  isTerminalDispositionStatus,
  isTurnCostBudgetV1Enabled,
  resolveBudgetConfig,
  resolveBudgetMaxTurns,
  writeHermesDispositionReport,
} from "./turn-cost-budget.js";

describe("turn-cost-budget flag + config", () => {
  it("flag defaults off", () => {
    expect(isTurnCostBudgetV1Enabled({})).toBe(false);
    expect(isTurnCostBudgetV1Enabled({ [TURN_COST_BUDGET_V1_ENV]: "0" })).toBe(false);
    expect(isTurnCostBudgetV1Enabled({ [TURN_COST_BUDGET_V1_ENV]: "1" })).toBe(true);
    expect(isTurnCostBudgetV1Enabled({ [TURN_COST_BUDGET_V1_ENV]: "true" })).toBe(true);
  });

  it("requires both flag and budget.enabled for active", () => {
    const inactive = resolveBudgetConfig(
      { "budget.enabled": true, "budget.turns": 40 },
      {},
    );
    expect(inactive.active).toBe(false);
    expect(inactive.enabled).toBe(true);

    const active = resolveBudgetConfig(
      { budget: { enabled: true, turns: 40, checkpointThreshold: 0.8 } },
      { [TURN_COST_BUDGET_V1_ENV]: "1" },
    );
    expect(active.active).toBe(true);
    expect(active.turns).toBe(40);
    expect(active.softMaxTurns).toBe(32);
    expect(active.costUsd).toBe(1.5);
  });

  it("nested budget wins over dotted keys", () => {
    const cfg = resolveBudgetConfig(
      {
        "budget.enabled": false,
        "budget.turns": 99,
        budget: { enabled: true, turns: 10, checkpointThreshold: 0.5 },
      },
      { [TURN_COST_BUDGET_V1_ENV]: "yes" },
    );
    expect(cfg.active).toBe(true);
    expect(cfg.turns).toBe(10);
    expect(cfg.softMaxTurns).toBe(5);
  });

  it("clamps Hermes max-turns to soft max when active", () => {
    const budget = resolveBudgetConfig(
      { "budget.enabled": true, "budget.turns": 40 },
      { [TURN_COST_BUDGET_V1_ENV]: "1" },
    );
    expect(resolveBudgetMaxTurns(budget, 1000)).toBe(32);
    expect(resolveBudgetMaxTurns(budget, 10)).toBe(10);
    expect(resolveBudgetMaxTurns({ ...budget, active: false }, 1000)).toBe(1000);
  });
});

describe("decideBudgetAction", () => {
  const baseBudget = resolveBudgetConfig(
    { budget: { enabled: true, turns: 40, checkpointThreshold: 0.8 } },
    { [TURN_COST_BUDGET_V1_ENV]: "1" },
  );

  it("T5: terminal disposition under soft threshold is none", () => {
    const d = decideBudgetAction({
      budget: baseBudget,
      currentTurns: 5,
      dispositionStatus: "done",
    });
    expect(d.kind).toBe("none");
    expect(d.reason).toBe("terminal_disposition");
  });

  it("T1: soft threshold without terminal disposition → checkpoint", () => {
    const d = decideBudgetAction({
      budget: baseBudget,
      currentTurns: 32,
      dispositionStatus: "in_progress",
    });
    expect(d.kind).toBe("checkpoint");
    expect(d.reason).toBe("soft_turns_threshold");
  });

  it("T4: hard turns (threshold=1) → hard_limit", () => {
    const hard = resolveBudgetConfig(
      { budget: { enabled: true, turns: 5, checkpointThreshold: 1 } },
      { [TURN_COST_BUDGET_V1_ENV]: "1" },
    );
    const d = decideBudgetAction({
      budget: hard,
      currentTurns: 5,
      dispositionStatus: null,
    });
    expect(d.kind).toBe("hard_limit");
    expect(d.reason).toBe("hard_turns_exceeded");
  });

  it("R4: hard cost with untrustworthy cost → hard_limit fail-safe", () => {
    const d = decideBudgetAction({
      budget: baseBudget,
      currentTurns: 1,
      enforceHardCost: true,
      costStatus: "unpriced",
      estimatedCostUsd: null,
    });
    expect(d.kind).toBe("hard_limit");
    expect(d.reason).toBe("hard_cost_untrustworthy");
  });

  it("R4: cost advisory when enforceHardCost off never hard-limits on cost alone", () => {
    const d = decideBudgetAction({
      budget: baseBudget,
      currentTurns: 1,
      enforceHardCost: false,
      estimatedCostUsd: 99,
      costStatus: "estimated",
    });
    expect(d.kind).toBe("none");
  });

  it("inactive budget never fires", () => {
    const d = decideBudgetAction({
      budget: { ...baseBudget, active: false },
      currentTurns: 100,
    });
    expect(d.kind).toBe("none");
    expect(d.reason).toBe("budget_inactive");
  });
});

describe("disposition write + shapes (T1/T4 atomic)", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes absolute-path disposition atomically and parses as recognized status", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-budget-disp-"));
    const filePath = path.join(dir, "run.disposition.json");
    const checkpoint = buildBudgetCheckpointDisposition(new Date("2026-11-07T05:00:00.000Z"));
    expect(checkpoint.status).toBe("in_progress");
    expect(checkpoint.monitor?.notes).toBe(BUDGET_CHECKPOINT_MONITOR_NOTES);
    expect(checkpoint.comment.toLowerCase()).toContain("remaining");

    await writeHermesDispositionReport(filePath, checkpoint);
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { status: string; comment: string };
    expect(parsed.status).toBe("in_progress");
    expect(isTerminalDispositionStatus(parsed.status)).toBe(false);

    const hard = buildBudgetHardLimitDisposition("hard_turns_exceeded");
    await writeHermesDispositionReport(filePath, hard);
    const hardParsed = JSON.parse(await fs.readFile(filePath, "utf8")) as {
      status: string;
      comment: string;
    };
    expect(hardParsed.status).toBe("blocked");
    expect(hardParsed.comment).toMatch(/budget/i);
    expect(hardParsed.comment).not.toMatch(/\bdone\b/i);
  });

  it("rejects non-absolute disposition paths (F9)", async () => {
    await expect(
      writeHermesDispositionReport("relative.disposition.json", {
        status: "in_progress",
        comment: "x",
      }),
    ).rejects.toThrow(/absolute path/i);
  });

  it("telemetry payload names the event (not side effects)", () => {
    const budget = resolveBudgetConfig(
      { budget: { enabled: true } },
      { [TURN_COST_BUDGET_V1_ENV]: "1" },
    );
    const decision = decideBudgetAction({
      budget,
      currentTurns: 32,
    });
    const payload = buildBudgetTelemetryPayload(decision, budget, {
      companyId: "co",
      agentId: "ag",
      issueId: "iss",
      runId: "run",
    });
    expect(payload?.phase).toBe(BUDGET_CHECKPOINT_PHASE);
    expect(payload?.measuredTurns).toBe(32);
    expect(payload?.budgetTurns).toBe(DEFAULT_BUDGET_TURNS);
    expect(payload?.agentId).toBe("ag");

    const hardDecision = decideBudgetAction({
      budget: resolveBudgetConfig(
        { budget: { enabled: true, turns: 3, checkpointThreshold: 1 } },
        { [TURN_COST_BUDGET_V1_ENV]: "1" },
      ),
      currentTurns: 3,
    });
    const hardPayload = buildBudgetTelemetryPayload(
      hardDecision,
      resolveBudgetConfig(
        { budget: { enabled: true, turns: 3, checkpointThreshold: 1 } },
        { [TURN_COST_BUDGET_V1_ENV]: "1" },
      ),
      { issueId: "iss" },
    );
    expect(hardPayload?.phase).toBe(BUDGET_HARD_LIMIT_PHASE);
  });
});
