import { readFileSync } from "node:fs";
import { eq, desc } from "drizzle-orm";
import { createDb, heartbeatRuns } from "@paperclipai/db";
const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json","utf8"));
const db = createDb(cfg.database.connectionString);
const rows=await db.select({
  id:heartbeatRuns.id,status:heartbeatRuns.status,responsibleUserId:heartbeatRuns.responsibleUserId,
  invocationSource:heartbeatRuns.invocationSource,createdAt:heartbeatRuns.createdAt,
}).from(heartbeatRuns).where(eq(heartbeatRuns.agentId,"ea29019a-c94a-4949-9b35-ea68a9903bbb")).orderBy(desc(heartbeatRuns.createdAt)).limit(10);
console.log(JSON.stringify(rows,null,2));
process.exit(0);
