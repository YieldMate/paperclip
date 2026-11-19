import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { createDb, heartbeatRuns } from "@paperclipai/db";
const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json","utf8"));
const db = createDb(cfg.database.connectionString);
const [r]=await db.select({
  id: heartbeatRuns.id,
  status: heartbeatRuns.status,
  controllerBootId: heartbeatRuns.controllerBootId,
  controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt,
  executionStage: heartbeatRuns.executionStage,
  processPid: heartbeatRuns.processPid,
  now: sql`clock_timestamp()`,
}).from(heartbeatRuns).where(eq(heartbeatRuns.id,"e1973053-dae3-4df7-a049-9a931f4468ae"));
console.log(JSON.stringify(r,null,2));
process.exit(0);
