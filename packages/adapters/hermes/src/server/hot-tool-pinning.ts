/**
 * YIE-70 hot MCP tool pinning v1 (flag-gated).
 *
 * Paperclip derives a per-agent "hot set" (top tools by completed-call count over a rolling
 * window), stores it as `overlays/<agentId>/pinned-tools.json`, and hands a run-local copy to
 * Hermes via `HERMES_PINNED_TOOLS_FILE`. Hermes (`tools/hot_tool_pinning.py`) keeps those tools out
 * of `tool_search` deferral and reports telemetry through its usage file. Everything here is inert
 * unless `PAPERCLIP_HOT_TOOL_PINNING_V1` is on.
 *
 * Manifest `name` values are Hermes registry names (`mcp__<server>__<tool>`), not gateway
 * `tool_call_events.tool_name` strings. See `toHermesRegistryToolName`.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Paperclip's single flag. Default OFF; 1/true/on/yes enables. */
export const HOT_TOOL_PINNING_V1_ENV = "PAPERCLIP_HOT_TOOL_PINNING_V1";
/** Hermes' own flag; Paperclip sets it with the Paperclip flag and clears it when off. */
export const HERMES_HOT_TOOL_PINNING_V1_ENV = "HERMES_HOT_TOOL_PINNING_V1";
export const HERMES_PINNED_TOOLS_FILE_ENV = "HERMES_PINNED_TOOLS_FILE";
/** Inline pin list Hermes also honours; cleared when the flag is off so no pin survives. */
export const HERMES_PINNED_TOOLS_ENV = "HERMES_PINNED_TOOLS";
export const PAPERCLIP_OVERLAYS_ROOT_ENV = "PAPERCLIP_OVERLAYS_ROOT";

export const PINNED_TOOLS_MANIFEST_NAME = "pinned-tools.json";
export const PINNED_TOOLS_MANIFEST_VERSION = 1;
export const MAX_PINNED_TOOLS = 10;
export const MAX_PINNED_SCHEMA_TOKENS = 10_000;
export const HOT_TOOL_WINDOW_DAYS = 7;
export const HOT_TOOL_WINDOW_MS = HOT_TOOL_WINDOW_DAYS * 24 * 60 * 60 * 1000;
export const HOT_TOOL_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Overlay server name for assigned connection tools (`buildPaperclipRuntimeMcpServers`).
 * Must stay in sync with `server/src/services/mcp-tool-names.ts` `ASSIGNED_MCP_SERVER_NAME`.
 */
export const HERMES_ASSIGNED_MCP_SERVER_SLUG = "paperclip-assigned";
/** Hermes registry prefix + 64-char clamp — mirrors `tools/mcp_tool_schema.py`. */
export const HERMES_MCP_TOOL_NAME_PREFIX = "mcp__";
export const HERMES_MCP_TOOL_NAME_MAX_LENGTH = 64;
export const HERMES_MCP_TOOL_NAME_HASH_LENGTH = 8;

/** Hermes `sanitize_mcp_name_component`: non [A-Za-z0-9_] → `_`. */
export function sanitizeHermesMcpNameComponent(value: string): string {
  return String(value || "").replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * Hermes registry/wire name for an MCP tool: `mcp__<server>__<tool>`, clamped to 64 chars with a
 * stable sha256 suffix when longer (same algorithm as Hermes `mcp_prefixed_tool_name`).
 *
 * For Paperclip assigned-gateway tools, pass the gateway `tool_call_events.tool_name` as `toolName`
 * and leave `serverSlug` at the default (`paperclip-assigned`).
 */
export function toHermesRegistryToolName(
  toolName: string,
  serverSlug: string = HERMES_ASSIGNED_MCP_SERVER_SLUG,
): string {
  const full =
    `${HERMES_MCP_TOOL_NAME_PREFIX}` +
    `${sanitizeHermesMcpNameComponent(serverSlug)}__` +
    `${sanitizeHermesMcpNameComponent(toolName)}`;
  if (full.length <= HERMES_MCP_TOOL_NAME_MAX_LENGTH) return full;
  const suffix = `_${createHash("sha256").update(full, "utf8").digest("hex").slice(0, HERMES_MCP_TOOL_NAME_HASH_LENGTH)}`;
  return full.slice(0, HERMES_MCP_TOOL_NAME_MAX_LENGTH - suffix.length) + suffix;
}

export function isHotToolPinningV1Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[HOT_TOOL_PINNING_V1_ENV]?.trim().toLowerCase();
  if (!raw) return false;
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export interface HotToolPinningLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

const consoleLogger: HotToolPinningLogger = {
  warn: (message, meta) => console.warn(`[hot-tool-pinning] ${message}`, meta ?? ""),
};

// --- schema token estimate ---------------------------------------------------------------------

function pythonJsonString(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Serialize like Python's `json.dumps` (", " / ": " separators, ASCII-escaped) so lengths match Hermes. */
export function pythonJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return pythonJsonString(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(pythonJsonDumps).join(", ")}]`;
  if (typeof value === "object") {
    const parts = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${pythonJsonString(k)}: ${pythonJsonDumps(v)}`);
    return `{${parts.join(", ")}}`;
  }
  return "null";
}

