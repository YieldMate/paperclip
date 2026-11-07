/**
 * YIE-74 config drift tidy (flag-gated).
 *
 * When `PAPERCLIP_CONFIG_TIDY_V1` is on:
 * - Strip dead instance-config adapter defaults and `database.embeddedPostgresPort`
 *   when an external `database.connectionString` is set.
 * - Migrate per-agent `smartModelRouting.*` dotted keys → nested object
 *   (partial keys preserved; Soren cheapModel-only stays without `enabled`).
 * - Set Atlas `timeoutSec: 0` → 20000 (fleet default).
 *
 * Flag off restores from the sibling backup file. Embedded-postgres code paths
 * for local/CLI/tests stay intact (OSS load-bearing).
 */

import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { resolvePaperclipConfigPath } from "../paths.js";

/** Env flag. Default OFF; set 1/true/on/yes to enable. */
export const CONFIG_TIDY_V1_ENV = "PAPERCLIP_CONFIG_TIDY_V1";
/** Steve r2 short name (also accepted). */
export const CONFIG_TIDY_V1_ALIAS_ENV = "CONFIG_TIDY_V1";

export const DEAD_ADAPTER_TYPE = "custom_llm_local";
export const DEAD_ADAPTER_MODEL = "nous-hermes-3-llama-3-70b";
export const DEAD_EMBEDDED_POSTGRES_PORT = 54329;
export const ATLAS_AGENT_NAME = "Atlas";
export const ATLAS_FLEET_TIMEOUT_SEC = 20_000;
export const AUDITOR_TIMEOUT_SEC = 8_000;

export const SMART_MODEL_ROUTING_NESTED_KEY = "smartModelRouting";
export const SMART_MODEL_ROUTING_FIELD_KEYS = [
  "enabled",
  "cheapModel",
  "maxPreflightTurns",
  "maxCheapInputTokens",
  "perTurn",
  "separatePreflight",
] as const;

export type SmartModelRoutingFieldKey = (typeof SMART_MODEL_ROUTING_FIELD_KEYS)[number];

export const CONFIG_TIDY_BACKUP_BASENAME = "config.tidy-v1.backup.json";
export const CONFIG_TIDY_BACKUP_VERSION = 1 as const;

