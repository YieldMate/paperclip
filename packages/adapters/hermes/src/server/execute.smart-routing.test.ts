import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

import {
  execute,
  isSmartRoutingPreflightEligible,
  mergeHermesUsageReports,
  resolveManagedHermesRuntimeStateDir,
} from "./execute.js";

const PRIMARY_SESSION = "20261028_primary_session";
const PREFLIGHT_SESSION = "20261028_preflight_session";
const FIXTURE_INSTANCE_ID = "hermes-smart-routing-test";

describe("mergeHermesUsageReports", () => {
  it("sums two reports into usageByModel parts that match totals", () => {
    const merged = mergeHermesUsageReports(
      [
        {
          model: "cheap-model",
          input_tokens: 10,
          output_tokens: 2,
          estimated_cost_usd: 0.01,
        },
        {
          model: "primary-model",
          input_tokens: 100,
          output_tokens: 20,
          estimated_cost_usd: 0.2,
          usage_by_model: [
            {
              model: "cheap-model",
              input_tokens: 30,
              output_tokens: 5,
              estimated_cost_usd: 0.03,
            },
            {
              model: "primary-model",
              input_tokens: 70,
              output_tokens: 15,
              estimated_cost_usd: 0.17,
            },
          ],
        },
      ],
      "primary-model",
    );

    expect(merged.usage).toEqual({ inputTokens: 110, outputTokens: 22 });
    expect(merged.costUsd).toBeCloseTo(0.21);
    expect(merged.usageByModel).toEqual([
      {
        model: "cheap-model",
        usage: { inputTokens: 40, outputTokens: 7 },
        costUsd: 0.04,
      },
      {
        model: "primary-model",
        usage: { inputTokens: 70, outputTokens: 15 },
        costUsd: 0.17,
      },
    ]);
  });

  it("prefers total_including_auxiliary cost and adds auxiliary tokens", () => {
    const merged = mergeHermesUsageReports(
      [
        {
          model: "primary-model",
          input_tokens: 100,
          output_tokens: 20,
          estimated_cost_usd: 0.2,
          cost_status: "estimated",
          auxiliary: { input_tokens: 5, output_tokens: 2, estimated_cost_usd: 0.01 },
          total_including_auxiliary: {
            estimated_cost_usd: 0.21,
            total_tokens: 127,
            api_calls: 3,
          },
        },
      ],
      "primary-model",
    );

    expect(merged.usage).toEqual({ inputTokens: 105, outputTokens: 22 });
    expect(merged.costUsd).toBeCloseTo(0.21);
    expect(merged.apiCalls).toBe(3);
    expect(merged.costStatus).toBe("estimated");
  });

  it("keeps token-bearing unknown/$0 reports as unpriced", () => {
    const merged = mergeHermesUsageReports(
      [
        {
          model: "deepseek/deepseek-v3.2-20251201",
          input_tokens: 1000,
          output_tokens: 50,
          estimated_cost_usd: 0,
          cost_status: "unknown",
        },
      ],
      "deepseek/deepseek-v3.2-20251201",
    );

    expect(merged.usage).toEqual({ inputTokens: 1000, outputTokens: 50 });
    expect(merged.costUsd).toBe(0);
    expect(merged.costStatus).toBe("unpriced");
  });
});

