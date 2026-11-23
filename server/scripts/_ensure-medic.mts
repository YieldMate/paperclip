import { readFileSync } from "node:fs";
import { createDb } from "@paperclipai/db";
import { platformHealthService } from "../src/services/platform-health.ts";

process.env.PAPERCLIP_HOME ??= "/home/paperclip/.paperclip";
process.env.PAPERCLIP_INSTANCE_ID ??= "default";

const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID
  ?? "71e9ee98-5046-46b9-a668-adaba1f26408";
const dryRun = process.argv.includes("--dry-run");

const cfg = JSON.parse(readFileSync("/home/paperclip/.paperclip/instances/default/config.json", "utf8"));
const db = createDb(cfg.database.connectionString);
const health = platformHealthService(db);

const result = await health.ensureMedicAgent(COMPANY_ID, {
  dryRun,
  budgetMonthlyCents: 5_000,
  intervalSec: 180,
  connectorCheckIntervalSec: 3_600,
  model: "z-ai/glm-5.3",
}, "s33cQuwlQ9uPbCdoDTHZLbA6CYyoSTwa");

const agent = result.agent as Record<string, unknown> | null;
const adapterConfig = (agent?.adapterConfig ?? {}) as Record<string, unknown>;
const metadata = (agent?.metadata ?? {}) as Record<string, unknown>;
console.log(JSON.stringify({
  created: result.created,
  maxTurns: adapterConfig.maxTurnsPerRun,
  toolsets: adapterConfig.toolsets,
  connectorHealth: metadata.connectorHealth,
  connectorCheckIntervalSec: metadata.connectorCheckIntervalSec,
  promptHasDiagnose: String(adapterConfig.promptTemplate ?? "").includes("connectors/diagnose"),
  capabilities: agent?.capabilities,
}, null, 2));
process.exit(0);
