import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb, agents } from "@paperclipai/db";
import { createAgentLifecycle } from "../src/services/agent-lifecycle.ts";
import { createLifecycleDriver } from "../src/services/agent-lifecycle-driver.ts";
import { createPluginWorkerManager } from "../src/services/plugin-worker-manager.ts";
import { configureAgentLifecycle } from "../src/services/agent-lifecycle.ts";

const MEDIC="ea29019a-c94a-4949-9b35-ea68a9903bbb";
const ACTOR="s33cQuwlQ9uPbCdoDTHZLbA6CYyoSTwa";
process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";

const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json","utf8"));
const db = createDb(cfg.database.connectionString);
const lifecycle = createAgentLifecycle(db);

try {
  const r = await lifecycle.resumeAgent(MEDIC, { createdByUserId: ACTOR });
  console.log("resumeAgent", JSON.stringify(r,null,2));
} catch (e: any) {
  console.log("resumeAgent err", e?.message ?? e);
}

try {
  const r = await lifecycle.retry(MEDIC, { createdByUserId: ACTOR });
  console.log("retry", JSON.stringify(r,null,2));
} catch (e: any) {
  console.log("retry err", e?.message ?? e);
}

const manager = createPluginWorkerManager();
const worker = configureAgentLifecycle(db, createLifecycleDriver(db, manager), () => true);
for (let i = 0; i < 8; i++) {
  await worker.process(MEDIC);
  await new Promise((r) => setTimeout(r, 1500));
  const [a] = await db.select({
    status: agents.status,
    lifecycleState: agents.lifecycleState,
    pauseReason: agents.pauseReason,
    lifecycleHolds: agents.lifecycleHolds,
    lifecycleOperation: agents.lifecycleOperation,
    lifecycleError: agents.lifecycleError,
  }).from(agents).where(eq(agents.id, MEDIC));
  console.log(`tick ${i}`, {
    status: a?.status,
    lifecycleState: a?.lifecycleState,
    holds: a?.lifecycleHolds,
    op: a?.lifecycleOperation,
    err: a?.lifecycleError,
  });
  if (a?.lifecycleState === "ready") break;
}
await worker.stop();
await manager.stop?.();
process.exit(0);
