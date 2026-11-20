import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb, agents } from "@paperclipai/db";
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
  spentMonthlyCents: agents.spentMonthlyCents,
  budgetMonthlyCents: agents.budgetMonthlyCents,
}).from(agents).where(eq(agents.id, MEDIC)).limit(1);
console.log("after", after);
process.exit(0);
