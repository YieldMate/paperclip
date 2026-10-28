import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

import { buildHermesRuntimeMcpOverlay, execute } from "./execute.js";

const SESSION_ID = "20261025_120000_abcdef";
const SECRET_TOKEN = "runtime-mcp-secret-token";

describe("buildHermesRuntimeMcpOverlay", () => {
  it("slugs names, disambiguates collisions, and puts tokens only in Authorization", () => {
    const overlay = buildHermesRuntimeMcpOverlay([
      { name: "Paperclip Linear!", url: "https://example.com/linear", token: "tok-a" },
      { name: "Paperclip Linear!", url: "https://example.com/linear-2", token: "tok-b" },
      { name: "  ???  ", url: "https://example.com/fallback" },
      { name: "No Token", url: "https://example.com/open", token: "" },
    ]);

    expect(overlay).toEqual({
      "paperclip-linear": {
        url: "https://example.com/linear",
        headers: { Authorization: "Bearer tok-a" },
      },
      "paperclip-linear-2": {
        url: "https://example.com/linear-2",
        headers: { Authorization: "Bearer tok-b" },
      },
      server: { url: "https://example.com/fallback" },
      "no-token": { url: "https://example.com/open" },
    });
  });

  it("skips servers without a url", () => {
    expect(buildHermesRuntimeMcpOverlay([
      { name: "Missing", url: "" },
      { name: "Ok", url: "https://example.com/ok", token: "t" },
    ])).toEqual({
      ok: {
        url: "https://example.com/ok",
        headers: { Authorization: "Bearer t" },
      },
    });
  });
});