/**
 * Wire-shape token estimate for one OpenAI function schema: `{"type":"function","function":schema}`.
 * Mirrors Hermes' `estimate_schema_tokens` chars/4 fallback; Hermes re-measures with cl100k_base
 * (tiktoken) at runtime, so this is the Paperclip-side budget guard, not the authority.
 */
export function estimateSchemaTokens(schema: Record<string, unknown>): number {
  const wire = pythonJsonDumps({ type: "function", function: schema });
  return Math.ceil(wire.length / 4);
}

/** Function-schema object from either the bare or the `{type:"function", function}` wire shape. */
export function normalizeFunctionSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const record = schema as Record<string, unknown>;
  const inner = record.function;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  return record;
}

// --- hot-set derivation ------------------------------------------------------------------------

export interface HotToolCount {
  /** Gateway / event tool name (`tool_call_events.tool_name`). */
  toolName: string;
  callCount: number;
  schema?: Record<string, unknown>;
  /**
   * Hermes overlay server slug used to build the registry name. Defaults to
   * `HERMES_ASSIGNED_MCP_SERVER_SLUG`. Pass `paperclip-projects` for project-tools, etc.
   */
  hermesServerSlug?: string;
}

export interface PinnedToolEntry {
  /** Hermes registry name (`mcp__…`) — what Hermes pins against. */
  name: string;
  callCount: number;
  schema?: Record<string, unknown>;
  /** Original gateway tool name from `tool_call_events`, when known. */
  gatewayToolName?: string;
}

export interface HotSetResult {
  tools: PinnedToolEntry[];
  schemaTokens: number;
  droppedByCap: string[];
  droppedByTokens: string[];
}

export interface DeriveHotSetOptions {
  maxTools?: number;
  maxSchemaTokens?: number;
  estimateTokens?: (schema: Record<string, unknown>) => number;
  log?: HotToolPinningLogger;
}

function compareCodepoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Highest call count first; ties keep the lexicographically earlier tool name. */
export function rankHotTools<T extends { name: string; callCount: number }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => b.callCount - a.callCount || compareCodepoints(a.name, b.name));
}

/**
 * Top tools by call count, capped at `maxTools` (10), then least-used tools are dropped (and logged)
 * until the summed schema tokens fit `maxSchemaTokens` (10k). Tools without a schema count as 0.
 */
