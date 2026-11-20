import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { createDb, agents, costEvents, heartbeatRuns } from "@paperclipai/db";
import { usdToCents } from "@paperclipai/shared";
import { billingReconciliationService } from "../src/services/billing-reconciliation.ts";

process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";

const COMPANY = "71e9ee98-5046-46b9-a668-adaba1f26408";
const MEDIC = "ea29019a-c94a-4949-9b35-ea68a9903bbb";
const EVENT_ID = "caa630b6-4e37-4f48-a577-0dc699a89492";
const RUN_ID = "8c1a22bd-9148-49cf-9e84-623db4111224";
const ACTOR = "s33cQuwlQ9uPbCdoDTHZLbA6CYyoSTwa";
// Hermes session_model_usage for local-976d6a… on this run.
const HERMES_ESTIMATE_USD = 0.283074402;
const HERMES_TOKENS = {
  inputTokens: 39685,
  outputTokens: 24661,
  cachedInputTokens: 1043968,
};

const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json", "utf8"));
const db = createDb(cfg.database.connectionString);
const billing = billingReconciliationService(db);

const [beforeEvent] = await db.select({
  id: costEvents.id,
  costCents: sql<string>`${costEvents.costCents}::text`,
  reportedCostCents: sql<string>`${costEvents.reportedCostCents}::text`,
  costStatus: costEvents.costStatus,
  inputTokens: costEvents.inputTokens,
  outputTokens: costEvents.outputTokens,
}).from(costEvents).where(eq(costEvents.id, EVENT_ID));
const [beforeAgent] = await db.select({
  spent: sql<string>`${agents.spentMonthlyCents}::text`,
}).from(agents).where(eq(agents.id, MEDIC));
console.log("before", { event: beforeEvent, agentSpent: beforeAgent?.spent });

const correctedCents = usdToCents(HERMES_ESTIMATE_USD);
const adjustment = await billing.adjust(COMPANY, EVENT_ID, {
  idempotencyKey: `medic-382-correction:${EVENT_ID}:v1`,
  expectedCents: beforeEvent!.costCents,
  correctedCents,
  reason: "Stdout-scraped $382 with 0 tokens was bogus; Hermes session_model_usage estimated $0.283 for this run (30 API calls, glm-5.3).",
  pricing: {
    source: "rate_card",
    version: "hermes-session-model-usage/v1",
    evidence: "session local-976d6a14181a6d282f86333d4225e90997da60ca29f00eb0bc3b81d7751f3d1e estimated_cost_usd=0.283074402 input=39685 output=24661 cache_read=1043968",
  },
}, ACTOR);
console.log("adjustment", {
  id: adjustment.id,
  previousCents: adjustment.previousCents,
  correctedCents: adjustment.correctedCents,
});

await db.update(costEvents).set({
  inputTokens: HERMES_TOKENS.inputTokens,
  outputTokens: HERMES_TOKENS.outputTokens,
  cachedInputTokens: HERMES_TOKENS.cachedInputTokens,
}).where(and(eq(costEvents.id, EVENT_ID), eq(costEvents.companyId, COMPANY)));

const [run] = await db.select({
  usageJson: heartbeatRuns.usageJson,
  resultJson: heartbeatRuns.resultJson,
}).from(heartbeatRuns).where(eq(heartbeatRuns.id, RUN_ID));
const usage = (run?.usageJson && typeof run.usageJson === "object" && !Array.isArray(run.usageJson))
  ? { ...(run.usageJson as Record<string, unknown>) }
  : {};
const result = (run?.resultJson && typeof run.resultJson === "object" && !Array.isArray(run.resultJson))
  ? { ...(run.resultJson as Record<string, unknown>) }
  : {};
usage.costUsd = HERMES_ESTIMATE_USD;
usage.cacheAdjustedCostUsd = HERMES_ESTIMATE_USD;
usage.inputTokens = HERMES_TOKENS.inputTokens;
usage.outputTokens = HERMES_TOKENS.outputTokens;
usage.cachedInputTokens = HERMES_TOKENS.cachedInputTokens;
usage.costStatus = "estimated";
usage.pricingProvenance = {
  source: "rate_card",
  version: "hermes-session-model-usage/v1",
  evidence: "Corrected bogus stdout scrape; Hermes estimated_cost_usd=0.283074402",
};
result.cost_usd = HERMES_ESTIMATE_USD;
await db.update(heartbeatRuns).set({
  usageJson: usage,
  resultJson: result,
}).where(and(eq(heartbeatRuns.id, RUN_ID), eq(heartbeatRuns.companyId, COMPANY)));

const [afterEvent] = await db.select({
  id: costEvents.id,
  costCents: sql<string>`${costEvents.costCents}::text`,
  reportedCostCents: sql<string>`${costEvents.reportedCostCents}::text`,
  costStatus: costEvents.costStatus,
  inputTokens: costEvents.inputTokens,
  outputTokens: costEvents.outputTokens,
  cachedInputTokens: costEvents.cachedInputTokens,
  pricingProvenance: costEvents.pricingProvenance,
}).from(costEvents).where(eq(costEvents.id, EVENT_ID));
const [afterAgent] = await db.select({
  spent: sql<string>`${agents.spentMonthlyCents}::text`,
  status: agents.status,
  pauseReason: agents.pauseReason,
}).from(agents).where(eq(agents.id, MEDIC));
console.log("after", { event: afterEvent, agent: afterAgent });
process.exit(0);
