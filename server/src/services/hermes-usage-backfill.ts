import { createHash } from "node:crypto";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, costEvents, heartbeatRuns } from "@paperclipai/db";
import { normalizeCents, usdToCents } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { createCostEventInTransaction } from "./costs.js";
import { withAccountingTransaction } from "./accounting-transaction.js";

export interface HermesSessionUsageRow {
  sessionId: string;
  model: string;
  billingProvider?: string | null;
  billingBaseUrl?: string | null;
  task?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  estimatedCostUsd?: number | null;
  costStatus?: string | null;
  /** Unix seconds or ISO string from Hermes first_seen / last_seen. */
  occurredAt: string | number;
}

export interface HermesUsageBackfillInput {
  agentId: string;
  from: string;
  to: string;
  dryRun?: boolean;
  rows: HermesSessionUsageRow[];
}

export interface HermesUsageBackfillProposal {
  idempotencyKey: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costCents: string;
  costStatus: "estimated" | "unpriced";
  occurredAt: string;
  skipReason?: string;
}

function parseOccurredAt(raw: string | number): Date {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Hermes stores unix seconds (float) in first_seen / last_seen.
    const ms = raw > 1e12 ? raw : raw * 1000;
    return new Date(ms);
  }
  const date = new Date(String(raw));
  if (Number.isNaN(date.getTime())) throw unprocessable(`Invalid occurredAt: ${raw}`);
  return date;
}

function clampTokens(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), 2_147_483_647);
}

function rowIdempotencyKey(row: HermesSessionUsageRow, day: string): string {
  const digest = createHash("sha256")
    .update([
      row.sessionId,
      row.model,
      row.billingProvider ?? "",
      row.task ?? "",
      day,
      String(clampTokens(row.inputTokens)),
      String(clampTokens(row.outputTokens)),
      String(clampTokens(row.cacheReadTokens ?? 0)),
    ].join("\0"))
    .digest("hex")
    .slice(0, 24);
  return `hermes-backfill:session:${digest}`;
}

function proposeRow(row: HermesSessionUsageRow, from: Date, to: Date): HermesUsageBackfillProposal | null {
  const occurredAt = parseOccurredAt(row.occurredAt);
  if (occurredAt < from || occurredAt > to) return null;
  const inputTokens = clampTokens(row.inputTokens);
  const outputTokens = clampTokens(row.outputTokens);
  const cachedInputTokens = clampTokens(row.cacheReadTokens ?? 0);
  if (inputTokens + outputTokens + cachedInputTokens <= 0) return null;
  const model = (row.model || "").trim() || "unknown";
  const day = occurredAt.toISOString().slice(0, 10);
  const estimated = typeof row.estimatedCostUsd === "number" && Number.isFinite(row.estimatedCostUsd)
    ? row.estimatedCostUsd
    : null;
  const hasPrice = estimated !== null && estimated > 0;
  return {
    idempotencyKey: rowIdempotencyKey(row, day),
    sessionId: row.sessionId,
    model,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    costCents: hasPrice ? usdToCents(estimated) : "0.0000000",
    costStatus: hasPrice ? "estimated" : "unpriced",
    occurredAt: occurredAt.toISOString(),
  };
}

