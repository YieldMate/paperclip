import { readFileSync } from "node:fs";
import { createDb } from "@paperclipai/db";
import { platformHealthService } from "../src/services/platform-health.ts";

process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";

const COMPANY = "71e9ee98-5046-46b9-a668-adaba1f26408";
const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json", "utf8"));
const db = createDb(cfg.database.connectionString);
const health = platformHealthService(db);

const snap = await health.getHealthSnapshot(COMPANY);
const desk = await health.proposeDeskActions(COMPANY);

const byAction = new Map<string, number>();
const byClass = new Map<string, number>();
for (const p of desk.proposals) {
  byAction.set(p.action, (byAction.get(p.action) ?? 0) + 1);
  byClass.set(p.class, (byClass.get(p.class) ?? 0) + 1);
}

console.log(JSON.stringify({
  snapshotCounts: snap.counts,
  pausedBudgetAgents: snap.pausedBudgetAgents.map((a) => ({
    name: a.name, id: a.id, pauseReason: a.pauseReason, spent: a.spentMonthlyCents, budget: a.budgetMonthlyCents,
  })),
  desk: {
    proposalCount: desk.proposals.length,
    byAction: Object.fromEntries([...byAction.entries()].sort()),
    byClass: Object.fromEntries([...byClass.entries()].sort()),
    samples: {
      retry: desk.proposals.filter((p) => p.action === "retry_failed_run").slice(0, 5),
      resolve: desk.proposals.filter((p) => p.action === "resolve_recovery_action").slice(0, 5),
      escalate: desk.proposals.filter((p) => p.action === "escalate").slice(0, 5),
    },
  },
}, null, 2));
process.exit(0);
