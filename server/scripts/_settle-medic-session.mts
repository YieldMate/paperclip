import { readFileSync } from "node:fs";
import { and, eq, desc } from "drizzle-orm";
import { createDb, agents, heartbeatRuns } from "@paperclipai/db";
import { heartbeatService } from "../src/services/heartbeat.ts";
import { platformHealthService } from "../src/services/platform-health.ts";
import {
  aggregateHermesSessionUsage,
  readHermesSessionUsage,
  resolveHermesStateDbPath,
} from "../src/services/platform-health-hermes.ts";

process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";

const MEDIC = "ea29019a-c94a-4949-9b35-ea68a9903bbb";
const COMPANY = "71e9ee98-5046-46b9-a668-adaba1f26408";
const SESSION = process.env.MEDIC_SESSION
  ?? "local-9a22278f80f610df8e79d0780d7b425bdacfe7affc039e430830c660196b01a4";

const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json", "utf8"));
const db = createDb(cfg.database.connectionString);
const hb = heartbeatService(db);
const health = platformHealthService(db, { cancelWorkForScope: hb.cancelBudgetScopeWork });

const pending = await db.select({
  id: heartbeatRuns.id,
  status: heartbeatRuns.status,
  sessionIdAfter: heartbeatRuns.sessionIdAfter,
  costAccountingPending: heartbeatRuns.costAccountingPending,
  adapterConfig: agents.adapterConfig,
}).from(heartbeatRuns)
  .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
  .where(and(
    eq(heartbeatRuns.agentId, MEDIC),
    eq(heartbeatRuns.costAccountingPending, true),
  ))
  .orderBy(desc(heartbeatRuns.createdAt));

console.log("pending", pending.map((r) => ({ id: r.id, session: r.sessionIdAfter, status: r.status })));

for (const run of pending) {
  const stateDb = resolveHermesStateDbPath(run.adapterConfig as Record<string, unknown>);
  const sessionId = run.sessionIdAfter || SESSION;
  const rows = readHermesSessionUsage(stateDb, sessionId);
  const agg = aggregateHermesSessionUsage(rows);
  console.log("sessionUsage", sessionId, agg);

  if (!run.sessionIdAfter) {
    await db.update(heartbeatRuns).set({
      sessionIdAfter: sessionId,
    }).where(eq(heartbeatRuns.id, run.id));
  }

  const result = await health.settlePendingRun(COMPANY, {
    runId: run.id,
    mode: "hermes_estimate",
    dryRun: false,
    ...(agg?.costUsd != null ? {} : { costUsd: 0.01 }),
  }, "session-footer-fix");
  console.log("settled", run.id, JSON.stringify(result));
}

const reconcile = await health.reconcileAndResume(COMPANY, { agentId: MEDIC, dryRun: false }, "session-footer-fix");
console.log("reconcile", JSON.stringify(reconcile));

const [after] = await db.select({
  status: agents.status,
  pauseReason: agents.pauseReason,
  lifecycleState: agents.lifecycleState,
}).from(agents).where(eq(agents.id, MEDIC));
console.log("after", after);
process.exit(0);
