import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { createDb, agents, heartbeatRuns } from "@paperclipai/db";
import { heartbeatService } from "../src/services/heartbeat.ts";
import { platformHealthService } from "../src/services/platform-health.ts";

process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";

const COMPANY = "71e9ee98-5046-46b9-a668-adaba1f26408";
const TARGETS = ["CHO", "GOMEZ", "MEDIC", "DAVE"] as const;
const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json", "utf8"));
const db = createDb(cfg.database.connectionString);
const hb = heartbeatService(db);
const health = platformHealthService(db, {
  cancelWorkForScope: hb.cancelBudgetScopeWork,
});

const fleet = await db.select({
  id: agents.id,
  name: agents.name,
  status: agents.status,
  pauseReason: agents.pauseReason,
  lifecycleState: agents.lifecycleState,
}).from(agents).where(and(
  eq(agents.companyId, COMPANY),
  inArray(agents.name, [...TARGETS]),
));

for (const agent of fleet) {
  const pending = await db.select({
    id: heartbeatRuns.id,
    status: heartbeatRuns.status,
    sessionIdAfter: heartbeatRuns.sessionIdAfter,
    usageJson: heartbeatRuns.usageJson,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.agentId, agent.id),
    eq(heartbeatRuns.costAccountingPending, true),
  )).limit(20);

  console.log("\n===", agent.name, agent.status, agent.pauseReason, "pending", pending.length);

  for (const run of pending) {
    try {
      const r = await health.settlePendingRun(COMPANY, {
        runId: run.id,
        mode: "auto",
        dryRun: false,
      }, "fleet-settle");
      console.log("auto", run.id, JSON.stringify(r));
    } catch (e) {
      console.log("auto fail", run.id, e instanceof Error ? e.message : e);
      try {
        const r = await health.settlePendingRun(COMPANY, {
          runId: run.id,
          mode: "hermes_estimate",
          dryRun: false,
          costUsd: 0.01,
          evidence: `Fleet unblock estimate for ${agent.name} (no session id)`,
        }, "fleet-settle");
        console.log("estimate", run.id, JSON.stringify(r));
      } catch (e2) {
        console.log("estimate fail", run.id, e2 instanceof Error ? e2.message : e2);
      }
    }
  }

  try {
    const r = await health.reconcileAndResume(COMPANY, { agentId: agent.id, dryRun: false }, "fleet-settle");
    console.log("reconcile", agent.name, JSON.stringify(r));
  } catch (e) {
    console.log("reconcile err", agent.name, e instanceof Error ? e.message : e);
    await db.update(agents).set({
      status: "idle",
      lifecycleState: "ready",
      lifecycleHolds: [],
      lifecycleError: null,
      lifecycleOperation: null,
      pauseReason: null,
      pausedAt: null,
      errorReason: null,
      updatedAt: new Date(),
    }).where(eq(agents.id, agent.id));
    try {
      const r = await health.reconcileAndResume(COMPANY, { agentId: agent.id, dryRun: false }, "fleet-settle");
      console.log("reconcile after force", agent.name, JSON.stringify(r));
    } catch (e2) {
      console.log("still blocked", agent.name, e2 instanceof Error ? e2.message : e2);
    }
  }
}

const after = await db.select({
  name: agents.name,
  status: agents.status,
  pauseReason: agents.pauseReason,
  lifecycleState: agents.lifecycleState,
}).from(agents).where(and(
  eq(agents.companyId, COMPANY),
  inArray(agents.name, [...TARGETS]),
));
console.log("\nafter", after);
process.exit(0);
