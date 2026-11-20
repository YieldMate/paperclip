import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb, agents } from "@paperclipai/db";
import { heartbeatService } from "../src/services/heartbeat.ts";
import { platformHealthService } from "../src/services/platform-health.ts";

process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";
process.env.PAPERCLIP_API_URL ??= "http://127.0.0.1:3100";

const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json", "utf8"));
const db = createDb(cfg.database.connectionString);
const MEDIC = "ea29019a-c94a-4949-9b35-ea68a9903bbb";
const dryRun = process.argv.includes("--dry-run");
const maxActions = Number(process.argv.find((a) => a.startsWith("--max="))?.slice(6) ?? "10");

const [medic] = await db.select({
  id: agents.id,
  companyId: agents.companyId,
  status: agents.status,
  pauseReason: agents.pauseReason,
  lifecycleState: agents.lifecycleState,
}).from(agents).where(eq(agents.id, MEDIC)).limit(1);
if (!medic) {
  console.error("MEDIC not found");
  process.exit(1);
}
console.log("MEDIC", medic);

const heartbeat = heartbeatService(db);
const health = platformHealthService(db, {
  cancelWorkForScope: heartbeat.cancelBudgetScopeWork,
  wakeupAgent: async (input) => {
    const payload: Record<string, unknown> = {};
    if (input.issueId) payload.issueId = input.issueId;
    if (input.recoveryActionId) payload.recoveryActionId = input.recoveryActionId;
    if (input.reason === "issue_recovery_action_restored") {
      payload.mutation = "recovery_action_resolution";
    }
    return heartbeat.wakeup(input.agentId, {
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

const proposals = await health.proposeDeskActions(medic.companyId);
const safe = proposals.proposals.filter((p) => p.autoApplySafe);
console.log(JSON.stringify({
  checkedAt: proposals.checkedAt,
  total: proposals.proposals.length,
  autoApplySafe: safe.length,
  byAction: Object.fromEntries(
    [...new Set(proposals.proposals.map((p) => p.action))].map((action) => [
      action,
      {
        total: proposals.proposals.filter((p) => p.action === action).length,
        safe: proposals.proposals.filter((p) => p.action === action && p.autoApplySafe).length,
      },
    ]),
  ),
  sample: safe.slice(0, 5),
}, null, 2));

const result = await health.applyDeskTriage(medic.companyId, {
  dryRun,
  maxActions,
  applyRetries: true,
  applyResolves: true,
}, "medic-desk-triage-script");
console.log("APPLY", JSON.stringify({
  dryRun: result.dryRun,
  applied: result.applied,
  skipped: result.skipped,
  maxActions: result.maxActions,
  results: result.results.slice(0, 20),
}, null, 2));
process.exit(0);
