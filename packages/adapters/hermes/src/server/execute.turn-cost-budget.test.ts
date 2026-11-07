/**
 * YIE-73 T1–T5 execute-path tests (Corin QA).
 * Flag default OFF; enable via PAPERCLIP_TURN_COST_BUDGET_V1 + budget.enabled.
 */
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

import { execute, resolveManagedHermesRuntimeStateDir } from "./execute.js";
import {
  __resetResidentsForTests,
  getLiveResident,
  normalizeCwdIdentity,
  residentStatePath,
  startResident,
  stopResident,
} from "./resident.js";
import { RESIDENT_WARM_POLICY_V2_ENV } from "./resident-warm-policy.js";
import {
  BUDGET_CHECKPOINT_MONITOR_NOTES,
  BUDGET_CHECKPOINT_PHASE,
  BUDGET_HARD_LIMIT_PHASE,
  TURN_COST_BUDGET_V1_ENV,
} from "./turn-cost-budget.js";

const SESSION_ID = "20261107_budget_abcdef";
const COMPANY_ID = "company-budget";
const AGENT_ID = "agent-budget";
const ISSUE_ID = "issue-budget";
const MODEL = "fixture-model";
const FIXTURE_INSTANCE_ID = "hermes-budget-test";

type PhaseEvent = { message: string; payload: Record<string, unknown> };

