import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb, heartbeatRuns } from "@paperclipai/db";
import { heartbeatService } from "../src/services/heartbeat.ts";

process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";
process.env.PAPERCLIP_API_URL ??= "http://127.0.0.1:3100";

const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json", "utf8"));
const db = createDb(cfg.database.connectionString);
const hb = heartbeatService(db);
const agentId = "ea29019a-c94a-4949-9b35-ea68a9903bbb";
const run = await hb.wakeup(agentId, {
  source: "on_demand",
  triggerDetail: "manual",
  reason: "medic_env_passthrough_verify",
  requestedByActorType: "user",
  // Real company member — "board" mints RESPONSIBLE_USER_UNAVAILABLE on company APIs.
  requestedByActorId: "s33cQuwlQ9uPbCdoDTHZLbA6CYyoSTwa",
});
console.log("queued", JSON.stringify({ id: run?.id, status: run?.status }, null, 2));
if (!run?.id) process.exit(1);

const started = Date.now();
while (Date.now() - started < 10 * 60_000) {
  const [r] = await db.select({
    status: heartbeatRuns.status,
    error: heartbeatRuns.error,
    executionStage: heartbeatRuns.executionStage,
    processPid: heartbeatRuns.processPid,
    exitCode: heartbeatRuns.exitCode,
    finishedAt: heartbeatRuns.finishedAt,
  }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).limit(1);
  console.log(new Date().toISOString(), r);
  if (r && ["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(r.status)) {
    console.log("FINAL", JSON.stringify(r, null, 2));
    process.exit(r.status === "succeeded" ? 0 : 1);
  }
  await new Promise((r) => setTimeout(r, 5000));
}
console.error("timeout waiting for run");
process.exit(2);
