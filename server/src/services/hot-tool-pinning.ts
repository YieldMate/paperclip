import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { toolCallEvents, toolCatalogEntries } from "@paperclipai/db";
import {
  HOT_TOOL_REFRESH_INTERVAL_MS,
  HOT_TOOL_WINDOW_MS,
  buildPinnedToolsManifest,
  deriveHotSet,
  isHotToolPinningV1Enabled,
  isSafeOverlayAgentId,
  parsePinnedToolsManifest,
  pinnedToolsManifestPath,
  resolveOverlaysRoot,
  serializePinnedToolsManifest,
  type HotToolCount,
  type HotToolPinningLogger,
} from "@paperclipai/hermes-paperclip-adapter/server";
import { logger } from "../middleware/logger.js";

/** `call_completed` is preferred; agents with no completed calls in the window fall back to `call_started`. */
const PREFERRED_EVENT = "call_completed" as const;
const FALLBACK_EVENT = "call_started" as const;

export interface AgentToolCountRow {
  agentId: string;
  toolName: string;
  eventType: string;
  callCount: number;
  catalogEntryId: string | null;
}

export type AgentHotToolCounts = Map<string, HotToolCount[]>;

/** Per-agent counts, preferring `call_completed` rows and falling back to `call_started` for that agent only. */
export function groupToolCountsByAgent(
  rows: AgentToolCountRow[],
  schemaByCatalogEntryId: Map<string, Record<string, unknown>> = new Map(),
): AgentHotToolCounts {
  const byAgent = new Map<string, AgentToolCountRow[]>();
  for (const row of rows) {
    const list = byAgent.get(row.agentId) ?? [];
    list.push(row);
    byAgent.set(row.agentId, list);
  }
  const result: AgentHotToolCounts = new Map();
  for (const [agentId, agentRows] of byAgent) {
    const hasPreferred = agentRows.some((row) => row.eventType === PREFERRED_EVENT);
    const eventType = hasPreferred ? PREFERRED_EVENT : FALLBACK_EVENT;
    result.set(
      agentId,
      agentRows
        .filter((row) => row.eventType === eventType)
        .map((row) => ({
          toolName: row.toolName,
          callCount: row.callCount,
          schema: row.catalogEntryId ? schemaByCatalogEntryId.get(row.catalogEntryId) : undefined,
        })),
    );
  }
  return result;
}

/** Rolling-window tool call counts per agent from `tool_call_events`, with catalog schemas for token budgeting. */
export async function queryAgentToolCounts(
  db: Db,
  opts: { since: Date; agentId?: string },
): Promise<AgentHotToolCounts> {
  const latestCatalogEntryId = sql<string | null>`(array_agg(${toolCallEvents.catalogEntryId} order by ${toolCallEvents.createdAt} desc) filter (where ${toolCallEvents.catalogEntryId} is not null))[1]`;
  const callCount = sql<number>`count(*)::int`;
  const rows = await db
    .select({
      agentId: toolCallEvents.agentId,
      toolName: toolCallEvents.toolName,
      eventType: toolCallEvents.eventType,
      callCount,
      catalogEntryId: latestCatalogEntryId,
    })
    .from(toolCallEvents)
    .where(and(
      gte(toolCallEvents.createdAt, opts.since),
      inArray(toolCallEvents.eventType, [PREFERRED_EVENT, FALLBACK_EVENT]),
      isNotNull(toolCallEvents.agentId),
      isNotNull(toolCallEvents.toolName),
      ...(opts.agentId ? [eq(toolCallEvents.agentId, opts.agentId)] : []),
    ))
    .groupBy(toolCallEvents.agentId, toolCallEvents.toolName, toolCallEvents.eventType);

  const catalogIds = [...new Set(rows.map((row) => row.catalogEntryId).filter((id): id is string => !!id))];
  const schemas = new Map<string, Record<string, unknown>>();
  if (catalogIds.length > 0) {
    const entries = await db
      .select({
        id: toolCatalogEntries.id,
        toolName: toolCatalogEntries.toolName,
        description: toolCatalogEntries.description,
        inputSchema: toolCatalogEntries.inputSchema,
      })
      .from(toolCatalogEntries)
      .where(inArray(toolCatalogEntries.id, catalogIds));
    for (const entry of entries) {
      schemas.set(entry.id, {
        name: entry.toolName,
        description: entry.description ?? "",
        parameters: entry.inputSchema ?? {},
      });
    }
  }

  return groupToolCountsByAgent(
    rows.flatMap((row) => row.agentId && row.toolName ? [{
      agentId: row.agentId,
      toolName: row.toolName,
      eventType: row.eventType,
      callCount: Number(row.callCount),
      catalogEntryId: row.catalogEntryId,
    }] : []),
    schemas,
  );
}

