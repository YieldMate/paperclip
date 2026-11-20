import { readFileSync } from "node:fs";
import { and, eq, desc, inArray } from "drizzle-orm";
import { createDb, agents, budgetIncidents, heartbeatRuns, activityLog, approvals } from "@paperclipai/db";

process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";
const COMPANY = "71e9ee98-5046-46b9-a668-adaba1f26408";
const MEDIC = "ea29019a-c94a-4949-9b35-ea68a9903bbb";
const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json", "utf8"));
const db = createDb(cfg.database.connectionString);

const fleet = await db.select({
  id: agents.id,
  name: agents.name,
  status: agents.status,
  pauseReason: agents.pauseReason,
  lifecycleState: agents.lifecycleState,
  spent: agents.spentMonthlyCents,
  budget: agents.budgetMonthlyCents,
}).from(agents).where(and(
  eq(agents.companyId, COMPANY),
  inArray(agents.name, ["MEDIC", "CHO", "GOMEZ", "DAVE", "MARCO", "Atlas"]),
));
console.log("fleet", JSON.stringify(fleet, null, 2));

const paused = fleet.filter((a) => a.status === "paused" || a.pauseReason === "budget");
console.log("pausedOrBudget", paused.map((a) => a.name));

const incidents = await db.select().from(budgetIncidents)
  .where(and(eq(budgetIncidents.companyId, COMPANY), eq(budgetIncidents.status, "open")))
  .orderBy(desc(budgetIncidents.createdAt));
console.log("openIncidents", incidents.map((i) => ({
  id: i.id,
  scopeType: i.scopeType,
  scopeId: i.scopeId,
  thresholdType: i.thresholdType,
  amountLimit: i.amountLimit,
  amountObserved: i.amountObserved,
  approvalId: i.approvalId,
  createdAt: i.createdAt,
})));

const approvalIds = incidents.map((i) => i.approvalId).filter(Boolean) as string[];
if (approvalIds.length) {
  const apps = await db.select().from(approvals).where(inArray(approvals.id, approvalIds));
  console.log("approvals", apps.map((a) => ({
    id: a.id,
    type: (a as any).type,
    status: (a as any).status,
    title: (a as any).title,
    payload: (a as any).payload ?? (a as any).details,
  })));
}

for (const a of fleet) {
  const pending = await db.select({
    id: heartbeatRuns.id,
    status: heartbeatRuns.status,
    costAccountingPending: heartbeatRuns.costAccountingPending,
    sessionIdAfter: heartbeatRuns.sessionIdAfter,
    usageJson: heartbeatRuns.usageJson,
    error: heartbeatRuns.error,
    createdAt: heartbeatRuns.createdAt,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.agentId, a.id),
    eq(heartbeatRuns.costAccountingPending, true),
  )).limit(10);
  if (pending.length === 0) continue;
  console.log("pendingRuns", a.name, pending.map((r) => ({
    id: r.id,
    status: r.status,
    sessionIdAfter: r.sessionIdAfter,
    costStatus: (r.usageJson as any)?.costStatus,
    receiptReady: (r.usageJson as any)?.accountingReceiptReady,
    createdAt: r.createdAt,
  })));
}

const heals = await db.select({
  id: activityLog.id,
  action: activityLog.action,
  createdAt: activityLog.createdAt,
  details: activityLog.details,
  agentId: activityLog.agentId,
}).from(activityLog).where(and(
  eq(activityLog.companyId, COMPANY),
  eq(activityLog.action, "platform_health.heal"),
)).orderBy(desc(activityLog.createdAt)).limit(15);
console.log("recentHeals", heals.map((h) => ({
  createdAt: h.createdAt,
  agentId: h.agentId,
  details: h.details,
})));

process.exit(0);
