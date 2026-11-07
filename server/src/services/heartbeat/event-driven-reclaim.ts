/**
 * YIE-72 event-driven workspace reclaim (flag-gated).
 *
 * When a shared-workspace holder releases, immediately CAS-claim the earliest
 * parked workspace_busy wake for a waiter and promote its scheduled_retry to
 * queued — instead of waiting for the blind 60s+jitter timer. Flag off keeps
 * the legacy delay and skips the release hook entirely.
 *
 * Transport note: Elena/Steve's `run_queue` / `workspace.released` language is
 * implemented as an in-process release hook + Postgres wake/run rows (Paperclip
 * has no AMQP wake bus today).
 */

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  heartbeatRuns,
  type Db,
} from "@paperclipai/db";
import { WORKSPACE_BUSY_RETRY_REASON } from "../../modules/run-dispatch/domain/wake-context.js";
import { logger } from "../../middleware/logger.js";

/** Paperclip env flag. Default OFF; 1/true/on/yes enables. */
export const EVENT_DRIVEN_RECLAIM_V1_ENV = "PAPERCLIP_EVENT_DRIVEN_RECLAIM_V1";
/** Elena alias accepted as an enablement synonym. */
export const WORKSPACE_EVENT_DRIVEN_CLAIM_ENABLED_ENV =
  "WORKSPACE_EVENT_DRIVEN_CLAIM_ENABLED";
/** Injectable safety-net delay (ms). Default 300000. */
export const WORKSPACE_BUSY_SAFETY_NET_MS_ENV =
  "PAPERCLIP_WORKSPACE_BUSY_SAFETY_NET_MS";

export const WORKSPACE_BUSY_SAFETY_NET_MS_DEFAULT = 300_000;
export const WORKSPACE_BUSY_RETRY_JITTER_MS_FLAG_ON = 10_000;

export const CLAIM_REASON_FRESH = "fresh";
export const CLAIM_REASON_PARKED_RECLAIM = "parked_reclaim";
export const CLAIM_REASON_SAFETY_NET = "safety_net";

/** A § telemetry: attempt outcomes on the holder run. */
export const WORKSPACE_RELEASE_CLAIM_ATTEMPTED_EVENT =
  "workspace_release_claim_attempted";
/**
 * B1 attribution: emitted only when the event-driven path successfully
 * requeues a parked wake. Safety-net promotions stamp claim_reason=safety_net
 * and never emit this message — that is how the two paths are distinguished.
 */
export const WORKSPACE_RELEASED_REQUEUE_EVENT = "workspace_released_requeue";

export type WakeClaimReason =
  | typeof CLAIM_REASON_FRESH
  | typeof CLAIM_REASON_PARKED_RECLAIM
  | typeof CLAIM_REASON_SAFETY_NET;

export type WorkspaceReleaseClaimOutcome =
  | "success"
  | "no_pending_wake"
  | "race_lost"
  | "flag_off"
  | "promote_failed"
  /** B3: holder run still running — refuse to promote waiters into a live workspace. */
  | "holder_still_live";

export type WorkspaceReleasedEvent = {
  companyId: string;
  agentId: string;
  issueId: string | null;
  workspaceId: string | null;
  releasedAt: Date;
  /** Holder run that just finished; used to match waiters. */
  holderRunId: string;
  projectWorkspaceId?: string | null;
  executionWorkspaceId?: string | null;
};

export type ClaimPendingWakeResult =
  | {
      outcome: "success";
      wakeId: string;
      runId: string;
      claimReason: WakeClaimReason;
      agentId: string;
      issueId: string | null;
    }
  | { outcome: "no_pending_wake" }
  | { outcome: "race_lost"; wakeId: string }
  | { outcome: "promote_failed"; wakeId: string; runId: string; reason: string };

function envEnabled(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

export function isEventDrivenReclaimV1Enabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    envEnabled(env[EVENT_DRIVEN_RECLAIM_V1_ENV]) ||
    envEnabled(env[WORKSPACE_EVENT_DRIVEN_CLAIM_ENABLED_ENV])
  );
}

export function getWorkspaceBusySafetyNetMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[WORKSPACE_BUSY_SAFETY_NET_MS_ENV]?.trim();
  if (!raw) return WORKSPACE_BUSY_SAFETY_NET_MS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return WORKSPACE_BUSY_SAFETY_NET_MS_DEFAULT;
  }
  return Math.floor(parsed);
}

/**
 * Delay used when parking a workspace_busy retry.
 * Flag on → 300s safety net (+ optional small jitter). Flag off → caller uses
 * legacy 60s + 60s jitter via computeWorkspaceBusyRetryDelayMs.
 */
