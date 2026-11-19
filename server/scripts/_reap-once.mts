import { readFileSync } from "node:fs";
import { createDb } from "@paperclipai/db";
import { platformHealthService } from "../src/services/platform-health.ts";

process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";

const COMPANY_ID = "71e9ee98-5046-46b9-a668-adaba1f26408";
const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json", "utf8"));
const db = createDb(cfg.database.connectionString);
const health = platformHealthService(db);
const result = await health.reapPendingReceipts(COMPANY_ID);
console.log(JSON.stringify(result, null, 2));
process.exit(0);
