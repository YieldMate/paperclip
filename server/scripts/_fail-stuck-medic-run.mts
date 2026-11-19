import { readFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { createDb, heartbeatRuns, agentWakeupRequests, agents } from "@paperclipai/db";
const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json","utf8"));
const db = createDb(cfg.database.connectionString);
const agentId="ea29019a-c94a-4949-9b35-ea68a9903bbb";
const stuck=["e1973053-dae3-4df7-a049-9a931f4468ae"];
for (const id of stuck) {
  await db.update(heartbeatRuns).set({
    status: "failed",
    error: "operator: aborted stuck preparing after controller lease expiry",
    errorCode: "controller_lease_lost",
    finishedAt: new Date(),
    executionStage: "preparing",
    updatedAt: new Date(),
  }).where(eq(heartbeatRuns.id, id));
}
await db.update(heartbeatRuns).set({
  status: "cancelled",
  error: "operator: cancelled while clearing stuck MEDIC prepare",
  finishedAt: new Date(),
  updatedAt: new Date(),
}).where(inArray(heartbeatRuns.status, ["queued","running"] as any)).where(eq(heartbeatRuns.agentId, agentId) as any);
// simpler: cancel other queued for medic
const recent = await db.select({id:heartbeatRuns.id,status:heartbeatRuns.status}).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
for (const r of recent) {
  if (r.status === "queued") {
    await db.update(heartbeatRuns).set({status:"cancelled", error:"operator: clear before rewake", finishedAt:new Date(), updatedAt:new Date()}).where(eq(heartbeatRuns.id,r.id));
  }
}
await db.update(agents).set({status:"idle", errorReason:null, updatedAt:new Date()}).where(eq(agents.id, agentId));
await db.update(agentWakeupRequests).set({status:"cancelled"}).where(eq(agentWakeupRequests.agentId, agentId));
console.log("cleared");
process.exit(0);
