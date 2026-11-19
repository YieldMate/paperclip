import { describe, expect, it } from "vitest";
import { acceptScrapedHermesCostUsd } from "./execute.js";

describe("acceptScrapedHermesCostUsd", () => {
  it("rejects cost with no token evidence (MEDIC $382 failure mode)", () => {
    expect(acceptScrapedHermesCostUsd(382, undefined)).toBe(false);
    expect(acceptScrapedHermesCostUsd(382, {
      inputTokens: 0,
      outputTokens: 0,
    })).toBe(false);
  });

  it("rejects absurd $/token scrapes even when tokens exist", () => {
    expect(acceptScrapedHermesCostUsd(382, {
      inputTokens: 100,
      outputTokens: 10,
    })).toBe(false);
  });

  it("accepts plausible usage-file-scale estimates", () => {
    expect(acceptScrapedHermesCostUsd(0.283, {
      inputTokens: 39685,
      outputTokens: 24661,
      cachedInputTokens: 1043968,
    })).toBe(true);
  });

  it("rejects negative or non-finite values", () => {
    expect(acceptScrapedHermesCostUsd(Number.NaN, {
      inputTokens: 10,
      outputTokens: 10,
    })).toBe(false);
    expect(acceptScrapedHermesCostUsd(-0.01, {
      inputTokens: 10,
      outputTokens: 10,
    })).toBe(false);
  });
});