export function isConfigTidyV1Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[CONFIG_TIDY_V1_ENV] ?? env[CONFIG_TIDY_V1_ALIAS_ENV])?.trim().toLowerCase();
  if (!raw) return false;
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export function resolveConfigTidyBackupPath(configPath: string): string {
  return path.join(path.dirname(path.resolve(configPath)), CONFIG_TIDY_BACKUP_BASENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

function dottedSmartKey(field: SmartModelRoutingFieldKey): string {
  return `${SMART_MODEL_ROUTING_NESTED_KEY}.${field}`;
}

/** True when instance config points at external Postgres (operator live path). */
export function hasExternalDatabaseConnection(config: Record<string, unknown>): boolean {
  const database = isRecord(config.database) ? config.database : null;
  if (!database) return false;
  if (typeof database.connectionString === "string" && database.connectionString.trim().length > 0) {
    return true;
  }
  return database.mode === "postgres";
}

export interface InstanceConfigTidyResult {
  next: Record<string, unknown>;
  removed: Record<string, unknown>;
  changed: boolean;
}

/**
 * Strip dead operator-facing keys from a raw instance config.json object.
 * Does not re-run zod defaults (so `embeddedPostgresPort` can stay absent).
 */
export function tidyInstanceConfig(raw: Record<string, unknown>): InstanceConfigTidyResult {
  const next = cloneRecord(raw);
  const removed: Record<string, unknown> = {};

  if (next.adapterType === DEAD_ADAPTER_TYPE) {
    removed.adapterType = next.adapterType;
    delete next.adapterType;
  }
  if (next.model === DEAD_ADAPTER_MODEL) {
    removed.model = next.model;
    delete next.model;
  }

  if (isRecord(next.llm)) {
    const llmRemoved: Record<string, unknown> = {};
    if (next.llm.adapterType === DEAD_ADAPTER_TYPE) {
      llmRemoved.adapterType = next.llm.adapterType;
      delete next.llm.adapterType;
    }
    if (next.llm.model === DEAD_ADAPTER_MODEL) {
      llmRemoved.model = next.llm.model;
      delete next.llm.model;
    }
    if (Object.keys(llmRemoved).length > 0) {
      removed.llm = llmRemoved;
    }
  }

  if (hasExternalDatabaseConnection(next) && isRecord(next.database)) {
    if (Object.prototype.hasOwnProperty.call(next.database, "embeddedPostgresPort")) {
      removed.database = {
        ...(isRecord(removed.database) ? removed.database : {}),
        embeddedPostgresPort: next.database.embeddedPostgresPort,
      };
      delete next.database.embeddedPostgresPort;
    }
  }

  return { next, removed, changed: Object.keys(removed).length > 0 };
}

export type SmartModelRoutingShape = "dotted" | "nested" | "mixed" | "absent";

export interface SmartModelRoutingMigrationResult {
  next: Record<string, unknown>;
  beforeShape: SmartModelRoutingShape;
  afterShape: SmartModelRoutingShape;
  nested: Record<string, unknown> | null;
  changed: boolean;
}

function collectDottedSmartFields(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of SMART_MODEL_ROUTING_FIELD_KEYS) {
    const key = dottedSmartKey(field);
    if (Object.prototype.hasOwnProperty.call(config, key)) {
      out[field] = config[key];
    }
  }
  return out;
}

function detectSmartShape(config: Record<string, unknown>): "dotted" | "nested" | "mixed" | "absent" {
  const dotted = collectDottedSmartFields(config);
  const hasDotted = Object.keys(dotted).length > 0;
  const hasNested = isRecord(config[SMART_MODEL_ROUTING_NESTED_KEY]);
  if (hasDotted && hasNested) return "mixed";
  if (hasNested) return "nested";
  if (hasDotted) return "dotted";
  return "absent";
}

/**
 * Cutover: dotted (and mixed) → nested. Absent keys stay absent (Soren).
 * Idempotent when already nested-only.
 */
export function migrateSmartModelRoutingToNested(
  adapterConfig: Record<string, unknown>,
): SmartModelRoutingMigrationResult {
  const next = cloneRecord(adapterConfig);
  const beforeShape = detectSmartShape(adapterConfig);
  const dotted = collectDottedSmartFields(next);
  const existingNested = isRecord(next[SMART_MODEL_ROUTING_NESTED_KEY])
    ? { ...(next[SMART_MODEL_ROUTING_NESTED_KEY] as Record<string, unknown>) }
    : {};

  // Nested wins on conflict; dotted fills gaps. Never invent missing keys.
  const nested: Record<string, unknown> = { ...dotted, ...existingNested };

  for (const field of SMART_MODEL_ROUTING_FIELD_KEYS) {
    delete next[dottedSmartKey(field)];
  }

  if (Object.keys(nested).length === 0) {
    delete next[SMART_MODEL_ROUTING_NESTED_KEY];
    return {
      next,
      beforeShape,
      afterShape: "absent",
      nested: null,
      changed: beforeShape !== "absent",
    };
  }

  next[SMART_MODEL_ROUTING_NESTED_KEY] = nested;
  const afterShape = "nested" as const;
  const changed =
    beforeShape !== "nested" ||
    JSON.stringify(existingNested) !== JSON.stringify(nested) ||
    Object.keys(dotted).length > 0;
  return { next, beforeShape, afterShape, nested, changed };
}

/** Rollback: nested → dotted, preserving exact present keys only. */
export function demoteSmartModelRoutingToDotted(
  adapterConfig: Record<string, unknown>,
): SmartModelRoutingMigrationResult {
  const next = cloneRecord(adapterConfig);
  const beforeShape = detectSmartShape(adapterConfig);
  const nested = isRecord(next[SMART_MODEL_ROUTING_NESTED_KEY])
    ? { ...(next[SMART_MODEL_ROUTING_NESTED_KEY] as Record<string, unknown>) }
    : {};

  delete next[SMART_MODEL_ROUTING_NESTED_KEY];
  for (const field of SMART_MODEL_ROUTING_FIELD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(nested, field)) {
      next[dottedSmartKey(field)] = nested[field];
    }
  }

  const afterShape = detectSmartShape(next);
  return {
    next,
    beforeShape,
    afterShape,
    nested: Object.keys(nested).length > 0 ? nested : null,
    changed: beforeShape === "nested" || beforeShape === "mixed",
  };
}

/**
 * Read helper used during migration: nested wins, else dotted.
 * Does not invent defaults for absent keys (Soren: enabled stays undefined).
 */
