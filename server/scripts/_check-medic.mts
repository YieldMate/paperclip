import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { createDb, agents, budgetPolicies } from "@paperclipai/db";

const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json", "utf8"));
const db = createDb(cfg.database.connectionString);
const medicId = "ea29019a-c94a-4949-9b35-ea68a9903bbb";
const [a] = await db.select({
  name: agents.name,
  status: agents.status,
  lifecycleState: agents.lifecycleState,
  pauseReason: agents.pauseReason,
  lifecycleHolds: agents.lifecycleHolds,
  lifecycleError: agents.lifecycleError,
}).from(agents).where(eq(agents.id, medicId));
const policies = await db.select({
  id: budgetPolicies.id,
  amount: budgetPolicies.amount,
  unpricedUsagePolicy: budgetPolicies.unpricedUsagePolicy,
  hardStopEnabled: budgetPolicies.hardStopEnabled,
  isActive: budgetPolicies.isActive,
}).from(budgetPolicies).where(and(eq(budgetPolicies.scopeId, medicId), eq(budgetPolicies.scopeType, "agent")));
console.log(JSON.stringify({ agent: a, policies }, null, 2));
process.exit(0);