export function computeEventDrivenWorkspaceBusyRetryDelayMs(
  random: () => number = Math.random,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const base = getWorkspaceBusySafetyNetMs(env);
  const jitter = Math.min(Math.max(random(), 0), 1);
  return base + Math.floor(jitter * WORKSPACE_BUSY_RETRY_JITTER_MS_FLAG_ON);
}

export type EventDrivenReclaimDependencies = {
  promoteScheduledRetry: (input: {
    runId: string;
    companyId: string;
    now?: Date;
  }) => Promise<{
    outcome: string;
    postCommitEffects?: unknown[];
  }>;
  applyPostCommitEffects?: (effects: unknown[]) => void | Promise<void>;
  appendReleaseTelemetry?: (input: {
    companyId: string;
    holderRunId: string;
    outcome: WorkspaceReleaseClaimOutcome;
    wakeId?: string | null;
    runId?: string | null;
    claimReason?: WakeClaimReason | null;
  }) => void | Promise<void>;
};

function readIssueId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const issueId = (payload as Record<string, unknown>).issueId;
  return typeof issueId === "string" && issueId.trim() ? issueId : null;
}

/**
 * Atomic CAS fence for event vs safety-net races:
 * UPDATE … SET claimed_at = NOW(), claim_reason = ? WHERE id = ? AND claimed_at IS NULL
 * On success, force the linked scheduled_retry due and promote it.
 */