export function readSmartModelRoutingFields(
  config: Record<string, unknown>,
): Partial<Record<SmartModelRoutingFieldKey, unknown>> {
  const nested = isRecord(config[SMART_MODEL_ROUTING_NESTED_KEY])
    ? (config[SMART_MODEL_ROUTING_NESTED_KEY] as Record<string, unknown>)
    : null;
  const out: Partial<Record<SmartModelRoutingFieldKey, unknown>> = {};
  for (const field of SMART_MODEL_ROUTING_FIELD_KEYS) {
    if (nested && Object.prototype.hasOwnProperty.call(nested, field)) {
      out[field] = nested[field];
      continue;
    }
    const dotted = dottedSmartKey(field);
    if (Object.prototype.hasOwnProperty.call(config, dotted)) {
      out[field] = config[dotted];
    }
  }
  return out;
}

export interface AtlasTimeoutResult {
  next: Record<string, unknown>;
  changed: boolean;
  previousTimeoutSec: unknown;
}

export function applyAtlasFleetTimeout(
  agentName: string,
  adapterConfig: Record<string, unknown>,
): AtlasTimeoutResult {
  const next = cloneRecord(adapterConfig);
  if (agentName !== ATLAS_AGENT_NAME) {
    return { next, changed: false, previousTimeoutSec: next.timeoutSec };
  }
  const previousTimeoutSec = next.timeoutSec;
  if (previousTimeoutSec === 0 || previousTimeoutSec === "0") {
    next.timeoutSec = ATLAS_FLEET_TIMEOUT_SEC;
    return { next, changed: true, previousTimeoutSec };
  }
  return { next, changed: false, previousTimeoutSec };
}

/** Operator-facing dump string used by CI grep assertions. */
export function serializeOperatorConfigDump(config: Record<string, unknown>): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function operatorDumpHasForbiddenRefs(dump: string): {
  custom_llm_local: boolean;
  nousHermes: boolean;
  port54329: boolean;
} {
  return {
    custom_llm_local: dump.includes(DEAD_ADAPTER_TYPE),
    nousHermes: dump.includes(DEAD_ADAPTER_MODEL),
    port54329: dump.includes(String(DEAD_EMBEDDED_POSTGRES_PORT)),
  };
}

export interface ConfigTidyAgentBackup {
  id: string;
  name: string;
  adapterConfig: Record<string, unknown>;
}

export interface ConfigTidyBackup {
  version: typeof CONFIG_TIDY_BACKUP_VERSION;
  createdAt: string;
  instanceConfigPath: string;
  /** Raw pre-tidy instance config (full file). */
  instanceConfigBefore: Record<string, unknown> | null;
  agents: ConfigTidyAgentBackup[];
}

export interface ConfigTidyApplyResult {
  enabled: boolean;
  instanceChanged: boolean;
  agentsChanged: number;
  agentsScanned: number;
  terminatedTolerated: number;
  backupPath: string | null;
  operatorDump: string | null;
}

export interface ConfigTidyLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

const silentLogger: ConfigTidyLogger = {
  info() {},
  warn() {},
};

