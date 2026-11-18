import { describe, expect, it } from "vitest";

import {
  DEFAULT_HERMES_PAPERCLIP_TOOLSETS,
  resolveHermesToolsetsForRun,
} from "./execute.js";
import { preValidateHermesToolsets } from "./reliability.js";

describe("resolveHermesToolsetsForRun", () => {
  it("uses built-in defaults and keeps overlay MCP off -t (HERMES_MCP_OVERLAY owns them)", () => {
    const resolved = resolveHermesToolsetsForRun(undefined, ["paperclip-linear", "projects"]);
    for (const name of DEFAULT_HERMES_PAPERCLIP_TOOLSETS) {
      expect(resolved.split(",")).toContain(name);
    }
    expect(resolved.split(",")).not.toContain("mcp-paperclip-linear");
    expect(resolved.split(",")).not.toContain("mcp-projects");
    expect(resolved.split(",")).not.toContain("all");
    expect(preValidateHermesToolsets(resolved, ["paperclip-linear", "projects"]).ok).toBe(true);
  });

  it("preserves an explicit toolsets value without appending overlay slugs", () => {
    const resolved = resolveHermesToolsetsForRun("terminal,file", ["paperclip-linear"]);
    expect(resolved).toBe("terminal,file");
  });

  it("preserves explicitly listed mcp toolsets from adapterConfig", () => {
    expect(resolveHermesToolsetsForRun("terminal,mcp-x", ["x"])).toBe("terminal,mcp-x");
  });
});
