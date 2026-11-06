import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyHotToolPinningEnv,
  deriveHotSet,
  estimateSchemaTokens,
  HERMES_HOT_TOOL_PINNING_V1_ENV,
  HERMES_PINNED_TOOLS_ENV,
  HERMES_PINNED_TOOLS_FILE_ENV,
  HOT_TOOL_PINNING_V1_ENV,
  isHotToolPinningV1Enabled,
  isSafeOverlayAgentId,
  MAX_PINNED_SCHEMA_TOKENS,
  MAX_PINNED_TOOLS,
  mergeHotToolPinningTelemetry,
  parsePinnedToolsManifest,
  pinnedToolsManifestPath,
  pythonJsonDumps,
  resolveOverlaysRoot,
  type HotToolCount,
} from "./hot-tool-pinning.js";

const silent = { warn: vi.fn() };

function counts(entries: Array<[string, number]>): HotToolCount[] {
  return entries.map(([toolName, callCount]) => ({ toolName, callCount }));
}

function schemaOfTokens(name: string, targetTokens: number): Record<string, unknown> {
  const schema = { name, description: "", parameters: {} };
  const base = estimateSchemaTokens(schema);
  return { ...schema, description: "x".repeat(Math.max(0, (targetTokens - base) * 4)) };
}

describe("isHotToolPinningV1Enabled", () => {
  it("defaults off and enables on 1/true/on/yes only", () => {
    expect(isHotToolPinningV1Enabled({})).toBe(false);
    for (const off of ["", "0", "false", "off", "no", "maybe"]) {
      expect(isHotToolPinningV1Enabled({ [HOT_TOOL_PINNING_V1_ENV]: off })).toBe(false);
    }
    for (const on of ["1", "true", "TRUE", " on ", "yes"]) {
      expect(isHotToolPinningV1Enabled({ [HOT_TOOL_PINNING_V1_ENV]: on })).toBe(true);
    }
  });

  it("ignores the Hermes-side flag: Paperclip has a single authority", () => {
    expect(isHotToolPinningV1Enabled({ [HERMES_HOT_TOOL_PINNING_V1_ENV]: "1" })).toBe(false);
  });
});

describe("deriveHotSet", () => {
  it("keeps the top 10 by call count and reports the rest as cap drops", () => {
    const rows = counts(Array.from({ length: 14 }, (_, i) => [`tool_${String(i).padStart(2, "0")}`, 100 - i]));
    const result = deriveHotSet(rows, { log: silent });
    expect(MAX_PINNED_TOOLS).toBe(10);
    expect(result.tools.map((t) => t.name)).toEqual(rows.slice(0, 10).map((r) => r.toolName));
    expect(result.droppedByCap).toEqual(["tool_10", "tool_11", "tool_12", "tool_13"]);
    expect(result.droppedByTokens).toEqual([]);
  });

  it("breaks ties by lexicographically earlier tool name", () => {
    const rows = counts([["zeta", 5], ["alpha", 5], ["mid", 5], ["top", 9]]);
    expect(deriveHotSet(rows, { maxTools: 3, log: silent }).tools.map((t) => t.name)).toEqual(["top", "alpha", "mid"]);
  });

  it("merges duplicate names and ignores empty names and non-positive counts", () => {
    const result = deriveHotSet(
      counts([["a", 2], ["a", 3], ["", 9], ["b", 0], ["c", -1], ["d", Number.NaN]]),
      { log: silent },
    );
    expect(result.tools).toEqual([{ name: "a", callCount: 5 }]);
  });

  it("drops the least-used tools (and logs each) until schemas fit the token cap", () => {
    const log = { warn: vi.fn() };
    const rows: HotToolCount[] = [
      { toolName: "most", callCount: 50, schema: schemaOfTokens("most", 4000) },
      { toolName: "second", callCount: 40, schema: schemaOfTokens("second", 4000) },
      { toolName: "third", callCount: 30, schema: schemaOfTokens("third", 3000) },
      { toolName: "least", callCount: 1, schema: schemaOfTokens("least", 500) },
    ];
    const result = deriveHotSet(rows, { log });
    expect(MAX_PINNED_SCHEMA_TOKENS).toBe(10_000);
    expect(result.tools.map((t) => t.name)).toEqual(["most", "second"]);
    expect(result.droppedByTokens).toEqual(["least", "third"]);
    expect(result.schemaTokens).toBeLessThanOrEqual(MAX_PINNED_SCHEMA_TOKENS);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls[0]).toEqual([
      expect.stringContaining("token cap"),
      expect.objectContaining({ dropped: "least", callCount: 1 }),
    ]);
  });

  it("drops the lexicographically later name first when least-used tools tie on count", () => {
    const rows: HotToolCount[] = [
      { toolName: "a_tool", callCount: 3, schema: schemaOfTokens("a_tool", 600) },
      { toolName: "b_tool", callCount: 3, schema: schemaOfTokens("b_tool", 600) },
    ];
    const result = deriveHotSet(rows, { maxSchemaTokens: 700, log: silent });
    expect(result.tools.map((t) => t.name)).toEqual(["a_tool"]);
    expect(result.droppedByTokens).toEqual(["b_tool"]);
  });

  it("counts tools without a schema as zero tokens", () => {
    const result = deriveHotSet(counts([["a", 2], ["b", 1]]), { maxSchemaTokens: 1, log: silent });
    expect(result.tools).toHaveLength(2);
    expect(result.schemaTokens).toBe(0);
  });
});

