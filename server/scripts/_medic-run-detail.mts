import { readFileSync } from "node:fs";
import { eq, desc } from "drizzle-orm";
import { createDb, heartbeatRuns, agents } from "@paperclipai/db";
const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json","utf8"));
const db = createDb(cfg.database.connectionString);
const agentId="ea29019a-c94a-4949-9b35-ea68a9903bbb";
const runId=process.argv[2];
const recent=await db.select({
  id:heartbeatRuns.id,status:heartbeatRuns.status,error:heartbeatRuns.error,
  executionStage:heartbeatRuns.executionStage,processPid:heartbeatRuns.processPid,
  startedAt:heartbeatRuns.startedAt,finishedAt:heartbeatRuns.finishedAt,
  controllerLeaseExpiresAt:heartbeatRuns.controllerLeaseExpiresAt,
  updatedAt:heartbeatRuns.updatedAt,
}).from(heartbeatRuns).where(eq(heartbeatRuns.agentId,agentId)).orderBy(desc(heartbeatRuns.createdAt)).limit(5);
const [a]=await db.select({status:agents.status,errorReason:agents.errorReason}).from(agents).where(eq(agents.id,agentId));
console.log(JSON.stringify({agent:a,recent},null,2));
if (runId) {
  const [r]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,runId)).limit(1);
  console.log("detail", JSON.stringify({id:r?.id,status:r?.status,stage:r?.executionStage,pid:r?.processPid,err:r?.error,lease:r?.controllerLeaseExpiresAt},null,2));
}
process.exit(0);
