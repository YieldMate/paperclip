import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

import { execute } from "./execute.js";

const PIN_ENV_KEYS = [
  "PAPERCLIP_HOT_TOOL_PINNING_V1",
  "HERMES_HOT_TOOL_PINNING_V1",
  "HERMES_PINNED_TOOLS_FILE",
  "HERMES_PINNED_TOOLS",
  "PAPERCLIP_OVERLAYS_ROOT",
  "PAPERCLIP_HOME",
  "PAPERCLIP_INSTANCE_ID",
] as const;
const AGENT_ID = "agent-hot-pin";
const SESSION_ID = "20261106_120000_abcdef";

describe("execute: hot tool pinning v1 wiring (real child process)", () => {
  let dir: string;
  let paperclipHome: string;
  let overlaysRoot: string;
  let command: string;
  let capturePath: string;
  let saved: Record<string, string | undefined>;

  beforeEach(async () => {
    saved = Object.fromEntries(PIN_ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of PIN_ENV_KEYS) delete process.env[key];
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-hot-pin-"));
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-hot-pin-home-"));
    overlaysRoot = path.join(dir, "overlays");
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "hermes-hot-pin-test";
    process.env.PAPERCLIP_OVERLAYS_ROOT = overlaysRoot;
    await fs.mkdir(path.join(overlaysRoot, AGENT_ID), { recursive: true });
    await fs.writeFile(
      path.join(overlaysRoot, AGENT_ID, "pinned-tools.json"),
      JSON.stringify({
        version: 1,
        tools: [
          { name: "mcp_linear_get_issue", callCount: 9 },
          { name: "mcp_linear_save_comment", callCount: 4 },
        ],
      }),
    );
    command = path.join(dir, "hermes.cjs");
    capturePath = path.join(dir, "invocations.jsonl");
    await fs.writeFile(command, `#!${process.execPath}
const fs = require("node:fs");
const file = process.env.HERMES_PINNED_TOOLS_FILE || null;
fs.appendFileSync(process.env.CAPTURE_PATH, JSON.stringify({
  paperclipFlag: process.env.PAPERCLIP_HOT_TOOL_PINNING_V1 ?? null,
  hermesFlag: process.env.HERMES_HOT_TOOL_PINNING_V1 ?? null,
  pinnedFile: file,
  pinnedInline: process.env.HERMES_PINNED_TOOLS ?? null,
  pinnedFileBody: file ? JSON.parse(fs.readFileSync(file, "utf8")) : null,
  pinnedFileMode: file ? fs.statSync(file).mode & 0o777 : null,
}) + "\\n");
if (process.env.FIXTURE_USAGE === "1" && process.env.HERMES_USAGE_FILE) {
  fs.writeFileSync(process.env.HERMES_USAGE_FILE, JSON.stringify({
    model: "fixture-model", input_tokens: 10, output_tokens: 5, api_calls: 1,
    tool_search_calls: 2, tool_describe_calls: 1, tool_calls_total: 7, pinned_schema_tokens: 321,
  }));
}
console.log("Fixture completed\\nsession_id: ${SESSION_ID}");
`, { mode: 0o700 });
  });

  afterEach(async () => {
    for (const key of PIN_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(paperclipHome, { recursive: true, force: true });
  });

  function context(env: Record<string, string> = {}, overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
    return {
      runId: "run-hot-pin",
      agent: {
        id: AGENT_ID,
        companyId: "company-synthetic",
        name: "Hermes fixture",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "task-synthetic" },
      config: {
        hermesCommand: command,
        provider: "openrouter",
        model: "fixture-model",
        cwd: dir,
        env: { CAPTURE_PATH: capturePath, FIXTURE_USAGE: "1", ...env },
        timeoutSec: 10,
        graceSec: 1,
      },
      context: {
        issueId: "task-synthetic",
        paperclipWake: {
          reason: "issue_assigned",
          issue: { id: "task-synthetic", title: "Synthetic task", status: "todo" },
          comments: [],
          commentWindow: { requestedCount: 0, returnedCount: 0, missingCount: 0 },
          fallbackFetchNeeded: false,
        },
      },
      onLog: async () => undefined,
      ...overrides,
    };
  }

  async function lastInvocation() {
    const lines = (await fs.readFile(capturePath, "utf8")).trim().split("\n");
    return JSON.parse(lines[lines.length - 1]);
  }

  const TELEMETRY_KEYS = ["tool_search_calls", "tool_describe_calls", "tool_calls_total", "pinned_schema_tokens"];

  it("flag on: injects both flags and a private run-local pinned-tools file, removed after the run", async () => {
    const result = await execute(context({ PAPERCLIP_HOT_TOOL_PINNING_V1: "1" }));

    const invocation = await lastInvocation();
    expect(invocation.paperclipFlag).toBe("1");
    expect(invocation.hermesFlag).toBe("1");
    expect(invocation.pinnedFile).toContain(`${path.sep}runs${path.sep}run-hot-pin${path.sep}mcp${path.sep}pinned-tools.json`);
    expect(invocation.pinnedFile).not.toContain(overlaysRoot);
    expect(invocation.pinnedFileMode).toBe(0o600);
    expect(invocation.pinnedFileBody.tools.map((t: { name: string }) => t.name)).toEqual([
      "mcp_linear_get_issue",
      "mcp_linear_save_comment",
    ]);
    await expect(fs.access(invocation.pinnedFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.resultJson).toMatchObject({
      tool_search_calls: 2,
      tool_describe_calls: 1,
      tool_calls_total: 7,
      pinned_schema_tokens: 321,
    });
  });

  it("flag on via the host environment behaves the same", async () => {
    process.env.PAPERCLIP_HOT_TOOL_PINNING_V1 = "true";
    await execute(context());
    const invocation = await lastInvocation();
    expect(invocation.hermesFlag).toBe("1");
    expect(invocation.pinnedFile).toBeTruthy();
  });

  it("flag on with no overlay for the agent: flags set, no file, telemetry fields present", async () => {
    const result = await execute(
      context({ PAPERCLIP_HOT_TOOL_PINNING_V1: "1", FIXTURE_USAGE: "0" }, {
        agent: { id: "agent-no-overlay", companyId: "company-synthetic", name: "x", adapterType: "hermes_local", adapterConfig: {} },
      }),
    );
    const invocation = await lastInvocation();
    expect(invocation.hermesFlag).toBe("1");
    expect(invocation.pinnedFile).toBeNull();
    expect(result.resultJson).toMatchObject({
      tool_search_calls: null,
      tool_describe_calls: null,
      tool_calls_total: null,
      pinned_schema_tokens: null,
    });
  });

  it("flag off: clears every inherited pinning variable and adds no telemetry keys", async () => {
    process.env.HERMES_HOT_TOOL_PINNING_V1 = "1";
    process.env.HERMES_PINNED_TOOLS_FILE = "/leftover/pinned-tools.json";
    process.env.HERMES_PINNED_TOOLS = "[\"x\"]";
    const result = await execute(context({ HERMES_PINNED_TOOLS_FILE: "/configured/pinned-tools.json" }));

    const invocation = await lastInvocation();
    expect(invocation.paperclipFlag).toBeNull();
    expect(invocation.hermesFlag).toBeNull();
    expect(invocation.pinnedFile).toBeNull();
    expect(invocation.pinnedInline).toBeNull();
    const resultJson = result.resultJson as Record<string, unknown>;
    for (const key of TELEMETRY_KEYS) expect(key in resultJson).toBe(false);
  });

  it("flag explicitly 0: same as unset", async () => {
    const result = await execute(context({ PAPERCLIP_HOT_TOOL_PINNING_V1: "0" }));
    const invocation = await lastInvocation();
    expect(invocation.paperclipFlag).toBeNull();
    expect(invocation.pinnedFile).toBeNull();
    for (const key of TELEMETRY_KEYS) expect(key in (result.resultJson as object)).toBe(false);
  });
});