describe("execute: turn/cost budget T1–T5 (YIE-73)", () => {
  let dir: string;
  let paperclipHome: string;
  let command: string;
  let capturePath: string;
  let savedEnv: Record<string, string | undefined>;
  let phaseEvents: PhaseEvent[];
  let patchBodies: Array<Record<string, unknown>>;
  let apiServer: http.Server | null = null;
  let apiBase: string;

  const ENV_KEYS = [
    TURN_COST_BUDGET_V1_ENV,
    RESIDENT_WARM_POLICY_V2_ENV,
    "PAPERCLIP_HOME",
    "PAPERCLIP_INSTANCE_ID",
    "PAPERCLIP_API_URL",
    "PAPERCLIP_PERF_TELEMETRY",
  ] as const;

  beforeEach(async () => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    __resetResidentsForTests();
    phaseEvents = [];
    patchBodies = [];

    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-budget-"));
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-budget-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = FIXTURE_INSTANCE_ID;
    process.env.PAPERCLIP_PERF_TELEMETRY = "1";

    capturePath = path.join(dir, "invocations.jsonl");
    command = path.join(dir, "hermes.cjs");
    await fs.writeFile(
      command,
      `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const args = process.argv.slice(2);
const maxTurnsIdx = args.indexOf("--max-turns");
const maxTurns = maxTurnsIdx >= 0 ? Number(args[maxTurnsIdx + 1]) : null;
fs.appendFileSync(process.env.CAPTURE_PATH, JSON.stringify({
  args,
  maxTurns,
  dispositionPath: process.env.HERMES_DISPOSITION_FILE ?? null,
  usagePath: process.env.HERMES_USAGE_FILE ?? null,
  mode: args.includes("--resident") ? "resident" : "oneshot",
}) + "\\n");

if (args.includes("--resident")) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.shutdown) { process.exit(0); return; }
    const turns = Number(process.env.FIXTURE_API_CALLS || "1");
    if (process.env.HERMES_USAGE_FILE) {
      fs.writeFileSync(process.env.HERMES_USAGE_FILE, JSON.stringify({
        model: "${MODEL}", input_tokens: 10, output_tokens: 5, api_calls: turns,
        estimated_cost_usd: Number(process.env.FIXTURE_COST_USD || "0.01"),
        cost_status: process.env.FIXTURE_COST_STATUS || "estimated",
      }));
    }
    if (process.env.FIXTURE_WRITE_DISPOSITION === "1" && process.env.HERMES_DISPOSITION_FILE) {
      fs.writeFileSync(process.env.HERMES_DISPOSITION_FILE, JSON.stringify({
        status: process.env.FIXTURE_DISPOSITION_STATUS || "done",
        comment: process.env.FIXTURE_DISPOSITION_COMMENT || "finished early",
      }));
    }
    process.stdout.write(JSON.stringify({
      ok: true,
      response: "resident-turn",
      session_id: "${SESSION_ID}",
    }) + "\\n");
  });
} else {
  const turns = Number(process.env.FIXTURE_API_CALLS || "1");
  if (process.env.HERMES_USAGE_FILE) {
    fs.writeFileSync(process.env.HERMES_USAGE_FILE, JSON.stringify({
      model: "${MODEL}", input_tokens: 10, output_tokens: 5, api_calls: turns,
      estimated_cost_usd: Number(process.env.FIXTURE_COST_USD || "0.01"),
      cost_status: process.env.FIXTURE_COST_STATUS || "estimated",
    }));
  }
  if (process.env.FIXTURE_WRITE_DISPOSITION === "1" && process.env.HERMES_DISPOSITION_FILE) {
    fs.writeFileSync(process.env.HERMES_DISPOSITION_FILE, JSON.stringify({
      status: process.env.FIXTURE_DISPOSITION_STATUS || "done",
      comment: process.env.FIXTURE_DISPOSITION_COMMENT || "finished early",
    }));
  }
  // Capture the disposition path body AFTER a short tick so adapter can rewrite it.
  console.log("Fixture completed\\nsession_id: ${SESSION_ID}");
}
`,
      { mode: 0o700 },
    );

    apiServer = http.createServer((req, res) => {
      if (req.method === "PATCH" && req.url?.startsWith("/api/issues/")) {
        let body = "";
        req.on("data", (c) => {
          body += c;
        });
        req.on("end", () => {
          try {
            patchBodies.push(JSON.parse(body));
          } catch {
            patchBodies.push({ raw: body });
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => {
      apiServer!.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = apiServer.address();
    if (!addr || typeof addr === "string") throw new Error("no api port");
    apiBase = `http://127.0.0.1:${addr.port}/api`;
    process.env.PAPERCLIP_API_URL = apiBase;
  });

  afterEach(async () => {
    await stopResident({
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      issueId: ISSUE_ID,
    }).catch(() => undefined);
    __resetResidentsForTests();
    if (apiServer) {
      await new Promise<void>((resolve) => apiServer!.close(() => resolve()));
      apiServer = null;
    }
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(paperclipHome, { recursive: true, force: true });
  });

  function context(
    env: Record<string, string> = {},
    overrides: Partial<AdapterExecutionContext> = {},
    budget: Record<string, unknown> = { enabled: true, turns: 3, checkpointThreshold: 0.8 },
  ): AdapterExecutionContext {
    return {
      runId: "run-budget",
      agent: {
        id: AGENT_ID,
        companyId: COMPANY_ID,
        name: "Hermes budget fixture",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: ISSUE_ID,
      },
      config: {
        hermesCommand: command,
        provider: "openrouter",
        model: MODEL,
        cwd: dir,
        env: { CAPTURE_PATH: capturePath, ...env },
        timeoutSec: 15,
        graceSec: 1,
        budget,
        paperclipApiUrl: apiBase,
      },
      context: {
        issueId: ISSUE_ID,
        paperclipWake: {
          reason: "issue_assigned",
          issue: { id: ISSUE_ID, title: "Budget task", status: "todo" },
          comments: [],
          commentWindow: { requestedCount: 0, returnedCount: 0, missingCount: 0 },
          fallbackFetchNeeded: false,
        },
      },
      authToken: "test-budget-token",
      onLog: async () => undefined,
      onEvent: async (event) => {
        if (typeof event.message === "string" && event.message.startsWith("run.phase.")) {
          phaseEvents.push({
            message: event.message,
            payload: (event.payload as Record<string, unknown>) ?? {},
          });
        }
      },
      ...overrides,
    } as AdapterExecutionContext;
  }

  async function lastInvocation() {
    const lines = (await fs.readFile(capturePath, "utf8")).trim().split("\n");
    return JSON.parse(lines[lines.length - 1]);
  }

  it("T5 + flag off: under-budget / flag-off behave like pre-change (no budget decision)", async () => {
    // Flag unset, budget.enabled true → inactive
    const result = await execute(
      context({ FIXTURE_API_CALLS: "2", FIXTURE_WRITE_DISPOSITION: "1" }),
    );
    expect(result.exitCode).toBe(0);
    const rj = result.resultJson as Record<string, unknown>;
    expect(rj.budget).toBeUndefined();
    expect(phaseEvents.some((e) => e.message.includes(BUDGET_CHECKPOINT_PHASE))).toBe(false);
    expect(patchBodies).toHaveLength(0);
    expect((await lastInvocation()).maxTurns).toBeNull();
  });

  it("T5: flag on but well under soft budget with terminal done → no checkpoint", async () => {
    process.env[TURN_COST_BUDGET_V1_ENV] = "1";
    const result = await execute(
      context(
        {
          FIXTURE_API_CALLS: "1",
          FIXTURE_WRITE_DISPOSITION: "1",
          FIXTURE_DISPOSITION_STATUS: "done",
        },
        {},
        { enabled: true, turns: 40, checkpointThreshold: 0.8 },
      ),
    );
    expect(result.exitCode).toBe(0);
    const budget = (result.resultJson as { budget: { decision: string } }).budget;
    expect(budget.decision).toBe("none");
    expect(phaseEvents.some((e) => e.message.includes(BUDGET_CHECKPOINT_PHASE))).toBe(false);
    expect(patchBodies).toHaveLength(0);
  });

  it("T1: soft-budget checkpoint written to absolute HERMES_DISPOSITION_FILE + registered monitor", async () => {
    process.env[TURN_COST_BUDGET_V1_ENV] = "1";
    // budget=3, threshold=0.8 → softMax=2; fixture reports 2 turns, no terminal disposition
    const result = await execute(
      context(
        { FIXTURE_API_CALLS: "2" },
        {},
        { enabled: true, turns: 3, checkpointThreshold: 0.8 },
      ),
    );

    const invocation = await lastInvocation();
    expect(invocation.maxTurns).toBe(2);
    expect(path.isAbsolute(invocation.dispositionPath)).toBe(true);
    // Run dir cleaned in finally — assert via resultJson (harness source of truth).
    const disposition = (result.resultJson as {
      disposition: { status: string; comment: string; monitor: { nextCheckAt: string; notes: string } };
      budget: { decision: string; monitor: { notes: string }; event: { phase: string } };
    }).disposition;
    expect(disposition.status).toBe("in_progress");
    expect(disposition.comment.toLowerCase()).toMatch(/remaining|resum/);
    expect(disposition.monitor.notes).toBe(BUDGET_CHECKPOINT_MONITOR_NOTES);
    expect(disposition.monitor.nextCheckAt).toBeTruthy();

    expect(result.exitCode).toBe(0);
    expect(patchBodies[0]).toMatchObject({
      executionPolicy: {
        monitor: { notes: BUDGET_CHECKPOINT_MONITOR_NOTES },
      },
    });
    const fired = phaseEvents.find((e) => e.message === `run.phase.${BUDGET_CHECKPOINT_PHASE}`);
    expect(fired).toBeTruthy();
    expect(fired?.payload.phase).toBe(BUDGET_CHECKPOINT_PHASE);
    expect(fired?.payload.measuredTurns).toBe(2);
    expect(fired?.payload.budgetTurns).toBe(3);
    expect(fired?.payload.issueId).toBe(ISSUE_ID);
    expect(fired?.payload.agentId).toBe(AGENT_ID);
  });

  it("T4: hard turns (threshold=1) → blocked disposition + hard_limit event + resident gone", async () => {
    process.env[TURN_COST_BUDGET_V1_ENV] = "1";
    process.env[RESIDENT_WARM_POLICY_V2_ENV] = "1";
    const key = { companyId: COMPANY_ID, agentId: AGENT_ID, issueId: ISSUE_ID };
    const runtimeDir = resolveManagedHermesRuntimeStateDir(
      {
        PAPERCLIP_HOME: paperclipHome,
        PAPERCLIP_INSTANCE_ID: FIXTURE_INSTANCE_ID,
      },
      COMPANY_ID,
      AGENT_ID,
    );
    await fs.mkdir(path.join(runtimeDir, "residents"), { recursive: true });
    await startResident({
      key,
      hermesCmd: command,
      model: MODEL,
      provider: "openrouter",
      toolsets: "terminal",
      cwd: dir,
      cwdIdentity: await normalizeCwdIdentity(dir),
      env: { CAPTURE_PATH: capturePath, FIXTURE_API_CALLS: "1" },
      sessionId: SESSION_ID,
      idleSec: 900,
      ttlSec: 900,
      statePath: residentStatePath(runtimeDir, ISSUE_ID),
    });

    const result = await execute(
      context(
        { FIXTURE_API_CALLS: "5" },
        {},
        { enabled: true, turns: 5, checkpointThreshold: 1, enforceHardCost: false },
      ),
    );

    expect(result.exitCode).toBe(1);
    const disposition = (result.resultJson as {
      disposition: { status: string; comment: string };
      budget: { decision: string };
    }).disposition;
    expect(disposition.status).toBe("blocked");
    expect(disposition.comment.toLowerCase()).toMatch(/budget/);
    expect(disposition.status).not.toBe("done");
    const fired = phaseEvents.find((e) => e.message === `run.phase.${BUDGET_HARD_LIMIT_PHASE}`);
    expect(fired?.payload.phase).toBe(BUDGET_HARD_LIMIT_PHASE);
    expect(fired?.payload.measuredTurns).toBe(5);
    expect(getLiveResident(key)).toBeFalsy();
    expect(patchBodies).toHaveLength(0); // no monitor on hard limit
  });

  it("T4c: hard cost fail-safe (R4) with untrustworthy cost → blocked", async () => {
    process.env[TURN_COST_BUDGET_V1_ENV] = "1";
    const result = await execute(
      context(
        {
          FIXTURE_API_CALLS: "1",
          FIXTURE_COST_STATUS: "unpriced",
        },
        {},
        {
          enabled: true,
          turns: 40,
          checkpointThreshold: 0.8,
          enforceHardCost: true,
        },
      ),
    );
    expect(result.exitCode).toBe(1);
    const disposition = (result.resultJson as { disposition: { status: string } }).disposition;
    expect(disposition.status).toBe("blocked");
    expect(
      phaseEvents.some((e) => e.message === `run.phase.${BUDGET_HARD_LIMIT_PHASE}`),
    ).toBe(true);
  });

  it("T2: checkpoint keeps same resident key warm for next wake (no re-key/evict)", async () => {
    process.env[TURN_COST_BUDGET_V1_ENV] = "1";
    process.env[RESIDENT_WARM_POLICY_V2_ENV] = "1";
    const key = { companyId: COMPANY_ID, agentId: AGENT_ID, issueId: ISSUE_ID };

    // First run: oneshot hits soft budget → checkpoint + warm resident
    const first = await execute(
      context(
        { FIXTURE_API_CALLS: "2" },
        {
          config: {
            hermesCommand: command,
            provider: "openrouter",
            model: MODEL,
            cwd: dir,
            env: { CAPTURE_PATH: capturePath, FIXTURE_API_CALLS: "2" },
            timeoutSec: 15,
            graceSec: 1,
            budget: { enabled: true, turns: 3, checkpointThreshold: 0.8 },
            paperclipApiUrl: apiBase,
            residentSession: true,
          },
        },
        { enabled: true, turns: 3, checkpointThreshold: 0.8 },
      ),
    );
    expect(first.exitCode).toBe(0);
    expect(
      (first.resultJson as { disposition: { status: string } }).disposition.status,
    ).toBe("in_progress");
    const live = getLiveResident(key);
    expect(live).toBeTruthy();
    const pidBefore = live?.child.pid;

    // Second wake on SAME issue: should reuse warm resident (T2)
    const t0 = Date.now();
    const second = await execute(
      context(
        {
          FIXTURE_API_CALLS: "1",
          FIXTURE_WRITE_DISPOSITION: "1",
          FIXTURE_DISPOSITION_STATUS: "done",
        },
        {
          config: {
            hermesCommand: command,
            provider: "openrouter",
            model: MODEL,
            cwd: dir,
            env: {
              CAPTURE_PATH: capturePath,
              FIXTURE_API_CALLS: "1",
              FIXTURE_WRITE_DISPOSITION: "1",
              FIXTURE_DISPOSITION_STATUS: "done",
            },
            timeoutSec: 15,
            graceSec: 1,
            budget: { enabled: true, turns: 40, checkpointThreshold: 0.8 },
            paperclipApiUrl: apiBase,
            residentSession: true,
          },
          runtime: {
            sessionId: SESSION_ID,
            sessionParams: { sessionId: SESSION_ID },
            sessionDisplayId: SESSION_ID.slice(0, 16),
            taskKey: ISSUE_ID,
          },
        },
        { enabled: true, turns: 40, checkpointThreshold: 0.8 },
      ),
    );
    const resumeMs = Date.now() - t0;
    expect(second.exitCode).toBe(0);
    expect(resumeMs).toBeLessThan(5000);
    const liveAfter = getLiveResident(key);
    // Same key; process may be same pid if reused through warm path
    expect(liveAfter).toBeTruthy();
    expect(pidBefore).toBeTruthy();
    // No re-key/evict: same {companyId,agentId,issueId} resident still live (R1)
    expect(String(liveAfter?.key ?? "")).toContain(COMPANY_ID);
    expect(String(liveAfter?.key ?? "")).toContain(AGENT_ID);
    expect(String(liveAfter?.key ?? "")).toContain(ISSUE_ID);
    expect(getLiveResident(key)?.child.pid).toBeTruthy();
  });

  it("T3: starting states todo/in_progress/in_review + open-children fixture never omit monitor on checkpoint", async () => {
    process.env[TURN_COST_BUDGET_V1_ENV] = "1";
    const startingStates = ["todo", "in_progress", "in_review"] as const;
    for (const status of startingStates) {
      phaseEvents = [];
      patchBodies = [];
      const issueId = `issue-budget-${status}`;
      const result = await execute(
        context(
          { FIXTURE_API_CALLS: "2" },
          {
            runId: `run-budget-${status}`,
            context: {
              issueId,
              paperclipWake: {
                reason: "issue_assigned",
                issue: {
                  id: issueId,
                  title: `Budget ${status}`,
                  status,
                  // R6: open child issues present on wake payload
                  children: [{ id: `${issueId}-child`, status: "todo", title: "child" }],
                },
                comments: [],
                commentWindow: { requestedCount: 0, returnedCount: 0, missingCount: 0 },
                fallbackFetchNeeded: false,
              },
            },
            agent: {
              id: AGENT_ID,
              companyId: COMPANY_ID,
              name: "Hermes budget fixture",
              adapterType: "hermes_local",
              adapterConfig: {},
            },
          },
          { enabled: true, turns: 3, checkpointThreshold: 0.8 },
        ),
      );
      const disposition = (result.resultJson as {
        disposition: { status: string; monitor?: { notes: string; nextCheckAt: string } };
      }).disposition;
      expect(disposition.status).toBe("in_progress");
      expect(disposition.monitor?.notes).toBe(BUDGET_CHECKPOINT_MONITOR_NOTES);
      expect(disposition.monitor?.nextCheckAt).toBeTruthy();
      expect(patchBodies.length).toBeGreaterThanOrEqual(1);
      expect(patchBodies[0]).toMatchObject({
        executionPolicy: { monitor: { notes: BUDGET_CHECKPOINT_MONITOR_NOTES } },
      });
      // Zero deliberate_wait_without_target risk: registered monitor always present
      expect(
        phaseEvents.some((e) => e.message === `run.phase.${BUDGET_CHECKPOINT_PHASE}`),
      ).toBe(true);
    }
  });
});
