/**
 * Host-local installer: import the Railway Hermes skill into the company
 * library and add it to engineer/devops/qa agents' desiredSkills.
 *
 * Usage (from repo root or server package):
 *   pnpm exec tsx server/scripts/_install-railway-skill.mts
 */
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { and, eq, ne } from "drizzle-orm";
import { createDb, agents } from "@paperclipai/db";
import { companySkillService } from "../src/services/company-skills.ts";

process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";

const COMPANY = "71e9ee98-5046-46b9-a668-adaba1f26408";
const SKILL_SLUG = "railway";
const SKILL_KEY = `company/${COMPANY}/${SKILL_SLUG}`;
const SOURCE_DIR =
  "/home/paperclip/src/paperclip/packages/skills-catalog/catalog/optional/software-development/railway";
const MANAGED_ROOT = path.join(
  process.env.PAPERCLIP_HOME,
  "instances",
  process.env.PAPERCLIP_INSTANCE_ID,
  "skills",
  COMPANY,
);
const STAGING_DIR = path.join(MANAGED_ROOT, ".import-src", SKILL_SLUG);

// Roles that routinely touch Railway infra / private DB
const TARGET_ROLES = new Set(["engineer", "devops", "qa"]);
// Named generals who already hit Railway in practice
const TARGET_NAMES = new Set(["Corin", "Elena", "Atlas", "MARCO", "MEDIC", "AUDITOR"]);

const cfg = JSON.parse(
  readFileSync("/home/paperclip/.paperclip/instances/default/config.json", "utf8"),
);
const db = createDb(cfg.database.connectionString);
const skills = companySkillService(db);

mkdirSync(path.dirname(STAGING_DIR), { recursive: true });
rmSync(STAGING_DIR, { recursive: true, force: true });
cpSync(SOURCE_DIR, STAGING_DIR, { recursive: true });

const existing = (await skills.list(COMPANY)).find(
  (s) => s.key === SKILL_KEY || s.slug === SKILL_SLUG,
);

let importResult: Awaited<ReturnType<typeof skills.importFromSource>> | null = null;
if (!existing) {
  importResult = await skills.importFromSource(COMPANY, STAGING_DIR);
} else {
  // Re-import / update path: force refresh via installUpdate if available
  try {
    await skills.installUpdate(COMPANY, existing.id);
  } catch {
    // keep existing if update not applicable
  }
}

const library = await skills.list(COMPANY);
const skill = library.find((s) => s.key === SKILL_KEY || s.slug === SKILL_SLUG);
if (!skill) {
  console.error(JSON.stringify({ error: "skill_missing_after_import", importResult }, null, 2));
  process.exit(1);
}

const agentRows = await db
  .select({
    id: agents.id,
    name: agents.name,
    role: agents.role,
    status: agents.status,
    adapterConfig: agents.adapterConfig,
  })
  .from(agents)
  .where(and(eq(agents.companyId, COMPANY), ne(agents.status, "terminated")));

const targets = agentRows.filter(
  (a) => TARGET_ROLES.has(String(a.role)) || TARGET_NAMES.has(a.name),
);

const synced: Array<{ id: string; name: string; desiredSkills: string[] }> = [];
for (const agent of targets) {
  const config =
    agent.adapterConfig && typeof agent.adapterConfig === "object"
      ? { ...(agent.adapterConfig as Record<string, unknown>) }
      : {};
  const sync =
    config.paperclipSkillSync && typeof config.paperclipSkillSync === "object"
      ? { ...(config.paperclipSkillSync as Record<string, unknown>) }
      : {};
  const current = Array.isArray(sync.desiredSkills)
    ? [...(sync.desiredSkills as string[])]
    : [];
  if (!current.includes(skill.key)) {
    current.push(skill.key);
  }
  sync.desiredSkills = current;
  config.paperclipSkillSync = sync;

  await db
    .update(agents)
    .set({ adapterConfig: config, updatedAt: new Date() })
    .where(eq(agents.id, agent.id));

  synced.push({ id: agent.id, name: agent.name, desiredSkills: current });
}

console.log(
  JSON.stringify(
    {
      skill: { id: skill.id, key: skill.key, slug: skill.slug, sourceType: skill.sourceType },
      importedNow: Boolean(importResult),
      importCount: importResult?.imported?.length ?? 0,
      warnings: importResult?.warnings ?? [],
      syncedAgents: synced.map((s) => ({ name: s.name, id: s.id, hasRailwaySkill: s.desiredSkills.includes(skill.key) })),
      hermesNativePath: "/home/paperclip/.hermes/skills/railway",
      stagingDir: STAGING_DIR,
    },
    null,
    2,
  ),
);

process.exit(0);
