import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb, agents } from "@paperclipai/db";
import { platformHealthService } from "../src/services/platform-health.ts";

process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";
process.env.PAPERCLIP_API_URL ??= "http://127.0.0.1:3100";

const MEDIC="ea29019a-c94a-4949-9b35-ea68a9903bbb";
const COMPANY="71e9ee98-5046-46b9-a668-adaba1f26408";
const ACTOR="s33cQuwlQ9uPbCdoDTHZLbA6CYyoSTwa";
const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json","utf8"));
const db = createDb(cfg.database.connectionString);
const health = platformHealthService(db);

const [before]=await db.select({spent:agents.spentMonthlyCents,budget:agents.budgetMonthlyCents,pause:agents.pauseReason,holds:agents.lifecycleHolds,state:agents.lifecycleState}).from(agents).where(eq(agents.id,MEDIC));
console.log("before", before);

await health.ensureMedicAgent(COMPANY, {
  dryRun: false,
  budgetMonthlyCents: 250_000,
  intervalSec: 180,
  model: "z-ai/glm-5.3",
}, ACTOR);

try {
  console.log("reconcile", await health.reconcileAndResume(COMPANY, { agentId: MEDIC, dryRun: false }, ACTOR));
} catch (e: any) {
  console.log("reconcile err", e?.message);
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

const [after]=await db.select({spent:agents.spentMonthlyCents,budget:agents.budgetMonthlyCents,pause:agents.pauseReason,holds:agents.lifecycleHolds,state:agents.lifecycleState,status:agents.status}).from(agents).where(eq(agents.id,MEDIC));
console.log("after", after);
process.exit(0);
