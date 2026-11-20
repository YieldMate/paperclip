import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { createDb, heartbeatRuns } from "@paperclipai/db";
import { platformHealthService } from "../src/services/platform-health.ts";

const MEDIC = "ea29019a-c94a-4949-9b35-ea68a9903bbb";
const COMPANY = "71e9ee98-5046-46b9-a668-adaba1f26408";
const ACTOR = "s33cQuwlQ9uPbCdoDTHZLbA6CYyoSTwa";
const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json","utf8"));
const db = createDb(cfg.database.connectionString);
const health = platformHealthService(db);

const pending = await db.select({
  id: heartbeatRuns.id,
  status: heartbeatRuns.status,
  costAccountingPending: heartbeatRuns.costAccountingPending,
  accountingLastError: heartbeatRuns.accountingLastError,
  usageJson: heartbeatRuns.usageJson,
}).from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, MEDIC), eq(heartbeatRuns.costAccountingPending, true)));
console.log("pending", JSON.stringify(pending.map(p => ({
  id: p.id, status: p.status, pending: p.costAccountingPending, err: p.accountingLastError,
  usageKeys: p.usageJson && typeof p.usageJson === "object" ? Object.keys(p.usageJson as object) : p.usageJson,
})), null, 2));

for (const run of pending) {
  for (const mode of ["auto", "hermes_estimate", "pre_provider"] as const) {
    try {
      const result = await health.settlePendingRun(COMPANY, { runId: run.id, mode, dryRun: false }, ACTOR);
      console.log("settled", mode, JSON.stringify(result, null, 2).slice(0, 800));
      break;
    } catch (e: any) {
      console.log("fail", mode, e?.message ?? e);
    }
  }
}

const after = await db.select({
  id: heartbeatRuns.id,
  costAccountingPending: heartbeatRuns.costAccountingPending,
  accountingLastError: heartbeatRuns.accountingLastError,
}).from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, MEDIC), eq(heartbeatRuns.costAccountingPending, true)));
console.log("stillPending", after);
process.exit(0);
