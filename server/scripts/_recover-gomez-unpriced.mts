/**
 * One-off: clear GOMEZ unpriced $0 ledger event from a failed Hermes resume
 * policy mismatch, then reconcile budget and finish lifecycle resume.
 */
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { createDb, agents, budgetIncidents, costEvents } from "@paperclipai/db";
import { budgetService } from "../src/services/budgets.ts";
import { configureAgentLifecycle } from "../src/services/agent-lifecycle.ts";
import { createLifecycleDriver } from "../src/services/agent-lifecycle-driver.ts";
import { createPluginWorkerManager } from "../src/services/plugin-worker-manager.ts";

process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";

const COMPANY_ID = "71e9ee98-5046-46b9-a668-adaba1f26408";
const AGENT_ID = "82300347-b483-469b-b636-9f18176851fa";
const POLICY_ID = "a3d97fd3-fa62-45c7-aeee-cec5426c54f7";
const UNPRICED_EVENT_ID = "156b91b0-71a7-4001-a4b8-7bd16cb0650c";
const FAILED_RUN_ID = "c5998b57-0222-4b2b-8a6d-e433dfc14eb5";

const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json", "utf8"));
const db = createDb(cfg.database.connectionString);

const [event] = await db.select({
  id: costEvents.id,
  costStatus: costEvents.costStatus,
  costCents: costEvents.costCents,
  heartbeatRunId: costEvents.heartbeatRunId,
  provider: costEvents.provider,
  model: costEvents.model,
}).from(costEvents).where(eq(costEvents.id, UNPRICED_EVENT_ID));

if (!event) throw new Error("Unpriced event not found");
if (event.heartbeatRunId !== FAILED_RUN_ID) throw new Error(`Unexpected run on event: ${event.heartbeatRunId}`);
if (event.costStatus !== "unpriced") throw new Error(`Unexpected status: ${event.costStatus}`);
console.log("removing unpriced event", event);

await db.delete(costEvents).where(eq(costEvents.id, UNPRICED_EVENT_ID));

const budgets = budgetService(db);
const block = await budgets.reconcileScope(COMPANY_ID, "agent", AGENT_ID);
console.log("reconcileScope", block);

const manager = createPluginWorkerManager();
const worker = configureAgentLifecycle(db, createLifecycleDriver(db, manager), () => true);
await worker.process(AGENT_ID);
await new Promise((r) => setTimeout(r, 2000));
await worker.process(AGENT_ID);

const [agent] = await db.select({
  name: agents.name,
  status: agents.status,
  lifecycleState: agents.lifecycleState,
  pauseReason: agents.pauseReason,
  pausedAt: agents.pausedAt,
}).from(agents).where(eq(agents.id, AGENT_ID));

const incidents = await db.select({
  id: budgetIncidents.id,
  status: budgetIncidents.status,
}).from(budgetIncidents).where(and(
  eq(budgetIncidents.policyId, POLICY_ID),
  eq(budgetIncidents.status, "open"),
));

const remainingUnpriced = await db.select({ id: costEvents.id }).from(costEvents).where(and(
  eq(costEvents.agentId, AGENT_ID),
  eq(costEvents.costStatus, "unpriced"),
));

console.log("final", { agent, openIncidents: incidents, remainingUnpriced });

await worker.stop();
await manager.stop?.();
process.exit(agent?.status !== "paused" && incidents.length === 0 && remainingUnpriced.length === 0 ? 0 : 2);