async function manifestBody(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

function sameTools(previous: string | null, next: string): boolean {
  if (previous === null) return false;
  try {
    return JSON.stringify(parsePinnedToolsManifest(JSON.parse(previous)))
      === JSON.stringify(parsePinnedToolsManifest(JSON.parse(next)));
  } catch {
    return false;
  }
}

async function writeManifestAtomic(file: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, file);
}

export interface PinnedToolsRefreshResult {
  agents: number;
  written: number;
  unchanged: number;
  skipped: number;
}

const pinningLogger: HotToolPinningLogger = {
  warn: (message, meta) => logger.warn(meta ?? {}, message),
};

/**
 * Recompute every agent's hot set from the last 7 days of tool calls and write
 * `overlays/<agentId>/pinned-tools.json`. A manifest whose tools did not change is left untouched so the
 * committed overlay does not churn on `updatedAt`.
 */
export async function refreshPinnedToolsOverlays(opts: {
  db: Db;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  overlaysRoot?: string;
  loadCounts?: (since: Date) => Promise<AgentHotToolCounts>;
  log?: HotToolPinningLogger;
}): Promise<PinnedToolsRefreshResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const log = opts.log ?? pinningLogger;
  const root = opts.overlaysRoot ?? (await resolveOverlaysRoot(env));
  const since = new Date(now.getTime() - HOT_TOOL_WINDOW_MS);
  const counts = await (opts.loadCounts?.(since) ?? queryAgentToolCounts(opts.db, { since }));

  const result: PinnedToolsRefreshResult = { agents: counts.size, written: 0, unchanged: 0, skipped: 0 };
  for (const [agentId, toolCounts] of counts) {
    if (!isSafeOverlayAgentId(agentId)) {
      result.skipped += 1;
      continue;
    }
    const hot = deriveHotSet(toolCounts, { log });
    if (hot.tools.length === 0) {
      result.skipped += 1;
      continue;
    }
    const file = pinnedToolsManifestPath(root, agentId);
    const body = serializePinnedToolsManifest(buildPinnedToolsManifest(agentId, hot.tools, { now }));
    if (sameTools(await manifestBody(file), body)) {
      result.unchanged += 1;
      continue;
    }
    await writeManifestAtomic(file, body);
    result.written += 1;
  }
  return result;
}

export interface PinnedToolsRefreshHandle {
  tick(): Promise<PinnedToolsRefreshResult | null>;
  stop(): void;
}

let activeRefresh: { handle: PinnedToolsRefreshHandle; timer: ReturnType<typeof setInterval> } | null = null;

/**
 * Hourly hot-set refresh (same shape as the Hermes adapter's `ensureHourlyResidentSweep`): idempotent,
 * fail-open, unref'd. Nothing is scheduled while `PAPERCLIP_HOT_TOOL_PINNING_V1` is off, and each tick
 * re-checks the flag, so turning it off stops the SQL and the writes.
 */
export function ensureHourlyPinnedToolsRefresh(opts: {
  db: Db;
  env?: NodeJS.ProcessEnv;
  intervalMs?: number;
  shouldRun?: () => boolean;
  overlaysRoot?: string;
  log?: HotToolPinningLogger;
}): PinnedToolsRefreshHandle | null {
  const env = opts.env ?? process.env;
  if (!isHotToolPinningV1Enabled(env)) return null;
  if (activeRefresh) return activeRefresh.handle;

  let inFlight: Promise<PinnedToolsRefreshResult | null> | null = null;
  const tick = (): Promise<PinnedToolsRefreshResult | null> => {
    if (!isHotToolPinningV1Enabled(env) || opts.shouldRun?.() === false) return Promise.resolve(null);
    if (inFlight) return inFlight;
    inFlight = refreshPinnedToolsOverlays({
      db: opts.db,
      env,
      overlaysRoot: opts.overlaysRoot,
      log: opts.log,
    })
      .catch((err) => {
        logger.warn({ err }, "hot tool pinning refresh failed");
        return null;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  };

  const timer = setInterval(() => { void tick(); }, opts.intervalMs ?? HOT_TOOL_REFRESH_INTERVAL_MS);
  timer.unref?.();
  const handle: PinnedToolsRefreshHandle = {
    tick,
    stop() {
      clearInterval(timer);
      if (activeRefresh?.handle === handle) activeRefresh = null;
    },
  };
  activeRefresh = { handle, timer };
  void tick();
  return handle;
}
