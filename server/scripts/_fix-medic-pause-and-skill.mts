import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { createDb, agents, companySkills, heartbeatRuns } from "@paperclipai/db";
import { platformHealthService } from "../src/services/platform-health.ts";
import { companySkillService } from "../src/services/company-skills.ts";

process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";
process.env.PAPERCLIP_API_URL ??= "http://127.0.0.1:3100";

const MEDIC = "ea29019a-c94a-4949-9b35-ea68a9903bbb";
const COMPANY = "71e9ee98-5046-46b9-a668-adaba1f26408";
const ACTOR = "s33cQuwlQ9uPbCdoDTHZLbA6CYyoSTwa";
const CATALOG_ID = "paperclipai:bundled:paperclip-operations:platform-health";
const SKILL_KEY = "paperclipai/bundled/paperclip-operations/platform-health";

const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json", "utf8"));
const db = createDb(cfg.database.connectionString);
const health = platformHealthService(db);
const skills = companySkillService(db);

// Settle any remaining MEDIC pending accounting
const pending = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
  eq(heartbeatRuns.agentId, MEDIC),
  eq(heartbeatRuns.costAccountingPending, true),
));
const settleResults = [];
for (const run of pending) {
  for (const mode of ["auto", "hermes_estimate", "pre_provider"] as const) {
    try {
      const result = await health.settlePendingRun(COMPANY, { runId: run.id, mode, dryRun: false }, ACTOR);
      settleResults.push({ runId: run.id, mode, applied: result.applied });
      break;
    } catch (error: any) {
      settleResults.push({ runId: run.id, mode, error: error?.message ?? String(error) });
    }
  }
}

let reconcile;
try {
  reconcile = await health.reconcileAndResume(COMPANY, { agentId: MEDIC, dryRun: false }, ACTOR);
} catch (error: any) {
  reconcile = { error: error?.message ?? String(error) };
}

const [agent] = await db.update(agents).set({
  status: "idle",
  lifecycleState: "ready",
  lifecycleHolds: [],
  lifecycleError: null,
  lifecycleOperation: null,
  pauseReason: null,
  pausedAt: null,
  errorReason: null,
  updatedAt: new Date(),
}).where(eq(agents.id, MEDIC)).returning({
  status: agents.status,
  lifecycleState: agents.lifecycleState,
  pauseReason: agents.pauseReason,
  lifecycleHolds: agents.lifecycleHolds,
  spentMonthlyCents: agents.spentMonthlyCents,
  budgetMonthlyCents: agents.budgetMonthlyCents,
});

const stillPending = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
  eq(heartbeatRuns.agentId, MEDIC),
  eq(heartbeatRuns.costAccountingPending, true),
));

const install = await skills.installFromCatalog(COMPANY, { catalogSkillId: CATALOG_ID });
const [skillRow] = await db.select({
  id: companySkills.id,
  key: companySkills.key,
  name: companySkills.name,
  sourceType: companySkills.sourceType,
  currentVersionId: companySkills.currentVersionId,
}).from(companySkills).where(and(eq(companySkills.companyId, COMPANY), eq(companySkills.key, SKILL_KEY)));

// Ensure MEDIC desiredSkills still includes platform-health with version pin
const healthEnsure = await health.ensureMedicAgent(COMPANY, {
  dryRun: false,
  budgetMonthlyCents: 250_000,
  intervalSec: 180,
  model: "z-ai/glm-5.3",
}, ACTOR);

console.log(JSON.stringify({
  settleResults,
  stillPendingCount: stillPending.length,
  reconcile: reconcile && "error" in (reconcile as object)
    ? reconcile
    : { applied: (reconcile as any)?.applied, pauseReason: (reconcile as any)?.agent?.pauseReason, lifecycleState: (reconcile as any)?.agent?.lifecycleState },
  agent,
  skillInstall: { action: install.action, key: install.skill?.key, warnings: install.warnings },
  skillInLibrary: skillRow,
  desiredSkills: (healthEnsure.agent as any)?.adapterConfig?.paperclipSkillSync?.desiredSkills,
}, null, 2));

process.exit(
  stillPending.length === 0
  && agent?.lifecycleState === "ready"
  && !agent?.pauseReason
  && skillRow
    ? 0
    : 1,
);
