import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { createDb, heartbeatRuns, agents } from "@paperclipai/db";
const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json","utf8"));
const db = createDb(cfg.database.connectionString);
const agentId="ea29019a-c94a-4949-9b35-ea68a9903bbb";
const updated = await db.update(heartbeatRuns).set({
  status: "cancelled",
  error: "operator: cancel orphaned side-process prepare",
  finishedAt: new Date(),
  updatedAt: new Date(),
}).where(and(
  eq(heartbeatRuns.agentId, agentId),
  inArray(heartbeatRuns.status, ["queued", "running"]),
)).returning({id:heartbeatRuns.id,status:heartbeatRuns.status});
await db.update(agents).set({status:"idle", errorReason:null, updatedAt:new Date()}).where(eq(agents.id, agentId));
console.log(JSON.stringify(updated,null,2));
process.exit(0);
