import { describe, expect, it } from "vitest";

import {
  DEFAULT_HERMES_PAPERCLIP_TOOLSETS,
  resolveHermesToolsetsForRun,
} from "./execute.js";

describe("resolveHermesToolsetsForRun", () => {
  it("uses built-in defaults and appends overlay MCP slugs when toolsets unset", () => {
    const resolved = resolveHermesToolsetsForRun(undefined, ["paperclip-linear", "projects"]);
    for (const name of DEFAULT_HERMES_PAPERCLIP_TOOLSETS) {
      expect(resolved.split(",")).toContain(name);
    }
    expect(resolved.split(",")).toContain("mcp-paperclip-linear");
    expect(resolved.split(",")).toContain("mcp-projects");
    expect(resolved.split(",")).not.toContain("all");
  });

  it("preserves an explicit toolsets value and still appends overlay slugs", () => {
    const resolved = resolveHermesToolsetsForRun("terminal,file", ["paperclip-linear"]);
    expect(resolved).toBe("terminal,file,mcp-paperclip-linear");
  });

  it("does not duplicate overlay slugs already listed", () => {
    expect(resolveHermesToolsetsForRun("terminal,mcp-x", ["x"])).toBe("terminal,mcp-x");
  });
});