export async function applyConfigTidyV1(input: {
  db: Db;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  logger?: ConfigTidyLogger;
}): Promise<ConfigTidyApplyResult> {
  const env = input.env ?? process.env;
  const logger = input.logger ?? silentLogger;
  const configPath = path.resolve(input.configPath ?? resolvePaperclipConfigPath());
  const backupPath = resolveConfigTidyBackupPath(configPath);

  if (!isConfigTidyV1Enabled(env)) {
    return {
      enabled: false,
      instanceChanged: false,
      agentsChanged: 0,
      agentsScanned: 0,
      terminatedTolerated: 0,
      backupPath: null,
      operatorDump: null,
    };
  }

  let instanceConfigBefore: Record<string, unknown> | null = null;
  let instanceChanged = false;
  let operatorDump: string | null = null;

  if (fs.existsSync(configPath)) {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
    if (!isRecord(raw)) {
      throw new Error(`YIE-74 config tidy: ${configPath} is not a JSON object`);
    }
    instanceConfigBefore = cloneRecord(raw);
    const tidied = tidyInstanceConfig(raw);
    if (tidied.changed) {
      atomicWriteJson(configPath, tidied.next);
      instanceChanged = true;
    }
    operatorDump = serializeOperatorConfigDump(tidied.next);
  }

  const rows = await input.db
    .select({
      id: agents.id,
      name: agents.name,
      adapterConfig: agents.adapterConfig,
      lifecycleState: agents.lifecycleState,
      status: agents.status,
    })
    .from(agents);

  const agentBackups: ConfigTidyAgentBackup[] = [];
  let agentsChanged = 0;
  let terminatedTolerated = 0;

  for (const row of rows) {
    if (row.lifecycleState === "terminated" || row.status === "terminated") {
      terminatedTolerated += 1;
      // Still migrate terminated rows so a restore is coherent; tolerate in start checks.
    }
    const before = isRecord(row.adapterConfig) ? cloneRecord(row.adapterConfig) : {};
    let next = before;
    let changed = false;

    const routing = migrateSmartModelRoutingToNested(next);
    if (routing.changed) {
      next = routing.next;
      changed = true;
    }

    const atlas = applyAtlasFleetTimeout(row.name, next);
    if (atlas.changed) {
      next = atlas.next;
      changed = true;
    }

    if (!changed) continue;

    agentBackups.push({ id: row.id, name: row.name, adapterConfig: before });
    await input.db
      .update(agents)
      .set({ adapterConfig: next, updatedAt: new Date() })
      .where(eq(agents.id, row.id));
    agentsChanged += 1;
  }

  const backup: ConfigTidyBackup = {
    version: CONFIG_TIDY_BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    instanceConfigPath: configPath,
    instanceConfigBefore,
    agents: agentBackups,
  };
  // Always write/refresh backup while flag is on so rollback has material.
  if (instanceConfigBefore || agentBackups.length > 0 || !fs.existsSync(backupPath)) {
    atomicWriteJson(backupPath, backup);
  }

  logger.info(
    {
      instanceChanged,
      agentsChanged,
      agentsScanned: rows.length,
      terminatedTolerated,
      backupPath,
    },
    "YIE-74 config tidy v1 applied",
  );

  return {
    enabled: true,
    instanceChanged,
    agentsChanged,
    agentsScanned: rows.length,
    terminatedTolerated,
    backupPath,
    operatorDump,
  };
}

export async function rollbackConfigTidyV1(input: {
  db: Db;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  logger?: ConfigTidyLogger;
}): Promise<{ restored: boolean; agentsRestored: number; backupPath: string | null }> {
  const env = input.env ?? process.env;
  const logger = input.logger ?? silentLogger;
  if (isConfigTidyV1Enabled(env)) {
    return { restored: false, agentsRestored: 0, backupPath: null };
  }

  const configPath = path.resolve(input.configPath ?? resolvePaperclipConfigPath());
  const backupPath = resolveConfigTidyBackupPath(configPath);
  if (!fs.existsSync(backupPath)) {
    return { restored: false, agentsRestored: 0, backupPath: null };
  }

  const backup = JSON.parse(fs.readFileSync(backupPath, "utf8")) as ConfigTidyBackup;
  if (backup.version !== CONFIG_TIDY_BACKUP_VERSION) {
    throw new Error(`YIE-74 config tidy rollback: unsupported backup version ${String(backup.version)}`);
  }

  if (backup.instanceConfigBefore && isRecord(backup.instanceConfigBefore)) {
    atomicWriteJson(configPath, backup.instanceConfigBefore);
  }

  let agentsRestored = 0;
  for (const agent of backup.agents ?? []) {
    await input.db
      .update(agents)
      .set({ adapterConfig: agent.adapterConfig, updatedAt: new Date() })
      .where(eq(agents.id, agent.id));
    agentsRestored += 1;
  }

  fs.unlinkSync(backupPath);
  logger.warn({ agentsRestored, backupPath }, "YIE-74 config tidy v1 rolled back from backup");
  return { restored: true, agentsRestored, backupPath };
}

/**
 * Boot entry: apply when flag on; restore backup when flag off.
 * Safe to call every startup (idempotent apply / no-op rollback without backup).
 */
export async function runConfigTidyV1OnStartup(input: {
  db: Db;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  logger?: ConfigTidyLogger;
}): Promise<ConfigTidyApplyResult | { restored: boolean; agentsRestored: number; backupPath: string | null }> {
  if (isConfigTidyV1Enabled(input.env)) {
    return applyConfigTidyV1(input);
  }
  return rollbackConfigTidyV1(input);
}

/** Live roster names used by YIE-74 acceptance (10 ready as of 2026-11-07). */
export const YIE74_LIVE_ROSTER_READY_NAMES = [
  "Atlas",
  "Elena",
  "Corin",
  "Steve",
  "Remy",
  "Soren",
  "AUDITOR",
  "DIGGER",
  "PROSPECTOR",
  "Seth",
] as const;
