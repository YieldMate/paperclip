import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb, agents } from "@paperclipai/db";
import { configureAgentLifecycle } from "../src/services/agent-lifecycle.ts";
import { createLifecycleDriver } from "../src/services/agent-lifecycle-driver.ts";
import { createPluginWorkerManager } from "../src/services/plugin-worker-manager.ts";
const MEDIC_ID = "ea29019a-c94a-4949-9b35-ea68a9903bbb";

process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";

const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json", "utf8"));
const db = createDb(cfg.database.connectionString);

const manager = createPluginWorkerManager();
const worker = configureAgentLifecycle(db, createLifecycleDriver(db, manager), () => true);
for (let i = 0; i < 5; i++) {
  await worker.process(MEDIC_ID);
  await new Promise((r) => setTimeout(r, 1500));
  const [a] = await db.select({
    status: agents.status,
    lifecycleState: agents.lifecycleState,
    pauseReason: agents.pauseReason,
    lifecycleError: agents.lifecycleError,
  }).from(agents).where(eq(agents.id, MEDIC_ID));
  console.log(`tick ${i}`, a);
  if (a?.lifecycleState === "ready") break;
}

await worker.stop();
await manager.stop?.();
process.exit(0);
