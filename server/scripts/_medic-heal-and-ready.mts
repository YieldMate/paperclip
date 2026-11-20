import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
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
const health = platformHealthService(db, {
  cancelWorkForScope: hb.cancelBudgetScopeWork,
  wakeupAgent: async (input) => {
    const payload: Record<string, unknown> = {};
    if (input.issueId) payload.issueId = input.issueId;
    if (input.recoveryActionId) payload.recoveryActionId = input.recoveryActionId;
    return hb.wakeup(input.agentId, {
      failedRunId: input.failedRunId ?? null,
      source: input.source,
      triggerDetail: input.triggerDetail,
      reason: input.reason,
      payload: Object.keys(payload).length > 0 ? payload : null,
      requestedByActorType: "user",
      requestedByActorId: input.requestedByUserId,
      contextSnapshot: {
        triggeredBy: "board",
        responsibleUserId: input.requestedByUserId,
        actorId: input.requestedByUserId,
        platformHealthDeskTriage: true,
      },
    });
  },
});

const pending = await db.select({
  id: heartbeatRuns.id,
  status: heartbeatRuns.status,
  costAccountingPending: heartbeatRuns.costAccountingPending,
}).from(heartbeatRuns).where(and(
  eq(heartbeatRuns.agentId, MEDIC),
  eq(heartbeatRuns.costAccountingPending, true),
)).limit(20);
console.log("medicPending", pending);

const reaped = await health.reapPendingReceipts(COMPANY);
console.log("reaped", reaped);

const healed = await health.autoHeal(COMPANY, {
  dryRun: false,
  maxActions: 25,
  applyDeskTriage: true,
  maxDeskActions: 10,
}, "medic-heal-ready");
console.log("autoHeal", {
  actionsUsed: (healed as { actionsUsed?: number }).actionsUsed,
  results: healed.results.filter((r) => r.applied).length,
  deskApplied: healed.deskTriage?.applied ?? null,
  deskSkipped: healed.deskTriage?.skipped ?? null,
});

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
  console.log("reconcile", JSON.stringify(r, null, 2));
} catch (e) {
  console.log("reconcile err", e instanceof Error ? e.message : e);
}

const [after] = await db.select({
  status: agents.status,
  pauseReason: agents.pauseReason,
  lifecycleState: agents.lifecycleState,
}).from(agents).where(eq(agents.id, MEDIC)).limit(1);
console.log("after", after);
process.exit(0);
