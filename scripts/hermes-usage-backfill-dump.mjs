#!/usr/bin/env node
/**
 * Dump Hermes session_model_usage rows as JSON for
 * POST /api/companies/:id/accounting/hermes-usage-backfill.
 *
 * Usage:
 *   node scripts/hermes-usage-backfill-dump.mjs \
 *     --db ~/.hermes/state.db \
 *     --from 2026-11-01T00:00:00.000Z \
 *     --to 2026-11-08T00:00:00.000Z \
 *     > rows.json
 *
 * Requires the `sqlite3` CLI on PATH.
 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const dbPath = resolve(
  (arg("--db") || `${homedir()}/.hermes/state.db`).replace(/^~(?=\/|$)/, homedir()),
);
const from = Date.parse(arg("--from", "2026-11-01T00:00:00.000Z"));
const to = Date.parse(arg("--to", new Date().toISOString()));
if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
  console.error("Invalid --from / --to (ISO datetimes required)");
  process.exit(2);
}

const fromSec = from / 1000;
const toSec = to / 1000;

const sql = `
.mode json
SELECT
  session_id AS sessionId,
  model AS model,
  billing_provider AS billingProvider,
  billing_base_url AS billingBaseUrl,
  COALESCE(task, '') AS task,
  input_tokens AS inputTokens,
  output_tokens AS outputTokens,
  cache_read_tokens AS cacheReadTokens,
  estimated_cost_usd AS estimatedCostUsd,
  cost_status AS costStatus,
  COALESCE(last_seen, first_seen) AS occurredAt
FROM session_model_usage
WHERE COALESCE(last_seen, first_seen) >= ${fromSec}
  AND COALESCE(last_seen, first_seen) <= ${toSec}
  AND (input_tokens + output_tokens + cache_read_tokens) > 0;
`;

const result = spawnSync("sqlite3", [dbPath], {
  input: sql,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (result.status !== 0) {
  console.error(result.stderr || result.error || "sqlite3 failed");
  process.exit(result.status ?? 1);
}

const text = (result.stdout || "").trim();
const rows = text ? JSON.parse(text) : [];
process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
