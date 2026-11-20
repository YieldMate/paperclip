import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb, agents, heartbeatRuns } from "@paperclipai/db";
import { and } from "drizzle-orm";

process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
const MEDIC = "ea29019a-c94a-4949-9b35-ea68a9903bbb";
const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json", "utf8"));
const db = createDb(cfg.database.connectionString);
const [a] = await db.select({
  status: agents.status,
  pauseReason: agents.pauseReason,
  lifecycleState: agents.lifecycleState,
  spent: agents.spentMonthlyCents,
}).from(agents).where(eq(agents.id, MEDIC));
const pending = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
  eq(heartbeatRuns.agentId, MEDIC),
  eq(heartbeatRuns.costAccountingPending, true),
));
console.log(JSON.stringify({ agent: a, pendingCount: pending.length }, null, 2));
process.exit(0);