describe("estimateSchemaTokens", () => {
  it("measures the wire shape with Python json.dumps spacing (chars / 4, rounded up)", () => {
    const schema = { description: "é ü \u2603 \"q\"" };
    // Python: len(json.dumps({"type": "function", "function": schema})) == 79
    expect(pythonJsonDumps({ type: "function", function: schema }).length).toBe(79);
    expect(estimateSchemaTokens(schema)).toBe(20);
  });
});

describe("overlay manifests", () => {
  it("accepts manifest objects, bare lists and name strings; skips malformed entries", () => {
    const entries = parsePinnedToolsManifest({
      version: 1,
      tools: [
        { name: " a ", callCount: 3, schema: { type: "function", function: { name: "a", parameters: {} } } },
        "b",
        { name: "" },
        { callCount: 2 },
        null,
      ],
    });
    expect(entries).toEqual([
      { name: "a", callCount: 3, schema: { name: "a", parameters: {} } },
      { name: "b", callCount: 0 },
    ]);
    expect(parsePinnedToolsManifest(["x"])).toEqual([{ name: "x", callCount: 0 }]);
    expect(parsePinnedToolsManifest("nope")).toEqual([]);
  });

  it("rejects agent ids that could escape the overlays root", () => {
    expect(isSafeOverlayAgentId("3f1c0a9e-1111-4222-8333-444455556666")).toBe(true);
    for (const bad of ["", "..", "../x", "a/b", "a..b", "_example", ".hidden"]) {
      expect(isSafeOverlayAgentId(bad)).toBe(false);
    }
    expect(() => pinnedToolsManifestPath("/o", "../x")).toThrow(/unsafe/);
    expect(pinnedToolsManifestPath("/o", "agent-1")).toBe(path.join("/o", "agent-1", "pinned-tools.json"));
  });

  it("resolves the overlays root from env, else the repo-relative overlays/ dir", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "hot-pin-root-"));
    try {
      await fs.writeFile(path.join(repo, "pnpm-workspace.yaml"), "packages: []\n");
      const nested = path.join(repo, "a", "b");
      await fs.mkdir(nested, { recursive: true });
      expect(await resolveOverlaysRoot({ PAPERCLIP_OVERLAYS_ROOT: "/custom/overlays" }, nested)).toBe("/custom/overlays");
      expect(await resolveOverlaysRoot({}, nested)).toBe(path.join(repo, "overlays"));
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

describe("applyHotToolPinningEnv", () => {
  let tmp: string;
  let overlaysRoot: string;
  let runDir: string;
  const AGENT = "agent-synthetic";

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hot-pin-env-"));
    overlaysRoot = path.join(tmp, "overlays");
    runDir = path.join(tmp, "run", "mcp");
    await fs.mkdir(path.join(overlaysRoot, AGENT), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function writeOverlay(tools: unknown[]) {
    await fs.writeFile(
      path.join(overlaysRoot, AGENT, "pinned-tools.json"),
      JSON.stringify({ version: 1, tools }),
    );
  }

  it("flag on: writes a private run-local copy and sets the child env", async () => {
    await writeOverlay([
      { name: "b_tool", callCount: 1 },
      { name: "a_tool", callCount: 7, schema: { name: "a_tool", description: "d", parameters: {} } },
    ]);
    const env: Record<string, string> = {};
    const state = await applyHotToolPinningEnv(env, {
      enabled: true,
      agentId: AGENT,
      runDir,
      overlaysRoot,
      log: silent,
    });

    const runLocal = path.join(runDir, "pinned-tools.json");
    expect(env[HOT_TOOL_PINNING_V1_ENV]).toBe("1");
    expect(env[HERMES_HOT_TOOL_PINNING_V1_ENV]).toBe("1");
    expect(env[HERMES_PINNED_TOOLS_FILE_ENV]).toBe(runLocal);
    expect(state).toMatchObject({ enabled: true, pinnedToolsFile: runLocal, pinnedCount: 2 });
    expect((await fs.stat(runLocal)).mode & 0o777).toBe(0o600);
    const written = JSON.parse(await fs.readFile(runLocal, "utf8"));
    expect(written.tools.map((t: { name: string }) => t.name)).toEqual(["a_tool", "b_tool"]);
    expect(written.agentId).toBe(AGENT);
    expect(runLocal).not.toContain(overlaysRoot);
  });

  it("flag on: re-applies the caps to a stale or hand-edited overlay", async () => {
    await writeOverlay(Array.from({ length: 13 }, (_, i) => ({ name: `t${String(i).padStart(2, "0")}`, callCount: 100 - i })));
    const env: Record<string, string> = {};
    const state = await applyHotToolPinningEnv(env, { enabled: true, agentId: AGENT, runDir, overlaysRoot, log: silent });
    expect(state.pinnedCount).toBe(10);
  });

  it("flag on without a manifest: sets the flags, no file path, no run-local copy", async () => {
    const env: Record<string, string> = { [HERMES_PINNED_TOOLS_FILE_ENV]: "/stale/pinned.json" };
    const state = await applyHotToolPinningEnv(env, {
      enabled: true,
      agentId: "agent-without-overlay",
      runDir,
      overlaysRoot,
      log: silent,
    });
    expect(env[HERMES_HOT_TOOL_PINNING_V1_ENV]).toBe("1");
    expect(env[HERMES_PINNED_TOOLS_FILE_ENV]).toBeUndefined();
    expect(state.pinnedToolsFile).toBeNull();
    await expect(fs.access(path.join(runDir, "pinned-tools.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("flag on with a corrupt manifest: warns and pins nothing", async () => {
    await fs.writeFile(path.join(overlaysRoot, AGENT, "pinned-tools.json"), "{not json");
    const log = { warn: vi.fn() };
    const env: Record<string, string> = {};
    const state = await applyHotToolPinningEnv(env, { enabled: true, agentId: AGENT, runDir, overlaysRoot, log });
    expect(state.pinnedToolsFile).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("not valid JSON"), expect.anything());
  });

  it("flag off: leaves no pinning variable behind, including inherited ones", async () => {
    await writeOverlay([{ name: "a_tool", callCount: 1 }]);
    const env: Record<string, string> = {
      PATH: "/bin",
      [HOT_TOOL_PINNING_V1_ENV]: "0",
      [HERMES_HOT_TOOL_PINNING_V1_ENV]: "1",
      [HERMES_PINNED_TOOLS_FILE_ENV]: "/leftover/pinned-tools.json",
      [HERMES_PINNED_TOOLS_ENV]: "[\"a_tool\"]",
    };
    const state = await applyHotToolPinningEnv(env, { enabled: false, agentId: AGENT, runDir, overlaysRoot });
    expect(env.PATH).toBe("/bin");
    for (const key of [HOT_TOOL_PINNING_V1_ENV, HERMES_HOT_TOOL_PINNING_V1_ENV, HERMES_PINNED_TOOLS_FILE_ENV, HERMES_PINNED_TOOLS_ENV]) {
      expect(env[key]).toBeUndefined();
    }
    expect(state).toEqual({ enabled: false, pinnedToolsFile: null, pinnedCount: 0, schemaTokens: 0 });
    await expect(fs.access(runDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("mergeHotToolPinningTelemetry", () => {
  it("flag off: returns null so no keys are added", () => {
    expect(mergeHotToolPinningTelemetry([{ tool_calls_total: 4 }], false)).toBeNull();
  });

  it("sums call counters across preflight + primary and takes the largest schema-token figure", () => {
    expect(
      mergeHotToolPinningTelemetry(
        [
          { tool_search_calls: 1, tool_describe_calls: 0, tool_calls_total: 2, pinned_schema_tokens: 800 },
          null,
          { tool_search_calls: 2, tool_describe_calls: 3, tool_calls_total: 9, pinned_schema_tokens: 1200 },
        ],
        true,
      ),
    ).toEqual({ tool_search_calls: 3, tool_describe_calls: 3, tool_calls_total: 11, pinned_schema_tokens: 1200 });
  });

  it("flag on with nothing reported: explicit nulls; junk values are ignored", () => {
    expect(mergeHotToolPinningTelemetry([null, undefined], true)).toEqual({
      tool_search_calls: null,
      tool_describe_calls: null,
      tool_calls_total: null,
      pinned_schema_tokens: null,
    });
    expect(
      mergeHotToolPinningTelemetry([{ tool_calls_total: -1, tool_search_calls: Number.NaN, pinned_schema_tokens: null }], true),
    ).toMatchObject({ tool_calls_total: null, tool_search_calls: null, pinned_schema_tokens: null });
  });
});