export async function planHermesUsageBackfill(
  db: Db,
  companyId: string,
  input: HermesUsageBackfillInput,
): Promise<{ proposals: HermesUsageBackfillProposal[]; wouldInsert: number; wouldSkip: number }> {
  const [agent] = await db.select({ id: agents.id, adapterType: agents.adapterType })
    .from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, companyId)));
  if (!agent) throw notFound("Agent not found");
  if (agent.adapterType !== "hermes_local" && agent.adapterType !== "hermes") {
    // Allow hermes_local primarily; other names still accepted if operator forces attribution.
  }
  const from = new Date(input.from);
  const to = new Date(input.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    throw unprocessable("from/to must be valid ISO datetimes with from <= to");
  }
  if (input.rows.length > 20_000) throw unprocessable("At most 20000 Hermes usage rows per request");

  const proposals: HermesUsageBackfillProposal[] = [];
  for (const row of input.rows) {
    const proposal = proposeRow(row, from, to);
    if (!proposal) continue;
    proposals.push(proposal);
  }

  // Skip when a pending run still owns accounting for overlapping tokens (same agent, same day).
  const pending = await db.select({
    id: heartbeatRuns.id,
    finishedAt: heartbeatRuns.finishedAt,
    createdAt: heartbeatRuns.createdAt,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId),
    eq(heartbeatRuns.agentId, input.agentId),
    eq(heartbeatRuns.costAccountingPending, true),
  ));
  const pendingDays = new Set(
    pending.map((run) => (run.finishedAt ?? run.createdAt).toISOString().slice(0, 10)),
  );

  let wouldSkip = 0;
  const existingKeys = new Set<string>();
  if (proposals.length > 0) {
    const keys = proposals.map((p) => p.idempotencyKey);
    // Chunk inArray to keep parameter lists bounded.
    for (let i = 0; i < keys.length; i += 500) {
      const chunk = keys.slice(i, i + 500);
      const existing = await db.select({ key: costEvents.idempotencyKey })
        .from(costEvents)
        .where(and(
          eq(costEvents.companyId, companyId),
          inArray(costEvents.idempotencyKey, chunk),
        ));
      for (const row of existing) {
        if (row.key) existingKeys.add(row.key);
      }
    }
    // Also skip if a non-zero reported event already covers this agent+model+day.
    const reported = await db.select({
      model: costEvents.model,
      day: sql<string>`to_char(${costEvents.occurredAt} at time zone 'UTC', 'YYYY-MM-DD')`,
    }).from(costEvents).where(and(
      eq(costEvents.companyId, companyId),
      eq(costEvents.agentId, input.agentId),
      gte(costEvents.occurredAt, from),
      lte(costEvents.occurredAt, to),
      sql`${costEvents.costStatus} = 'reported' and ${costEvents.costCents} > 0`,
    ));
    const reportedDays = new Set(reported.map((r) => `${r.model}|${r.day}`));

    for (const proposal of proposals) {
      const day = proposal.occurredAt.slice(0, 10);
      if (existingKeys.has(proposal.idempotencyKey)) {
        proposal.skipReason = "already_backfilled";
        wouldSkip += 1;
        continue;
      }
      if (pendingDays.has(day)) {
        proposal.skipReason = "pending_run";
        wouldSkip += 1;
        continue;
      }
      if (reportedDays.has(`${proposal.model}|${day}`)) {
        proposal.skipReason = "reported_nonzero_exists";
        wouldSkip += 1;
      }
    }
  }

  const wouldInsert = proposals.filter((p) => !p.skipReason).length;
  return { proposals, wouldInsert, wouldSkip };
}

export async function applyHermesUsageBackfill(
  db: Db,
  companyId: string,
  input: HermesUsageBackfillInput,
  actorId: string,
) {
  const plan = await planHermesUsageBackfill(db, companyId, input);
  const dryRun = input.dryRun !== false;
  if (dryRun) {
    return { dryRun: true as const, ...plan, inserted: 0 };
  }

  const toInsert = plan.proposals.filter((p) => !p.skipReason);
  let inserted = 0;
  await withAccountingTransaction(db, companyId, async (tx, publications) => {
    for (const proposal of toInsert) {
      await createCostEventInTransaction(tx, companyId, {
        idempotencyKey: proposal.idempotencyKey,
        agentId: input.agentId,
        provider: "nous",
        biller: "nous",
        billingType: "metered_api",
        costStatus: proposal.costStatus,
        model: proposal.model,
        inputTokens: proposal.inputTokens,
        cachedInputTokens: proposal.cachedInputTokens,
        outputTokens: proposal.outputTokens,
        costCents: proposal.costCents,
        pricingProvenance: {
          source: "operator",
          version: "hermes-session-model-usage-backfill",
          evidence: `session:${proposal.sessionId}`,
        },
        occurredAt: new Date(proposal.occurredAt),
      }, publications, { actorType: "user", actorId });
      inserted += 1;
    }
    await logActivity(tx, {
      companyId,
      actorType: "user",
      actorId,
      action: "cost.hermes_usage_backfill",
      entityType: "company",
      entityId: companyId,
      details: {
        agentId: input.agentId,
        from: input.from,
        to: input.to,
        inserted,
        skipped: plan.wouldSkip,
      },
    }, publications);
  });

  return {
    dryRun: false as const,
    proposals: plan.proposals,
    wouldInsert: plan.wouldInsert,
    wouldSkip: plan.wouldSkip,
    inserted,
    spendCentsExact: normalizeCents(
      toInsert.reduce((sum, p) => sum + Number(p.costCents), 0).toFixed(7),
    ),
  };
}
