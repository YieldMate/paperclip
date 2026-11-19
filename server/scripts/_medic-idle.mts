import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb, agents } from "@paperclipai/db";
const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json","utf8"));
const db = createDb(cfg.database.connectionString);
await db.update(agents).set({status:"idle", errorReason:null, updatedAt:new Date()}).where(eq(agents.id,"ea29019a-c94a-4949-9b35-ea68a9903bbb"));
console.log("idle");
process.exit(0);
