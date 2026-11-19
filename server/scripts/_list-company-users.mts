import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb, companyMemberships, users } from "@paperclipai/db";
const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json","utf8"));
const db = createDb(cfg.database.connectionString);
const companyId="71e9ee98-5046-46b9-a668-adaba1f26408";
const rows = await db.select({
  userId: companyMemberships.userId,
  status: companyMemberships.status,
  role: companyMemberships.role,
  email: users.email,
  name: users.name,
}).from(companyMemberships).leftJoin(users, eq(users.id, companyMemberships.userId)).where(eq(companyMemberships.companyId, companyId));
console.log(JSON.stringify(rows,null,2));
process.exit(0);
