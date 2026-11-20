import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb, agents } from "@paperclipai/db";
import { heartbeatService } from "../src/services/heartbeat.ts";
import { platformHealthService } from "../src/services/platform-health.ts";

process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";
process.env.PAPERCLIP_API_URL ??= "http://127.0.0.1:3100";

const MEDIC = "ea29019a-c94a-4949-9b35-ea68a9903bbb";
const ACTOR = "s33cQuwlQ9uPbCdoDTHZLbA6CYyoSTwa";
const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json", "utf8"));
const db = createDb(cfg.database.connectionString);

const [before] = await db.select({
  status: agents.status,
  pauseReason: agents.pauseReason,
  lifecycleState: agents.lifecycleState,
  spentMonthlyCents: agents.spentMonthlyCents,
  budgetMonthlyCents: agents.budgetMonthlyCents,
  companyId: agents.companyId,
}).from(agents).where(eq(agents.id, MEDIC)).limit(1);
console.log("before", before);

const heartbeat = heartbeatService(db);
const health = platformHealthService(db, {
  cancelWorkForScope: heartbeat.cancelBudgetScopeWork,
});

// Clear false budget pause / stuck lifecycle so MEDIC can run.
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

const ensured = await health.ensureMedicAgent(before!.companyId, {
  dryRun: false,
  budgetMonthlyCents: 50_000,
  intervalSec: 180,
}, ACTOR);
console.log("ensureMedic", {
  created: ensured.created,
  agentId: ensured.agent?.id,
  status: ensured.agent?.status,
  pauseReason: ensured.agent?.pauseReason,
  lifecycleState: ensured.agent?.lifecycleState,
  metadata: ensured.agent?.metadata,
});

const prompt = (ensured.agent as { adapterConfig?: { promptTemplate?: string } } | null)?.adapterConfig?.promptTemplate ?? "";
console.log("promptHasApplyDesk", prompt.includes("apply-desk-triage"));
console.log("promptHasAutoHealDesk", prompt.includes("applyDeskTriage"));

// Apply a few resolves (no more retries in this pass).
const resolvePass = await health.applyDeskTriage(before!.companyId, {
  dryRun: false,
  maxActions: 5,
  applyRetries: false,
  applyResolves: true,
}, "medic-desk-resolve-script");
console.log("RESOLVE", JSON.stringify({
  applied: resolvePass.applied,
  skipped: resolvePass.skipped,
  results: resolvePass.results.filter((r) => r.action === "resolve_recovery_action").slice(0, 10),
}, null, 2));

process.exit(0);
