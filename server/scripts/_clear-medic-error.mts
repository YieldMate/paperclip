import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb, agents } from "@paperclipai/db";
import { createAgentLifecycle } from "../src/services/agent-lifecycle.ts";
import { platformHealthService } from "../src/services/platform-health.ts";

process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";

const MEDIC_ID = "ea29019a-c94a-4949-9b35-ea68a9903bbb";
const COMPANY_ID = "71e9ee98-5046-46b9-a668-adaba1f26408";

const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json", "utf8"));
const db = createDb(cfg.database.connectionString);

const lifecycle = createAgentLifecycle(db);
await lifecycle.clearError(MEDIC_ID);

const health = platformHealthService(db);
const ensured = await health.ensureMedicAgent(COMPANY_ID, {
  dryRun: false,
  budgetMonthlyCents: 5_000,
  intervalSec: 180,
  model: "z-ai/glm-5.3",
}, "board");

const [a] = await db.select({
  status: agents.status,
  errorReason: agents.errorReason,
  lifecycleState: agents.lifecycleState,
  prompt: agents.adapterConfig,
}).from(agents).where(eq(agents.id, MEDIC_ID));

console.log(JSON.stringify({
  cleared: true,
  ensuredCreated: ensured.created,
  status: a?.status,
  errorReason: a?.errorReason,
  lifecycleState: a?.lifecycleState,
  promptSnippet: typeof (a?.prompt as Record<string, unknown>)?.promptTemplate === "string"
    ? String((a?.prompt as Record<string, unknown>).promptTemplate).slice(0, 180)
    : null,
}, null, 2));
process.exit(0);
