/**
 * Finish CHO recovery: reconcile budget (clear hard-stop incident) and complete
 * the stuck lifecycle resume after spawn-E2BIG accounting was settled.
 */
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb, agents, budgetIncidents } from "@paperclipai/db";
import { budgetService } from "../src/services/budgets.ts";
import { configureAgentLifecycle } from "../src/services/agent-lifecycle.ts";
import { createLifecycleDriver } from "../src/services/agent-lifecycle-driver.ts";
import { createPluginWorkerManager } from "../src/services/plugin-worker-manager.ts";

process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";

const COMPANY_ID = "71e9ee98-5046-46b9-a668-adaba1f26408";
const AGENT_ID = "e40b7b94-1416-45eb-bc7c-53574a19fc10";
const POLICY_ID = "5a2100a8-3a29-446c-8146-f1c9b053c057";

const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json", "utf8"));
const db = createDb(cfg.database.connectionString);

const budgets = budgetService(db);
const block = await budgets.reconcileScope(COMPANY_ID, "agent", AGENT_ID);
console.log("reconcileScope", block);

const manager = createPluginWorkerManager();
const worker = configureAgentLifecycle(db, createLifecycleDriver(db, manager), () => true);

console.log("processing lifecycle for", AGENT_ID);
await worker.process(AGENT_ID);
await new Promise((r) => setTimeout(r, 2000));
await worker.process(AGENT_ID);

const [agent] = await db.select({
  name: agents.name,
  status: agents.status,
  lifecycleState: agents.lifecycleState,
  pauseReason: agents.pauseReason,
  pausedAt: agents.pausedAt,
  lifecycleHolds: agents.lifecycleHolds,
  lifecycleError: agents.lifecycleError,
  lifecycleOperation: agents.lifecycleOperation,
}).from(agents).where(eq(agents.id, AGENT_ID));

const incidents = await db.select({
  id: budgetIncidents.id,
  status: budgetIncidents.status,
}).from(budgetIncidents).where(eq(budgetIncidents.policyId, POLICY_ID));

console.log("final", {
  agent: {
    name: agent?.name,
    status: agent?.status,
    lifecycleState: agent?.lifecycleState,
    pauseReason: agent?.pauseReason,
    pausedAt: agent?.pausedAt,
    lifecycleHolds: agent?.lifecycleHolds,
    lifecycleError: agent?.lifecycleError,
    hostComplete: agent?.lifecycleOperation && (agent.lifecycleOperation as { hostComplete?: boolean }).hostComplete,
  },
  incidents,
});

await worker.stop();
await manager.stop?.();
process.exit(agent?.status !== "paused" && agent?.lifecycleState === "ready" && !incidents.some((i) => i.status === "open") ? 0 : 2);
