/**
 * Hermes session id + state.db usage recovery for Paperclip accounting.
 *
 * Quiet mode prints `session_id: <id>`. Non-quiet CLI footers print
 * `Session: <id>` and `hermes --resume <id>` — older parsers missed those,
 * leaving sessionIdAfter null and budget hard-stops on incomplete receipts.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { UsageSummary } from "@paperclipai/adapter-utils";

/** Hermes session ids are hex/local tokens — avoid matching JSON `\n` escapes in raw logs. */
const HERMES_SESSION_ID_TOKEN = "([A-Za-z0-9_-]+)";

/** Quiet mode: "session_id: <id>" on its own line. */
export const HERMES_QUIET_SESSION_ID_REGEX = new RegExp(`^session_id:\\s*${HERMES_SESSION_ID_TOKEN}`, "m");

/** Verbose footer: "Session:        local-…" */
export const HERMES_FOOTER_SESSION_ID_REGEX = new RegExp(`^Session:\\s+${HERMES_SESSION_ID_TOKEN}`, "m");

/** Resume hint in the same footer block. */
export const HERMES_RESUME_SESSION_ID_REGEX = new RegExp(`hermes\\s+--resume\\s+${HERMES_SESSION_ID_TOKEN}`, "i");

/** Legacy "session id:" / "session_saved:" forms. */
export const HERMES_LEGACY_SESSION_ID_REGEX = new RegExp(
  `session[_ ](?:id|saved)[:\\s]+${HERMES_SESSION_ID_TOKEN}`,
  "i",
);

export function extractHermesSessionId(stdout: string, stderr = ""): string | undefined {
  const quiet = stdout.match(HERMES_QUIET_SESSION_ID_REGEX);
  if (quiet?.[1]) return quiet[1];

  const combined = `${stdout}\n${stderr}`;
  const footer = combined.match(HERMES_FOOTER_SESSION_ID_REGEX);
  if (footer?.[1]) return footer[1];

  const resume = combined.match(HERMES_RESUME_SESSION_ID_REGEX);
  if (resume?.[1]) return resume[1];

  const legacy = combined.match(HERMES_LEGACY_SESSION_ID_REGEX);
  if (legacy?.[1]) return legacy[1];

  return undefined;
}

export function resolveHermesHomeFromEnv(env: Record<string, string | undefined> | null | undefined): string {
  const hermesHome = env?.HERMES_HOME?.trim();
  if (hermesHome) return path.resolve(hermesHome);
  const home = env?.HOME?.trim();
  return path.join(home ? path.resolve(home) : os.homedir(), ".hermes");
}

export function resolveHermesStateDbPath(env: Record<string, string | undefined> | null | undefined): string {
  return path.join(resolveHermesHomeFromEnv(env), "state.db");
}

export interface RecoveredHermesSessionUsage {
  usage: UsageSummary;
  costUsd?: number;
  costStatus: "estimated" | "unpriced";
  model: string;
  rowCount: number;
}

function clampTokens(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), 2_147_483_647);
}

/**
 * Read session_model_usage for a Hermes session. Returns null when the DB is
 * missing or the session has no billable rows.
 */
export function recoverHermesSessionUsageFromStateDb(
  stateDbPath: string,
  sessionId: string,
  fallbackModel: string,
): RecoveredHermesSessionUsage | null {
  if (!sessionId.trim() || !fs.existsSync(stateDbPath)) return null;

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(stateDbPath, { readOnly: true });
    const rows = db.prepare(`
      SELECT
        model AS model,
        COALESCE(input_tokens, 0) AS inputTokens,
        COALESCE(output_tokens, 0) AS outputTokens,
        COALESCE(cache_read_tokens, 0) AS cacheReadTokens,
        estimated_cost_usd AS estimatedCostUsd
      FROM session_model_usage
      WHERE session_id = ?
        AND (COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) + COALESCE(cache_read_tokens, 0)) > 0
    `).all(sessionId) as Array<Record<string, unknown>>;

    if (rows.length === 0) return null;

    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let costUsd = 0;
    let hasCost = false;
    let model = fallbackModel;
    for (const row of rows) {
      inputTokens += clampTokens(row.inputTokens);
      outputTokens += clampTokens(row.outputTokens);
      cachedInputTokens += clampTokens(row.cacheReadTokens);
      const rowModel = typeof row.model === "string" && row.model.trim() ? row.model.trim() : null;
      if (rowModel) model = rowModel;
      const estimated = row.estimatedCostUsd == null || row.estimatedCostUsd === ""
        ? null
        : Number(row.estimatedCostUsd);
      if (estimated != null && Number.isFinite(estimated) && estimated >= 0) {
        costUsd += estimated;
        hasCost = true;
      }
    }

    if (inputTokens + outputTokens + cachedInputTokens <= 0) return null;

    return {
      usage: {
        inputTokens,
        outputTokens,
        ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
      },
      ...(hasCost ? { costUsd } : {}),
      costStatus: hasCost ? "estimated" : "unpriced",
      model,
      rowCount: rows.length,
    };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}