export function deriveHotSet(counts: Iterable<HotToolCount>, opts: DeriveHotSetOptions = {}): HotSetResult {
  const maxTools = opts.maxTools ?? MAX_PINNED_TOOLS;
  const maxSchemaTokens = opts.maxSchemaTokens ?? MAX_PINNED_SCHEMA_TOKENS;
  const estimate = opts.estimateTokens ?? estimateSchemaTokens;
  const log = opts.log ?? consoleLogger;

  const merged = new Map<string, PinnedToolEntry>();
  for (const row of counts) {
    const gatewayToolName = typeof row.toolName === "string" ? row.toolName.trim() : "";
    const callCount = Number(row.callCount);
    if (!gatewayToolName || !Number.isFinite(callCount) || callCount <= 0) continue;
    // Map assigned-gateway names to Hermes registry names. Covers MCP/app connection tools
    // (`mcp.<ns>:<tool>`), built-ins/plugins (`paperclip-self:get_issue_context`), and any row
    // that already carries a Hermes server slug. Leave `mcp__…` and plain fixture names alone.
    const looksLikeGateway =
      gatewayToolName.includes(":") ||
      /^(mcp|app)\./.test(gatewayToolName) ||
      row.hermesServerSlug != null;
    const name =
      gatewayToolName.startsWith(HERMES_MCP_TOOL_NAME_PREFIX) || !looksLikeGateway
        ? gatewayToolName
        : toHermesRegistryToolName(gatewayToolName, row.hermesServerSlug);
    const prev = merged.get(name);
    const schema = row.schema ? { ...row.schema, name } : undefined;
    if (prev) {
      prev.callCount += callCount;
      prev.schema ??= schema;
      prev.gatewayToolName ??= gatewayToolName === name ? undefined : gatewayToolName;
    } else {
      merged.set(name, {
        name,
        callCount,
        ...(schema ? { schema } : {}),
        ...(gatewayToolName !== name ? { gatewayToolName } : {}),
      });
    }
  }

  const ranked = rankHotTools([...merged.values()]);
  const droppedByCap = ranked.slice(maxTools).map((entry) => entry.name);
  const kept = ranked.slice(0, maxTools);
  if (droppedByCap.length > 0) {
    log.warn("hot set exceeds tool cap; dropping least-used tools", { maxTools, dropped: droppedByCap });
  }

  const tokensByName = new Map<string, number>();
  for (const entry of kept) {
    tokensByName.set(entry.name, entry.schema ? estimate(entry.schema) : 0);
  }
  let schemaTokens = [...tokensByName.values()].reduce((sum, n) => sum + n, 0);
  const droppedByTokens: string[] = [];
  while (kept.length > 0 && schemaTokens > maxSchemaTokens) {
    const dropped = kept.pop()!;
    schemaTokens -= tokensByName.get(dropped.name) ?? 0;
    droppedByTokens.push(dropped.name);
    log.warn("pinned schemas exceed token cap; dropped least-used tool", {
      maxSchemaTokens,
      dropped: dropped.name,
      callCount: dropped.callCount,
    });
  }

  return { tools: kept, schemaTokens, droppedByCap, droppedByTokens };
}

// --- overlay manifests -------------------------------------------------------------------------

export interface PinnedToolsManifest {
  version: number;
  agentId?: string;
  updatedAt?: string;
  window?: { days: number; eventType: string };
  tools: PinnedToolEntry[];
}

const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeOverlayAgentId(agentId: string): boolean {
  return SAFE_AGENT_ID.test(agentId) && !agentId.includes("..");
}

/** `PAPERCLIP_OVERLAYS_ROOT`, else the repo-relative `overlays/` (nearest ancestor with pnpm-workspace.yaml). */
export async function resolveOverlaysRoot(
  env: NodeJS.ProcessEnv = process.env,
  startDir: string = process.cwd(),
): Promise<string> {
  const configured = env[PAPERCLIP_OVERLAYS_ROOT_ENV]?.trim();
  if (configured) return path.resolve(configured);
  let dir = path.resolve(startDir);
  for (;;) {
    try {
      await fs.access(path.join(dir, "pnpm-workspace.yaml"));
      return path.join(dir, "overlays");
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return path.join(path.resolve(startDir), "overlays");
      dir = parent;
    }
  }
}

export function pinnedToolsManifestPath(overlaysRoot: string, agentId: string): string {
  if (!isSafeOverlayAgentId(agentId)) {
    throw new Error(`unsafe overlay agent id: ${JSON.stringify(agentId)}`);
  }
  return path.join(overlaysRoot, agentId, PINNED_TOOLS_MANIFEST_NAME);
}

