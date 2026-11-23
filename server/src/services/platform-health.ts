import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  agents,
  budgetIncidents,
  budgetPolicies,
  budgetReservations,
  companies,
  connectionGrants,
  costEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  projectWorkspaces,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import {
  PLATFORM_HEALTH_AGENT_NAME,
  isNativeWorkspaceExportRepairCause,
  isToolConnectionAttentionHealth,
  requiresExecutionReconciliation,
  type IssueRecoveryActionOutcome,
  type PlatformHealthAction,
  type PlatformHealthApplyDeskTriage,
  type PlatformHealthAutoHeal,
  type PlatformHealthDiagnoseConnector,
  type PlatformHealthEnsureMedic,
  type PlatformHealthIssueClass,
  type PlatformHealthProbeConnector,
  type PlatformHealthReconcileResume,
  type PlatformHealthSettlePendingRun,
  type ToolConnectionHealthStatus,
} from "@paperclipai/shared";
import { badRequest, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import {
  agentInstructionsService,
  resolveManagedInstructionsRoot,
} from "./agent-instructions.js";
import { createAgentLifecycle, scheduleAgentLifecycle } from "./agent-lifecycle.js";
import { listAttentionExhaustedRuns } from "./attention-exhausted-runs.js";
import { budgetService, type BudgetServiceHooks } from "./budgets.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { createGitRemoteAuthProvider } from "./git-credentials.js";
import { ensureManagedProjectWorkspace } from "./heartbeat/workspaces.js";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { issueService } from "./issues.js";
import {
  aggregateHermesSessionUsage,
  extractHermesSessionIdFromRunLog,
  readHermesSessionUsage,
  resolveHermesStateDbPath,
} from "./platform-health-hermes.js";
import { projectService } from "./projects.js";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { accountRunCost } from "./run-cost-accounting.js";
import { requestTaskRetry } from "./task-retry.js";
import { persistUsageReceipt, spoolUsageReceipt } from "./usage-receipts.js";

/** Durable MEDIC instructions (managed AGENTS.md). Keep in sync with ensureMedic promptTemplate. */
export function buildMedicAgentsMd(): string {
  return `# MEDIC — Platform Health

## Mission
Keep the YieldMate Paperclip fleet runnable. Detect and remediate budget hard-stops from pending/unpriced accounting, stuck lifecycle resumes, stranded Decisions-desk recoveries, and broken/expired tool connectors. Prefer ops APIs over one-off database edits. Be decisive; do not explore the codebase.

## Reporting line
You report to Atlas (Chief of Staff). Escalate true overspend, missing provider evidence, board-owned recovery actions, and connectors that need human reconnect — do not raise budget caps yourself and do not complete OAuth reconnects yourself.

## Skills
- \`paperclipai/bundled/paperclip-operations/platform-health\` — primary protocol
- \`paperclip\` — Paperclip REST conventions

## Auth (every curl)
First shell line (also loads \`$HERMES_DISPOSITION_FILE\`):
\`\`\`bash
set -a && . "\${HERMES_PAPERCLIP_ENV_FILE:?missing}" && set +a
\`\`\`
REST: \`$PAPERCLIP_API_URL\` (append \`/api\` if missing), \`Authorization: Bearer $PAPERCLIP_API_KEY\`, \`X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\`.
Never use MCP overlay bearers for \`/api\` calls.
Ignore unrelated Connection MCP tool overlays (Penpot/design) — platform health uses REST ops APIs only.

## Wake protocol (max ~10 tool calls)
1. \`GET /api/companies/{{companyId}}/ops/health/snapshot\`.
2. If \`empty\` is false and metadata \`autoHeal: true\` — immediately \`POST .../ops/health/auto-heal\` with \`{"dryRun":false,"maxActions":10,"applyDeskTriage":true,"maxDeskActions":10}\`. Do not dry-run first.
3. If desk work was omitted or \`deskTriage.applied\` is 0 while stranded failed-run / recovery findings remain, \`POST .../ops/health/apply-desk-triage\` with \`{"dryRun":false,"maxActions":10}\`. Do not call agent wakeup or \`recovery-actions/resolve\` yourself — apply-desk-triage owns board privilege.
4. **Connectors (hourly):** Inspect \`connectorFindings\`. Escalate only rows with \`reportDue: true\` (server already applies the hourly cadence). Name connection, app, healthStatus, healthMessage, and that a human must reconnect if OAuth expired. Never auto-reconnect OAuth.
5. **Operator diagnose:** When the wake prompt names an agent + connector (e.g. "Steve cannot access Linear"), \`POST .../ops/health/connectors/diagnose\` with \`{"agentName":"Steve","applicationKey":"linear","probe":true}\` (or connectionId/connectionName). Report whether the connection itself is unhealthy vs the agent lacks tool access while the connection is fine.
6. After sourcing the env file, write \`$HERMES_DISPOSITION_FILE\` as \`{"status":"in_progress","comment":"<one short paragraph: auto-heal + desk + connectors>"}\` and stop. If \`empty:true\` and no due connector findings and no diagnose request, comment \`healthy\` and stop.

## Auto-safe vs escalate
Auto-safe: settle pre-provider failures, Hermes incomplete receipts with session evidence, clear non-billable unpriced events, stuck \`resuming\`, budget pause without true overspend (after pending heals), \`workspace_validation_stranded\` via auto-heal \`repair_project_workspace_git\` when the project workspace has a \`repoUrl\`, safe desk retries/resolves for non-workspace causes.
Escalate (comment + stop): true overspend (\`spent >= budget\`), unpriced usage with no Hermes/provider evidence, workspace validation without a repairable \`repoUrl\`, same fingerprint healed ≥ 3 times today, cross-company or destructive requests, budget-paused assignees for desk wakes, \`connector_unhealthy\` / expired OAuth (human reconnect).

## Don't
- Invent $0 receipts when billable evidence exists
- Resume \`manual\` / \`setup\` pauses or true overspend
- Raise monthly budget caps (board-only)
- Wake stranded issue recovery while the assignee is still budget-paused
- Desk-resolve \`workspace_validation_failed\` as restored without repairing git/cwd — use auto-heal repair only
- Auto-reconnect OAuth or invent connector credentials
- Overload CHO / GOMEZ / Atlas with this role — MEDIC owns platform health
`;
}

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"] as const;
const PRE_PROVIDER_ERROR_RE = /spawn\s+E2BIG|E2BIG|ENOENT|failed to spawn|bootstrap/i;
const MAX_REAPER_BATCH = 25;
const HEAL_ACTIVITY_ACTION = "platform_health.heal";
const CONNECTOR_ALERT_ACTIVITY_ACTION = "platform_health.connector_alert";
const DEFAULT_CONNECTOR_CHECK_INTERVAL_SEC = 3_600;
const CONNECTOR_STALE_PROBE_MS = 2 * 60 * 60_000;

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
  connectionId?: string | null;
  connectionName?: string | null;
  applicationKey?: string | null;
  applicationName?: string | null;
  healthStatus?: string | null;
  detail: string;
  autoSafe: boolean;
  recommendedAction: PlatformHealthAction;
  /** Connector findings only: true when hourly report cadence says escalate now. */
  reportDue?: boolean;
}

