/**
 * Settle GOMEZ run aa327ca1… that succeeded with real Hermes usage but left
 * accountingReceiptReady=false / unpriced, which hard-stopped the agent.
 *
 * Evidence: Hermes session local-1456bcfe… (~$0.302 estimated on z-ai/glm-5.3).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { createDb, agents, budgetIncidents, budgetReservations, heartbeatRuns } from "@paperclipai/db";
import { spoolUsageReceipt, persistUsageReceipt } from "../src/services/usage-receipts.ts";
import { accountRunCost } from "../src/services/run-cost-accounting.ts";
import { budgetService } from "../src/services/budgets.ts";
import { configureAgentLifecycle } from "../src/services/agent-lifecycle.ts";
import { createLifecycleDriver } from "../src/services/agent-lifecycle-driver.ts";
import { createPluginWorkerManager } from "../src/services/plugin-worker-manager.ts";

process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";

const RUN_ID = "aa327ca1-25ba-499d-8268-0d6ec19f855e";
const COMPANY_ID = "71e9ee98-5046-46b9-a668-adaba1f26408";
const AGENT_ID = "82300347-b483-469b-b636-9f18176851fa";
const POLICY_ID = "a3d97fd3-fa62-45c7-aeee-cec5426c54f7";
const SOURCE_ID = "9db604c8-22ad-4b96-85d6-2eec8682a365";

const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json", "utf8"));
const db = createDb(cfg.database.connectionString);

const [before] = await db.select({
  pending: heartbeatRuns.costAccountingPending,
  accountedAt: heartbeatRuns.costAccountedAt,
  usageJson: heartbeatRuns.usageJson,
}).from(heartbeatRuns).where(eq(heartbeatRuns.id, RUN_ID));

if (!before) throw new Error("Run not found");
console.log("before", {
  pending: before.pending,
  accountedAt: before.accountedAt,
  receiptReady: (before.usageJson as Record<string, unknown> | null)?.accountingReceiptReady,
  costStatus: (before.usageJson as Record<string, unknown> | null)?.costStatus,
});

if (!(before.accountedAt && !before.pending)) {
  const envelope = {
    schema: "paperclip/accounting-receipt/v1" as const,
    id: randomUUID(),
    companyId: COMPANY_ID,
    runId: RUN_ID,
    sourceId: SOURCE_ID,
    sequence: 2,
    receivedAt: new Date().toISOString(),
    adapterType: "hermes_local",
    receipt: {
      complete: true,
      provider: "nous",
      biller: "nous",
      model: "z-ai/glm-5.3",
      billingType: "metered_api",
      costStatus: "estimated" as const,
      costUsd: 0.30246127599999995,
      usage: {
        inputTokens: 38226,
        outputTokens: 20808,
        cachedInputTokens: 1231744,
      },
      usageByModel: [{
        model: "z-ai/glm-5.3",
        costUsd: 0.30246127599999995,
        usage: {
          inputTokens: 38226,
          outputTokens: 20808,
          cachedInputTokens: 1231744,
        },
      }],
      pricingProvenance: {
        source: "operator" as const,
        version: "hermes-session-recover/v1",
        evidence:
          "Recovered from Hermes session local-1456bcfede7b86ca3b83d83da49e27d3273f7f3ca339cc3811a7c0d3631721be after incomplete accounting spool",
      },
    },
  };

  const file = await spoolUsageReceipt(envelope);
  console.log("spooled", file);
  await persistUsageReceipt(db, envelope);
  const accounted = await accountRunCost(db, RUN_ID);
  console.log("accounted", accounted);
}

const budgets = budgetService(db);
console.log("reconcileScope", await budgets.reconcileScope(COMPANY_ID, "agent", AGENT_ID));

const manager = createPluginWorkerManager();
const worker = configureAgentLifecycle(db, createLifecycleDriver(db, manager), () => true);
await worker.process(AGENT_ID);
await new Promise((r) => setTimeout(r, 2000));
await worker.process(AGENT_ID);

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
}).from(budgetIncidents).where(and(
  eq(budgetIncidents.policyId, POLICY_ID),
  eq(budgetIncidents.status, "open"),
));

const [reservation] = await db.select({
  id: budgetReservations.id,
  state: budgetReservations.state,
}).from(budgetReservations).where(eq(budgetReservations.runId, RUN_ID));

console.log("final", {
  pending: afterRun?.pending,
  accountedAt: afterRun?.accountedAt,
  costUsd: (afterRun?.usageJson as Record<string, unknown> | null)?.costUsd,
  agent,
  openIncidents,
  reservation,
});

await worker.stop();
await manager.stop?.();
process.exit(afterRun?.pending || agent?.status === "paused" || openIncidents.length > 0 ? 1 : 0);
