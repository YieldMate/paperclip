import { readFileSync } from "node:fs";
import { createDb } from "@paperclipai/db";
import { companySkillService } from "../src/services/company-skills.ts";
const COMPANY="71e9ee98-5046-46b9-a668-adaba1f26408";
const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json","utf8"));
const db = createDb(cfg.database.connectionString);
const skills = companySkillService(db);
const list = await skills.list(COMPANY);
const hit = list.find((s) => s.key === "paperclipai/bundled/paperclip-operations/platform-health");
console.log(JSON.stringify({
  found: Boolean(hit),
  key: hit?.key,
  name: hit?.name,
  sourceType: hit?.sourceType,
  inLibraryCount: list.length,
}, null, 2));
process.exit(hit ? 0 : 1);
