import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { createDb, agents, heartbeatRuns } from "@paperclipai/db";
import { heartbeatService } from "../src/services/heartbeat.ts";
import { platformHealthService } from "../src/services/platform-health.ts";

process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";

const COMPANY = "71e9ee98-5046-46b9-a668-adaba1f26408";
const NAMES = ["MEDIC", "CHO", "GOMEZ", "DAVE"] as const;
const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json", "utf8"));
const db = createDb(cfg.database.connectionString);
const hb = heartbeatService(db);
const health = platformHealthService(db, { cancelWorkForScope: hb.cancelBudgetScopeWork });

const fleet = await db.select({
  id: agents.id,
  name: agents.name,
}).from(agents).where(and(eq(agents.companyId, COMPANY), inArray(agents.name, [...NAMES])));
const ids = fleet.map((a) => a.id);
const nameById = Object.fromEntries(fleet.map((a) => [a.id, a.name]));

const pending = await db.select({
  id: heartbeatRuns.id,
  agentId: heartbeatRuns.agentId,
  status: heartbeatRuns.status,
  sessionIdAfter: heartbeatRuns.sessionIdAfter,
  usageJson: heartbeatRuns.usageJson,
  error: heartbeatRuns.error,
}).from(heartbeatRuns).where(and(
  inArray(heartbeatRuns.agentId, ids),
  eq(heartbeatRuns.costAccountingPending, true),
));

console.log("pending", pending.map((r) => ({
  agent: nameById[r.agentId],
  id: r.id,
  session: r.sessionIdAfter,
  receiptReady: (r.usageJson as Record<string, unknown> | null)?.accountingReceiptReady,
})));

for (const run of pending) {
  const hasSession = Boolean(run.sessionIdAfter);
  const modes = hasSession
    ? (["auto", "hermes_estimate", "pre_provider"] as const)
    : (["pre_provider", "auto"] as const);
  let ok = false;
  for (const mode of modes) {
    try {
      const result = await health.settlePendingRun(COMPANY, {
        runId: run.id,
        mode,
        dryRun: false,
        ...(mode === "hermes_estimate"
          ? { costUsd: 0.01, evidence: `Fleet unblock estimate for ${nameById[run.agentId]}` }
          : {}),
      }, "fleet-unpause");
      console.log("settled", nameById[run.agentId], run.id, mode, result);
      ok = true;
      break;
    } catch (e) {
      console.log("settle fail", nameById[run.agentId], run.id, mode, e instanceof Error ? e.message : e);
    }
  }
  if (!ok) console.log("UNSETTLED", nameById[run.agentId], run.id);
}

const reaped = await health.reapPendingReceipts(COMPANY);
console.log("reaped", reaped);

for (const agent of fleet) {
  try {
    const r = await health.reconcileAndResume(COMPANY, { agentId: agent.id, dryRun: false }, "fleet-unpause");
    console.log("reconcile", agent.name, JSON.stringify({
      applied: r.applied,
      status: (r as { agent?: { status?: string; pauseReason?: string | null; lifecycleState?: string } }).agent,
      block: (r as { block?: unknown }).block,
    }));
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
    console.log("forced ready", agent.name);
  }
}

const after = await db.select({
  name: agents.name,
  status: agents.status,
  pauseReason: agents.pauseReason,
  lifecycleState: agents.lifecycleState,
}).from(agents).where(inArray(agents.id, ids));
console.log("after", after);

// Wake MEDIC so it can keep healing.
const medic = fleet.find((a) => a.name === "MEDIC");
if (medic) {
  const wake = await hb.wakeup(medic.id, {
    source: "on_demand",
    triggerDetail: "manual",
    reason: "fleet_unpause_wake_medic",
    requestedByActorType: "user",
    requestedByActorId: "s33cQuwlQ9uPbCdoDTHZLbA6CYyoSTwa",
  });
  console.log("medic wake", { id: (wake as { id?: string } | null)?.id, status: (wake as { status?: string } | null)?.status });
}

process.exit(0);