describe("isSmartRoutingPreflightEligible", () => {
  const routing = {
    enabled: true,
    cheapModel: "cheap-model",
    maxPreflightTurns: 2,
    maxCheapInputTokens: 12000,
    perTurn: true,
    separatePreflight: true,
  };

  function ctx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
    return {
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Hermes",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: "task-1",
      },
      config: {},
      context: {
        issueId: "issue-1",
        wakeReason: "issue_assigned",
      },
      onLog: async () => undefined,
      ...overrides,
    };
  }

  it("allows a fresh issue wake when separatePreflight is on", () => {
    expect(isSmartRoutingPreflightEligible(ctx(), {}, undefined, routing)).toBe(true);
  });

  it("skips separate preflight when the flag is off", () => {
    expect(
      isSmartRoutingPreflightEligible(ctx(), {}, undefined, {
        ...routing,
        separatePreflight: false,
      }),
    ).toBe(false);
  });

  it("skips resume, approval, and execution wakes", () => {
    expect(isSmartRoutingPreflightEligible(ctx(), {}, "sess", routing)).toBe(false);
    expect(
      isSmartRoutingPreflightEligible(
        ctx({ context: { issueId: "issue-1", wakeReason: "approval_approved" } }),
        {},
        undefined,
        routing,
      ),
    ).toBe(false);
    expect(
      isSmartRoutingPreflightEligible(
        ctx({ context: { issueId: "issue-1", wakeReason: "execution_review_requested" } }),
        {},
        undefined,
        routing,
      ),
    ).toBe(false);
  });
});

