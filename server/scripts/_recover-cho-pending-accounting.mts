/**
 * One-off: settle CHO spawn-E2BIG run that never started provider work, then
 * let budget reconciliation resume the agent.
 *
 * Evidence: heartbeat run 0a2e211c-... failed with `spawn E2BIG` before Hermes
 * launched (no usage). Mark as pre-provider failure and account.
 */
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { createDb, agents, budgetIncidents, budgetReservations, heartbeatRuns } from "@paperclipai/db";
import { accountRunCost } from "../src/services/run-cost-accounting.ts";
import { budgetService } from "../src/services/budgets.ts";
import { notifyDeliveryWork, DELIVERY_QUEUES } from "../src/services/delivery-work-notifications.ts";

process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";

const RUN_ID = "0a2e211c-33f6-41a3-9e9f-352764f84496";
const COMPANY_ID = "71e9ee98-5046-46b9-a668-adaba1f26408";
const AGENT_ID = "e40b7b94-1416-45eb-bc7c-53574a19fc10";

const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json", "utf8"));
const db = createDb(cfg.database.connectionString);

const [before] = await db.select({
  id: heartbeatRuns.id,
  status: heartbeatRuns.status,
  pending: heartbeatRuns.costAccountingPending,
  accountedAt: heartbeatRuns.costAccountedAt,
  error: heartbeatRuns.error,
  usageJson: heartbeatRuns.usageJson,
  resultJson: heartbeatRuns.resultJson,
}).from(heartbeatRuns).where(eq(heartbeatRuns.id, RUN_ID));

if (!before) throw new Error("Run not found");
console.log("before", {
  status: before.status,
  pending: before.pending,
  accountedAt: before.accountedAt,
  error: before.error,
  receiptReady: (before.usageJson as Record<string, unknown> | null)?.accountingReceiptReady,
});

if (before.error !== "spawn E2BIG") {
  throw new Error(`Unexpected error for recovery path: ${before.error}`);
}

if (before.accountedAt && !before.pending) {
  console.log("Already accounted; nothing to do for the run.");
} else {
  // Spawn failed before Hermes could start provider work — authorize zero-cost release.
  await db.update(heartbeatRuns).set({
    usageJson: sql`coalesce(${heartbeatRuns.usageJson}, '{}'::jsonb) || '{"accountingProviderWorkStarted":false}'::jsonb`,
    resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({
      executionRecovery: {
        kind: "bootstrap",
        providerWorkStarted: false,
        reason: "spawn_e2big_before_provider",
      },
    })}::jsonb`,
  }).where(eq(heartbeatRuns.id, RUN_ID));

  const accounted = await accountRunCost(db, RUN_ID);
  console.log("accounted", accounted);
}

const budgets = budgetService(db);
await budgets.evaluateAffectedScopes(COMPANY_ID, AGENT_ID, null);
await notifyDeliveryWork(db, DELIVERY_QUEUES.budgetEnforcement, COMPANY_ID);

const [afterRun] = await db.select({
  pending: heartbeatRuns.costAccountingPending,
  accountedAt: heartbeatRuns.costAccountedAt,
  usageJson: heartbeatRuns.usageJson,
}).from(heartbeatRuns).where(eq(heartbeatRuns.id, RUN_ID));

const [agent] = await db.select({
  name: agents.name,
  status: agents.status,
  pauseReason: agents.pauseReason,
  lifecycleState: agents.lifecycleState,
}).from(agents).where(eq(agents.id, AGENT_ID));

const openIncidents = await db.select({
  id: budgetIncidents.id,
  status: budgetIncidents.status,
  amountObserved: budgetIncidents.amountObserved,
  amountLimit: budgetIncidents.amountLimit,
}).from(budgetIncidents).where(and(
  eq(budgetIncidents.scopeId, AGENT_ID),
  eq(budgetIncidents.status, "open"),
));

const [reservation] = await db.select({
  id: budgetReservations.id,
  state: budgetReservations.state,
}).from(budgetReservations).where(eq(budgetReservations.runId, RUN_ID));

console.log("after", {
  pending: afterRun?.pending,
  accountedAt: afterRun?.accountedAt,
  agent,
  openIncidents,
  reservation,
});

process.exit(afterRun?.pending || agent?.status === "paused" ? 1 : 0);
