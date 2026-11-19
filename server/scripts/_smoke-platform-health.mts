import { readFileSync } from "node:fs";
import { createDb } from "@paperclipai/db";
import { platformHealthService } from "../src/services/platform-health.ts";

process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";

const COMPANY_ID = "71e9ee98-5046-46b9-a668-adaba1f26408";
const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json", "utf8"));
const db = createDb(cfg.database.connectionString);
const health = platformHealthService(db);

const snapshot = await health.getHealthSnapshot(COMPANY_ID);
console.log("snapshot", {
  empty: snapshot.empty,
  counts: snapshot.counts,
  findings: snapshot.findings.slice(0, 10).map((f) => ({
    class: f.class,
    autoSafe: f.autoSafe,
    action: f.recommendedAction,
    detail: f.detail,
  })),
});

const heal = await health.autoHeal(COMPANY_ID, { dryRun: true }, "smoke");
console.log("autoHeal.dryRun", {
  snapshotEmpty: heal.snapshotEmpty,
  results: heal.results.slice(0, 10).map((r) => ({
    class: r.finding.class,
    action: r.action,
    applied: r.applied,
    skippedReason: r.skippedReason,
  })),
});

const desk = await health.proposeDeskActions(COMPANY_ID);
console.log("desk", { proposals: desk.proposals.length, sample: desk.proposals.slice(0, 5) });

process.exit(0);