describe("Hermes runtime MCP overlay (real capture process)", () => {
  let dir: string;
  let command: string;
  let capturePath: string;
  let logs: string[];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-runtime-mcp-"));
    command = path.join(dir, "hermes.cjs");
    capturePath = path.join(dir, "invocations.jsonl");
    logs = [];
    await fs.writeFile(command, `#!${process.execPath}
const fs = require("node:fs");
const overlayPath = process.env.HERMES_MCP_OVERLAY || null;
let overlay = null;
let overlayMode = null;
if (overlayPath) {
  overlay = JSON.parse(fs.readFileSync(overlayPath, "utf8"));
  overlayMode = fs.statSync(overlayPath).mode & 0o777;
}
fs.appendFileSync(process.env.CAPTURE_PATH, JSON.stringify({
  args: process.argv.slice(2),
  inprocess: process.env.HERMES_INPROCESS_CHAT ?? null,
  overlayPath,
  overlay,
  overlayMode,
  systemPrompt: process.env.HERMES_EPHEMERAL_SYSTEM_PROMPT ?? null,
}) + "\\n");
if (process.env.FIXTURE_EXIT_CODE) process.exit(Number(process.env.FIXTURE_EXIT_CODE));
console.log("Fixture completed\\nsession_id: ${SESSION_ID}");
`, { mode: 0o700 });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function context(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
    return {
      runId: "run-runtime-mcp",
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
      },
      context: {
        issueId: "task-synthetic",
        paperclipWake: {
          reason: "issue_assigned",
          issue: { id: "task-synthetic", title: "Synthetic task", status: "todo" },
          comments: [],
          commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
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

  it("always sets HERMES_INPROCESS_CHAT without an overlay when runtimeMcp is missing", async () => {
    await execute(context());
    const [invocation] = await invocations();
    expect(invocation.inprocess).toBe("1");
    expect(invocation.overlayPath).toBeNull();
    expect(invocation.overlay).toBeNull();
    expect(invocation.systemPrompt).toContain("Paperclip API guidance:");
    expect(invocation.systemPrompt).not.toContain("Paperclip connection tools:");
    expect(invocation.args).toContain("-q");
    expect(invocation.args).toContain("--yolo");
    expect(logs.join("")).not.toContain("Attached");
  });

  it.each(["", "   ", undefined])(
    "skips the overlay when servers exist but runId is %j",
    async (runId) => {
      await execute({
        ...context({ runId: runId as string }),
        runtimeMcp: {
          getServers: () => [{
            name: "Paperclip Linear",
            url: "https://mcp.example.com/linear",
            token: SECRET_TOKEN,
            connectionId: "conn-linear",
          }],
        },
      });

      const [invocation] = await invocations();
      expect(invocation.inprocess).toBe("1");
      expect(invocation.overlayPath).toBeNull();
      expect(invocation.overlay).toBeNull();
      expect(invocation.systemPrompt).not.toContain("Paperclip connection tools:");
      expect(logs.join("")).not.toContain("Attached");
      await expect(fs.access(path.join(os.tmpdir(), "paperclip-runtime-mcp", "undefined.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(path.join(os.tmpdir(), "paperclip-runtime-mcp", ".json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("writes a mode-0600 overlay, guides the prompt, and deletes the file after exit", async () => {
    const overlayPath = path.join(os.tmpdir(), "paperclip-runtime-mcp", "run-runtime-mcp.json");
    await execute({
      ...context(),
      runtimeMcp: {
        getServers: () => [
          {
            name: "Paperclip Linear",
            url: "https://mcp.example.com/linear",
            token: SECRET_TOKEN,
            connectionId: "conn-linear",
          },
          {
            name: "Paperclip projects",
            url: "https://mcp.example.com/projects",
            token: SECRET_TOKEN,
            connectionId: "paperclip-project-tools",
          },
        ],
      },
    });

    const [invocation] = await invocations();
    expect(invocation.inprocess).toBe("1");
    expect(invocation.overlayPath).toBe(overlayPath);
    expect(invocation.overlayMode).toBe(0o600);
    expect(invocation.overlay).toEqual({
      "paperclip-linear": {
        url: "https://mcp.example.com/linear",
        headers: { Authorization: `Bearer ${SECRET_TOKEN}` },
      },
      "paperclip-projects": {
        url: "https://mcp.example.com/projects",
        headers: { Authorization: `Bearer ${SECRET_TOKEN}` },
      },
    });
    expect(invocation.systemPrompt).toContain("Paperclip API guidance:");
    expect(invocation.systemPrompt).toContain("Paperclip connection tools:");
    expect(invocation.systemPrompt).toContain("mcp-paperclip-*");
    expect(invocation.systemPrompt).toContain("Do not use Hermes hosted connectors or manage_connections");
    expect(invocation.args).toContain("-q");
    expect(invocation.args).toContain("--yolo");
    expect(invocation.args).toContain("--provider");
    expect(logs.join("")).toContain("Attached 2 Paperclip MCP server(s) for this run.");
    expect(logs.join("")).not.toContain(SECRET_TOKEN);
    expect(logs.join("")).not.toContain("Authorization");
    await expect(fs.access(overlayPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes the overlay file when the child fails", async () => {
    const overlayPath = path.join(os.tmpdir(), "paperclip-runtime-mcp", "run-runtime-mcp.json");
    const result = await execute({
      ...context({
        config: {
          hermesCommand: command,
          provider: "openrouter",
          model: "fixture-model",
          cwd: dir,
          env: { CAPTURE_PATH: capturePath, FIXTURE_EXIT_CODE: "7" },
          timeoutSec: 10,
          graceSec: 1,
        },
      }),
      runtimeMcp: {
        getServers: () => [{
          name: "Paperclip Linear",
          url: "https://mcp.example.com/linear",
          token: SECRET_TOKEN,
          connectionId: "conn-linear",
        }],
      },
    });

    expect(result.exitCode).toBe(7);
    const [invocation] = await invocations();
    expect(invocation.overlayPath).toBe(overlayPath);
    await expect(fs.access(overlayPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes the overlay file when a startup log rejects", async () => {
    const overlayPath = path.join(os.tmpdir(), "paperclip-runtime-mcp", "run-runtime-mcp.json");
    await expect(execute({
      ...context({
        onLog: async (_stream, chunk) => {
          logs.push(chunk);
          if (chunk.includes("Starting Hermes Agent")) {
            throw new Error("run log write failed");
          }
        },
      }),
      runtimeMcp: {
        getServers: () => [{
          name: "Paperclip Linear",
          url: "https://mcp.example.com/linear",
          token: SECRET_TOKEN,
          connectionId: "conn-linear",
        }],
      },
    })).rejects.toThrow("run log write failed");

    await expect(fs.access(capturePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(overlayPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