/** Entries from a manifest object or bare list of names/objects; malformed entries are skipped. */
export function parsePinnedToolsManifest(raw: unknown): PinnedToolEntry[] {
  const items = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { tools?: unknown }).tools)
      ? (raw as { tools: unknown[] }).tools
      : [];
  const entries: PinnedToolEntry[] = [];
  for (const item of items) {
    const record = typeof item === "string" ? { name: item } : item;
    if (!record || typeof record !== "object") continue;
    const { name, callCount, schema, gatewayToolName } = record as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim()) continue;
    const count = Number(callCount);
    const fn = normalizeFunctionSchema(schema);
    const gateway =
      typeof gatewayToolName === "string" && gatewayToolName.trim()
        ? gatewayToolName.trim()
        : undefined;
    entries.push({
      name: name.trim(),
      callCount: Number.isFinite(count) && count > 0 ? count : 0,
      ...(fn ? { schema: fn } : {}),
      ...(gateway ? { gatewayToolName: gateway } : {}),
    });
  }
  return entries;
}

export function buildPinnedToolsManifest(
  agentId: string,
  tools: PinnedToolEntry[],
  opts: { now?: Date; eventType?: string } = {},
): PinnedToolsManifest {
  return {
    version: PINNED_TOOLS_MANIFEST_VERSION,
    agentId,
    updatedAt: (opts.now ?? new Date()).toISOString(),
    window: { days: HOT_TOOL_WINDOW_DAYS, eventType: opts.eventType ?? "call_completed" },
    tools,
  };
}

export function serializePinnedToolsManifest(manifest: PinnedToolsManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Entries stored for an agent, or null when no readable manifest exists. */
export async function readPinnedToolsManifest(
  file: string,
  log: HotToolPinningLogger = consoleLogger,
): Promise<PinnedToolEntry[] | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("cannot read pinned tools manifest", { file, error: String(err) });
    }
    return null;
  }
  try {
    return parsePinnedToolsManifest(JSON.parse(text.replace(/^\uFEFF/, "")));
  } catch (err) {
    log.warn("pinned tools manifest is not valid JSON", { file, error: String(err) });
    return null;
  }
}

// --- per-run wiring ----------------------------------------------------------------------------

export const HOT_TOOL_PINNING_ENV_KEYS = [
  HOT_TOOL_PINNING_V1_ENV,
  HERMES_HOT_TOOL_PINNING_V1_ENV,
  HERMES_PINNED_TOOLS_FILE_ENV,
  HERMES_PINNED_TOOLS_ENV,
] as const;

/**
 * `runChildProcess` re-merges the host `process.env` under the run env, so a plain `delete` would let a
 * host-level `HERMES_*` pin variable leak back in. An explicit `undefined` wins the merge and is dropped
 * before spawn (Node ignores undefined env values too).
 */
function unsetEnv(env: Record<string, string>, key: string): void {
  (env as Record<string, string | undefined>)[key] = undefined;
}

export interface HotToolPinningRunState {
  enabled: boolean;
  pinnedToolsFile: string | null;
  pinnedCount: number;
  schemaTokens: number;
}

/** Stable reuse fingerprint for warm residents: cold-start when the flag or pin set changes. */
export async function hotPinningFingerprint(state: HotToolPinningRunState): Promise<string> {
  if (!state.enabled) return "off";
  if (!state.pinnedToolsFile) {
    return `on:empty:${state.pinnedCount}:${state.schemaTokens}`;
  }
  try {
    const body = await fs.readFile(state.pinnedToolsFile, "utf8");
    return `on:${createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16)}`;
  } catch {
    return `on:missing:${state.pinnedCount}:${state.schemaTokens}`;
  }
}

/**
 * Flag on: read the agent's overlay manifest, write a run-local copy into `runDir` and point the child
 * env at it. Flag off: strip every pinning variable (including ones inherited from the host or the
 * agent's configured env) so the child runs exactly as before the flag existed.
 */
