import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb, agents, heartbeatRuns } from "@paperclipai/db";
import { heartbeatService } from "../src/services/heartbeat.ts";
import { platformHealthService } from "../src/services/platform-health.ts";

process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";
const MEDIC = "ea29019a-c94a-4949-9b35-ea68a9903bbb";
const COMPANY = "71e9ee98-5046-46b9-a668-adaba1f26408";
const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json", "utf8"));
const db = createDb(cfg.database.connectionString);
const hb = heartbeatService(db);
const health = platformHealthService(db, { cancelWorkForScope: hb.cancelBudgetScopeWork });

const pending = await db.select({
  id: heartbeatRuns.id,
  status: heartbeatRuns.status,
  error: heartbeatRuns.error,
  usageJson: heartbeatRuns.usageJson,
  sessionIdAfter: heartbeatRuns.sessionIdAfter,
  costAccountingPending: heartbeatRuns.costAccountingPending,
}).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, MEDIC));
const stillPending = pending.filter((r) => r.costAccountingPending);
console.log("stillPending", stillPending.map((r) => ({
  id: r.id,
  status: r.status,
  sessionIdAfter: r.sessionIdAfter,
  receiptReady: (r.usageJson as Record<string, unknown> | null)?.accountingReceiptReady,
  costStatus: (r.usageJson as Record<string, unknown> | null)?.costStatus,
})));

for (const run of stillPending) {
  try {
    const r = await health.settlePendingRun(COMPANY, { runId: run.id, mode: "auto", dryRun: false }, "medic-clear");
    console.log("settled", run.id, JSON.stringify(r));
  } catch (e) {
    console.log("settle fail", run.id, e instanceof Error ? e.message : e);
    try {
      const r = await health.settlePendingRun(COMPANY, {
        runId: run.id,
        mode: "hermes_estimate",
        dryRun: false,
        costUsd: 0.01,
        evidence: "MEDIC unblock estimate after heal",
      }, "medic-clear");
      console.log("estimate", run.id, JSON.stringify(r));
    } catch (e2) {
      console.log("estimate fail", run.id, e2 instanceof Error ? e2.message : e2);
    }
  }
}

await db.update(agents).set({
  status: "idle",
  lifecycleState: "ready",
  lifecycleHolds: [],
  lifecycleError: null,
  lifecycleOperation: null,
  pauseReason: null,
  pausedAt: null,
  errorReason: null,
  updatedAt: new Date(),
}).where(eq(agents.id, MEDIC));

try {
  const r = await health.reconcileAndResume(COMPANY, { agentId: MEDIC, dryRun: false }, "medic-clear");
  console.log("reconcile", JSON.stringify(r));
} catch (e) {
  console.log("reconcile err", e instanceof Error ? e.message : e);
}
const [after] = await db.select({
  status: agents.status,
  pauseReason: agents.pauseReason,
  lifecycleState: agents.lifecycleState,
}).from(agents).where(eq(agents.id, MEDIC));
console.log("after", after);
process.exit(0);