describe("Hermes smart model routing spawns", () => {
  let dir: string;
  let paperclipHome: string;
  let command: string;
  let capturePath: string;
  let logs: string[];
  let previousPaperclipHome: string | undefined;
  let previousPaperclipInstanceId: string | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-smart-routing-"));
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-home-"));
    previousPaperclipHome = process.env.PAPERCLIP_HOME;
    previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = FIXTURE_INSTANCE_ID;
    command = path.join(dir, "hermes.cjs");
    capturePath = path.join(dir, "invocations.jsonl");
    logs = [];
    await fs.writeFile(command, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const overlayPath = process.env.HERMES_MCP_OVERLAY || null;
let overlay = null;
if (overlayPath) {
  overlay = JSON.parse(fs.readFileSync(overlayPath, "utf8"));
}
const modelIdx = process.argv.indexOf("-m");
const model = modelIdx >= 0 ? process.argv[modelIdx + 1] : null;
const resumeIdx = process.argv.indexOf("--resume");
const usagePath = process.env.HERMES_USAGE_FILE || null;
const isCheap = model === "cheap-model";
fs.appendFileSync(process.env.CAPTURE_PATH, JSON.stringify({
  model,
  resume: resumeIdx >= 0 ? process.argv[resumeIdx + 1] : null,
  inprocess: process.env.HERMES_INPROCESS_CHAT ?? null,
  overlayPath,
  overlay,
  route: process.env.HERMES_PAPERCLIP_MODEL_ROUTE ?? null,
  usagePath,
  systemPrompt: process.env.HERMES_EPHEMERAL_SYSTEM_PROMPT ?? null,
  prompt: (() => {
    const q = process.argv.indexOf("-q");
    return q >= 0 ? process.argv[q + 1] : null;
  })(),
}) + "\\n");
if (usagePath) {
  const report = isCheap
    ? { model: "cheap-model", input_tokens: 10, output_tokens: 2, estimated_cost_usd: 0.01 }
    : {
        model: "fixture-model",
        input_tokens: 100,
        output_tokens: 20,
        estimated_cost_usd: 0.2,
        usage_by_model: [
          { model: "cheap-model", input_tokens: 30, output_tokens: 5, estimated_cost_usd: 0.03 },
          { model: "fixture-model", input_tokens: 70, output_tokens: 15, estimated_cost_usd: 0.17 },
        ],
      };
  fs.writeFileSync(usagePath, JSON.stringify(report) + "\\n");
}
if (process.env.FIXTURE_PREFLIGHT_FAIL && isCheap) {
  process.exit(7);
}
if (process.env.FIXTURE_PREFLIGHT_HOLD_MS && isCheap) {
  const end = Date.now() + Number(process.env.FIXTURE_PREFLIGHT_HOLD_MS);
  while (Date.now() < end) {}
}
const session = isCheap ? "${PREFLIGHT_SESSION}" : "${PRIMARY_SESSION}";
console.log((isCheap ? "Preflight notes" : "Primary response") + "\\nsession_id: " + session);
`, { mode: 0o700 });
  });

  afterEach(async () => {
    if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousPaperclipHome;
    if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(paperclipHome, { recursive: true, force: true });
  });

  function expectedOverlayPath(runId: string): string {
    return path.join(
      resolveManagedHermesRuntimeStateDir(
        {
          PAPERCLIP_HOME: paperclipHome,
          PAPERCLIP_INSTANCE_ID: FIXTURE_INSTANCE_ID,
        },
        "company-synthetic",
        "agent-synthetic",
      ),
      "runs",
      runId,
      "mcp",
      "overlay.json",
    );
  }

  function context(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
    return {
      runId: "run-smart-routing",
      agent: {
        id: "agent-synthetic",
        companyId: "company-synthetic",
        name: "Hermes fixture",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: "task-synthetic",
      },
      config: {
        hermesCommand: command,
        provider: "openrouter",
        model: "fixture-model",
        cwd: dir,
        env: { CAPTURE_PATH: capturePath },
        timeoutSec: 10,
        graceSec: 1,
        smartModelRouting: {
          enabled: true,
          cheapModel: "cheap-model",
          maxPreflightTurns: 2,
          maxCheapInputTokens: 12000,
          perTurn: true,
          separatePreflight: true,
        },
      },
      context: {
        issueId: "task-synthetic",
        wakeReason: "issue_assigned",
        paperclipWake: {
          reason: "issue_assigned",
          issue: { id: "task-synthetic", title: "Synthetic task", status: "todo" },
          comments: [],
          commentWindow: { requestedCount: 0, returnedCount: 0, missingCount: 0 },
          fallbackFetchNeeded: false,
        },
      },
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
      ...overrides,
    };
  }

  async function invocations() {
    return (await fs.readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  }

  it("runs cheap then primary with the same overlay and stores only the primary session", async () => {
    const overlayPath = expectedOverlayPath("run-smart-routing");
    const result = await execute({
      ...context(),
      runtimeMcp: {
        getServers: () => [{
          name: "Paperclip Linear",
          url: "https://mcp.example.com/linear",
          token: "tok",
          connectionId: "conn-linear",
        }],
      },
    });

    const calls = await invocations();
    expect(calls).toHaveLength(2);
    expect(calls[0].model).toBe("cheap-model");
    expect(calls[0].resume).toBeNull();
    expect(calls[0].route).toBeNull();
    expect(calls[0].overlayPath).toBe(overlayPath);
    expect(calls[0].systemPrompt).toContain("Paperclip cheap-model preflight:");
    expect(calls[1].model).toBe("fixture-model");
    expect(calls[1].overlayPath).toBe(overlayPath);
    expect(calls[1].route).toContain("cheap-model");
    expect(calls[1].prompt).toContain("Preflight notes");
    expect(result.sessionParams).toEqual({ sessionId: PRIMARY_SESSION });
    expect(result.resultJson).toMatchObject({
      session_id: PRIMARY_SESSION,
      modelRouting: { phases: ["cheap_preflight", "primary"] },
    });
    expect(result.usageByModel?.map((p) => p.model).sort()).toEqual(["cheap-model", "fixture-model"]);
    await expect(fs.access(overlayPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("starts the primary with no handoff when the cheap child fails", async () => {
    const result = await execute({
      ...context({
        config: {
          ...context().config,
          env: { CAPTURE_PATH: capturePath, FIXTURE_PREFLIGHT_FAIL: "1" },
        },
      }),
    });

    const calls = await invocations();
    expect(calls).toHaveLength(2);
    expect(calls[0].model).toBe("cheap-model");
    expect(calls[1].model).toBe("fixture-model");
    expect(calls[1].prompt).not.toContain("Preflight notes");
    expect(result.sessionParams).toEqual({ sessionId: PRIMARY_SESSION });
    expect(logs.join("")).toContain("continuing with primary (no handoff)");
  });

  it.each([
    {
      name: "resumed session",
      overrides: {
        runtime: {
          sessionId: "existing",
          sessionParams: { sessionId: "existing" },
          sessionDisplayId: "existing",
          taskKey: "task-synthetic",
        },
      },
    },
    {
      name: "approval wake",
      overrides: {
        context: {
          issueId: "task-synthetic",
          wakeReason: "approval_approved",
        },
      },
    },
    {
      name: "execution wake",
      overrides: {
        context: {
          issueId: "task-synthetic",
          wakeReason: "execution_review_requested",
        },
      },
    },
  ])("spawns only the primary for $name", async ({ overrides }) => {
    await execute(context(overrides as Partial<AdapterExecutionContext>));
    const calls = await invocations();
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("fixture-model");
  });

  it("reads flat dotted schema keys from the UI", async () => {
    const base = context();
    const { smartModelRouting: _nested, ...restConfig } = base.config as Record<string, unknown>;
    await execute({
      ...base,
      config: {
        ...restConfig,
        "smartModelRouting.enabled": true,
        "smartModelRouting.cheapModel": "cheap-model",
        "smartModelRouting.maxPreflightTurns": 2,
        "smartModelRouting.maxCheapInputTokens": 12000,
        "smartModelRouting.perTurn": true,
        "smartModelRouting.separatePreflight": true,
      },
    });
    const calls = await invocations();
    expect(calls).toHaveLength(2);
    expect(calls[0].model).toBe("cheap-model");
    expect(calls[1].model).toBe("fixture-model");
  });

  it("skips the separate preflight child by default (per-turn routing only)", async () => {
    const base = context();
    await execute({
      ...base,
      config: {
        ...base.config,
        smartModelRouting: {
          enabled: true,
          cheapModel: "cheap-model",
          maxPreflightTurns: 2,
          maxCheapInputTokens: 12000,
          perTurn: true,
          separatePreflight: false,
        },
      },
    });
    const calls = await invocations();
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("fixture-model");
    expect(calls[0].route).toContain("cheap-model");
  });

  it("forwards onSpawn only to the primary child when preflight runs", async () => {
    const spawnPids: number[] = [];
    await execute({
      ...context(),
      onSpawn: async (info) => {
        spawnPids.push(info.pid);
      },
    });
    const calls = await invocations();
    expect(calls).toHaveLength(2);
    // Fixture hermes.cjs exits immediately; onSpawn still fires once for the primary.
    expect(spawnPids.length).toBe(1);
  });
});

describe("Hermes quiet run without smart routing (YIE-67 usage file)", () => {
  let dir: string;
  let paperclipHome: string;
  let command: string;
  let capturePath: string;
  let previousPaperclipHome: string | undefined;
  let previousPaperclipInstanceId: string | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-quiet-usage-"));
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-home-"));
    previousPaperclipHome = process.env.PAPERCLIP_HOME;
    previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = FIXTURE_INSTANCE_ID;
    command = path.join(dir, "hermes.cjs");
    capturePath = path.join(dir, "invocations.jsonl");
    await fs.writeFile(command, `#!${process.execPath}
const fs = require("node:fs");
const usagePath = process.env.HERMES_USAGE_FILE || null;
fs.appendFileSync(process.env.CAPTURE_PATH, JSON.stringify({
  model: (() => {
    const i = process.argv.indexOf("-m");
    return i >= 0 ? process.argv[i + 1] : null;
  })(),
  usagePath,
  route: process.env.HERMES_PAPERCLIP_MODEL_ROUTE ?? null,
}) + "\\n");
if (usagePath) {
  fs.writeFileSync(usagePath, JSON.stringify({
    model: "fixture-model",
    input_tokens: 80,
    output_tokens: 12,
    estimated_cost_usd: 0.05,
    api_calls: 2,
    cost_status: "estimated",
  }) + "\\n");
}
console.log("Quiet response\\nsession_id: ${PRIMARY_SESSION}");
`, { mode: 0o700 });
  });

  afterEach(async () => {
    if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousPaperclipHome;
    if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(paperclipHome, { recursive: true, force: true });
  });

  it("sets HERMES_USAGE_FILE and surfaces estimated usage + phases without smart routing", async () => {
    const phases: string[] = [];
    const result = await execute({
      runId: "run-quiet-no-routing",
      agent: {
        id: "agent-synthetic",
        companyId: "company-synthetic",
        name: "Hermes fixture",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: "task-synthetic",
      },
      config: {
        hermesCommand: command,
        provider: "openrouter",
        model: "fixture-model",
        cwd: dir,
        env: { CAPTURE_PATH: capturePath },
        timeoutSec: 10,
        graceSec: 1,
        // Intentionally no smartModelRouting — matches Elena and most fleet agents.
      },
      context: {
        issueId: "task-synthetic",
        wakeReason: "issue_assigned",
        paperclipWake: {
          reason: "issue_assigned",
          issue: { id: "task-synthetic", title: "Synthetic task", status: "todo" },
          comments: [],
          commentWindow: { requestedCount: 0, returnedCount: 0, missingCount: 0 },
          fallbackFetchNeeded: false,
        },
      },
      onLog: async () => undefined,
      onEvent: async (event) => {
        if (typeof event.message === "string" && event.message.startsWith("run.phase.")) {
          phases.push(event.message);
        }
      },
    });

    const calls = (await fs.readFile(capturePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toHaveLength(1);
    expect(calls[0].route).toBeNull();
    expect(calls[0].usagePath).toMatch(/run-quiet-no-routing\.usage\.json$/);

    expect(result.usage).toEqual({ inputTokens: 80, outputTokens: 12 });
    expect(result.costUsd).toBeCloseTo(0.05);
    expect(result.costStatus).toBe("estimated");
    expect(result.resultJson).not.toHaveProperty("modelRouting");

    expect(phases).toContain("run.phase.first_token");
    expect(phases.filter((p) => p === "run.phase.turn_n")).toHaveLength(2);
  });

  it("still wires HERMES_USAGE_FILE when smart routing is explicitly disabled", async () => {
    await execute({
      runId: "run-routing-off",
      agent: {
        id: "agent-synthetic",
        companyId: "company-synthetic",
        name: "Hermes fixture",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: "task-synthetic",
      },
      config: {
        hermesCommand: command,
        provider: "openrouter",
        model: "fixture-model",
        cwd: dir,
        env: { CAPTURE_PATH: capturePath },
        timeoutSec: 10,
        graceSec: 1,
        smartModelRouting: { enabled: false },
      },
      context: {
        issueId: "task-synthetic",
        wakeReason: "issue_commented",
      },
      onLog: async () => undefined,
    });

    const calls = (await fs.readFile(capturePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toHaveLength(1);
    expect(calls[0].usagePath).toMatch(/run-routing-off\.usage\.json$/);
  });

  it("leaves accounting incomplete when usage file is empty after a successful run", async () => {
    const emptyUsageCommand = path.join(dir, "hermes-empty-usage.cjs");
    await fs.writeFile(emptyUsageCommand, `#!${process.execPath}
const fs = require("node:fs");
const usagePath = process.env.HERMES_USAGE_FILE || null;
fs.appendFileSync(process.env.CAPTURE_PATH, JSON.stringify({ usagePath }) + "\\n");
// Deliberately leave HERMES_USAGE_FILE empty / unwritten after provider work.
console.log("Quiet response\\nsession_id: ${PRIMARY_SESSION}");
`, { mode: 0o700 });

    const result = await execute({
      runId: "run-empty-usage",
      agent: {
        id: "agent-synthetic",
        companyId: "company-synthetic",
        name: "Hermes fixture",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: "task-synthetic",
      },
      config: {
        hermesCommand: emptyUsageCommand,
        provider: "openrouter",
        model: "fixture-model",
        cwd: dir,
        env: { CAPTURE_PATH: capturePath },
        timeoutSec: 10,
        graceSec: 1,
      },
      context: {
        issueId: "task-synthetic",
        wakeReason: "issue_assigned",
      },
      onLog: async () => undefined,
    });

    expect(result.exitCode).toBe(0);
    expect(result.usageComplete).toBe(false);
    expect(result.costStatus).toBe("unpriced");
    expect(result.costUsd).toBeUndefined();
    expect(result.usage).toBeUndefined();
  });
});
