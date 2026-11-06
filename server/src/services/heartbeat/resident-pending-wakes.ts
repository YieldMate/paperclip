/**
 * YIE-71: resolve issue IDs with a pending wake for resident LRU protection.
 *
 * "Active issue with a pending wake" is exactly:
 * - agent_wakeup_requests.status='queued' whose payload->>'issueId' matches, OR
 * - heartbeat_runs.scheduled_retry_at > now() for the issue.
 */

import { and, eq, gt, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  heartbeatRuns,
  type Db,
} from "@paperclipai/db";

export async function listPendingWakeIssueIds(input: {
  db: Db;
  companyId: string;
  agentId: string;
  now?: Date;
}): Promise<string[]> {
  const now = input.now ?? new Date();
  const ids = new Set<string>();

  try {
    const wakeRows = await input.db
      .select({
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, input.companyId),
          eq(agentWakeupRequests.agentId, input.agentId),
          eq(agentWakeupRequests.status, "queued"),
        ),
      );
    for (const row of wakeRows) {
      const payload = row.payload;
      if (!payload || typeof payload !== "object") continue;
      const issueId = (payload as Record<string, unknown>).issueId;
      if (typeof issueId === "string" && issueId.length > 0) ids.add(issueId);
    }
  } catch {
    // fail-open
  }

  try {
    const retryRows = await input.db
      .select({
        issueId: heartbeatRuns.issueId,
        contextIssueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.agentId, input.agentId),
          gt(heartbeatRuns.scheduledRetryAt, now),
        ),
      );
    for (const row of retryRows) {
      if (typeof row.issueId === "string" && row.issueId.length > 0) {
        ids.add(row.issueId);
        continue;
      }
      if (typeof row.contextIssueId === "string" && row.contextIssueId.length > 0) {
        ids.add(row.contextIssueId);
      }
    }
  } catch {
    // fail-open
  }

  return [...ids];
}
