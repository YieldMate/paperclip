import { describe, expect, it } from "vitest";

import {
  dispositionPathHasUnexpandedToken,
  looksLikeTerminalDispositionComment,
  preValidateHermesToolsets,
  resolveHermesReliabilityFlags,
} from "./reliability.js";

describe("resolveHermesReliabilityFlags", () => {
  it("defaults all reliability flags on", () => {
    expect(resolveHermesReliabilityFlags({})).toEqual({
      failOpenSkillReconcile: true,
      preValidateToolsets: true,
      dispositionSafety: true,
      optionalInstallNonFatal: true,
    });
  });

  it("honors nested and dotted overrides for rollback", () => {
    expect(
      resolveHermesReliabilityFlags({
        reliability: { failOpenSkillReconcile: false },
        "reliability.preValidateToolsets": false,
      }),
    ).toMatchObject({
      failOpenSkillReconcile: false,
      preValidateToolsets: false,
      dispositionSafety: true,
    });
  });
});

describe("preValidateHermesToolsets", () => {
  it("fails fast on legacy creative/productivity entries", () => {
    const result = preValidateHermesToolsets("creative,productivity", ["paperclip-linear"]);
    expect(result.ok).toBe(false);
    expect(result.unresolved).toEqual(["creative", "productivity"]);
    expect(result.errorMessage).toMatch(/toolset.*not (found|resolved|valid)/i);
  });

  it("accepts builtins plus overlay mcp slugs", () => {
    const result = preValidateHermesToolsets(
      "terminal,file,mcp-paperclip-linear",
      ["paperclip-linear"],
    );
    expect(result).toEqual({
      ok: true,
      resolved: "terminal,file,mcp-paperclip-linear",
      unresolved: [],
    });
  });

  it("accepts Hermes coding / video_gen builtins", () => {
    const result = preValidateHermesToolsets("coding,video_gen,terminal", []);
    expect(result.ok).toBe(true);
    expect(result.resolved).toBe("coding,video_gen,terminal");
  });

  it("fails when the resolved list is empty", () => {
    const result = preValidateHermesToolsets("", []);
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/no valid toolsets/i);
  });
});

describe("dispositionPathHasUnexpandedToken", () => {
  it("detects literal $TOKEN and ${TOKEN} paths", () => {
    expect(dispositionPathHasUnexpandedToken("$SCRATCH_HOME/disposition.json")).toBe(true);
    expect(dispositionPathHasUnexpandedToken("${SCRATCH_HOME}/disposition.json")).toBe(true);
    expect(dispositionPathHasUnexpandedToken("/tmp/run.disposition.json")).toBe(false);
  });
});

describe("looksLikeTerminalDispositionComment", () => {
  it("matches explicit disposition phrasing, not bare or negated done", () => {
    expect(looksLikeTerminalDispositionComment("Moved the issue to done.")).toBe(true);
    expect(looksLikeTerminalDispositionComment("status: in_review")).toBe(true);
    expect(looksLikeTerminalDispositionComment("Marked the issue ready for review")).toBe(true);
    expect(looksLikeTerminalDispositionComment("This is not ready for review yet.")).toBe(false);
    expect(looksLikeTerminalDispositionComment("Do not set the issue to done.")).toBe(false);
    expect(looksLikeTerminalDispositionComment("I have not marked the issue ready for review.")).toBe(false);
    expect(looksLikeTerminalDispositionComment("Still investigating.")).toBe(false);
    expect(looksLikeTerminalDispositionComment("I am done looking at the logs.")).toBe(false);
  });
});
