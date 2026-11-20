import { readFileSync } from "node:fs";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  createDb,
  agents,
  budgetIncidents,
  costEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import { heartbeatService } from "../src/services/heartbeat.ts";
import { platformHealthService } from "../src/services/platform-health.ts";

process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";

const COMPANY = "71e9ee98-5046-46b9-a668-adaba1f26408";
const NAMES = ["MEDIC", "CHO", "GOMEZ", "DAVE"] as const;
const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json", "utf8"));
const db = createDb(cfg.database.connectionString);
const hb = heartbeatService(db);
const health = platformHealthService(db, {
  cancelWorkForScope: hb.cancelBudgetScopeWork,
  wakeupAgent: async (input) => hb.wakeup(input.agentId, {
    failedRunId: input.failedRunId ?? null,
    source: input.source,
    triggerDetail: input.triggerDetail,
    reason: input.reason,
    payload: input.issueId ? { issueId: input.issueId } : null,
    requestedByActorType: "user",
    requestedByActorId: input.requestedByUserId,
  }),
});

const fleet = await db.select({
  id: agents.id,
  name: agents.name,
  status: agents.status,
  pauseReason: agents.pauseReason,
  lifecycleState: agents.lifecycleState,
  spent: agents.spentMonthlyCents,
  budget: agents.budgetMonthlyCents,
}).from(agents).where(and(eq(agents.companyId, COMPANY), inArray(agents.name, [...NAMES])));

const ids = fleet.map((a) => a.id);
const pendingByAgent = await db.select({
  agentId: heartbeatRuns.agentId,
  id: heartbeatRuns.id,
  status: heartbeatRuns.status,
  error: heartbeatRuns.error,
  sessionIdAfter: heartbeatRuns.sessionIdAfter,
  usageJson: heartbeatRuns.usageJson,
  finishedAt: heartbeatRuns.finishedAt,
}).from(heartbeatRuns).where(and(
  inArray(heartbeatRuns.agentId, ids),
  eq(heartbeatRuns.costAccountingPending, true),
)).orderBy(desc(heartbeatRuns.finishedAt)).limit(50);

const unpriced = await db.select({
  id: costEvents.id,
  agentId: costEvents.agentId,
  runId: costEvents.heartbeatRunId,
  costCents: costEvents.costCents,
  createdAt: costEvents.createdAt,
}).from(costEvents).where(and(
  eq(costEvents.companyId, COMPANY),
  inArray(costEvents.agentId, ids),
  eq(costEvents.costStatus, "unpriced"),
)).limit(30);

const incidents = await db.select({
  id: budgetIncidents.id,
  scopeId: budgetIncidents.scopeId,
  state: budgetIncidents.state,
  reason: budgetIncidents.reason,
  createdAt: budgetIncidents.createdAt,
}).from(budgetIncidents).where(and(
  eq(budgetIncidents.companyId, COMPANY),
  inArray(budgetIncidents.scopeId, ids),
  inArray(budgetIncidents.state, ["open", "active", "blocking"]),
)).limit(20).catch(() => []);

console.log(JSON.stringify({
  fleet,
  pendingCount: pendingByAgent.length,
  pendingByAgent: pendingByAgent.map((r) => ({
    agentId: r.agentId,
    id: r.id,
    status: r.status,
    error: r.error?.slice(0, 120) ?? null,
    sessionIdAfter: r.sessionIdAfter,
    receiptReady: (r.usageJson as Record<string, unknown> | null)?.accountingReceiptReady ?? null,
    costStatus: (r.usageJson as Record<string, unknown> | null)?.costStatus ?? null,
    finishedAt: r.finishedAt,
  })),
  unpriced,
  incidents,
}, null, 2));

const snap = await health.getHealthSnapshot(COMPANY);
console.log("SNAPSHOT", JSON.stringify({
  empty: snap.empty,
  counts: snap.counts,
  paused: snap.pausedBudgetAgents.map((a: { name: string; id: string }) => a.name),
  findingsTop: snap.findings.slice(0, 15).map((f: { class: string; agentName: string | null; recommendedAction: string; autoSafe: boolean; detail: string }) => ({
    class: f.class,
    agent: f.agentName,
    action: f.recommendedAction,
    autoSafe: f.autoSafe,
    detail: f.detail.slice(0, 120),
  })),
}, null, 2));

process.exit(0);
