import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { financeEvents } from "@paperclipai/db";
import {
  importNousPortalSpendSchema,
  normalizeCents,
  type ImportNousPortalSpend,
} from "@paperclipai/shared";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { createFinanceEventInTransaction } from "./finance.js";
import { logActivity } from "./activity-log.js";
import { conflict } from "../errors.js";

const PORTAL_BILLER = "nous_portal";
const PORTAL_SOURCE = "nous_portal_csv";

export async function importNousPortalSpend(
  db: Db,
  companyId: string,
  raw: ImportNousPortalSpend,
  actorId: string,
) {
  const input = importNousPortalSpendSchema.parse(raw);
  if (input.currency !== "USD") {
    throw conflict("Nous Portal CSV import currently supports USD only");
  }

  const proposals = input.lines.map((line) => ({
    ...line,
    idempotencyKey: `nous-portal:${input.externalId}:${line.externalId}`,
    amountCents: normalizeCents(line.amountCents),
    eventKind: line.kind === "credit" ? "credit_refund" as const
      : line.kind === "inference" ? "inference_charge" as const
        : "platform_fee" as const,
    direction: line.kind === "credit" ? "credit" as const : "debit" as const,
  }));

  if (input.dryRun) {
    const totalDebit = proposals
      .filter((p) => p.direction === "debit")
      .reduce((sum, p) => sum + Number(p.amountCents), 0);
    const totalCredit = proposals
      .filter((p) => p.direction === "credit")
      .reduce((sum, p) => sum + Number(p.amountCents), 0);
    return {
      dryRun: true as const,
      externalId: input.externalId,
      lineCount: proposals.length,
      netCents: normalizeCents((totalDebit - totalCredit).toFixed(7)),
      inserted: 0,
    };
  }

  return withAccountingTransaction(db, companyId, async (tx, publications) => {
    let inserted = 0;
    for (const line of proposals) {
      const created = await createFinanceEventInTransaction(tx, publications, companyId, {
        idempotencyKey: line.idempotencyKey,
        biller: PORTAL_BILLER,
        externalInvoiceId: input.externalId,
        eventKind: line.eventKind,
        direction: line.direction,
        amountCents: line.amountCents,
        currency: input.currency,
        occurredAt: new Date(line.occurredAt),
        description: (line.description ?? `Nous Portal ${input.externalId} · ${line.externalId}`).slice(0, 500),
        metadataJson: {
          source: PORTAL_SOURCE,
          kind: line.kind,
          externalLineId: line.externalId,
        },
      }, { actorType: "user", actorId });
      if (created) inserted += 1;
    }
    await logActivity(tx, {
      companyId,
      actorType: "user",
      actorId,
      action: "accounting.nous_portal_imported",
      entityType: "company",
      entityId: companyId,
      details: { externalId: input.externalId, lineCount: input.lines.length, inserted },
    }, publications);
    return {
      dryRun: false as const,
      externalId: input.externalId,
      lineCount: input.lines.length,
      inserted,
    };
  });
}

/** Net Portal spend in [from, to] from imported finance events (debits − credits). */
export async function sumNousPortalMonthSpendCents(
  db: Db,
  companyId: string,
  from: Date,
  to: Date,
): Promise<number | null> {
  const [row] = await db.select({
    net: sql<number>`coalesce(sum(case
      when ${financeEvents.direction} = 'credit' then -${financeEvents.amountCents}
      else ${financeEvents.amountCents}
    end), 0)::double precision`,
    count: sql<number>`count(*)::int`,
  }).from(financeEvents).where(and(
    eq(financeEvents.companyId, companyId),
    eq(financeEvents.biller, PORTAL_BILLER),
    sql`${financeEvents.metadataJson}->>'source' = ${PORTAL_SOURCE}`,
    gte(financeEvents.occurredAt, from),
    lte(financeEvents.occurredAt, to),
  ));
  if (!row || Number(row.count) === 0) return null;
  return Number(row.net);
}

/** Parse a simple Nous Portal CSV: day,amount_usd[,description[,kind]] */
export function parseNousPortalCsv(csvText: string): ImportNousPortalSpend["lines"] {
  const lines: ImportNousPortalSpend["lines"] = [];
  const rows = csvText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (rows.length === 0) return lines;
  let start = 0;
  const header = rows[0].toLowerCase();
  if (header.includes("day") || header.includes("date") || header.includes("amount")) {
    start = 1;
  }
  for (let i = start; i < rows.length; i += 1) {
    const cols = rows[i].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    if (cols.length < 2) continue;
    const day = cols[0];
    const amountUsd = Number(cols[1]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(amountUsd)) continue;
    const description = cols[2] || undefined;
    const kindRaw = (cols[3] || "other").toLowerCase();
    const kind = (["inference", "fee", "credit", "tools", "hosting", "other"] as const)
      .includes(kindRaw as "other")
      ? (kindRaw as ImportNousPortalSpend["lines"][number]["kind"])
      : "other";
    // Prefer decimal dollars → cents without binary float drift for common CSV values.
    const centsFromUsd = Number((Math.abs(amountUsd) * 100).toFixed(7));
    lines.push({
      externalId: `${day}:${kind}:${i}`,
      amountCents: centsFromUsd.toFixed(7),
      occurredAt: `${day}T12:00:00.000Z`,
      description,
      kind: amountUsd < 0 ? "credit" : kind,
    });
  }
  return lines;
}