export async function applyHotToolPinningEnv(
  env: Record<string, string>,
  opts: {
    enabled: boolean;
    agentId: string;
    runDir?: string;
    overlaysRoot?: string;
    log?: HotToolPinningLogger;
  },
): Promise<HotToolPinningRunState> {
  if (!opts.enabled) {
    for (const key of HOT_TOOL_PINNING_ENV_KEYS) unsetEnv(env, key);
    return { enabled: false, pinnedToolsFile: null, pinnedCount: 0, schemaTokens: 0 };
  }

  const log = opts.log ?? consoleLogger;
  env[HOT_TOOL_PINNING_V1_ENV] = "1";
  env[HERMES_HOT_TOOL_PINNING_V1_ENV] = "1";
  // Paperclip owns the pin source: clear both file and inline list so a host/config
  // HERMES_PINNED_TOOLS cannot bypass the hot-set derivation.
  unsetEnv(env, HERMES_PINNED_TOOLS_FILE_ENV);
  unsetEnv(env, HERMES_PINNED_TOOLS_ENV);

  const state: HotToolPinningRunState = {
    enabled: true,
    pinnedToolsFile: null,
    pinnedCount: 0,
    schemaTokens: 0,
  };
  if (!opts.runDir || !isSafeOverlayAgentId(opts.agentId)) return state;

  const overlaysRoot = opts.overlaysRoot ?? (await resolveOverlaysRoot(env));
  const stored = await readPinnedToolsManifest(pinnedToolsManifestPath(overlaysRoot, opts.agentId), log);
  if (!stored) return state;

  // Re-apply the caps: a hand-edited or stale manifest must not exceed them at run time.
  const hot = deriveHotSet(
    stored.map((entry) => ({ toolName: entry.name, callCount: entry.callCount, schema: entry.schema })),
    { log },
  );
  const runLocal = path.join(opts.runDir, PINNED_TOOLS_MANIFEST_NAME);
  await fs.mkdir(opts.runDir, { recursive: true, mode: 0o700 });
  await fs.rm(runLocal, { force: true });
  await fs.writeFile(
    runLocal,
    serializePinnedToolsManifest(buildPinnedToolsManifest(opts.agentId, hot.tools)),
    { mode: 0o600, flag: "wx" },
  );
  env[HERMES_PINNED_TOOLS_FILE_ENV] = runLocal;
  return { ...state, pinnedToolsFile: runLocal, pinnedCount: hot.tools.length, schemaTokens: hot.schemaTokens };
}

// --- telemetry ---------------------------------------------------------------------------------

export interface HotToolPinningUsageFields {
  tool_search_calls?: number | null;
  tool_describe_calls?: number | null;
  tool_calls_total?: number | null;
  pinned_schema_tokens?: number | null;
}

export interface HotToolPinningTelemetry {
  tool_search_calls: number | null;
  tool_describe_calls: number | null;
  tool_calls_total: number | null;
  pinned_schema_tokens: number | null;
}

function finiteCount(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * `resultJson` fields merged from the preflight + primary Hermes usage reports: call counters are
 * summed, `pinned_schema_tokens` is the largest reported. Flag off returns null so callers add no
 * keys at all; flag on with no report yields explicit nulls ("enabled, nothing reported").
 */
export function mergeHotToolPinningTelemetry(
  reports: Array<HotToolPinningUsageFields | null | undefined>,
  enabled: boolean,
): HotToolPinningTelemetry | null {
  if (!enabled) return null;
  const sum = (key: "tool_search_calls" | "tool_describe_calls" | "tool_calls_total"): number | null => {
    let total: number | null = null;
    for (const report of reports) {
      const n = finiteCount(report?.[key]);
      if (n !== null) total = (total ?? 0) + n;
    }
    return total;
  };
  let pinnedSchemaTokens: number | null = null;
  for (const report of reports) {
    const n = finiteCount(report?.pinned_schema_tokens);
    if (n !== null && (pinnedSchemaTokens === null || n > pinnedSchemaTokens)) pinnedSchemaTokens = n;
  }
  return {
    tool_search_calls: sum("tool_search_calls"),
    tool_describe_calls: sum("tool_describe_calls"),
    tool_calls_total: sum("tool_calls_total"),
    pinned_schema_tokens: pinnedSchemaTokens,
  };
}
