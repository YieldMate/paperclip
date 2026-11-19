import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb, agents } from "@paperclipai/db";
import { createAgentLifecycle } from "../src/services/agent-lifecycle.ts";
import { createLifecycleDriver } from "../src/services/agent-lifecycle-driver.ts";
import { createPluginWorkerManager } from "../src/services/plugin-worker-manager.ts";
import { configureAgentLifecycle } from "../src/services/agent-lifecycle.ts";

const MEDIC="ea29019a-c94a-4949-9b35-ea68a9903bbb";
process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";

const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json","utf8"));
const db = createDb(cfg.database.connectionString);
const lifecycle = createAgentLifecycle(db);

const [before]=await db.select({
  status:agents.status, lifecycleState:agents.lifecycleState, lifecycleHolds:agents.lifecycleHolds,
  lifecycleOperation:agents.lifecycleOperation, pauseReason:agents.pauseReason,
}).from(agents).where(eq(agents.id,MEDIC));
console.log("before", JSON.stringify(before,null,2));

// Try explicit resume if available
if (typeof (lifecycle as any).resume === "function") {
  await (lifecycle as any).resume(MEDIC, { createdByUserId: "s33cQuwlQ9uPbCdoDTHZLbA6CYyoSTwa" });
} else if (typeof (lifecycle as any).requestResume === "function") {
  await (lifecycle as any).requestResume(MEDIC, { createdByUserId: "s33cQuwlQ9uPbCdoDTHZLbA6CYyoSTwa" });
} else {
  console.log("lifecycle methods", Object.keys(lifecycle));
}

const manager = createPluginWorkerManager();
const worker = configureAgentLifecycle(db, createLifecycleDriver(db, manager), () => true);
for (let i = 0; i < 10; i++) {
  await worker.process(MEDIC);
  await new Promise((r) => setTimeout(r, 1000));
  const [a] = await db.select({
    status: agents.status,
    lifecycleState: agents.lifecycleState,
    pauseReason: agents.pauseReason,
    lifecycleHolds: agents.lifecycleHolds,
    lifecycleError: agents.lifecycleError,
  }).from(agents).where(eq(agents.id, MEDIC));
  console.log(`tick ${i}`, a);
  if (a?.lifecycleState === "ready") break;
}
await worker.stop();
await manager.stop?.();
process.exit(0);
