import { readFileSync } from "node:fs";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createDb, heartbeatRuns, environmentLeases } from "@paperclipai/db";
const MEDIC="ea29019a-c94a-4949-9b35-ea68a9903bbb";
const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json","utf8"));
const db = createDb(cfg.database.connectionString);
const active = await db.select({
  leaseId: environmentLeases.id,
  status: environmentLeases.status,
  cleanupStatus: environmentLeases.cleanupStatus,
  runId: environmentLeases.heartbeatRunId,
  runStatus: heartbeatRuns.status,
}).from(environmentLeases)
  .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, environmentLeases.heartbeatRunId))
  .where(and(
    eq(heartbeatRuns.agentId, MEDIC),
    inArray(environmentLeases.status, ["active", "pending_cleanup", "retained"]),
  ));
const nonTerminal = await db.select({id:heartbeatRuns.id,status:heartbeatRuns.status,lease:heartbeatRuns.controllerLeaseExpiresAt}).from(heartbeatRuns).where(and(
  eq(heartbeatRuns.agentId, MEDIC),
  sql`${heartbeatRuns.status} not in ('succeeded','failed','cancelled','timed_out','interrupted')`,
));
console.log(JSON.stringify({activeLeases:active.length, sample:active.slice(0,10), nonTerminal},null,2));
process.exit(0);
