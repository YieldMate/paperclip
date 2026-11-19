import { readFileSync } from "node:fs";
import { createDb } from "@paperclipai/db";
import { platformHealthService } from "../src/services/platform-health.ts";

process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";

const COMPANY_ID = "71e9ee98-5046-46b9-a668-adaba1f26408";
const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json", "utf8"));
const db = createDb(cfg.database.connectionString);
const health = platformHealthService(db);

const result = await health.autoHeal(COMPANY_ID, { dryRun: false, maxActions: 5 }, "platform-health-bootstrap");
console.log(JSON.stringify({
  actionsUsed: result.actionsUsed,
  applied: result.results.filter((r) => r.applied).map((r) => ({
    class: r.finding.class,
    action: r.action,
    runId: r.finding.runId,
    costEventId: r.finding.costEventId,
  })),
  failures: result.results
    .filter((r) => r.skippedReason && !["not_auto_safe", "max_actions"].includes(r.skippedReason))
    .slice(0, 10)
    .map((r) => ({
      class: r.finding.class,
      action: r.action,
      skippedReason: r.skippedReason,
      runId: r.finding.runId,
    })),
}, null, 2));

const after = await health.getHealthSnapshot(COMPANY_ID);
console.log("after.counts", after.counts);
process.exit(0);
