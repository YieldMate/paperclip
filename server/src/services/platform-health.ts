import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  agents,
  budgetIncidents,
  budgetPolicies,
  budgetReservations,
  companies,
  costEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  PLATFORM_HEALTH_AGENT_NAME,
  isNativeWorkspaceExportRepairCause,
  requiresExecutionReconciliation,
  type IssueRecoveryActionOutcome,
  type PlatformHealthAction,
  type PlatformHealthApplyDeskTriage,
  type PlatformHealthAutoHeal,
  type PlatformHealthEnsureMedic,
  type PlatformHealthIssueClass,
  type PlatformHealthReconcileResume,
  type PlatformHealthSettlePendingRun,
} from "@paperclipai/shared";
import { badRequest, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { createAgentLifecycle, scheduleAgentLifecycle } from "./agent-lifecycle.js";
import { listAttentionExhaustedRuns } from "./attention-exhausted-runs.js";
import { budgetService, type BudgetServiceHooks } from "./budgets.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { issueService } from "./issues.js";
import {
  aggregateHermesSessionUsage,
  readHermesSessionUsage,
  resolveHermesStateDbPath,
} from "./platform-health-hermes.js";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { accountRunCost } from "./run-cost-accounting.js";
import { persistUsageReceipt, spoolUsageReceipt } from "./usage-receipts.js";

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"] as const;
const PRE_PROVIDER_ERROR_RE = /spawn\s+E2BIG|E2BIG|ENOENT|failed to spawn|bootstrap/i;
const MAX_REAPER_BATCH = 25;
const HEAL_ACTIVITY_ACTION = "platform_health.heal";

type ObjectRecord = Record<string, unknown>;

function object(value: unknown): ObjectRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectRecord : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function fingerprintFor(parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join(":");
}

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000);
}

function utcDayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export interface PlatformHealthFinding {
  class: PlatformHealthIssueClass;
  fingerprint: string;
  agentId: string | null;
  agentName: string | null;
  runId?: string | null;
  costEventId?: string | null;
  recoveryActionId?: string | null;
  issueId?: string | null;
  detail: string;
  autoSafe: boolean;
  recommendedAction: PlatformHealthAction;
}

export interface PlatformHealthHealResult {
  finding: PlatformHealthFinding;
  action: PlatformHealthAction;
  dryRun: boolean;
  applied: boolean;
  skippedReason?: string;
  result?: Record<string, unknown>;
}

function classifyPendingRun(run: {
  id: string;
  agentId: string;
  agentName: string | null;
  status: string;
  error: string | null;
  usageJson: unknown;
  resultJson: unknown;
  sessionIdAfter: string | null;
}): PlatformHealthFinding {
  const usage = object(run.usageJson);
  const result = object(run.resultJson);
  const recovery = object(result.executionRecovery);
  const receiptReady = usage.accountingReceiptReady;
  const providerStarted =
    recovery.providerWorkStarted !== false
    && usage.accountingProviderWorkStarted !== false;

  if (
    !providerStarted
    || (run.error && PRE_PROVIDER_ERROR_RE.test(run.error) && receiptReady === false)
  ) {
    return {
      class: "pre_provider_failure",
      fingerprint: fingerprintFor(["pre_provider", run.id]),
      agentId: run.agentId,
      agentName: run.agentName,
      runId: run.id,
      detail: run.error ? `Pre-provider failure: ${run.error}` : "Provider work never started",
      autoSafe: true,
      recommendedAction: "settle_pre_provider",
    };
  }

  if (receiptReady === false) {
    return {
      class: "pending_incomplete_receipt",
      fingerprint: fingerprintFor(["pending_receipt", run.id]),
      agentId: run.agentId,
      agentName: run.agentName,
      runId: run.id,
      detail: run.sessionIdAfter
        ? `Incomplete receipt; Hermes session ${run.sessionIdAfter}`
        : "Incomplete accounting receipt with no session id",
      autoSafe: Boolean(run.sessionIdAfter),
      recommendedAction: run.sessionIdAfter ? "settle_hermes_estimate" : "escalate",
    };
  }

  return {
    class: "unknown",
    fingerprint: fingerprintFor(["pending_unknown", run.id]),
    agentId: run.agentId,
    agentName: run.agentName,
    runId: run.id,
    detail: "Pending accounting without a recognized recovery class",
    autoSafe: false,
    recommendedAction: "escalate",
  };
}

export type PlatformHealthWakeupRequest = {
  agentId: string;
  source: "on_demand" | "automation";
  triggerDetail: "manual" | "system";
  reason: string;
  failedRunId?: string | null;
  issueId?: string | null;
  recoveryActionId?: string | null;
  requestedByUserId: string;
};

export type PlatformHealthServiceHooks = BudgetServiceHooks & {
  /** Board-privileged agent wakeup used for desk retries / recovery restores. */
  wakeupAgent?: (input: PlatformHealthWakeupRequest) => Promise<unknown>;
};

