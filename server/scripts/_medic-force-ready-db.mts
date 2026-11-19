import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb, agents } from "@paperclipai/db";
const MEDIC="ea29019a-c94a-4949-9b35-ea68a9903bbb";
const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json","utf8"));
const db = createDb(cfg.database.connectionString);
const [updated]=await db.update(agents).set({
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
  budgetMonthlyCents: agents.budgetMonthlyCents,
  spentMonthlyCents: agents.spentMonthlyCents,
});
console.log(JSON.stringify(updated,null,2));
process.exit(0);
