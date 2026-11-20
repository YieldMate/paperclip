import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

/** Hermes session ids are hex/local tokens — avoid matching JSON `\n` escapes in raw logs. */
const HERMES_SESSION_ID_TOKEN = "([A-Za-z0-9_-]+)";
/** Quiet mode: "session_id: <id>" */
const HERMES_QUIET_SESSION_ID_REGEX = new RegExp(`^session_id:\\s*${HERMES_SESSION_ID_TOKEN}`, "m");
/** Non-quiet footer: "Session:        local-…" */
const HERMES_FOOTER_SESSION_ID_REGEX = new RegExp(`^Session:\\s+${HERMES_SESSION_ID_TOKEN}`, "m");
/** Resume hint: "hermes --resume local-…" */
const HERMES_RESUME_SESSION_ID_REGEX = new RegExp(`hermes\\s+--resume\\s+${HERMES_SESSION_ID_TOKEN}`, "i");

export interface HermesSessionUsageRow {
  sessionId: string;
  model: string;
  billingProvider: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  estimatedCostUsd: number | null;
  costStatus: string | null;
  occurredAt: number | null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Resolve HERMES_HOME / ~/.hermes for an agent's adapterConfig. */
export function resolveAgentHermesHome(adapterConfig: Record<string, unknown> | null | undefined): string {
  const env =
    adapterConfig && typeof adapterConfig.env === "object" && adapterConfig.env !== null && !Array.isArray(adapterConfig.env)
      ? (adapterConfig.env as Record<string, unknown>)
      : {};
  const hermesHome = asString(env.HERMES_HOME);
  if (hermesHome) return path.resolve(hermesHome);
  const home = asString(env.HOME);
  return path.join(home ? path.resolve(home) : os.homedir(), ".hermes");
}

export function resolveHermesStateDbPath(adapterConfig: Record<string, unknown> | null | undefined): string {
  return path.join(resolveAgentHermesHome(adapterConfig), "state.db");
}

/** Extract a Hermes session id from quiet or non-quiet CLI output. */
export function extractHermesSessionIdFromText(text: string): string | null {
  if (!text) return null;
  const quiet = text.match(HERMES_QUIET_SESSION_ID_REGEX);
  if (quiet?.[1]) return quiet[1];
  const footer = text.match(HERMES_FOOTER_SESSION_ID_REGEX);
  if (footer?.[1]) return footer[1];
  const resume = text.match(HERMES_RESUME_SESSION_ID_REGEX);
  if (resume?.[1]) return resume[1];
  return null;
}

/**
 * Recover a missing sessionIdAfter from the durable run log. Non-quiet Hermes
 * footers print `Session:` / `--resume` which older adapters did not persist.
 */
export function extractHermesSessionIdFromRunLog(input: {
  companyId: string;
  agentId: string;
  runId: string;
}): string | null {
  const basePath = process.env.RUN_LOG_BASE_PATH
    ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
  const logPath = path.join(basePath, input.companyId, input.agentId, `${input.runId}.ndjson`);
  if (!fs.existsSync(logPath)) return null;
  try {
    const stat = fs.statSync(logPath);
    const maxBytes = 256 * 1024;
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(logPath, "r");
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString("utf8");
      // Unwrap ndjson {chunk} payloads first so JSON `\n` escapes don't pollute matches.
      const chunks: string[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as { chunk?: unknown };
          if (typeof row.chunk === "string") chunks.push(row.chunk);
          else chunks.push(line);
        } catch {
          chunks.push(line);
        }
      }
      return extractHermesSessionIdFromText(chunks.join(""))
        ?? extractHermesSessionIdFromText(text);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function clampTokens(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), 2_147_483_647);
}

/**
 * Read Hermes session_model_usage for a session id. Returns [] when the DB is
 * missing or the session has no billable rows.
 */
export function readHermesSessionUsage(
  stateDbPath: string,
  sessionId: string,
): HermesSessionUsageRow[] {
  if (!sessionId.trim() || !fs.existsSync(stateDbPath)) return [];
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(stateDbPath, { readOnly: true });
    const rows = db.prepare(`
      SELECT
        session_id AS sessionId,
        model AS model,
        billing_provider AS billingProvider,
        COALESCE(input_tokens, 0) AS inputTokens,
        COALESCE(output_tokens, 0) AS outputTokens,
        COALESCE(cache_read_tokens, 0) AS cacheReadTokens,
        estimated_cost_usd AS estimatedCostUsd,
        cost_status AS costStatus,
        COALESCE(last_seen, first_seen) AS occurredAt
      FROM session_model_usage
      WHERE session_id = ?
        AND (COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) + COALESCE(cache_read_tokens, 0)) > 0
    `).all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      sessionId: String(row.sessionId ?? sessionId),
      model: String(row.model ?? "unknown"),
      billingProvider: row.billingProvider == null ? null : String(row.billingProvider),
      inputTokens: clampTokens(row.inputTokens),
      outputTokens: clampTokens(row.outputTokens),
      cacheReadTokens: clampTokens(row.cacheReadTokens),
      estimatedCostUsd:
        row.estimatedCostUsd == null || row.estimatedCostUsd === ""
          ? null
          : Number(row.estimatedCostUsd),
      costStatus: row.costStatus == null ? null : String(row.costStatus),
      occurredAt: row.occurredAt == null ? null : Number(row.occurredAt),
    })).filter((row) => Number.isFinite(row.estimatedCostUsd ?? 0) || row.inputTokens + row.outputTokens > 0);
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

export function aggregateHermesSessionUsage(rows: HermesSessionUsageRow[]): {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number | null;
  usageByModel: Array<{ model: string; costUsd: number; usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } }>;
} | null {
  if (rows.length === 0) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let costUsd = 0;
  let hasCost = false;
  const byModel = new Map<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number }>();
  for (const row of rows) {
    inputTokens += row.inputTokens;
    outputTokens += row.outputTokens;
    cacheReadTokens += row.cacheReadTokens;
    if (row.estimatedCostUsd != null && Number.isFinite(row.estimatedCostUsd)) {
      costUsd += row.estimatedCostUsd;
      hasCost = true;
    }
    const current = byModel.get(row.model) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
    current.inputTokens += row.inputTokens;
    current.outputTokens += row.outputTokens;
    current.cacheReadTokens += row.cacheReadTokens;
    if (row.estimatedCostUsd != null && Number.isFinite(row.estimatedCostUsd)) {
      current.costUsd += row.estimatedCostUsd;
    }
    byModel.set(row.model, current);
  }
  const primary = [...byModel.entries()].sort((a, b) =>
    (b[1].inputTokens + b[1].outputTokens) - (a[1].inputTokens + a[1].outputTokens))[0]?.[0] ?? rows[0]!.model;
  return {
    model: primary,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    costUsd: hasCost ? costUsd : null,
    usageByModel: [...byModel.entries()].map(([model, usage]) => ({
      model,
      costUsd: usage.costUsd,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cacheReadTokens,
      },
    })),
  };
}