export function platformHealthService(db: Db, hooks: PlatformHealthServiceHooks = {}) {
  const budgets = budgetService(db, hooks);
  const lifecycle = createAgentLifecycle(db, hooks);
  const recoveryActions = issueRecoveryActionService(db);
  const issuesSvc = issueService(db);

  async function boardActorUserId(companyId: string): Promise<string> {
    const [company] = await db.select({
      defaultResponsibleUserId: companies.defaultResponsibleUserId,
    }).from(companies).where(eq(companies.id, companyId)).limit(1);
    return text(company?.defaultResponsibleUserId) ?? "local-board";
  }

  async function wakeBudgetAndLifecycle(companyId: string) {
    await withAccountingTransaction(db, companyId, async (tx) => {
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.budgetEnforcement, companyId);
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.agentLifecycle, companyId);
    });
  }

  async function wakeLifecycle(companyId: string) {
    await withAccountingTransaction(db, companyId, async (tx) => {
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.agentLifecycle, companyId);
    });
  }

  async function loadRun(companyId: string, runId: string) {
    const [run] = await db.select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      error: heartbeatRuns.error,
      usageJson: heartbeatRuns.usageJson,
      resultJson: heartbeatRuns.resultJson,
      sessionIdAfter: heartbeatRuns.sessionIdAfter,
      costAccountingPending: heartbeatRuns.costAccountingPending,
      costAccountedAt: heartbeatRuns.costAccountedAt,
      finishedAt: heartbeatRuns.finishedAt,
      updatedAt: heartbeatRuns.updatedAt,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
      agentName: agents.name,
    }).from(heartbeatRuns)
      .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)))
      .limit(1);
    if (!run) throw notFound("Heartbeat run not found");
    return run;
  }

  async function countHealsToday(companyId: string, fingerprint: string): Promise<number> {
    const day = utcDayKey();
    const [row] = await db.execute<{ count: number }>(sql`
      select count(*)::int as count
      from activity_log
      where company_id = ${companyId}
        and action = ${HEAL_ACTIVITY_ACTION}
        and created_at >= (${day}::date)
        and created_at < ((${day}::date) + interval '1 day')
        and details->>'fingerprint' = ${fingerprint}
    `);
    return Number(row?.count ?? 0);
  }

  async function recordHeal(
    companyId: string,
    actorId: string,
    finding: PlatformHealthFinding,
    action: PlatformHealthAction,
    applied: boolean,
    extra: Record<string, unknown> = {},
  ) {
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId,
      action: HEAL_ACTIVITY_ACTION,
      entityType: "agent",
      entityId: finding.agentId ?? companyId,
      details: {
        fingerprint: finding.fingerprint,
        class: finding.class,
        action,
        applied,
        runId: finding.runId ?? null,
        costEventId: finding.costEventId ?? null,
        ...extra,
      },
    });
  }

  async function settlePreProvider(companyId: string, runId: string, dryRun: boolean, actorId: string) {
    const run = await loadRun(companyId, runId);
    if (!run.costAccountingPending && run.costAccountedAt) {
      return { applied: false, skippedReason: "already_accounted", runId };
    }
    if (dryRun) {
      return { applied: false, dryRun: true, mode: "pre_provider", runId, error: run.error };
    }
    await db.update(heartbeatRuns).set({
      usageJson: sql`coalesce(${heartbeatRuns.usageJson}, '{}'::jsonb) || '{"accountingProviderWorkStarted":false,"accountingReceiptReady":true}'::jsonb`,
      resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({
        executionRecovery: {
          kind: "platform_health",
          providerWorkStarted: false,
          reason: "pre_provider_failure",
          healedBy: actorId,
        },
      })}::jsonb`,
    }).where(eq(heartbeatRuns.id, runId));
    const accounted = await accountRunCost(db, runId, hooks);
    await budgets.evaluateAffectedScopes(companyId, run.agentId, null);
    await wakeBudgetAndLifecycle(companyId);
    scheduleAgentLifecycle(db, run.agentId);
    return { applied: accounted, mode: "pre_provider", runId, accounted };
  }

  async function settleHermesEstimate(
    companyId: string,
    runId: string,
    dryRun: boolean,
    actorId: string,
    overrides?: { costUsd?: number; evidence?: string },
  ) {
    const run = await loadRun(companyId, runId);
    if (!run.costAccountingPending && run.costAccountedAt) {
      return { applied: false, skippedReason: "already_accounted", runId };
    }
    const sessionId = run.sessionIdAfter;
    if (!sessionId && overrides?.costUsd == null) {
      throw unprocessable("No Hermes session id on run and no costUsd override provided");
    }

    const stateDb = resolveHermesStateDbPath(run.adapterConfig);
    const hermesRows = sessionId ? readHermesSessionUsage(stateDb, sessionId) : [];
    const aggregated = aggregateHermesSessionUsage(hermesRows);
    const costUsd = overrides?.costUsd ?? aggregated?.costUsd ?? null;
    if (costUsd == null || !Number.isFinite(costUsd)) {
      throw unprocessable("Hermes session usage has no estimated cost; pass costUsd to override");
    }
    if ((aggregated?.inputTokens ?? 0) + (aggregated?.outputTokens ?? 0) === 0 && overrides?.costUsd == null) {
      throw unprocessable("Hermes session has no billable tokens");
    }

    const usage = {
      inputTokens: aggregated?.inputTokens ?? 0,
      outputTokens: aggregated?.outputTokens ?? 0,
      cachedInputTokens: aggregated?.cacheReadTokens ?? 0,
    };
    const model = aggregated?.model ?? text(object(run.usageJson).model) ?? "unknown";
    const evidence = overrides?.evidence
      ?? `Recovered from Hermes session ${sessionId ?? "override"} via platform-health`;

    if (dryRun) {
      return {
        applied: false,
        dryRun: true,
        mode: "hermes_estimate",
        runId,
        sessionId,
        costUsd,
        usage,
        model,
        hermesRowCount: hermesRows.length,
      };
    }

    const previous = object(run.usageJson);
    const sourceId = text(previous.accountingReceiptSourceId) ?? randomUUID();
    const sequence = Math.max(1, Number(previous.accountingReceiptSequence ?? 0) + 1);
    const envelope = {
      schema: "paperclip/accounting-receipt/v1" as const,
      id: randomUUID(),
      companyId,
      runId,
      sourceId,
      sequence,
      receivedAt: new Date().toISOString(),
      adapterType: run.adapterType || "hermes_local",
      receipt: {
        complete: true,
        provider: text(previous.provider) ?? "nous",
        biller: text(previous.biller) ?? text(previous.provider) ?? "nous",
        model,
        billingType: text(previous.billingType) ?? "metered_api",
        costStatus: "estimated" as const,
        costUsd,
        usage,
        usageByModel: aggregated?.usageByModel ?? [{ model, costUsd, usage }],
        pricingProvenance: {
          source: "operator" as const,
          version: "platform-health/hermes-estimate/v1",
          evidence,
        },
      },
    };

    const file = await spoolUsageReceipt(envelope);
    await persistUsageReceipt(db, envelope);
    const accounted = await accountRunCost(db, runId, hooks);
    await budgets.evaluateAffectedScopes(companyId, run.agentId, null);
    await wakeBudgetAndLifecycle(companyId);
    scheduleAgentLifecycle(db, run.agentId);
    return {
      applied: accounted,
      mode: "hermes_estimate",
      runId,
      sessionId,
      costUsd,
      accounted,
      receiptFile: file,
      healedBy: actorId,
    };
  }

  async function clearBadUnpriced(
    companyId: string,
    input: { runId?: string; costEventId?: string; dryRun: boolean; actorId: string },
  ) {
    const conditions = [
      eq(costEvents.companyId, companyId),
      eq(costEvents.costStatus, "unpriced"),
      sql`${costEvents.costCents}::numeric = 0`,
    ];
    if (input.costEventId) conditions.push(eq(costEvents.id, input.costEventId));
    if (input.runId) conditions.push(eq(costEvents.heartbeatRunId, input.runId));

    const events = await db.select({
      id: costEvents.id,
      agentId: costEvents.agentId,
      heartbeatRunId: costEvents.heartbeatRunId,
      costCents: costEvents.costCents,
      costStatus: costEvents.costStatus,
      model: costEvents.model,
    }).from(costEvents).where(and(...conditions)).limit(20);

    if (events.length === 0) throw notFound("No matching $0 unpriced cost event");

    // Only clear when linked run failed/interrupted with no billable tokens, or no run.
    const safe: typeof events = [];
    for (const event of events) {
      if (!event.heartbeatRunId) {
        safe.push(event);
        continue;
      }
      const [run] = await db.select({
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
        usageJson: heartbeatRuns.usageJson,
      }).from(heartbeatRuns).where(eq(heartbeatRuns.id, event.heartbeatRunId)).limit(1);
      if (!run) {
        safe.push(event);
        continue;
      }
      const usage = object(run.usageJson);
      const tokens = Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0);
      if (tokens > 0 && run.status === "succeeded") continue;
      if (["failed", "interrupted", "cancelled", "timed_out"].includes(run.status) || tokens === 0) {
        safe.push(event);
      }
    }
    if (safe.length === 0) {
      throw unprocessable("Unpriced events look billable; refusing to delete");
    }

    if (input.dryRun) {
      return { applied: false, dryRun: true, mode: "clear_unpriced", events: safe };
    }

    const ids = safe.map((event) => event.id);
    await db.delete(costEvents).where(inArray(costEvents.id, ids));
    const agentIds = [...new Set(safe.map((event) => event.agentId).filter(Boolean))] as string[];
    for (const agentId of agentIds) {
      await budgets.reconcileScope(companyId, "agent", agentId);
      scheduleAgentLifecycle(db, agentId);
    }
    await wakeBudgetAndLifecycle(companyId);
    return { applied: true, mode: "clear_unpriced", deletedIds: ids, healedBy: input.actorId };
  }

  async function getHealthSnapshot(companyId: string, opts?: { pendingAgeMinutes?: number; resumingAgeMinutes?: number }) {
    const pendingAge = minutesAgo(opts?.pendingAgeMinutes ?? 5);
    const resumingAge = minutesAgo(opts?.resumingAgeMinutes ?? 2);

    const pausedBudgetAgents = await db.select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
      pauseReason: agents.pauseReason,
      lifecycleState: agents.lifecycleState,
      pausedAt: agents.pausedAt,
      spentMonthlyCents: agents.spentMonthlyCents,
      budgetMonthlyCents: agents.budgetMonthlyCents,
    }).from(agents).where(and(
      eq(agents.companyId, companyId),
      eq(agents.pauseReason, "budget"),
    ));

    const stuckResuming = await db.select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
      pauseReason: agents.pauseReason,
      lifecycleState: agents.lifecycleState,
      updatedAt: agents.updatedAt,
    }).from(agents).where(and(
      eq(agents.companyId, companyId),
      eq(agents.lifecycleState, "resuming"),
      lt(agents.updatedAt, resumingAge),
    ));

    const pendingRuns = await db.select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      agentName: agents.name,
      status: heartbeatRuns.status,
      error: heartbeatRuns.error,
      usageJson: heartbeatRuns.usageJson,
      resultJson: heartbeatRuns.resultJson,
      sessionIdAfter: heartbeatRuns.sessionIdAfter,
      finishedAt: heartbeatRuns.finishedAt,
      updatedAt: heartbeatRuns.updatedAt,
      accountingLastError: heartbeatRuns.accountingLastError,
    }).from(heartbeatRuns)
      .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.costAccountingPending, true),
        inArray(heartbeatRuns.status, [...TERMINAL_RUN_STATUSES]),
        or(isNull(heartbeatRuns.finishedAt), lt(heartbeatRuns.finishedAt, pendingAge)),
      ))
      .orderBy(asc(heartbeatRuns.updatedAt))
      .limit(100);

    const openIncidents = await db.select({
      id: budgetIncidents.id,
      policyId: budgetIncidents.policyId,
      status: budgetIncidents.status,
      scopeType: budgetPolicies.scopeType,
      scopeId: budgetPolicies.scopeId,
      amountObserved: budgetIncidents.amountObserved,
      amountLimit: budgetIncidents.amountLimit,
    }).from(budgetIncidents)
      .innerJoin(budgetPolicies, eq(budgetPolicies.id, budgetIncidents.policyId))
      .where(and(
        eq(budgetPolicies.companyId, companyId),
        eq(budgetIncidents.status, "open"),
      ))
      .limit(100);

    const unpricedEvents = await db.select({
      id: costEvents.id,
      agentId: costEvents.agentId,
      heartbeatRunId: costEvents.heartbeatRunId,
      costCents: costEvents.costCents,
      model: costEvents.model,
      createdAt: costEvents.createdAt,
    }).from(costEvents).where(and(
      eq(costEvents.companyId, companyId),
      eq(costEvents.costStatus, "unpriced"),
      sql`${costEvents.billingType} is distinct from 'subscription_included'`,
    )).orderBy(asc(costEvents.createdAt)).limit(100);

    const heldReservations = await db.select({
      id: budgetReservations.id,
      runId: budgetReservations.runId,
      agentId: budgetReservations.agentId,
      state: budgetReservations.state,
      amountCents: budgetReservations.amountCents,
    }).from(budgetReservations).where(and(
      eq(budgetReservations.companyId, companyId),
      eq(budgetReservations.state, "held"),
    )).limit(100);

    const exhaustedRuns = await listAttentionExhaustedRuns(db, companyId).catch(() => []);
    const recoveryActions = await db.select({
      id: issueRecoveryActions.id,
      sourceIssueId: issueRecoveryActions.sourceIssueId,
      status: issueRecoveryActions.status,
      ownerType: issueRecoveryActions.ownerType,
      updatedAt: issueRecoveryActions.updatedAt,
    }).from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, companyId),
      inArray(issueRecoveryActions.status, ["active", "escalated"]),
      inArray(issueRecoveryActions.ownerType, ["user", "board"]),
    )).limit(100).catch(() => [] as Array<{
      id: string; sourceIssueId: string; status: string; ownerType: string; updatedAt: Date;
    }>);

    const findings: PlatformHealthFinding[] = [];

    for (const run of pendingRuns) {
      findings.push(classifyPendingRun(run));
    }

    for (const event of unpricedEvents) {
      const cents = Number(event.costCents ?? 0);
      if (cents !== 0) {
        findings.push({
          class: "unknown",
          fingerprint: fingerprintFor(["unpriced", event.id]),
          agentId: event.agentId,
          agentName: null,
          costEventId: event.id,
          runId: event.heartbeatRunId,
          detail: `Unpriced cost event (${cents} cents)`,
          autoSafe: false,
          recommendedAction: "escalate",
        });
        continue;
      }
      findings.push({
        class: "bad_unpriced_event",
        fingerprint: fingerprintFor(["bad_unpriced", event.id]),
        agentId: event.agentId,
        agentName: null,
        costEventId: event.id,
        runId: event.heartbeatRunId,
        detail: "$0 unpriced cost event may be blocking hard-stop policy",
        autoSafe: true,
        recommendedAction: "clear_unpriced",
      });
    }

    for (const agent of stuckResuming) {
      findings.push({
        class: "stuck_resuming",
        fingerprint: fingerprintFor(["stuck_resuming", agent.id]),
        agentId: agent.id,
        agentName: agent.name,
        detail: `lifecycleState=resuming since ${asDate(agent.updatedAt)?.toISOString() ?? "unknown"}`,
        autoSafe: true,
        recommendedAction: "kick_lifecycle",
      });
    }

    for (const agent of pausedBudgetAgents) {
      const overspent = Number(agent.budgetMonthlyCents ?? 0) > 0
        && Number(agent.spentMonthlyCents ?? 0) >= Number(agent.budgetMonthlyCents ?? 0);
      if (overspent) {
        findings.push({
          class: "true_overspend",
          fingerprint: fingerprintFor(["overspend", agent.id, utcDayKey()]),
          agentId: agent.id,
          agentName: agent.name,
          detail: `Spent ${agent.spentMonthlyCents} of ${agent.budgetMonthlyCents} monthly cents`,
          autoSafe: false,
          recommendedAction: "escalate",
        });
      }
    }

    for (const run of exhaustedRuns.slice(0, 50)) {
      const issueId = text(object(run.contextSnapshot).issueId) ?? text(object(run.contextSnapshot).taskId);
      findings.push({
        class: "stranded_failed_run",
        fingerprint: fingerprintFor(["failed_run", run.id]),
        agentId: run.agentId ?? null,
        agentName: run.agentName ?? null,
        runId: run.id,
        issueId,
        detail: run.exhaustionMessage ?? "Exhausted failed/timed-out run on decisions desk",
        autoSafe: false,
        recommendedAction: "retry_failed_run",
      });
    }

    for (const action of recoveryActions) {
      findings.push({
        class: "stranded_recovery_action",
        fingerprint: fingerprintFor(["recovery_action", action.id]),
        agentId: null,
        agentName: null,
        recoveryActionId: action.id,
        issueId: action.sourceIssueId,
        detail: `Recovery action ${action.status} owned by ${action.ownerType}`,
        autoSafe: false,
        recommendedAction: "resolve_recovery_action",
      });
    }

    return {
      companyId,
      checkedAt: new Date().toISOString(),
      empty: findings.length === 0
        && pausedBudgetAgents.length === 0
        && pendingRuns.length === 0
        && openIncidents.length === 0,
      counts: {
        findings: findings.length,
        pausedBudgetAgents: pausedBudgetAgents.length,
        stuckResuming: stuckResuming.length,
        pendingRuns: pendingRuns.length,
        openIncidents: openIncidents.length,
        unpricedEvents: unpricedEvents.length,
        heldReservations: heldReservations.length,
        exhaustedFailedRuns: exhaustedRuns.length,
        recoveryActions: recoveryActions.length,
        autoSafe: findings.filter((f) => f.autoSafe).length,
        escalate: findings.filter((f) => !f.autoSafe).length,
      },
      pausedBudgetAgents,
      stuckResuming,
      pendingRuns: pendingRuns.map((run) => ({
        id: run.id,
        agentId: run.agentId,
        agentName: run.agentName,
        status: run.status,
        error: run.error,
        sessionIdAfter: run.sessionIdAfter,
        accountingReceiptReady: object(run.usageJson).accountingReceiptReady ?? null,
        costStatus: object(run.usageJson).costStatus ?? null,
        finishedAt: asDate(run.finishedAt)?.toISOString() ?? null,
        classification: classifyPendingRun(run),
      })),
      openIncidents,
      unpricedEvents,
      heldReservations,
      findings,
    };
  }

  async function settlePendingRun(
    companyId: string,
    input: PlatformHealthSettlePendingRun,
    actorId: string,
  ) {
    const parsed = {
      runId: input.runId,
      mode: input.mode ?? "auto",
      dryRun: input.dryRun ?? false,
      costUsd: input.costUsd,
      evidence: input.evidence,
      costEventId: input.costEventId,
    };
    const run = await loadRun(companyId, parsed.runId);
    let mode = parsed.mode;
    if (mode === "auto") {
      const finding = classifyPendingRun(run);
      if (finding.recommendedAction === "settle_pre_provider") mode = "pre_provider";
      else if (finding.recommendedAction === "settle_hermes_estimate") mode = "hermes_estimate";
      else if (finding.recommendedAction === "clear_unpriced") mode = "clear_unpriced";
      else if (parsed.costEventId) mode = "clear_unpriced";
      else throw unprocessable(`Cannot auto-settle: ${finding.detail}`);
    }

    if (mode === "pre_provider") {
      return settlePreProvider(companyId, parsed.runId, parsed.dryRun, actorId);
    }
    if (mode === "hermes_estimate") {
      return settleHermesEstimate(companyId, parsed.runId, parsed.dryRun, actorId, {
        costUsd: parsed.costUsd,
        evidence: parsed.evidence,
      });
    }
    if (mode === "clear_unpriced") {
      return clearBadUnpriced(companyId, {
        runId: parsed.runId,
        costEventId: parsed.costEventId,
        dryRun: parsed.dryRun,
        actorId,
      });
    }
    throw badRequest(`Unsupported settle mode: ${mode}`);
  }

  async function reconcileAndResume(
    companyId: string,
    input: PlatformHealthReconcileResume,
    actorId: string,
  ) {
    const [agent] = await db.select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
      pauseReason: agents.pauseReason,
      lifecycleState: agents.lifecycleState,
      budgetMonthlyCents: agents.budgetMonthlyCents,
      spentMonthlyCents: agents.spentMonthlyCents,
    }).from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, companyId))).limit(1);
    if (!agent) throw notFound("Agent not found");

    if (agent.pauseReason && agent.pauseReason !== "budget" && agent.lifecycleState !== "resuming") {
      throw unprocessable(`Refusing to resume agent paused for ${agent.pauseReason}`);
    }
    const overspent = Number(agent.budgetMonthlyCents ?? 0) > 0
      && Number(agent.spentMonthlyCents ?? 0) >= Number(agent.budgetMonthlyCents ?? 0);
    if (overspent) {
      throw unprocessable("Agent is truly over budget; raise budget instead of forcing resume");
    }

    if (input.dryRun) {
      return {
        applied: false,
        dryRun: true,
        agent,
        wouldReconcile: true,
      };
    }

    const block = await budgets.reconcileScope(companyId, "agent", agent.id);
    await wakeBudgetAndLifecycle(companyId);
    scheduleAgentLifecycle(db, agent.id);

    const [after] = await db.select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
      pauseReason: agents.pauseReason,
      lifecycleState: agents.lifecycleState,
    }).from(agents).where(eq(agents.id, agent.id)).limit(1);

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId,
      action: "platform_health.reconcile_resume",
      entityType: "agent",
      entityId: agent.id,
      details: { block, before: agent, after },
    });

    return { applied: true, block, agent: after };
  }

  async function autoHeal(
    companyId: string,
    input: PlatformHealthAutoHeal,
    actorId: string,
  ) {
    const dryRun = input.dryRun ?? true;
    const maxHeals = input.maxHealsPerFingerprint ?? 3;
    const maxActions = input.maxActions ?? 10;
    const snapshot = await getHealthSnapshot(companyId, {
      pendingAgeMinutes: input.pendingAgeMinutes,
      resumingAgeMinutes: input.resumingAgeMinutes,
    });
    const results: PlatformHealthHealResult[] = [];
    let actionsUsed = 0;

    for (const finding of snapshot.findings) {
      if (!finding.autoSafe) {
        if (results.length < 20) {
          results.push({
            finding,
            action: "escalate",
            dryRun,
            applied: false,
            skippedReason: "not_auto_safe",
          });
        }
        continue;
      }
      if (actionsUsed >= maxActions) {
        results.push({
          finding,
          action: finding.recommendedAction,
          dryRun,
          applied: false,
          skippedReason: "max_actions",
        });
        continue;
      }

      const prior = await countHealsToday(companyId, finding.fingerprint);
      if (prior >= maxHeals) {
        results.push({
          finding,
          action: "escalate",
          dryRun,
          applied: false,
          skippedReason: `loop_cap_${prior}`,
        });
        continue;
      }

      try {
        if (finding.recommendedAction === "settle_pre_provider" && finding.runId) {
          const result = await settlePreProvider(companyId, finding.runId, dryRun, actorId);
          if (!dryRun) await recordHeal(companyId, actorId, finding, "settle_pre_provider", true, result);
          results.push({ finding, action: "settle_pre_provider", dryRun, applied: !dryRun && Boolean(result.applied), result });
          actionsUsed++;
          continue;
        }
        if (finding.recommendedAction === "settle_hermes_estimate" && finding.runId) {
          const result = await settleHermesEstimate(companyId, finding.runId, dryRun, actorId);
          if (!dryRun) await recordHeal(companyId, actorId, finding, "settle_hermes_estimate", true, result);
          results.push({ finding, action: "settle_hermes_estimate", dryRun, applied: !dryRun && Boolean(result.applied), result });
          actionsUsed++;
          continue;
        }
        if (finding.recommendedAction === "clear_unpriced" && finding.costEventId) {
          const result = await clearBadUnpriced(companyId, {
            costEventId: finding.costEventId,
            runId: finding.runId ?? undefined,
            dryRun,
            actorId,
          });
          if (!dryRun) await recordHeal(companyId, actorId, finding, "clear_unpriced", true, result);
          results.push({ finding, action: "clear_unpriced", dryRun, applied: !dryRun && Boolean(result.applied), result });
          actionsUsed++;
          continue;
        }
        if (finding.recommendedAction === "kick_lifecycle" && finding.agentId) {
          if (dryRun) {
            results.push({ finding, action: "kick_lifecycle", dryRun: true, applied: false });
          } else {
            await wakeLifecycle(companyId);
            scheduleAgentLifecycle(db, finding.agentId);
            await recordHeal(companyId, actorId, finding, "kick_lifecycle", true);
            results.push({ finding, action: "kick_lifecycle", dryRun: false, applied: true });
          }
          actionsUsed++;
          continue;
        }
        results.push({
          finding,
          action: finding.recommendedAction,
          dryRun,
          applied: false,
          skippedReason: "unsupported_auto_action",
        });
      } catch (error) {
        results.push({
          finding,
          action: finding.recommendedAction,
          dryRun,
          applied: false,
          skippedReason: error instanceof Error ? error.message : "heal_failed",
        });
      }
    }

    // After settling accounting, reconcile budget-paused agents that are not true overspend.
    for (const agent of snapshot.pausedBudgetAgents) {
      if (actionsUsed >= maxActions) break;
      const overspent = Number(agent.budgetMonthlyCents ?? 0) > 0
        && Number(agent.spentMonthlyCents ?? 0) >= Number(agent.budgetMonthlyCents ?? 0);
      if (overspent) continue;
      const finding: PlatformHealthFinding = {
        class: "pending_incomplete_receipt",
        fingerprint: fingerprintFor(["reconcile_resume", agent.id]),
        agentId: agent.id,
        agentName: agent.name,
        detail: "Budget pause without true overspend; reconcile after heals",
        autoSafe: true,
        recommendedAction: "reconcile_resume",
      };
      const prior = await countHealsToday(companyId, finding.fingerprint);
      if (prior >= maxHeals) {
        results.push({ finding, action: "escalate", dryRun, applied: false, skippedReason: `loop_cap_${prior}` });
        continue;
      }
      try {
        const result = await reconcileAndResume(companyId, { agentId: agent.id, dryRun }, actorId);
        if (!dryRun) await recordHeal(companyId, actorId, finding, "reconcile_resume", true, result);
        results.push({ finding, action: "reconcile_resume", dryRun, applied: !dryRun && Boolean(result.applied), result });
        actionsUsed++;
      } catch (error) {
        results.push({
          finding,
          action: "reconcile_resume",
          dryRun,
          applied: false,
          skippedReason: error instanceof Error ? error.message : "reconcile_failed",
        });
      }
    }

    let deskTriage: Awaited<ReturnType<typeof applyDeskTriage>> | null = null;
    if (input.applyDeskTriage !== false) {
      try {
        deskTriage = await applyDeskTriage(companyId, {
          dryRun,
          maxActions: input.maxDeskActions ?? 10,
          applyRetries: true,
          applyResolves: true,
        }, actorId);
      } catch (error) {
        deskTriage = {
          dryRun,
          companyId,
          checkedAt: new Date().toISOString(),
          applied: 0,
          skipped: 0,
          maxActions: input.maxDeskActions ?? 10,
          results: [{
            action: "escalate",
            fingerprint: "desk_triage_failed",
            applied: false,
            skippedReason: error instanceof Error ? error.message : "desk_triage_failed",
          }],
        };
      }
    }

    return { dryRun, snapshotEmpty: snapshot.empty, results, actionsUsed, maxActions, deskTriage };
  }

  /**
   * Deterministic reaper for aged incomplete receipts / pre-provider failures.
   * Called from the cost-accounting worker so MEDIC is not required for the
   * hottest CHO/GOMEZ classes.
   */
  async function reapPendingReceipts(companyId?: string) {
    const pendingAge = minutesAgo(5);
    const conditions = [
      eq(heartbeatRuns.costAccountingPending, true),
      inArray(heartbeatRuns.status, [...TERMINAL_RUN_STATUSES]),
      or(isNull(heartbeatRuns.finishedAt), lt(heartbeatRuns.finishedAt, pendingAge)),
      sql`${heartbeatRuns.usageJson}->>'accountingReceiptReady' = 'false'`,
    ];
    if (companyId) conditions.push(eq(heartbeatRuns.companyId, companyId));

    const pending = await db.select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      agentName: agents.name,
      status: heartbeatRuns.status,
      error: heartbeatRuns.error,
      usageJson: heartbeatRuns.usageJson,
      resultJson: heartbeatRuns.resultJson,
      sessionIdAfter: heartbeatRuns.sessionIdAfter,
    }).from(heartbeatRuns)
      .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
      .where(and(...conditions))
      .orderBy(asc(heartbeatRuns.updatedAt))
      .limit(MAX_REAPER_BATCH);

    let healed = 0;
    const errors: Array<{ runId: string; error: string }> = [];
    for (const run of pending) {
      const finding = classifyPendingRun(run);
      try {
        if (finding.recommendedAction === "settle_pre_provider") {
          const result = await settlePreProvider(run.companyId, run.id, false, "platform-health-reaper");
          if (result.applied) healed++;
        } else if (finding.recommendedAction === "settle_hermes_estimate") {
          const result = await settleHermesEstimate(run.companyId, run.id, false, "platform-health-reaper");
          if (result.applied) healed++;
        }
      } catch (error) {
        errors.push({
          runId: run.id,
          error: error instanceof Error ? error.message.slice(0, 500) : "reaper_failed",
        });
      }
    }

    // Clear aged $0 unpriced blockers with no billable evidence.
    const unpriced = await db.select({
      id: costEvents.id,
      companyId: costEvents.companyId,
      agentId: costEvents.agentId,
      heartbeatRunId: costEvents.heartbeatRunId,
    }).from(costEvents).where(and(
      ...(companyId ? [eq(costEvents.companyId, companyId)] : []),
      eq(costEvents.costStatus, "unpriced"),
      sql`${costEvents.costCents}::numeric = 0`,
      sql`${costEvents.billingType} is distinct from 'subscription_included'`,
      lt(costEvents.createdAt, pendingAge),
    )).orderBy(asc(costEvents.createdAt)).limit(MAX_REAPER_BATCH);

    for (const event of unpriced) {
      try {
        const result = await clearBadUnpriced(event.companyId, {
          costEventId: event.id,
          runId: event.heartbeatRunId ?? undefined,
          dryRun: false,
          actorId: "platform-health-reaper",
        });
        if (result.applied) healed++;
      } catch {
        // leave for MEDIC / board — not every $0 unpriced is safe
      }
    }

    return { scanned: pending.length + unpriced.length, healed, errors };
  }

  async function ensureMedicAgent(
    companyId: string,
    input: PlatformHealthEnsureMedic,
    actorUserId: string,
  ) {
    const existing = await db.select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
      lifecycleState: agents.lifecycleState,
      pauseReason: agents.pauseReason,
      adapterType: agents.adapterType,
      runtimeConfig: agents.runtimeConfig,
      budgetMonthlyCents: agents.budgetMonthlyCents,
    }).from(agents).where(and(
      eq(agents.companyId, companyId),
      eq(agents.name, PLATFORM_HEALTH_AGENT_NAME),
      sql`${agents.lifecycleState} <> 'terminated'`,
    )).limit(1);

    const intervalSec = input.intervalSec ?? 180;
    const budgetMonthlyCents = input.budgetMonthlyCents ?? 5_000;
    const desiredHeartbeat = {
      enabled: true,
      intervalSec,
      wakeOnDemand: true,
      skipTimerWhenNoActionableWork: false,
      maxConcurrentRuns: 1,
    };

    const desiredSkills = [
      "paperclipai/bundled/paperclip-operations/platform-health",
      "paperclip",
    ];
    const medicPrompt = [
      "You are MEDIC, the company platform-health agent. Be decisive; do not explore the codebase.",
      "First shell line of every curl: `set -a && . \"${HERMES_PAPERCLIP_ENV_FILE:?missing}\" && set +a` (path is also in the system prompt).",
      "REST: $PAPERCLIP_API_URL (append /api if missing), Authorization: Bearer $PAPERCLIP_API_KEY, X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID. Never use MCP overlay bearers.",
      "Protocol (max ~8 tool calls):",
      "1) GET /api/companies/{{companyId}}/ops/health/snapshot. If empty:true, write disposition in_progress with comment 'healthy' and stop.",
      "2) Your agent metadata.autoHeal is true — immediately POST /api/companies/{{companyId}}/ops/health/auto-heal {\"dryRun\":false,\"maxActions\":10,\"applyDeskTriage\":true,\"maxDeskActions\":10}. Do not dry-run first. Auto-heal also applies safe Decisions-desk retries/resolves via apply-desk-triage.",
      "3) If auto-heal omitted desk work or deskTriage.applied is 0 while snapshot still shows stranded_failed_run / stranded_recovery_action, POST /api/companies/{{companyId}}/ops/health/apply-desk-triage {\"dryRun\":false,\"maxActions\":10}. Do not call agent wakeup or recovery-actions/resolve yourself — those require board privilege and this endpoint owns them.",
      "4) Write HERMES_DISPOSITION_FILE {\"status\":\"in_progress\",\"comment\":\"<one short paragraph: auto-heal counts + desk retries/resolves>\"} and stop. Do not keep iterating.",
      "Never invent $0 receipts. Never resume manual/setup pauses or true overspend.",
    ].join(" ");
    const skillAdapterConfig = {
      model: input.model ?? "z-ai/glm-5.3",
      timeoutSec: 600,
      persistSession: true,
      maxTurnsPerRun: 20,
      toolsets: "terminal,file,code_execution",
      promptTemplate: medicPrompt,
      paperclipSkillSync: {
        desiredSkills,
      },
    };
    const medicMetadata = {
      platformHealth: true,
      autoHeal: true,
      detectOnly: false,
    };

    if (existing[0]) {
      const agent = existing[0];
      if (input.dryRun) {
        return { created: false, dryRun: true, agent };
      }
      const [full] = await db.select({
        adapterConfig: agents.adapterConfig,
        runtimeConfig: agents.runtimeConfig,
      }).from(agents).where(eq(agents.id, agent.id)).limit(1);
      const runtimeConfig = {
        ...object(full?.runtimeConfig),
        heartbeat: {
          ...object(object(full?.runtimeConfig).heartbeat),
          ...desiredHeartbeat,
        },
      };
      const adapterConfig = {
        ...object(full?.adapterConfig),
        ...skillAdapterConfig,
        paperclipSkillSync: {
          ...object(object(full?.adapterConfig).paperclipSkillSync),
          desiredSkills,
        },
      };
      await lifecycle.updateConfiguration(agent.id, {
        runtimeConfig,
        adapterConfig,
        budgetMonthlyCents,
        title: "Platform Health",
        capabilities: "Detect and remediate fleet budget hard-stops, pending accounting, stuck resumes, and stranded decisions-desk recoveries.",
        metadata: medicMetadata,
      }, { recordRevision: { createdByUserId: actorUserId, source: "platform_health.ensure_medic" } });
      await budgets.upsertPolicy(companyId, {
        scopeType: "agent",
        scopeId: agent.id,
        amount: budgetMonthlyCents,
        windowKind: "calendar_month_utc",
        hardStopEnabled: true,
        unpricedUsagePolicy: "allow",
        isActive: budgetMonthlyCents > 0,
      }, actorUserId);
      const [updated] = await db.select().from(agents).where(eq(agents.id, agent.id)).limit(1);
      return { created: false, dryRun: false, agent: updated };
    }

    if (input.dryRun) {
      return { created: true, dryRun: true, agent: null };
    }

    let reportsTo = input.reportsToAgentId ?? null;
    if (!reportsTo) {
      const [atlas] = await db.select({ id: agents.id }).from(agents).where(and(
        eq(agents.companyId, companyId),
        eq(agents.name, "Atlas"),
        sql`${agents.lifecycleState} <> 'terminated'`,
      )).limit(1);
      reportsTo = atlas?.id ?? null;
    }

    const hired = await lifecycle.requestHire(companyId, {
      name: PLATFORM_HEALTH_AGENT_NAME,
      role: "devops",
      title: "Platform Health",
      capabilities: "Detect and remediate fleet budget hard-stops, pending accounting, stuck resumes, and stranded decisions-desk recoveries.",
      adapterType: "hermes_local",
      adapterConfig: skillAdapterConfig,
      runtimeConfig: { heartbeat: desiredHeartbeat },
      budgetMonthlyCents,
      reportsTo,
      metadata: medicMetadata,
    }, { createdByUserId: actorUserId });

    await budgets.upsertPolicy(companyId, {
      scopeType: "agent",
      scopeId: hired.id,
      amount: budgetMonthlyCents,
      windowKind: "calendar_month_utc",
      hardStopEnabled: true,
      unpricedUsagePolicy: "allow",
      isActive: budgetMonthlyCents > 0,
    }, actorUserId);

    return { created: true, dryRun: false, agent: hired };
  }

  type DeskProposal = {
    class: PlatformHealthIssueClass;
    action: PlatformHealthAction;
    fingerprint: string;
    runId?: string | null;
    issueId?: string | null;
    recoveryActionId?: string | null;
    agentId?: string | null;
    endpoint: string;
    body?: Record<string, unknown>;
    reason: string;
    autoApplySafe: boolean;
  };

  /**
   * After accounting/lifecycle heals, propose decisions-desk follow-ups.
   * Prefer POST apply-desk-triage for board-privileged retries/resolves.
   */
  async function proposeDeskActions(companyId: string) {
    const snapshot = await getHealthSnapshot(companyId);
    const pausedIds = new Set(snapshot.pausedBudgetAgents.map((agent) => agent.id));
    const proposals: DeskProposal[] = [];

    for (const finding of snapshot.findings) {
      if (finding.class === "stranded_failed_run" && finding.runId) {
        if (!finding.agentId) {
          proposals.push({
            class: finding.class,
            action: "escalate",
            fingerprint: finding.fingerprint,
            runId: finding.runId,
            issueId: finding.issueId,
            agentId: null,
            endpoint: "none",
            reason: "Failed run has no assignee agent",
            autoApplySafe: false,
          });
          continue;
        }
        if (pausedIds.has(finding.agentId)) {
          proposals.push({
            class: finding.class,
            action: "escalate",
            fingerprint: finding.fingerprint,
            runId: finding.runId,
            issueId: finding.issueId,
            agentId: finding.agentId,
            endpoint: "none",
            reason: "Assignee still budget-paused; heal accounting first",
            autoApplySafe: false,
          });
          continue;
        }
        proposals.push({
          class: finding.class,
          action: "retry_failed_run",
          fingerprint: finding.fingerprint,
          runId: finding.runId,
          issueId: finding.issueId,
          agentId: finding.agentId,
          endpoint: `POST /api/companies/${companyId}/ops/health/apply-desk-triage`,
          body: {
            reason: "retry_failed_run",
            failedRunId: finding.runId,
            ...(finding.issueId ? { issueId: finding.issueId } : {}),
          },
          reason: "Bounded retry exhausted; underlying pause appears clear",
          autoApplySafe: true,
        });
      }
      if (finding.class === "stranded_recovery_action" && finding.issueId && finding.recoveryActionId) {
        const resolvePlan = await planRecoveryResolve(companyId, {
          issueId: finding.issueId,
          recoveryActionId: finding.recoveryActionId,
          pausedIds,
        });
        proposals.push({
          class: finding.class,
          action: resolvePlan.action,
          fingerprint: finding.fingerprint,
          issueId: finding.issueId,
          recoveryActionId: finding.recoveryActionId,
          agentId: resolvePlan.agentId,
          endpoint: resolvePlan.autoApplySafe
            ? `POST /api/companies/${companyId}/ops/health/apply-desk-triage`
            : "none",
          body: resolvePlan.body,
          reason: resolvePlan.reason,
          autoApplySafe: resolvePlan.autoApplySafe,
        });
      }
      if (finding.class === "blocker_attention") {
        proposals.push({
          class: finding.class,
          action: "escalate",
          fingerprint: finding.fingerprint,
          issueId: finding.issueId,
          endpoint: finding.issueId ? `GET /api/issues/${finding.issueId}/heartbeat-context` : "none",
          reason: "Human unblock owner required; inspect blocker graph before mutating",
          autoApplySafe: false,
        });
      }
    }

    return {
      companyId,
      checkedAt: snapshot.checkedAt,
      proposals,
    };
  }

  async function planRecoveryResolve(
    companyId: string,
    input: { issueId: string; recoveryActionId: string; pausedIds: Set<string> },
  ): Promise<{
    action: PlatformHealthAction;
    autoApplySafe: boolean;
    body?: Record<string, unknown>;
    reason: string;
    agentId?: string | null;
  }> {
    const [issue] = await db.select({
      id: issues.id,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
    }).from(issues).where(and(
      eq(issues.id, input.issueId),
      eq(issues.companyId, companyId),
    )).limit(1);
    const [action] = await db.select({
      id: issueRecoveryActions.id,
      cause: issueRecoveryActions.cause,
      returnOwnerAgentId: issueRecoveryActions.returnOwnerAgentId,
      ownerType: issueRecoveryActions.ownerType,
      status: issueRecoveryActions.status,
    }).from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.id, input.recoveryActionId),
      eq(issueRecoveryActions.companyId, companyId),
    )).limit(1);

    if (!issue || !action) {
      return {
        action: "escalate",
        autoApplySafe: false,
        reason: "Recovery action or source issue missing",
      };
    }

    if (
      requiresExecutionReconciliation(action.cause)
      || isNativeWorkspaceExportRepairCause(action.cause)
      || action.cause === "native_workspace_finalization_owner_unverified"
      || action.cause === "native_workspace_sync_out_unsafe_archive"
    ) {
      return {
        action: "escalate",
        autoApplySafe: false,
        reason: `Recovery cause ${action.cause} requires board reconciliation / workspace repair`,
      };
    }

    if (issue.status === "done" || issue.status === "cancelled" || issue.status === "in_review") {
      return {
        action: "resolve_recovery_action",
        autoApplySafe: true,
        agentId: issue.assigneeAgentId,
        body: {
          actionId: action.id,
          outcome: issue.status === "in_review" ? "cancelled" : "restored",
          sourceIssueStatus: issue.status,
          resolutionNote: "Cleared by MEDIC after platform-health heal; source already terminal/review",
        },
        reason: `Source issue is ${issue.status}; safe to clear stranded recovery`,
      };
    }

    if (issue.status === "blocked") {
      const returnOwnerId = action.returnOwnerAgentId ?? issue.assigneeAgentId;
      if (!returnOwnerId) {
        return {
          action: "escalate",
          autoApplySafe: false,
          reason: "Blocked recovery has no return owner to restore",
        };
      }
      if (input.pausedIds.has(returnOwnerId)) {
        return {
          action: "escalate",
          autoApplySafe: false,
          agentId: returnOwnerId,
          reason: "Return owner still budget-paused; heal accounting first",
        };
      }
      const [owner] = await db.select({
        id: agents.id,
        status: agents.status,
      }).from(agents).where(and(
        eq(agents.id, returnOwnerId),
        eq(agents.companyId, companyId),
      )).limit(1);
      if (!owner || owner.status === "paused" || owner.status === "terminated") {
        return {
          action: "escalate",
          autoApplySafe: false,
          agentId: returnOwnerId,
          reason: "Return owner unavailable; resume or reassign before restore",
        };
      }
      return {
        action: "resolve_recovery_action",
        autoApplySafe: true,
        agentId: returnOwnerId,
        body: {
          actionId: action.id,
          outcome: "restored",
          sourceIssueStatus: "todo",
          resolutionNote: "Restored by MEDIC after platform-health heal cleared the underlying blocker",
        },
        reason: "Board/user-owned blocked recovery safe to hand back after heal",
      };
    }

    return {
      action: "escalate",
      autoApplySafe: false,
      agentId: issue.assigneeAgentId,
      reason: `Source issue status ${issue.status} is not an auto-safe resolve target`,
    };
  }

  /**
   * Apply safe decisions-desk retries/resolves with board privilege.
   * MEDIC calls this instead of agent wakeup / recovery-actions/resolve.
   */
  async function applyDeskTriage(
    companyId: string,
    input: PlatformHealthApplyDeskTriage,
    actorId: string,
  ) {
    const dryRun = input.dryRun ?? false;
    const maxActions = input.maxActions ?? 10;
    const applyRetries = input.applyRetries !== false;
    const applyResolves = input.applyResolves !== false;
    const triage = await proposeDeskActions(companyId);
    const boardUserId = await boardActorUserId(companyId);
    const results: Array<{
      action: PlatformHealthAction;
      fingerprint: string;
      applied: boolean;
      skippedReason?: string;
      runId?: string | null;
      issueId?: string | null;
      recoveryActionId?: string | null;
      agentId?: string | null;
      result?: Record<string, unknown>;
    }> = [];
    let applied = 0;
    let skipped = 0;

    for (const proposal of triage.proposals) {
      if (applied >= maxActions) {
        skipped++;
        results.push({
          action: proposal.action,
          fingerprint: proposal.fingerprint,
          applied: false,
          skippedReason: "max_actions",
          runId: proposal.runId,
          issueId: proposal.issueId,
          recoveryActionId: proposal.recoveryActionId,
          agentId: proposal.agentId,
        });
        continue;
      }

      if (!proposal.autoApplySafe) {
        skipped++;
        results.push({
          action: proposal.action,
          fingerprint: proposal.fingerprint,
          applied: false,
          skippedReason: "not_auto_safe",
          runId: proposal.runId,
          issueId: proposal.issueId,
          recoveryActionId: proposal.recoveryActionId,
          agentId: proposal.agentId,
        });
        continue;
      }

      if (proposal.action === "retry_failed_run") {
        if (!applyRetries) {
          skipped++;
          results.push({
            action: proposal.action,
            fingerprint: proposal.fingerprint,
            applied: false,
            skippedReason: "retries_disabled",
            runId: proposal.runId,
            issueId: proposal.issueId,
            agentId: proposal.agentId,
          });
          continue;
        }
        if (!hooks.wakeupAgent || !proposal.agentId || !proposal.runId) {
          skipped++;
          results.push({
            action: proposal.action,
            fingerprint: proposal.fingerprint,
            applied: false,
            skippedReason: !hooks.wakeupAgent ? "wakeup_hook_missing" : "missing_agent_or_run",
            runId: proposal.runId,
            issueId: proposal.issueId,
            agentId: proposal.agentId,
          });
          continue;
        }

        const prior = await countHealsToday(companyId, proposal.fingerprint);
        if (prior >= 3) {
          skipped++;
          results.push({
            action: proposal.action,
            fingerprint: proposal.fingerprint,
            applied: false,
            skippedReason: `loop_cap_${prior}`,
            runId: proposal.runId,
            issueId: proposal.issueId,
            agentId: proposal.agentId,
          });
          continue;
        }

        if (dryRun) {
          results.push({
            action: proposal.action,
            fingerprint: proposal.fingerprint,
            applied: false,
            runId: proposal.runId,
            issueId: proposal.issueId,
            agentId: proposal.agentId,
            result: { dryRun: true },
          });
          applied++;
          continue;
        }

        try {
          const wake = await hooks.wakeupAgent({
            agentId: proposal.agentId,
            source: "on_demand",
            triggerDetail: "manual",
            reason: "retry_failed_run",
            failedRunId: proposal.runId,
            issueId: proposal.issueId ?? null,
            requestedByUserId: boardUserId,
          });
          await recordHeal(companyId, actorId, {
            class: proposal.class,
            fingerprint: proposal.fingerprint,
            agentId: proposal.agentId,
            agentName: null,
            runId: proposal.runId,
            issueId: proposal.issueId,
            detail: proposal.reason,
            autoSafe: true,
            recommendedAction: "retry_failed_run",
          }, "retry_failed_run", true, {
            wakeRunId: wake && typeof wake === "object" && "id" in wake
              ? (wake as { id?: string }).id ?? null
              : null,
          });
          results.push({
            action: proposal.action,
            fingerprint: proposal.fingerprint,
            applied: true,
            runId: proposal.runId,
            issueId: proposal.issueId,
            agentId: proposal.agentId,
            result: { wake },
          });
          applied++;
        } catch (error) {
          skipped++;
          results.push({
            action: proposal.action,
            fingerprint: proposal.fingerprint,
            applied: false,
            skippedReason: error instanceof Error ? error.message : "retry_failed",
            runId: proposal.runId,
            issueId: proposal.issueId,
            agentId: proposal.agentId,
          });
        }
        continue;
      }

      if (proposal.action === "resolve_recovery_action") {
        if (!applyResolves) {
          skipped++;
          results.push({
            action: proposal.action,
            fingerprint: proposal.fingerprint,
            applied: false,
            skippedReason: "resolves_disabled",
            issueId: proposal.issueId,
            recoveryActionId: proposal.recoveryActionId,
            agentId: proposal.agentId,
          });
          continue;
        }
        if (!proposal.issueId || !proposal.recoveryActionId || !proposal.body) {
          skipped++;
          results.push({
            action: proposal.action,
            fingerprint: proposal.fingerprint,
            applied: false,
            skippedReason: "incomplete_resolve_payload",
            issueId: proposal.issueId,
            recoveryActionId: proposal.recoveryActionId,
          });
          continue;
        }

        const prior = await countHealsToday(companyId, proposal.fingerprint);
        if (prior >= 3) {
          skipped++;
          results.push({
            action: proposal.action,
            fingerprint: proposal.fingerprint,
            applied: false,
            skippedReason: `loop_cap_${prior}`,
            issueId: proposal.issueId,
            recoveryActionId: proposal.recoveryActionId,
            agentId: proposal.agentId,
          });
          continue;
        }

        if (dryRun) {
          results.push({
            action: proposal.action,
            fingerprint: proposal.fingerprint,
            applied: false,
            issueId: proposal.issueId,
            recoveryActionId: proposal.recoveryActionId,
            agentId: proposal.agentId,
            result: { dryRun: true, body: proposal.body },
          });
          applied++;
          continue;
        }

        try {
          const outcome = text(proposal.body.outcome);
          const sourceIssueStatus = text(proposal.body.sourceIssueStatus);
          const resolutionNote = text(proposal.body.resolutionNote);
          if (!outcome || !sourceIssueStatus) {
            throw new Error("resolve payload missing outcome/sourceIssueStatus");
          }

          const [before] = await db.select({
            id: issues.id,
            status: issues.status,
            assigneeAgentId: issues.assigneeAgentId,
          }).from(issues).where(and(
            eq(issues.id, proposal.issueId),
            eq(issues.companyId, companyId),
          )).limit(1);
          if (!before) throw notFound("Issue not found");

          let issueAfter = before;
          if (sourceIssueStatus !== before.status) {
            const updated = await issuesSvc.update(proposal.issueId, {
              status: sourceIssueStatus,
              actorUserId: boardUserId,
            });
            if (!updated) throw notFound("Issue not found");
            issueAfter = {
              id: updated.id,
              status: updated.status,
              assigneeAgentId: updated.assigneeAgentId,
            };
          }

          const actionStatus = outcome === "cancelled" ? "cancelled" : "resolved";
          const resolved = await recoveryActions.resolveActiveForIssue({
            companyId,
            sourceIssueId: proposal.issueId,
            actionId: proposal.recoveryActionId,
            status: actionStatus,
            outcome: outcome as IssueRecoveryActionOutcome,
            resolutionNote,
          });
          if (!resolved) throw notFound("Active recovery action not found");

          let wake: unknown = null;
          if (
            outcome === "restored"
            && sourceIssueStatus === "todo"
            && issueAfter.assigneeAgentId
            && hooks.wakeupAgent
          ) {
            wake = await hooks.wakeupAgent({
              agentId: issueAfter.assigneeAgentId,
              source: "automation",
              triggerDetail: "system",
              reason: "issue_recovery_action_restored",
              issueId: proposal.issueId,
              recoveryActionId: proposal.recoveryActionId,
              requestedByUserId: boardUserId,
            });
          }

          await recordHeal(companyId, actorId, {
            class: proposal.class,
            fingerprint: proposal.fingerprint,
            agentId: issueAfter.assigneeAgentId,
            agentName: null,
            recoveryActionId: proposal.recoveryActionId,
            issueId: proposal.issueId,
            detail: proposal.reason,
            autoSafe: true,
            recommendedAction: "resolve_recovery_action",
          }, "resolve_recovery_action", true, {
            outcome,
            sourceIssueStatus,
            previousIssueStatus: before.status,
          });

          results.push({
            action: proposal.action,
            fingerprint: proposal.fingerprint,
            applied: true,
            issueId: proposal.issueId,
            recoveryActionId: proposal.recoveryActionId,
            agentId: issueAfter.assigneeAgentId,
            result: { recoveryAction: resolved, issueStatus: issueAfter.status, wake },
          });
          applied++;
        } catch (error) {
          skipped++;
          results.push({
            action: proposal.action,
            fingerprint: proposal.fingerprint,
            applied: false,
            skippedReason: error instanceof Error ? error.message : "resolve_failed",
            issueId: proposal.issueId,
            recoveryActionId: proposal.recoveryActionId,
            agentId: proposal.agentId,
          });
        }
        continue;
      }

      skipped++;
      results.push({
        action: proposal.action,
        fingerprint: proposal.fingerprint,
        applied: false,
        skippedReason: "unsupported_desk_action",
        issueId: proposal.issueId,
        agentId: proposal.agentId,
      });
    }

    return {
      dryRun,
      companyId,
      checkedAt: triage.checkedAt,
      applied,
      skipped,
      maxActions,
      results,
    };
  }

  return {
    getHealthSnapshot,
    settlePendingRun,
    reconcileAndResume,
    autoHeal,
    reapPendingReceipts,
    ensureMedicAgent,
    proposeDeskActions,
    applyDeskTriage,
  };
}

export type PlatformHealthService = ReturnType<typeof platformHealthService>;
