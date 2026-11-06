import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  toolApplications,
  toolCallEvents,
  toolCatalogEntries,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import {
  ensureHourlyPinnedToolsRefresh,
  groupToolCountsByAgent,
  queryAgentToolCounts,
  refreshPinnedToolsOverlays,
  type AgentHotToolCounts,
} from "./hot-tool-pinning.js";

const silent = { warn: vi.fn() };
const FLAG = "PAPERCLIP_HOT_TOOL_PINNING_V1";

describe("groupToolCountsByAgent", () => {
  it("prefers call_completed per agent and falls back to call_started only for agents without completions", () => {
    const grouped = groupToolCountsByAgent([
      { agentId: "a1", toolName: "x", eventType: "call_completed", callCount: 3, catalogEntryId: null },
      { agentId: "a1", toolName: "y", eventType: "call_started", callCount: 99, catalogEntryId: null },
      { agentId: "a2", toolName: "z", eventType: "call_started", callCount: 5, catalogEntryId: null },
    ]);
    expect(grouped.get("a1")).toEqual([{ toolName: "x", callCount: 3, schema: undefined }]);
    expect(grouped.get("a2")).toEqual([{ toolName: "z", callCount: 5, schema: undefined }]);
  });

  it("attaches the catalog schema for the entry id", () => {
    const schema = { name: "x", description: "", parameters: {} };
    const grouped = groupToolCountsByAgent(
      [{ agentId: "a1", toolName: "x", eventType: "call_completed", callCount: 1, catalogEntryId: "c1" }],
      new Map([["c1", schema]]),
    );
    expect(grouped.get("a1")?.[0].schema).toBe(schema);
  });
});

