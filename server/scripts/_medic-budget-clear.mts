import { readFileSync } from "node:fs";
import { and, eq, desc } from "drizzle-orm";
import { createDb, agents, budgetPolicies, costEvents, budgetHolds } from "@paperclipai/db";
import { platformHealthService } from "../src/services/platform-health.ts";
import { createAgentLifecycle } from "../src/services/agent-lifecycle.ts";

process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";
process.env.PAPERCLIP_API_URL ??= "http://127.0.0.1:3100";

const MEDIC="ea29019a-c94a-4949-9b35-ea68a9903bbb";
const COMPANY="71e9ee98-5046-46b9-a668-adaba1f26408";
const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json","utf8"));
const db = createDb(cfg.database.connectionString);

const [a]=await db.select({
  status:agents.status, pauseReason:agents.pauseReason, spentMonthlyCents:agents.spentMonthlyCents,
  budgetMonthlyCents:agents.budgetMonthlyCents, lifecycleState:agents.lifecycleState, lifecycleHolds:agents.lifecycleHolds,
  errorReason:agents.errorReason,
}).from(agents).where(eq(agents.id,MEDIC));
const policies=await db.select().from(budgetPolicies).where(and(eq(budgetPolicies.scopeId,MEDIC),eq(budgetPolicies.scopeType,"agent")));
console.log("before", JSON.stringify({a, policies: policies.map(p=>({id:p.id,amount:p.amount,unpriced:p.unpricedUsagePolicy}))},null,2));

const health = platformHealthService(db);
const result = await health.reconcileAndResume(COMPANY, MEDIC, "s33cQuwlQ9uPbCdoDTHZLbA6CYyoSTwa");
console.log("reconcile", JSON.stringify(result,null,2));

const [a2]=await db.select({
  status:agents.status, pauseReason:agents.pauseReason, spentMonthlyCents:agents.spentMonthlyCents,
  lifecycleState:agents.lifecycleState, lifecycleHolds:agents.lifecycleHolds, errorReason:agents.errorReason,
}).from(agents).where(eq(agents.id,MEDIC));
console.log("after", JSON.stringify(a2,null,2));
process.exit(0);