export interface PlatformHealthConnectorFinding extends PlatformHealthFinding {
  connectionId: string;
  connectionName: string;
  applicationKey: string | null;
  applicationName: string | null;
  healthStatus: string;
  reportDue: boolean;
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
  companyId?: string;
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
    let sessionId = run.sessionIdAfter;
    if (!sessionId && run.companyId) {
      sessionId = extractHermesSessionIdFromRunLog({
        companyId: run.companyId,
        agentId: run.agentId,
        runId: run.id,
      });
    }
    // Capture-failed runs are healable via hermes estimate (settle clears the
    // fence). Without a session id they must escalate — never leave the reaper
    // appending unused receipts against a permanent capture failure.
    return {
      class: "pending_incomplete_receipt",
      fingerprint: fingerprintFor(["pending_receipt", run.id]),
      agentId: run.agentId,
      agentName: run.agentName,
      runId: run.id,
      detail: sessionId
        ? `Incomplete receipt; Hermes session ${sessionId}${usage.accountingCaptureFailed === true ? " (capture failed)" : ""}`
        : "Incomplete accounting receipt with no session id",
      autoSafe: Boolean(sessionId),
      recommendedAction: sessionId ? "settle_hermes_estimate" : "escalate",
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

  async function recentConnectorAlertAt(companyId: string, fingerprint: string): Promise<Date | null> {
    const [row] = await db.execute<{ created_at: Date }>(sql`
      select created_at
      from activity_log
      where company_id = ${companyId}
        and action = ${CONNECTOR_ALERT_ACTIVITY_ACTION}
        and details->>'fingerprint' = ${fingerprint}
      order by created_at desc
      limit 1
    `);
    return asDate(row?.created_at);
  }

  async function recordConnectorAlert(
    companyId: string,
    actorId: string,
    finding: PlatformHealthConnectorFinding,
  ) {
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId,
      action: CONNECTOR_ALERT_ACTIVITY_ACTION,
      entityType: "tool_connection",
      entityId: finding.connectionId,
      details: {
        fingerprint: finding.fingerprint,
        class: finding.class,
        connectionId: finding.connectionId,
        connectionName: finding.connectionName,
        applicationKey: finding.applicationKey,
        healthStatus: finding.healthStatus,
        detail: finding.detail,
      },
    });
  }

  async function resolveMedicConnectorIntervalSec(companyId: string): Promise<number> {
    const [medic] = await db.select({
      metadata: agents.metadata,
    }).from(agents).where(and(
      eq(agents.companyId, companyId),
      eq(agents.name, PLATFORM_HEALTH_AGENT_NAME),
      sql`${agents.lifecycleState} <> 'terminated'`,
    )).limit(1);
    const meta = object(medic?.metadata);
    const raw = Number(meta.connectorCheckIntervalSec);
    if (Number.isFinite(raw) && raw >= 60) return Math.min(raw, 24 * 3_600);
    return DEFAULT_CONNECTOR_CHECK_INTERVAL_SEC;
  }

  async function listConnectorFindings(
    companyId: string,
    opts?: { connectorCheckIntervalSec?: number },
  ): Promise<PlatformHealthConnectorFinding[]> {
    const intervalSec = opts?.connectorCheckIntervalSec
      ?? await resolveMedicConnectorIntervalSec(companyId);
    const intervalMs = intervalSec * 1000;
    const rows = await db.select({
      id: toolConnections.id,
      name: toolConnections.name,
      status: toolConnections.status,
      enabled: toolConnections.enabled,
      healthStatus: toolConnections.healthStatus,
      healthMessage: toolConnections.healthMessage,
      lastError: toolConnections.lastError,
      healthCheckedAt: toolConnections.healthCheckedAt,
      applicationKey: toolApplications.applicationKey,
      applicationName: toolApplications.name,
      sourceTemplateKey: sql<string | null>`coalesce(${toolConnections.config}->>'sourceTemplateKey', ${toolConnections.transportConfig}->>'sourceTemplateKey')`,
    }).from(toolConnections)
      .innerJoin(toolApplications, and(
        eq(toolApplications.id, toolConnections.applicationId),
        eq(toolApplications.companyId, toolConnections.companyId),
      ))
      .where(and(
        eq(toolConnections.companyId, companyId),
        eq(toolConnections.enabled, true),
        eq(toolConnections.status, "active"),
        sql`${toolConnections.transport} not in ('chat_sdk', 'runtime_auth')`,
        sql`${toolApplications.type} is distinct from 'paperclip_plugin'`,
      ))
      .limit(200);

    const findings: PlatformHealthConnectorFinding[] = [];
    for (const row of rows) {
      const healthStatus = (row.healthStatus ?? "unchecked") as ToolConnectionHealthStatus;
      const checkedAt = asDate(row.healthCheckedAt);
      const attention = isToolConnectionAttentionHealth(healthStatus);
      const stale = !checkedAt || (Date.now() - checkedAt.getTime()) > CONNECTOR_STALE_PROBE_MS;
      if (!attention && !stale) continue;

      const className: PlatformHealthIssueClass = attention
        ? "connector_unhealthy"
        : "connector_stale_probe";
      const fingerprint = fingerprintFor([className, row.id, healthStatus]);
      const lastAlert = await recentConnectorAlertAt(companyId, fingerprint);
      const reportDue = !lastAlert || (Date.now() - lastAlert.getTime()) >= intervalMs;
      const appKey = text(row.applicationKey) ?? text(row.sourceTemplateKey);
      findings.push({
        class: className,
        fingerprint,
        agentId: null,
        agentName: null,
        connectionId: row.id,
        connectionName: row.name,
        applicationKey: appKey,
        applicationName: row.applicationName,
        healthStatus,
        detail: attention
          ? `${row.name}: health=${healthStatus}${row.healthMessage ? ` — ${row.healthMessage}` : ""}${row.lastError ? ` (${row.lastError})` : ""}`
          : `${row.name}: health probe stale (last checked ${checkedAt?.toISOString() ?? "never"})`,
        autoSafe: false,
        recommendedAction: attention ? "escalate_connector" : "probe_connection_health",
        reportDue,
      });
    }
    return findings;
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
    let sessionId = run.sessionIdAfter;
    if (!sessionId) {
      // Older hermes adapters missed non-quiet `Session:` footers — recover from the run log.
      const recovered = extractHermesSessionIdFromRunLog({
        companyId,
        agentId: run.agentId,
        runId,
      });
      if (recovered) {
        sessionId = recovered;
        if (!dryRun) {
          await db.update(heartbeatRuns).set({ sessionIdAfter: recovered }).where(eq(heartbeatRuns.id, runId));
        }
      }
    }
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
    // Operator/reaper estimates intentionally replace a failed live capture.
    // Clear the capture-failed fence first: otherwise persist keeps
    // accountingReceiptReady=false and accountRunCost refuses to settle, so
    // each reaper tick appends another unused receipt forever.
    if (previous.accountingCaptureFailed === true) {
      await db.update(heartbeatRuns).set({
        accountingLastError: null,
        usageJson: sql`coalesce(${heartbeatRuns.usageJson}, '{}'::jsonb) || ${JSON.stringify({
          accountingCaptureFailed: false,
        })}::jsonb`,
      }).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)));
    }
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
    try {
      await persistUsageReceipt(db, envelope);
      await fs.rm(file, { force: true });
    } catch (error) {
      // Leave the fsynced spool file for replayUsageReceipts; do not create a
      // second estimate on the next reaper tick for the same unresolved debt.
      throw error;
    }
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

  async function getHealthSnapshot(companyId: string, opts?: {
    pendingAgeMinutes?: number;
    resumingAgeMinutes?: number;
    connectorCheckIntervalSec?: number;
    includeConnectors?: boolean;
  }) {
    // Keep short: incomplete Hermes receipts should settle before budget hard-stops stick.
    const pendingAge = minutesAgo(opts?.pendingAgeMinutes ?? 1);
    const resumingAge = minutesAgo(opts?.resumingAgeMinutes ?? 2);
    const includeConnectors = opts?.includeConnectors !== false;

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

    // Mid-pause with holds already cleared (false budget hard-stop) never reaches
    // paused→resuming without an explicit reconcile.
    const stuckPausing = await db.select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
      pauseReason: agents.pauseReason,
      lifecycleState: agents.lifecycleState,
      lifecycleHolds: agents.lifecycleHolds,
      metadata: agents.metadata,
      updatedAt: agents.updatedAt,
    }).from(agents).where(and(
      eq(agents.companyId, companyId),
      eq(agents.lifecycleState, "pausing"),
      sql`coalesce(jsonb_array_length(${agents.lifecycleHolds}), 0) = 0`,
      lt(agents.updatedAt, resumingAge),
    ));

    const pendingRuns = await db.select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
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
      cause: issueRecoveryActions.cause,
      updatedAt: issueRecoveryActions.updatedAt,
    }).from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, companyId),
      inArray(issueRecoveryActions.status, ["active", "escalated"]),
      inArray(issueRecoveryActions.ownerType, ["user", "board"]),
    )).limit(100).catch(() => [] as Array<{
      id: string; sourceIssueId: string; status: string; ownerType: string; cause: string; updatedAt: Date;
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

    for (const agent of stuckPausing) {
      findings.push({
        class: "stuck_resuming",
        fingerprint: fingerprintFor(["stuck_pausing", agent.id]),
        agentId: agent.id,
        agentName: agent.name,
        detail: `lifecycleState=pausing with empty holds since ${asDate(agent.updatedAt)?.toISOString() ?? "unknown"}`,
        autoSafe: true,
        recommendedAction: "reconcile_resume",
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
      if (action.cause === "workspace_validation_failed") {
        const [issue] = await db.select({
          id: issues.id,
          identifier: issues.identifier,
          projectId: issues.projectId,
          projectWorkspaceId: issues.projectWorkspaceId,
          assigneeAgentId: issues.assigneeAgentId,
        }).from(issues).where(and(
          eq(issues.id, action.sourceIssueId),
          eq(issues.companyId, companyId),
        )).limit(1);
        let repoUrl: string | null = null;
        let projectWorkspaceId = issue?.projectWorkspaceId ?? null;
        if (projectWorkspaceId) {
          const [workspace] = await db.select({
            id: projectWorkspaces.id,
            repoUrl: projectWorkspaces.repoUrl,
          }).from(projectWorkspaces).where(and(
            eq(projectWorkspaces.id, projectWorkspaceId),
            eq(projectWorkspaces.companyId, companyId),
          )).limit(1);
          repoUrl = typeof workspace?.repoUrl === "string" && workspace.repoUrl.trim()
            ? workspace.repoUrl.trim()
            : null;
        }
        const repairable = Boolean(repoUrl && issue?.projectId && projectWorkspaceId);
        findings.push({
          class: "workspace_validation_stranded",
          fingerprint: fingerprintFor(["workspace_validation", action.id]),
          agentId: issue?.assigneeAgentId ?? null,
          agentName: null,
          recoveryActionId: action.id,
          issueId: action.sourceIssueId,
          detail: repairable
            ? `Workspace validation stranded on ${issue?.identifier ?? action.sourceIssueId}; project workspace has repoUrl for repair`
            : `Workspace validation stranded on ${issue?.identifier ?? action.sourceIssueId}; missing project repoUrl/cwd binding`,
          autoSafe: repairable,
          recommendedAction: repairable ? "repair_project_workspace_git" : "escalate",
        });
        continue;
      }
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

    const connectorFindings = includeConnectors
      ? await listConnectorFindings(companyId, {
        connectorCheckIntervalSec: opts?.connectorCheckIntervalSec,
      })
      : [];

    const empty = findings.length === 0
      && pausedBudgetAgents.length === 0
      && stuckPausing.length === 0
      && pendingRuns.length === 0
      && openIncidents.length === 0;

    return {
      companyId,
      checkedAt: new Date().toISOString(),
      empty,
      connectorEmpty: connectorFindings.length === 0,
      connectorReportDue: connectorFindings.some((f) => f.reportDue),
      counts: {
        findings: findings.length,
        pausedBudgetAgents: pausedBudgetAgents.length,
        stuckResuming: stuckResuming.length,
        stuckPausing: stuckPausing.length,
        pendingRuns: pendingRuns.length,
        openIncidents: openIncidents.length,
        unpricedEvents: unpricedEvents.length,
        heldReservations: heldReservations.length,
        exhaustedFailedRuns: exhaustedRuns.length,
        recoveryActions: recoveryActions.length,
        autoSafe: findings.filter((f) => f.autoSafe).length,
        escalate: findings.filter((f) => !f.autoSafe).length,
        connectorFindings: connectorFindings.length,
        connectorReportDue: connectorFindings.filter((f) => f.reportDue).length,
      },
      pausedBudgetAgents,
      stuckResuming,
      stuckPausing,
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
      connectorFindings,
    };
  }

  async function probeConnector(
    companyId: string,
    input: PlatformHealthProbeConnector,
    actorId: string,
  ) {
    const connectionId = input.connectionId;
    const [row] = await db.select({
      id: toolConnections.id,
      companyId: toolConnections.companyId,
      name: toolConnections.name,
      healthStatus: toolConnections.healthStatus,
    }).from(toolConnections).where(and(
      eq(toolConnections.id, connectionId),
      eq(toolConnections.companyId, companyId),
    )).limit(1);
    if (!row) throw notFound("Tool connection not found");

    const { toolAccessService } = await import("./tool-access.js");
    let probeError: string | null = null;
    try {
      await toolAccessService(db).checkHealth(connectionId, {
        actorType: "system",
        actorId: actorId || "platform_health",
      });
    } catch (error) {
      probeError = error instanceof Error ? error.message : String(error);
    }

    const [after] = await db.select({
      id: toolConnections.id,
      name: toolConnections.name,
      status: toolConnections.status,
      enabled: toolConnections.enabled,
      healthStatus: toolConnections.healthStatus,
      healthMessage: toolConnections.healthMessage,
      lastError: toolConnections.lastError,
      healthCheckedAt: toolConnections.healthCheckedAt,
    }).from(toolConnections).where(eq(toolConnections.id, connectionId)).limit(1);

    return {
      companyId,
      connectionId,
      connectionName: after?.name ?? row.name,
      probed: true,
      probeError,
      beforeHealthStatus: row.healthStatus,
      healthStatus: after?.healthStatus ?? null,
      healthMessage: after?.healthMessage ?? null,
      lastError: after?.lastError ?? null,
      healthCheckedAt: asDate(after?.healthCheckedAt)?.toISOString() ?? null,
      attention: after?.healthStatus
        ? isToolConnectionAttentionHealth(after.healthStatus as ToolConnectionHealthStatus)
        : false,
    };
  }

  async function diagnoseConnector(
    companyId: string,
    input: PlatformHealthDiagnoseConnector,
    actorId: string,
  ) {
    const probe = input.probe !== false;
    let agent: { id: string; name: string; status: string; lifecycleState: string } | null = null;
    if (input.agentId || input.agentName) {
      const [match] = await db.select({
        id: agents.id,
        name: agents.name,
        status: agents.status,
        lifecycleState: agents.lifecycleState,
      }).from(agents).where(and(
        eq(agents.companyId, companyId),
        sql`${agents.lifecycleState} <> 'terminated'`,
        input.agentId ? eq(agents.id, input.agentId) : sql`lower(${agents.name}) = lower(${input.agentName!.trim()})`,
      )).limit(1);
      if (!match) throw notFound(input.agentId ? "Agent not found" : `Agent named ${input.agentName} not found`);
      agent = match;
    }

    const connectionFilters = [
      eq(toolConnections.companyId, companyId),
      sql`${toolConnections.status} is distinct from 'archived'`,
    ];
    if (input.connectionId) {
      connectionFilters.push(eq(toolConnections.id, input.connectionId));
    } else if (input.connectionName) {
      connectionFilters.push(sql`lower(${toolConnections.name}) like lower(${`%${input.connectionName.trim()}%`})`);
    } else if (input.applicationKey) {
      const key = input.applicationKey.trim().toLowerCase();
      connectionFilters.push(sql`(
        lower(coalesce(${toolApplications.applicationKey}, '')) like ${`%${key}%`}
        or lower(coalesce(${toolApplications.name}, '')) like ${`%${key}%`}
        or lower(coalesce(${toolConnections.name}, '')) like ${`%${key}%`}
        or lower(coalesce(${toolConnections.config}->>'sourceTemplateKey', '')) like ${`%${key}%`}
      )`);
    } else {
      throw badRequest("Provide connectionId, connectionName, or applicationKey");
    }

    const candidates = await db.select({
      id: toolConnections.id,
      name: toolConnections.name,
      status: toolConnections.status,
      enabled: toolConnections.enabled,
      healthStatus: toolConnections.healthStatus,
      healthMessage: toolConnections.healthMessage,
      lastError: toolConnections.lastError,
      healthCheckedAt: toolConnections.healthCheckedAt,
      authKind: toolConnections.authKind,
      applicationKey: toolApplications.applicationKey,
      applicationName: toolApplications.name,
      sourceTemplateKey: sql<string | null>`coalesce(${toolConnections.config}->>'sourceTemplateKey', ${toolConnections.transportConfig}->>'sourceTemplateKey')`,
    }).from(toolConnections)
      .innerJoin(toolApplications, and(
        eq(toolApplications.id, toolConnections.applicationId),
        eq(toolApplications.companyId, toolConnections.companyId),
      ))
      .where(and(...connectionFilters))
      .orderBy(desc(toolConnections.updatedAt))
      .limit(10);

    if (candidates.length === 0) throw notFound("No matching tool connection");
    const preferred = candidates.find((c) => c.status === "active" && c.enabled)
      ?? candidates.find((c) => c.status === "active")
      ?? candidates[0];

    let probeResult: Awaited<ReturnType<typeof probeConnector>> | null = null;
    if (probe) {
      probeResult = await probeConnector(companyId, { connectionId: preferred.id }, actorId);
    }

    const [fresh] = await db.select({
      id: toolConnections.id,
      name: toolConnections.name,
      status: toolConnections.status,
      enabled: toolConnections.enabled,
      healthStatus: toolConnections.healthStatus,
      healthMessage: toolConnections.healthMessage,
      lastError: toolConnections.lastError,
      healthCheckedAt: toolConnections.healthCheckedAt,
      authKind: toolConnections.authKind,
    }).from(toolConnections).where(eq(toolConnections.id, preferred.id)).limit(1);

    const installs = await db.select({
      targetType: toolConnectionInstalls.targetType,
      targetId: toolConnectionInstalls.targetId,
      createdAt: toolConnectionInstalls.createdAt,
    }).from(toolConnectionInstalls).where(and(
      eq(toolConnectionInstalls.companyId, companyId),
      eq(toolConnectionInstalls.connectionId, preferred.id),
    )).limit(50);

    const grants = await db.select({
      id: connectionGrants.id,
      kind: connectionGrants.kind,
      status: connectionGrants.status,
      subjectAgentId: connectionGrants.subjectAgentId,
    }).from(connectionGrants).where(and(
      eq(connectionGrants.companyId, companyId),
      eq(connectionGrants.connectionId, preferred.id),
    )).limit(50);

    let agentAccess: Record<string, unknown> | null = null;
    let agentAccessError: string | null = null;
    if (agent) {
      try {
        const { createToolGatewayService } = await import("./tool-gateway.js");
        agentAccess = await createToolGatewayService(db).summarizeConnectionAccessForAgent({
          companyId,
          connectionId: preferred.id,
          agentId: agent.id,
        }) as unknown as Record<string, unknown>;
      } catch (error) {
        agentAccessError = error instanceof Error ? error.message : String(error);
      }
    }

    const healthStatus = (fresh?.healthStatus ?? preferred.healthStatus ?? "unchecked") as ToolConnectionHealthStatus;
    const connectionHealthy = healthStatus === "ok" || healthStatus === "healthy";
    const attention = isToolConnectionAttentionHealth(healthStatus);
    const agentHasInstall = agent
      ? installs.some((i) =>
        (i.targetType === "company" && i.targetId === companyId)
        || (i.targetType === "agent" && i.targetId === agent.id))
      : null;
    const allowedCount = typeof agentAccess?.allowedCount === "number" ? agentAccess.allowedCount : null;
    const toolCount = typeof agentAccess?.toolCount === "number" ? agentAccess.toolCount : null;

    let verdict: string;
    let likelyCause: string;
    if (attention || !connectionHealthy) {
      verdict = "connection_unhealthy";
      likelyCause = fresh?.healthMessage
        ?? fresh?.lastError
        ?? "Connection health requires attention; human reconnect may be required";
    } else if (agent && agentAccess && allowedCount === 0 && (toolCount ?? 0) > 0) {
      verdict = "agent_policy_blocks_tools";
      likelyCause = `${agent.name} has ${toolCount} tools on this connection but none are allowed by policy/profile`;
    } else if (agent && agentAccess && (toolCount ?? 0) === 0) {
      verdict = "agent_missing_tools";
      likelyCause = `${agent.name} sees 0 tools for a healthy connection — likely run-prep / gateway assignment / catalog gap, not expired OAuth`;
    } else if (agent && agentAccessError) {
      verdict = "agent_access_check_failed";
      likelyCause = agentAccessError;
    } else if (agent && connectionHealthy && allowedCount && allowedCount > 0) {
      verdict = "connection_and_agent_access_ok";
      likelyCause = `Connection is healthy and ${agent.name} has ${allowedCount} allowed tools — if the agent still cannot use Linear, the gap is likely wake-time tool registry / gateway token assignment, not the connector credential`;
    } else {
      verdict = connectionHealthy ? "connection_healthy" : "connection_attention";
      likelyCause = fresh?.healthMessage ?? "See healthStatus";
    }

    const finding: PlatformHealthConnectorFinding = {
      class: attention ? "connector_unhealthy" : "unknown",
      fingerprint: fingerprintFor(["diagnose", preferred.id, agent?.id ?? "none"]),
      agentId: agent?.id ?? null,
      agentName: agent?.name ?? null,
      connectionId: preferred.id,
      connectionName: fresh?.name ?? preferred.name,
      applicationKey: text(preferred.applicationKey) ?? text(preferred.sourceTemplateKey),
      applicationName: preferred.applicationName,
      healthStatus,
      detail: `${verdict}: ${likelyCause}`,
      autoSafe: false,
      recommendedAction: attention ? "escalate_connector" : "propose",
      reportDue: true,
    };
    await recordConnectorAlert(companyId, actorId, finding);

    return {
      companyId,
      checkedAt: new Date().toISOString(),
      verdict,
      likelyCause,
      agent,
      connection: {
        id: preferred.id,
        name: fresh?.name ?? preferred.name,
        status: fresh?.status ?? preferred.status,
        enabled: fresh?.enabled ?? preferred.enabled,
        authKind: fresh?.authKind ?? preferred.authKind,
        healthStatus,
        healthMessage: fresh?.healthMessage ?? preferred.healthMessage,
        lastError: fresh?.lastError ?? preferred.lastError,
        healthCheckedAt: asDate(fresh?.healthCheckedAt ?? preferred.healthCheckedAt)?.toISOString() ?? null,
        applicationKey: text(preferred.applicationKey) ?? text(preferred.sourceTemplateKey),
        applicationName: preferred.applicationName,
        attention,
      },
      candidates: candidates.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        enabled: c.enabled,
        healthStatus: c.healthStatus,
        applicationKey: text(c.applicationKey) ?? text(c.sourceTemplateKey),
      })),
      installs: installs.map((i) => ({
        targetType: i.targetType,
        targetId: i.targetId,
        createdAt: asDate(i.createdAt)?.toISOString() ?? null,
      })),
      grants: grants.map((g) => ({
        id: g.id,
        kind: g.kind,
        status: g.status,
        subjectAgentId: g.subjectAgentId,
      })),
      agentInstallPresent: agentHasInstall,
      agentAccess,
      agentAccessError,
      probe: probeResult,
    };
  }

  async function acknowledgeConnectorFindings(
    companyId: string,
    actorId: string,
    fingerprints?: string[],
  ) {
    const findings = await listConnectorFindings(companyId);
    const due = findings.filter((f) => f.reportDue
      && (!fingerprints?.length || fingerprints.includes(f.fingerprint)));
    for (const finding of due) {
      await recordConnectorAlert(companyId, actorId, finding);
    }
    return {
      companyId,
      acknowledged: due.length,
      findings: due,
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

    if (
      agent.pauseReason
      && agent.pauseReason !== "budget"
      && agent.lifecycleState !== "resuming"
      && agent.lifecycleState !== "pausing"
    ) {
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
    // Advance pausing/paused → resuming when budget holds are gone.
    await lifecycle.reconcileAgent(agent.id);
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

  async function repairProjectWorkspaceGit(
    companyId: string,
    input: { issueId: string; recoveryActionId: string },
    dryRun: boolean,
    actorId: string,
  ) {
    const [issue] = await db.select({
      id: issues.id,
      identifier: issues.identifier,
      status: issues.status,
      projectId: issues.projectId,
      projectWorkspaceId: issues.projectWorkspaceId,
      assigneeAgentId: issues.assigneeAgentId,
      executionWorkspaceId: issues.executionWorkspaceId,
    }).from(issues).where(and(
      eq(issues.id, input.issueId),
      eq(issues.companyId, companyId),
    )).limit(1);
    if (!issue) throw notFound("Issue not found");
    if (!issue.projectId || !issue.projectWorkspaceId) {
      return {
        applied: false,
        skippedReason: "issue_missing_project_workspace",
        issueId: issue.id,
      };
    }

    const [workspace] = await db.select({
      id: projectWorkspaces.id,
      cwd: projectWorkspaces.cwd,
      repoUrl: projectWorkspaces.repoUrl,
      repoRef: projectWorkspaces.repoRef,
      defaultRef: projectWorkspaces.defaultRef,
    }).from(projectWorkspaces).where(and(
      eq(projectWorkspaces.id, issue.projectWorkspaceId),
      eq(projectWorkspaces.companyId, companyId),
    )).limit(1);
    const repoUrl = typeof workspace?.repoUrl === "string" && workspace.repoUrl.trim()
      ? workspace.repoUrl.trim()
      : null;
    if (!workspace || !repoUrl) {
      return {
        applied: false,
        skippedReason: "project_workspace_missing_repo_url",
        issueId: issue.id,
        projectWorkspaceId: issue.projectWorkspaceId,
      };
    }

    if (dryRun) {
      return {
        applied: false,
        dryRun: true,
        issueId: issue.id,
        projectWorkspaceId: workspace.id,
        repoUrl,
        currentCwd: workspace.cwd,
      };
    }

    const boardUserId = await boardActorUserId(companyId);
    const existingCwd = typeof workspace.cwd === "string" && workspace.cwd.trim()
      ? workspace.cwd.trim()
      : null;
    const existingHasGit = existingCwd
      ? await fs.lstat(path.resolve(existingCwd, ".git"))
        .then((entry) => entry.isDirectory() || entry.isFile())
        .catch(() => false)
      : false;

    let materializedCwd = existingCwd;
    let materializedWarning: string | null = null;
    if (!existingHasGit) {
      const resolveGitAuth = createGitRemoteAuthProvider(db, companyId, {
        issueId: issue.id,
        responsibleUserId: boardUserId === "local-board" ? null : boardUserId,
      });
      const materialized = await ensureManagedProjectWorkspace({
        companyId,
        projectId: issue.projectId,
        repoUrl,
        resolveGitAuth,
      });
      materializedCwd = materialized.cwd;
      materializedWarning = materialized.warning;
    }
    const hasGit = materializedCwd
      ? await fs.lstat(path.resolve(materializedCwd, ".git"))
        .then((entry) => entry.isDirectory() || entry.isFile())
        .catch(() => false)
      : false;
    if (!materializedCwd || !hasGit) {
      throw unprocessable(
        `Managed project workspace for ${issue.identifier ?? issue.id} still has no .git after materialize`,
        { cwd: materializedCwd, warning: materializedWarning },
      );
    }

    if (workspace.cwd !== materializedCwd) {
      await projectService(db).updateWorkspace(issue.projectId, workspace.id, {
        cwd: materializedCwd,
      });
    }

    const [latestRun] = await db.select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      agentId: heartbeatRuns.agentId,
    }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId),
      or(
        eq(heartbeatRuns.issueId, issue.id),
        eq(heartbeatRuns.nativeIssueId, issue.id),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`,
      ),
    )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);

    if (issue.executionWorkspaceId) {
      await db.update(issues).set({
        executionWorkspaceId: null,
        updatedAt: new Date(),
      }).where(and(
        eq(issues.id, issue.id),
        eq(issues.companyId, companyId),
      ));
    }

    let retry: Awaited<ReturnType<typeof requestTaskRetry>> | null = null;
    if (latestRun && issue.assigneeAgentId && latestRun.agentId === issue.assigneeAgentId) {
      retry = await requestTaskRetry({
        db,
        companyId,
        issueId: issue.id,
        actorId: boardUserId,
        actorSource: "board_key",
        idempotencyKey: randomUUID(),
        observedRunId: latestRun.id,
      });
    }

    if (!retry?.accepted) {
      if (issue.status === "blocked") {
        await issuesSvc.update(issue.id, {
          status: "todo",
          actorUserId: boardUserId,
        });
      }
      await recoveryActions.resolveActiveForIssue({
        companyId,
        sourceIssueId: issue.id,
        actionId: input.recoveryActionId,
        status: "resolved",
        outcome: "restored",
        resolutionNote: "MEDIC repaired project workspace git checkout; handed issue back for execution",
      });
      let wake: unknown = null;
      if (issue.assigneeAgentId && hooks.wakeupAgent) {
        wake = await hooks.wakeupAgent({
          agentId: issue.assigneeAgentId,
          source: "automation",
          triggerDetail: "system",
          reason: "repair_project_workspace_git",
          issueId: issue.id,
          recoveryActionId: input.recoveryActionId,
          requestedByUserId: boardUserId,
        });
      }
      return {
        applied: true,
        issueId: issue.id,
        projectWorkspaceId: workspace.id,
        cwd: materializedCwd,
        warning: materializedWarning,
        retry,
        wake,
        path: "wakeup_after_resolve",
      };
    }

    await recoveryActions.resolveActiveForIssue({
      companyId,
      sourceIssueId: issue.id,
      actionId: input.recoveryActionId,
      status: "resolved",
      outcome: "restored",
      resolutionNote: "MEDIC repaired project workspace git checkout and queued task retry",
    });
    if (issue.status === "blocked") {
      await issuesSvc.update(issue.id, {
        status: "todo",
        actorUserId: boardUserId,
      });
    }

    return {
      applied: true,
      issueId: issue.id,
      projectWorkspaceId: workspace.id,
      cwd: materializedCwd,
      warning: materializedWarning,
      retry,
      path: "task_retry",
    };
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
        if (finding.recommendedAction === "reconcile_resume" && finding.agentId) {
          const result = await reconcileAndResume(companyId, { agentId: finding.agentId, dryRun }, actorId);
          if (!dryRun) await recordHeal(companyId, actorId, finding, "reconcile_resume", true, result);
          results.push({
            finding,
            action: "reconcile_resume",
            dryRun,
            applied: !dryRun && Boolean(result.applied),
            result,
          });
          actionsUsed++;
          continue;
        }
        if (
          finding.recommendedAction === "repair_project_workspace_git"
          && finding.issueId
          && finding.recoveryActionId
        ) {
          const result = await repairProjectWorkspaceGit(companyId, {
            issueId: finding.issueId,
            recoveryActionId: finding.recoveryActionId,
          }, dryRun, actorId);
          const applied = !dryRun && Boolean(result.applied);
          if (!dryRun && applied) {
            await recordHeal(companyId, actorId, finding, "repair_project_workspace_git", true, result);
          }
          results.push({
            finding,
            action: applied || dryRun ? "repair_project_workspace_git" : "escalate",
            dryRun,
            applied,
            result,
            ...(!applied && !dryRun && result.skippedReason
              ? { skippedReason: result.skippedReason }
              : {}),
          });
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
    const pendingAge = minutesAgo(1);
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

    // Clear mid-pause with empty holds (false budget hard-stop left hostComplete stuck).
    const stuckPausingAge = minutesAgo(2);
    const stuckPausing = await db.select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
    }).from(agents).where(and(
      ...(companyId ? [eq(agents.companyId, companyId)] : []),
      eq(agents.lifecycleState, "pausing"),
      sql`coalesce(jsonb_array_length(${agents.lifecycleHolds}), 0) = 0`,
      lt(agents.updatedAt, stuckPausingAge),
    )).orderBy(asc(agents.updatedAt)).limit(MAX_REAPER_BATCH);

    for (const agent of stuckPausing) {
      try {
        await budgets.reconcileScope(agent.companyId, "agent", agent.id);
        await lifecycle.reconcileAgent(agent.id);
        await wakeLifecycle(agent.companyId);
        healed++;
      } catch (error) {
        errors.push({
          runId: agent.id,
          error: error instanceof Error ? error.message.slice(0, 500) : "stuck_pausing_reaper_failed",
        });
      }
    }

    return {
      scanned: pending.length + unpriced.length + stuckPausing.length,
      healed,
      errors,
    };
  }

  /**
   * Seed/refresh managed AGENTS.md. Re-syncs when the file is still the MEDIC
   * managed template (starts with `# MEDIC — Platform Health`); preserves true
   * operator rewrites. Keeps promptTemplate (wake protocol) in parallel.
   */
  async function ensureMedicInstructions(agent: {
    id: string;
    companyId: string;
    name: string;
    adapterConfig: unknown;
  }): Promise<Record<string, unknown>> {
    const instructions = agentInstructionsService(db);
    const root = resolveManagedInstructionsRoot(agent);
    const entryPath = path.join(root, "AGENTS.md");
    let existing = "";
    try {
      existing = await fs.readFile(entryPath, "utf8");
    } catch {
      existing = "";
    }

    const managedPrefix = "# MEDIC — Platform Health";
    const isManagedMedicDoc = existing.trim().startsWith(managedPrefix);
    const desired = buildMedicAgentsMd();
    if (existing.trim().length > 0 && !isManagedMedicDoc) {
      const ensured = await instructions.ensureManagedBundle(agent);
      return ensured.adapterConfig;
    }
    if (isManagedMedicDoc && existing === desired) {
      const ensured = await instructions.ensureManagedBundle(agent);
      return ensured.adapterConfig;
    }

    await fs.mkdir(root, { recursive: true });
    // Blank placeholder files trip materialize's "revision required" guard.
    await fs.rm(entryPath, { force: true }).catch(() => undefined);

    const materialized = await instructions.materializeManagedBundle(
      agent,
      { "AGENTS.md": desired },
      { entryFile: "AGENTS.md", replaceExisting: true },
    );
    return materialized.adapterConfig;
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
    const connectorCheckIntervalSec = input.connectorCheckIntervalSec ?? DEFAULT_CONNECTOR_CHECK_INTERVAL_SEC;
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
      "You are MEDIC, the company platform-health agent. Be decisive; do not explore the codebase. Follow AGENTS.md and the platform-health skill.",
      "First shell line of every curl: `set -a && . \"${HERMES_PAPERCLIP_ENV_FILE:?missing}\" && set +a` (path is also in the system prompt).",
      "REST: $PAPERCLIP_API_URL (append /api if missing), Authorization: Bearer $PAPERCLIP_API_KEY, X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID. Never use MCP overlay bearers.",
      "Protocol (max ~10 tool calls):",
      "1) GET /api/companies/{{companyId}}/ops/health/snapshot.",
      "2) If empty is false and metadata.autoHeal is true — immediately POST /api/companies/{{companyId}}/ops/health/auto-heal {\"dryRun\":false,\"maxActions\":10,\"applyDeskTriage\":true,\"maxDeskActions\":10}. Do not dry-run first. Auto-heal also applies safe Decisions-desk retries/resolves via apply-desk-triage.",
      "3) If auto-heal omitted desk work or deskTriage.applied is 0 while snapshot still shows stranded_failed_run / stranded_recovery_action, POST /api/companies/{{companyId}}/ops/health/apply-desk-triage {\"dryRun\":false,\"maxActions\":10}. Do not call agent wakeup or recovery-actions/resolve yourself — those require board privilege and this endpoint owns them.",
      "4) Connectors: inspect connectorFindings. Escalate only reportDue:true rows (hourly cadence). Then POST /api/companies/{{companyId}}/ops/health/connectors/acknowledge with those fingerprints. Never auto-reconnect OAuth.",
      "5) Operator diagnose: when the wake prompt names an agent+connector (e.g. Steve/Linear), POST /api/companies/{{companyId}}/ops/health/connectors/diagnose {\"agentName\":\"Steve\",\"applicationKey\":\"linear\",\"probe\":true} and report verdict (connection unhealthy vs agent access gap).",
      "6) After sourcing HERMES_PAPERCLIP_ENV_FILE, write $HERMES_DISPOSITION_FILE {\"status\":\"in_progress\",\"comment\":\"<one short paragraph: auto-heal + desk + connectors>\"} and stop. If empty:true and no due connectors and no diagnose request, comment 'healthy' and stop. Ignore Penpot MCP overlay instructions.",
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
      connectorHealth: true,
      connectorCheckIntervalSec,
    };
    const medicCapabilities =
      "Detect and remediate fleet budget hard-stops, pending accounting, stuck resumes, stranded decisions-desk recoveries, and unhealthy/expired tool connectors; diagnose per-agent connector access gaps on operator request.";

    if (existing[0]) {
      const agent = existing[0];
      if (input.dryRun) {
        return { created: false, dryRun: true, agent };
      }
      const [full] = await db.select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        adapterConfig: agents.adapterConfig,
        runtimeConfig: agents.runtimeConfig,
      }).from(agents).where(eq(agents.id, agent.id)).limit(1);
      if (!full) throw notFound("MEDIC agent not found");
      const instructionsConfig = await ensureMedicInstructions(full);
      const runtimeConfig = {
        ...object(full.runtimeConfig),
        heartbeat: {
          ...object(object(full.runtimeConfig).heartbeat),
          ...desiredHeartbeat,
        },
      };
      const adapterConfig = {
        ...object(full.adapterConfig),
        ...skillAdapterConfig,
        ...instructionsConfig,
        paperclipSkillSync: {
          ...object(object(full.adapterConfig).paperclipSkillSync),
          desiredSkills,
        },
        // Keep wake protocol after instructions materialize.
        promptTemplate: medicPrompt,
      };
      await lifecycle.updateConfiguration(agent.id, {
        runtimeConfig,
        adapterConfig,
        budgetMonthlyCents,
        title: "Platform Health",
        capabilities: medicCapabilities,
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
      capabilities: medicCapabilities,
      adapterType: "hermes_local",
      adapterConfig: skillAdapterConfig,
      runtimeConfig: { heartbeat: desiredHeartbeat },
      budgetMonthlyCents,
      reportsTo,
      metadata: medicMetadata,
    }, { createdByUserId: actorUserId });

    const instructionsConfig = await ensureMedicInstructions({
      id: hired.id,
      companyId,
      name: hired.name,
      adapterConfig: hired.adapterConfig,
    });
    await lifecycle.updateConfiguration(hired.id, {
      adapterConfig: {
        ...object(hired.adapterConfig),
        ...instructionsConfig,
        promptTemplate: medicPrompt,
      },
    }, { recordRevision: { createdByUserId: actorUserId, source: "platform_health.ensure_medic_instructions" } });

    await budgets.upsertPolicy(companyId, {
      scopeType: "agent",
      scopeId: hired.id,
      amount: budgetMonthlyCents,
      windowKind: "calendar_month_utc",
      hardStopEnabled: true,
      unpricedUsagePolicy: "allow",
      isActive: budgetMonthlyCents > 0,
    }, actorUserId);

    const [seeded] = await db.select().from(agents).where(eq(agents.id, hired.id)).limit(1);
    return { created: true, dryRun: false, agent: seeded ?? hired };
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
      if (finding.class === "workspace_validation_stranded") {
        proposals.push({
          class: finding.class,
          action: finding.autoSafe ? "repair_project_workspace_git" : "escalate",
          fingerprint: finding.fingerprint,
          issueId: finding.issueId,
          recoveryActionId: finding.recoveryActionId,
          agentId: finding.agentId,
          endpoint: finding.autoSafe
            ? `POST /api/companies/${companyId}/ops/health/auto-heal`
            : "none",
          reason: finding.autoSafe
            ? "Repairable missing project git — use auto-heal repair_project_workspace_git (not desk resolve)"
            : finding.detail,
          autoApplySafe: false,
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
      || action.cause === "workspace_validation_failed"
      || action.cause === "native_workspace_finalization_owner_unverified"
      || action.cause === "native_workspace_sync_out_unsafe_archive"
    ) {
      return {
        action: "escalate",
        autoApplySafe: false,
        reason: action.cause === "workspace_validation_failed"
          ? "workspace_validation_failed requires project git repair via auto-heal repair_project_workspace_git, not desk resolve"
          : `Recovery cause ${action.cause} requires board reconciliation / workspace repair`,
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
    listConnectorFindings,
    probeConnector,
    diagnoseConnector,
    acknowledgeConnectorFindings,
  };
}

export type PlatformHealthService = ReturnType<typeof platformHealthService>;