describe("refreshPinnedToolsOverlays", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hot-pin-refresh-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const db = {} as Db;
  const now = new Date("2026-11-06T12:00:00.000Z");

  function loader(counts: AgentHotToolCounts) {
    const calls: Date[] = [];
    return { calls, loadCounts: async (since: Date) => { calls.push(since); return counts; } };
  }

  it("queries a rolling 7d window and writes overlays/<agentId>/pinned-tools.json (top 10, tie-break by name)", async () => {
    const tools = Array.from({ length: 12 }, (_, i) => ({ toolName: `tool_${String(i).padStart(2, "0")}`, callCount: 5 }));
    const { calls, loadCounts } = loader(new Map([["agent-1", tools]]));
    const result = await refreshPinnedToolsOverlays({ db, now, overlaysRoot: root, loadCounts, log: silent });

    expect(calls[0].toISOString()).toBe("2026-10-30T12:00:00.000Z");
    expect(result).toEqual({ agents: 1, written: 1, unchanged: 0, skipped: 0, pruned: 0 });
    const manifest = JSON.parse(await fs.readFile(path.join(root, "agent-1", "pinned-tools.json"), "utf8"));
    expect(manifest.version).toBe(1);
    expect(manifest.updatedAt).toBe(now.toISOString());
    expect(manifest.window).toEqual({ days: 7, eventType: "call_completed" });
    expect(manifest.tools.map((t: { name: string }) => t.name)).toEqual(
      Array.from({ length: 10 }, (_, i) => `tool_${String(i).padStart(2, "0")}`),
    );
  });

  it("leaves an unchanged manifest untouched (no updatedAt churn) and rewrites a changed one", async () => {
    const counts: AgentHotToolCounts = new Map([["agent-1", [{ toolName: "a", callCount: 2 }]]]);
    await refreshPinnedToolsOverlays({ db, now, overlaysRoot: root, loadCounts: async () => counts, log: silent });
    const file = path.join(root, "agent-1", "pinned-tools.json");
    const first = await fs.readFile(file, "utf8");

    const later = new Date(now.getTime() + 3_600_000);
    const same = await refreshPinnedToolsOverlays({ db, now: later, overlaysRoot: root, loadCounts: async () => counts, log: silent });
    expect(same).toMatchObject({ written: 0, unchanged: 1 });
    expect(await fs.readFile(file, "utf8")).toBe(first);

    counts.set("agent-1", [{ toolName: "a", callCount: 3 }]);
    const changed = await refreshPinnedToolsOverlays({ db, now: later, overlaysRoot: root, loadCounts: async () => counts, log: silent });
    expect(changed).toMatchObject({ written: 1 });
    expect(JSON.parse(await fs.readFile(file, "utf8")).updatedAt).toBe(later.toISOString());
  });

  it("skips agents with no usable tools and ids that are unsafe as folder names", async () => {
    const counts: AgentHotToolCounts = new Map([
      ["empty-agent", [{ toolName: "a", callCount: 0 }]],
      ["../escape", [{ toolName: "a", callCount: 4 }]],
    ]);
    const result = await refreshPinnedToolsOverlays({ db, now, overlaysRoot: root, loadCounts: async () => counts, log: silent });
    expect(result).toEqual({ agents: 2, written: 0, unchanged: 0, skipped: 2, pruned: 0 });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("prunes stale overlays for agents that left the rolling window or have an empty hot set", async () => {
    const staleFile = path.join(root, "stale-agent", "pinned-tools.json");
    const emptyFile = path.join(root, "empty-hot", "pinned-tools.json");
    await fs.mkdir(path.dirname(staleFile), { recursive: true });
    await fs.mkdir(path.dirname(emptyFile), { recursive: true });
    await fs.writeFile(staleFile, JSON.stringify({ version: 1, tools: [{ name: "old", callCount: 1 }] }));
    await fs.writeFile(emptyFile, JSON.stringify({ version: 1, tools: [{ name: "gone", callCount: 1 }] }));
    await fs.mkdir(path.join(root, "_example"), { recursive: true });
    await fs.writeFile(
      path.join(root, "_example", "pinned-tools.json"),
      JSON.stringify({ version: 1, tools: [{ name: "keep", callCount: 1 }] }),
    );

    const counts: AgentHotToolCounts = new Map([
      ["empty-hot", [{ toolName: "a", callCount: 0 }]],
      ["fresh-agent", [{ toolName: "mcp.linear:get_issue", callCount: 4 }]],
    ]);
    const result = await refreshPinnedToolsOverlays({
      db,
      now,
      overlaysRoot: root,
      loadCounts: async () => counts,
      log: silent,
    });
    expect(result.pruned).toBeGreaterThanOrEqual(2);
    expect(result.written).toBe(1);
    await expect(fs.access(staleFile)).rejects.toThrow();
    await expect(fs.access(emptyFile)).rejects.toThrow();
    await expect(fs.access(path.join(root, "_example", "pinned-tools.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, "fresh-agent", "pinned-tools.json"))).resolves.toBeUndefined();
  });
});

describe("ensureHourlyPinnedToolsRefresh", () => {
  const saved = process.env[FLAG];
  afterEach(() => {
    vi.useRealTimers();
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  });

  it("schedules nothing while the flag is off", () => {
    vi.useFakeTimers();
    expect(ensureHourlyPinnedToolsRefresh({ db: {} as Db, env: {} })).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flag on: one idempotent hourly timer; stop() clears it", () => {
    vi.useFakeTimers();
    const env = { [FLAG]: "1" };
    const handle = ensureHourlyPinnedToolsRefresh({ db: {} as Db, env, shouldRun: () => false });
    expect(handle).not.toBeNull();
    expect(ensureHourlyPinnedToolsRefresh({ db: {} as Db, env })).toBe(handle);
    expect(vi.getTimerCount()).toBe(1);
    handle!.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a tick after the flag is turned off does no work", async () => {
    const env: Record<string, string> = { [FLAG]: "1" };
    const handle = ensureHourlyPinnedToolsRefresh({ db: {} as Db, env, shouldRun: () => false })!;
    delete env[FLAG];
    expect(await handle.tick()).toBeNull();
    handle.stop();
  });
});

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("queryAgentToolCounts (PostgreSQL)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("hot-tool-pinning-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it("counts call_completed per agent/tool inside the window, ignores other agents/events/old rows, and joins the catalog schema", async () => {
    const companyId = randomUUID();
    const agentA = randomUUID();
    const agentB = randomUUID();
    const connectionId = randomUUID();
    const catalogId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pin co", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values([
      { id: agentA, companyId, name: "A", adapterType: "process", status: "active" },
      { id: agentB, companyId, name: "B", adapterType: "process", status: "active" },
    ]);
    const [application] = await db.insert(toolApplications).values({
      companyId, name: "Pin app", type: "mcp_http",
    }).returning();
    await db.insert(toolConnections).values({
      id: connectionId, companyId, applicationId: application.id, name: "Pin connection", uid: "pin-connection",
      transport: "mcp_remote",
    });
    await db.insert(toolCatalogEntries).values({
      id: catalogId, companyId, applicationId: application.id, connectionId, name: "get_issue", toolName: "get_issue",
      description: "Fetch an issue.", inputSchema: { type: "object", properties: { id: { type: "string" } } },
      versionHash: "v1",
    });

    const now = Date.now();
    const day = 86_400_000;
    const event = (agentId: string, toolName: string, eventType: string, ageDays: number, catalogEntryId?: string) => ({
      companyId, agentId, toolName, eventType, catalogEntryId: catalogEntryId ?? null,
      createdAt: new Date(now - ageDays * day),
    }) as typeof toolCallEvents.$inferInsert;
    await db.insert(toolCallEvents).values([
      event(agentA, "get_issue", "call_completed", 1, catalogId),
      event(agentA, "get_issue", "call_completed", 2, catalogId),
      event(agentA, "get_issue", "call_started", 1),
      event(agentA, "save_comment", "call_completed", 3),
      event(agentA, "old_tool", "call_completed", 9),
      event(agentA, "failed_tool", "call_failed", 1),
      event(agentB, "only_started", "call_started", 1),
    ]);

    const grouped = await queryAgentToolCounts(db, { since: new Date(now - 7 * day) });
    const a = grouped.get(agentA)!;
    expect(a.map((r) => [r.toolName, r.callCount]).sort()).toEqual([["get_issue", 2], ["save_comment", 1]]);
    expect(a.find((r) => r.toolName === "get_issue")?.schema).toEqual({
      name: "get_issue",
      description: "Fetch an issue.",
      parameters: { type: "object", properties: { id: { type: "string" } } },
    });
    expect(grouped.get(agentB)).toEqual([{ toolName: "only_started", callCount: 1, schema: undefined }]);
  }, 30_000);
});