export async function claimPendingWakeForIssue(
  db: Db,
  deps: EventDrivenReclaimDependencies,
  input: {
    companyId: string;
    agentId: string;
    issueId: string;
    claimReason: typeof CLAIM_REASON_PARKED_RECLAIM | typeof CLAIM_REASON_SAFETY_NET;
    now?: Date;
    /** When set, only claim this wake id (after verifying it matches the pair). */
    wakeId?: string;
  },
): Promise<ClaimPendingWakeResult> {
  const now = input.now ?? new Date();

  const candidates = await db
    .select({
      wakeId: agentWakeupRequests.id,
      agentId: agentWakeupRequests.agentId,
      payload: agentWakeupRequests.payload,
      runId: heartbeatRuns.id,
      runStatus: heartbeatRuns.status,
      scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
    })
    .from(agentWakeupRequests)
    .innerJoin(
      heartbeatRuns,
      and(
        eq(heartbeatRuns.wakeupRequestId, agentWakeupRequests.id),
        eq(heartbeatRuns.companyId, agentWakeupRequests.companyId),
      ),
    )
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.agentId, input.agentId),
        eq(agentWakeupRequests.status, "queued"),
        isNull(agentWakeupRequests.claimedAt),
        eq(heartbeatRuns.status, "scheduled_retry"),
        eq(heartbeatRuns.scheduledRetryReason, WORKSPACE_BUSY_RETRY_REASON),
        sql`${agentWakeupRequests.payload} ->> 'issueId' = ${input.issueId}`,
        input.wakeId ? eq(agentWakeupRequests.id, input.wakeId) : undefined,
      ),
    )
    .orderBy(asc(agentWakeupRequests.requestedAt), asc(agentWakeupRequests.id))
    .limit(1);

  const candidate = candidates[0];
  if (!candidate?.runId) {
    return { outcome: "no_pending_wake" };
  }

  const [claimed] = await db
    .update(agentWakeupRequests)
    .set({
      claimedAt: now,
      claimReason: input.claimReason,
      updatedAt: now,
    })
    .where(
      and(
        eq(agentWakeupRequests.id, candidate.wakeId),
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.status, "queued"),
        isNull(agentWakeupRequests.claimedAt),
      ),
    )
    .returning({ id: agentWakeupRequests.id });

  if (!claimed) {
    return { outcome: "race_lost", wakeId: candidate.wakeId };
  }

  // Make the retry due so the existing promote CAS (scheduled_retry + due) can win.
  await db
    .update(heartbeatRuns)
    .set({
      scheduledRetryAt: now,
      updatedAt: now,
      contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify({
        scheduledRetryAt: now.toISOString(),
        eventDrivenReclaim: {
          claimReason: input.claimReason,
          claimedAt: now.toISOString(),
        },
      })}::jsonb`,
    })
    .where(
      and(
        eq(heartbeatRuns.id, candidate.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.status, "scheduled_retry"),
      ),
    );

  const promote = await deps.promoteScheduledRetry({
    runId: candidate.runId,
    companyId: input.companyId,
    now,
  });

  if (promote.outcome === "promoted" && promote.postCommitEffects?.length) {
    await deps.applyPostCommitEffects?.(promote.postCommitEffects);
  }

  if (promote.outcome !== "promoted") {
    logger.warn(
      {
        wakeId: candidate.wakeId,
        runId: candidate.runId,
        promoteOutcome: promote.outcome,
        claimReason: input.claimReason,
      },
      "event-driven reclaim claimed wake but promote did not apply",
    );
    return {
      outcome: "promote_failed",
      wakeId: candidate.wakeId,
      runId: candidate.runId,
      reason: promote.outcome,
    };
  }

  return {
    outcome: "success",
    wakeId: candidate.wakeId,
    runId: candidate.runId,
    claimReason: input.claimReason,
    agentId: candidate.agentId,
    issueId: readIssueId(candidate.payload) ?? input.issueId,
  };
}

type WaiterRow = {
  wakeId: string;
  agentId: string;
  issueId: string | null;
  runId: string;
};

/**
 * Find the earliest queued workspace_busy waiter that was parked because of
 * this holder / freed workspace.
 */
export async function findEarliestWorkspaceBusyWaiter(
  db: Db,
  event: Pick<
    WorkspaceReleasedEvent,
    | "companyId"
    | "holderRunId"
    | "projectWorkspaceId"
    | "executionWorkspaceId"
    | "workspaceId"
  >,
): Promise<WaiterRow | null> {
  const projectWorkspaceId =
    event.projectWorkspaceId ?? event.workspaceId ?? null;
  const executionWorkspaceId = event.executionWorkspaceId ?? null;

  // Alias raw JSON projections so subquery references are valid in drizzle.
  const deferred = db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      holderRunId: sql<string | null>`${heartbeatRuns.resultJson} -> 'workspaceBusy' ->> 'holderRunId'`.as(
        "holder_run_id",
      ),
      busyProjectWorkspaceId: sql<string | null>`${heartbeatRuns.resultJson} -> 'workspaceBusy' ->> 'projectWorkspaceId'`.as(
        "busy_project_workspace_id",
      ),
      busyExecutionWorkspaceId: sql<string | null>`${heartbeatRuns.resultJson} -> 'workspaceBusy' ->> 'executionWorkspaceId'`.as(
        "busy_execution_workspace_id",
      ),
    })
    .from(heartbeatRuns)
    .as("deferred_workspace_busy");

  const rows = await db
    .select({
      wakeId: agentWakeupRequests.id,
      agentId: agentWakeupRequests.agentId,
      issueId: sql<string | null>`${agentWakeupRequests.payload} ->> 'issueId'`.as(
        "issue_id",
      ),
      runId: heartbeatRuns.id,
    })
    .from(agentWakeupRequests)
    .innerJoin(
      heartbeatRuns,
      and(
        eq(heartbeatRuns.wakeupRequestId, agentWakeupRequests.id),
        eq(heartbeatRuns.companyId, agentWakeupRequests.companyId),
      ),
    )
    .innerJoin(
      deferred,
      and(
        eq(deferred.id, heartbeatRuns.retryOfRunId),
        eq(deferred.companyId, heartbeatRuns.companyId),
      ),
    )
    .where(
      and(
        eq(agentWakeupRequests.companyId, event.companyId),
        eq(agentWakeupRequests.status, "queued"),
        isNull(agentWakeupRequests.claimedAt),
        eq(heartbeatRuns.status, "scheduled_retry"),
        eq(heartbeatRuns.scheduledRetryReason, WORKSPACE_BUSY_RETRY_REASON),
        sql`(
          ${deferred.holderRunId} = ${event.holderRunId}
          OR (
            ${projectWorkspaceId}::text IS NOT NULL
            AND ${deferred.busyProjectWorkspaceId} = ${projectWorkspaceId}
          )
          OR (
            ${executionWorkspaceId}::text IS NOT NULL
            AND ${deferred.busyExecutionWorkspaceId} = ${executionWorkspaceId}
          )
        )`,
      ),
    )
    .orderBy(asc(agentWakeupRequests.requestedAt), asc(agentWakeupRequests.id))
    .limit(1);

  const row = rows[0];
  if (!row?.wakeId || !row.agentId || !row.runId) return null;
  return {
    wakeId: row.wakeId,
    agentId: row.agentId,
    issueId: row.issueId,
    runId: row.runId,
  };
}

export async function onWorkspaceReleased(
  db: Db,
  deps: EventDrivenReclaimDependencies,
  event: WorkspaceReleasedEvent,
): Promise<{
  outcome: WorkspaceReleaseClaimOutcome;
  claim?: Extract<ClaimPendingWakeResult, { outcome: "success" }>;
}> {
  if (!isEventDrivenReclaimV1Enabled()) {
    return { outcome: "flag_off" };
  }

  // B3: never promote a parked wake into a workspace a silent-but-live holder
  // may still be writing. Release hooks normally run after terminalization;
  // this is the fail-closed race guard.
  const [holderRow] = await db
    .select({ status: heartbeatRuns.status })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.id, event.holderRunId),
        eq(heartbeatRuns.companyId, event.companyId),
      ),
    )
    .limit(1);
  if (holderRow?.status === "running") {
    await deps.appendReleaseTelemetry?.({
      companyId: event.companyId,
      holderRunId: event.holderRunId,
      outcome: "holder_still_live",
    });
    return { outcome: "holder_still_live" };
  }

  const waiter = await findEarliestWorkspaceBusyWaiter(db, event);
  if (!waiter || !waiter.issueId) {
    await deps.appendReleaseTelemetry?.({
      companyId: event.companyId,
      holderRunId: event.holderRunId,
      outcome: "no_pending_wake",
    });
    return { outcome: "no_pending_wake" };
  }

  const claimed = await claimPendingWakeForIssue(db, deps, {
    companyId: event.companyId,
    agentId: waiter.agentId,
    issueId: waiter.issueId,
    claimReason: CLAIM_REASON_PARKED_RECLAIM,
    now: event.releasedAt,
    wakeId: waiter.wakeId,
  });

  if (claimed.outcome === "success") {
    await deps.appendReleaseTelemetry?.({
      companyId: event.companyId,
      holderRunId: event.holderRunId,
      outcome: "success",
      wakeId: claimed.wakeId,
      runId: claimed.runId,
      claimReason: claimed.claimReason,
    });
    return { outcome: "success", claim: claimed };
  }

  if (claimed.outcome === "race_lost") {
    await deps.appendReleaseTelemetry?.({
      companyId: event.companyId,
      holderRunId: event.holderRunId,
      outcome: "race_lost",
      wakeId: claimed.wakeId,
    });
    return { outcome: "race_lost" };
  }

  if (claimed.outcome === "promote_failed") {
    await deps.appendReleaseTelemetry?.({
      companyId: event.companyId,
      holderRunId: event.holderRunId,
      outcome: "promote_failed",
      wakeId: claimed.wakeId,
      runId: claimed.runId,
    });
    return { outcome: "promote_failed" };
  }

  await deps.appendReleaseTelemetry?.({
    companyId: event.companyId,
    holderRunId: event.holderRunId,
    outcome: "no_pending_wake",
  });
  return { outcome: "no_pending_wake" };
}

/**
 * Safety-net path: when a due workspace_busy retry is about to promote via the
 * timer, CAS claim_reason=safety_net if still unclaimed. Losing the CAS means
 * the event path already won — promote may still proceed if the run is due.
 */
export async function tryMarkSafetyNetClaim(
  db: Db,
  input: {
    companyId: string;
    wakeupRequestId: string | null | undefined;
    now?: Date;
  },
): Promise<"marked" | "already_claimed" | "skipped"> {
  if (!isEventDrivenReclaimV1Enabled()) return "skipped";
  if (!input.wakeupRequestId) return "skipped";
  const now = input.now ?? new Date();
  const [updated] = await db
    .update(agentWakeupRequests)
    .set({
      claimedAt: now,
      claimReason: CLAIM_REASON_SAFETY_NET,
      updatedAt: now,
    })
    .where(
      and(
        eq(agentWakeupRequests.id, input.wakeupRequestId),
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.status, "queued"),
        isNull(agentWakeupRequests.claimedAt),
      ),
    )
    .returning({ id: agentWakeupRequests.id });
  return updated ? "marked" : "already_claimed";
}

/** Stamp claim_reason=fresh on a normal (non-parked) wake claim when flag is on. */
export async function maybeStampFreshClaimReason(
  db: Db,
  input: {
    companyId: string;
    wakeupRequestId: string | null | undefined;
    claimedAt: Date;
  },
): Promise<void> {
  if (!isEventDrivenReclaimV1Enabled()) return;
  if (!input.wakeupRequestId) return;
  await db
    .update(agentWakeupRequests)
    .set({
      claimReason: sql`coalesce(${agentWakeupRequests.claimReason}, ${CLAIM_REASON_FRESH})`,
      // Preserve an earlier parked_reclaim/safety_net claimed_at for latency.
      claimedAt: sql`coalesce(${agentWakeupRequests.claimedAt}, ${input.claimedAt.toISOString()}::timestamptz)`,
      updatedAt: input.claimedAt,
    })
    .where(
      and(
        eq(agentWakeupRequests.id, input.wakeupRequestId),
        eq(agentWakeupRequests.companyId, input.companyId),
      ),
    );
}
