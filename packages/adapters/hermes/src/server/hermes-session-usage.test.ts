import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractHermesSessionId,
  recoverHermesSessionUsageFromStateDb,
} from "./hermes-session-usage.js";
import { parseHermesOutput } from "./execute.js";

const SESSION = "local-3e7c7927609c846725d8d49058b558ff6afcc6f1792702bcc186cea781a5cd9b";

describe("extractHermesSessionId", () => {
  it("parses quiet-mode session_id lines", () => {
    expect(extractHermesSessionId(`hello\n\nsession_id: ${SESSION}\n`)).toBe(SESSION);
  });

  it("parses non-quiet Session footer (MEDIC pause failure mode)", () => {
    const stdout = [
      "Protocol complete.",
      "",
      "Resume this session with:",
      `  hermes --resume ${SESSION}`,
      `  hermes -c "Connect to Penpot focused page"`,
      "",
      `Session:        ${SESSION}`,
      "Title:          Connect to Penpot focused page",
      "Duration:       1m 0s",
      "Messages:       26 (1 user, 24 tool calls)",
      "",
    ].join("\n");
    expect(extractHermesSessionId(stdout)).toBe(SESSION);
  });

  it("falls back to hermes --resume when Session: line is absent", () => {
    expect(extractHermesSessionId(`done\nhermes --resume ${SESSION}\n`)).toBe(SESSION);
  });
});

describe("parseHermesOutput session capture", () => {
  it("persists non-quiet footer session ids", () => {
    const parsed = parseHermesOutput(
      `Quiet-ish response body\n\nSession:        ${SESSION}\n`,
      "",
    );
    expect(parsed.sessionId).toBe(SESSION);
    expect(parsed.response).toContain("Quiet-ish response body");
  });
});

describe("recoverHermesSessionUsageFromStateDb", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aggregates session_model_usage into estimated run cost", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-state-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "state.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session_model_usage (
        session_id TEXT,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        estimated_cost_usd REAL
      );
    `);
    db.prepare(`
      INSERT INTO session_model_usage
        (session_id, model, input_tokens, output_tokens, cache_read_tokens, estimated_cost_usd)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(SESSION, "z-ai/glm-5.3", 404, 13, 0, 0.000426452);
    db.prepare(`
      INSERT INTO session_model_usage
        (session_id, model, input_tokens, output_tokens, cache_read_tokens, estimated_cost_usd)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(SESSION, "z-ai/glm-5.3", 55773, 4060, 0, 0.155588134);
    db.close();

    const recovered = recoverHermesSessionUsageFromStateDb(dbPath, SESSION, "fallback");
    expect(recovered).not.toBeNull();
    expect(recovered?.usage).toEqual({
      inputTokens: 56177,
      outputTokens: 4073,
    });
    expect(recovered?.costUsd).toBeCloseTo(0.156014586, 9);
    expect(recovered?.costStatus).toBe("estimated");
    expect(recovered?.model).toBe("z-ai/glm-5.3");
  });

  it("returns null when the session has no billable rows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-state-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "state.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session_model_usage (
        session_id TEXT,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        estimated_cost_usd REAL
      );
    `);
    db.close();
    expect(recoverHermesSessionUsageFromStateDb(dbPath, SESSION, "fallback")).toBeNull();
  });
});
