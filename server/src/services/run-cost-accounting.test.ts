import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, costEvents, createDb, heartbeatRuns, promptInjectionInvocations, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import {
  accountRunCost,
  createCostAccountingReconciler,
  readCostAccountingWork,
  resolveLedgerEventCostStatus,
} from "./run-cost-accounting.js";

describe("resolveLedgerEventCostStatus", () => {
  it("does not drag a priced per-model part to unpriced when the receipt is unpriced", () => {
    expect(resolveLedgerEventCostStatus({
      costUsd: 0.007886424,
      reportedStatus: "unpriced",
      billingType: "metered_api",
      hasBillableEvidence: true,
      perModel: true,
    })).toBe("reported");
  });

  it("marks a zero-cost per-model part with tokens as unpriced", () => {
    expect(resolveLedgerEventCostStatus({
      costUsd: 0,
      reportedStatus: "unpriced",
      billingType: "metered_api",
      hasBillableEvidence: true,
      perModel: true,
    })).toBe("unpriced");
  });

  it("preserves estimated for priced per-model parts", () => {
    expect(resolveLedgerEventCostStatus({
      costUsd: 0.05,
      reportedStatus: "estimated",
      billingType: "metered_api",
      hasBillableEvidence: true,
      perModel: true,
    })).toBe("estimated");
  });

  it("keeps receipt-level unpriced when cost is missing", () => {
    expect(resolveLedgerEventCostStatus({
      costUsd: null,
      reportedStatus: "unpriced",
      billingType: "metered_api",
      hasBillableEvidence: true,
    })).toBe("unpriced");
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("run cost accounting work", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let directory: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("run-cost-work-");
    db = createDb(database.connectionString);
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "run-cost-work-"));
  }, 60_000);
  afterEach(async () => { await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL client_min_messages = warning`);
    await tx.execute(sql`TRUNCATE companies CASCADE`);
  }); });
  afterAll(async () => { if (directory) await fs.rm(directory, { force: true, recursive: true }); await database?.cleanup(); });

  async function seed(change: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Accounting", issuePrefix: "ACCT" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Accounting", role: "engineer", status: "idle", adapterType: "process" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "succeeded",
      costAccountingPending: true, finishedAt: new Date(),
      usageJson: { accountingReceiptReady: true, provider: "test", model: "test", billingType: "metered_api", costUsd: 0.01 }, ...change });
    return { companyId, agentId, runId };
  }

  it("returns from settled or running calls without opening an accounting transaction", async () => {
    const { runId } = await seed({ costAccountingPending: false });
    const transaction = vi.fn(db.transaction.bind(db));
    const observed = new Proxy(db, { get(target, property) {
      if (property === "transaction") return transaction;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as Db;
    expect(await accountRunCost(observed, runId)).toBe(false);
    await db.update(heartbeatRuns).set({ status: "running", costAccountingPending: true }).where(eq(heartbeatRuns.id, runId));
    expect(await accountRunCost(observed, runId)).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("settles once without delivering cancellation in the caller", async () => {
    const { companyId, runId } = await seed();
    const cancelWorkForScope = vi.fn(async () => { throw new Error("Cancellation must be asynchronous"); });
    expect(await accountRunCost(db, runId, { cancelWorkForScope })).toBe(true);
    expect(await accountRunCost(db, runId, { cancelWorkForScope })).toBe(false);
    const events = await db.select().from(costEvents).where(and(eq(costEvents.companyId, companyId), eq(costEvents.heartbeatRunId, runId)));
    expect(events).toHaveLength(1);
    expect(events[0].costCents).toBe(1);
    expect(cancelWorkForScope).not.toHaveBeenCalled();
    expect(await readCostAccountingWork(db, Date.now(), directory)).toEqual({ pending: false, nextRunAt: null });
  });

  it("repairs a stale pending marker without creating another charge", async () => {
    const { runId } = await seed({ costAccountedAt: new Date(), usageJson: { accountingReceiptReady: false } });
    expect((await readCostAccountingWork(db, Date.now(), directory)).pending).toBe(true);
    expect(await accountRunCost(db, runId)).toBe(false);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run.costAccountingPending).toBe(false);
    expect(await db.select().from(costEvents)).toHaveLength(0);
  });

  it("waits for a missing final receipt without scheduling unchanged debt", async () => {
    const { runId } = await seed({ usageJson: { accountingReceiptReady: false, inputTokens: 5 } });
    expect(await readCostAccountingWork(db, Date.now(), directory)).toEqual({ pending: false, nextRunAt: null });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run.costAccountingPending).toBe(true);
    await db.update(heartbeatRuns).set({ usageJson: { accountingReceiptReady: true, costUsd: 0.01 } }).where(eq(heartbeatRuns.id, runId));
    expect((await readCostAccountingWork(db, Date.now(), directory)).pending).toBe(true);
  });

  it("reconstructs the actual interrupted-service deadline and disarms after settlement", async () => {
    const { companyId } = await seed({ costAccountingPending: false });
    const startedAt = new Date();
    const [invocation] = await db.insert(promptInjectionInvocations).values({ companyId, source: "settings_test", actorType: "user", actorId: "test",
      connectionId: randomUUID(), grantId: randomUUID(), policyVersion: "tool-result-v1", model: "openai/gpt-oss-safeguard-20b", startedAt }).returning();
    const work = await readCostAccountingWork(db, startedAt.getTime(), directory);
    expect(work).toEqual({ pending: false, nextRunAt: startedAt.getTime() + 120_001 });
    expect((await readCostAccountingWork(db, startedAt.getTime() + 120_001, directory)).pending).toBe(true);
    await db.update(promptInjectionInvocations).set({ status: "unknown" }).where(eq(promptInjectionInvocations.id, invocation.id));
    expect(await readCostAccountingWork(db, startedAt.getTime() + 120_001, directory)).toEqual({ pending: false, nextRunAt: null });
  });

  it("assigns per-model costStatus so priced parts stay reported when a sibling is unpriced", async () => {
    const previous = process.env.PAPERCLIP_PERF_TELEMETRY;
    delete process.env.PAPERCLIP_PERF_TELEMETRY;
    try {
      const { companyId, runId } = await seed({
        usageJson: {
          accountingReceiptReady: true,
          provider: "openrouter",
          model: "z-ai/glm-5.3",
          billingType: "metered_api",
          costStatus: "unpriced",
          inputTokens: 100,
          cachedInputTokens: 0,
          outputTokens: 20,
          costUsd: 0.01,
          usageByModel: [
            {
              model: "z-ai/glm-5.3",
              usage: { inputTokens: 40, cachedInputTokens: 0, outputTokens: 10 },
              costUsd: 0.01,
            },
            {
              model: "deepseek/deepseek-v3.2-20251201",
              usage: { inputTokens: 60, cachedInputTokens: 0, outputTokens: 10 },
              costUsd: 0,
            },
          ],
        },
      });
      expect(await accountRunCost(db, runId)).toBe(true);
      const events = await db.select().from(costEvents)
        .where(and(eq(costEvents.companyId, companyId), eq(costEvents.heartbeatRunId, runId)));
      expect(events).toHaveLength(2);
      const byModel = Object.fromEntries(events.map((e) => [e.model, e.costStatus]));
      expect(byModel["z-ai/glm-5.3"]).toBe("reported");
      expect(byModel["deepseek/deepseek-v3.2-20251201"]).toBe("unpriced");
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_PERF_TELEMETRY;
      else process.env.PAPERCLIP_PERF_TELEMETRY = previous;
    }
  });

  it("shares service and run recovery across overlapping signals", async () => {
    let release!: () => void;
    const recover = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const reconcile = createCostAccountingReconciler(db, {}, recover);
    const first = reconcile(), second = reconcile();
    expect(first).toBe(second);
    expect(recover).toHaveBeenCalledOnce();
    release();
    await first;
    expect(recover).toHaveBeenCalledOnce();
  });

  it("recovers run receipts even when an unrelated service invocation cannot settle", async () => {
    const { runId } = await seed();
    const reconcile = createCostAccountingReconciler(db, {}, async () => { throw new Error("Unrelated service receipt failed"); });
    await expect(reconcile()).rejects.toThrow("Unrelated service receipt failed");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run.costAccountedAt).not.toBeNull();
    expect(run.costAccountingPending).toBe(false);
    expect(await db.select().from(costEvents)).toHaveLength(1);
  });
});
