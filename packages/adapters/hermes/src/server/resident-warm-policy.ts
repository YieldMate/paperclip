/**
 * YIE-71 resident warm policy (flag-gated).
 *
 * When `resident_warm_policy_v2` is off, callers keep today's stop-on-terminal
 * behaviour and write inert telemetry. When on: per-disposition TTL, cwd
 * identity comparison, LRU/RSS caps, and measurable warm/start decisions.
 */

import fs from "node:fs/promises";
import path from "node:path";

/** Env flag. Default ON; set 0/false/off/no to roll back to stop-on-terminal. */
export const RESIDENT_WARM_POLICY_V2_ENV = "PAPERCLIP_RESIDENT_WARM_POLICY_V2";

export const RESIDENT_WARM_TTL_IN_PROGRESS_SEC = 900;
export const RESIDENT_WARM_TTL_TERMINAL_SEC = 180;
export const RESIDENT_WARM_TTL_BLOCKED_SEC = 900;
export const RESIDENT_WARM_TTL_UNKNOWN_SEC = 180;
export const RESIDENT_WARM_TTL_CANCELLED_SEC = 0;

export const RESIDENT_WARM_MAX_LIVE = 8;
/** Pending-wake slots reserved above the count cap; never LRU victims. */
export const RESIDENT_WARM_PENDING_WAKE_RESERVATION = 2;
export const RESIDENT_WARM_MAX_AGGREGATE_RSS_MB = 4096;
export const RESIDENT_RSS_CACHE_MS = 10_000;

export type ResidentStartDecision = "reuse" | "cold" | "n_a";
export type ResidentWarmDecision = "warmed" | "not_warmed" | "n_a";

export type ResidentWarmReason =
  | "in_progress"
  | "done"
  | "in_review"
  | "blocked"
  | "cancelled"
  | "failed_retry"
  | "failed"
  | "disposition_unknown"
  | "turn_timeout"
  | "run_failed"
  | "flag_off"
  | "no_issue_key"
  | "cwd_mismatch"
  | "model_mismatch"
  | "session_mismatch"
  | "no_live_resident"
  | "ttl_expired"
  | "cap_evicted"
  | "start_failed"
  | "n/a";

export interface ResidentWarmTtlResult {
  ttlSec: number;
  reason: ResidentWarmReason;
  keep: boolean;
}

export interface ResidentWarmConfig {
  residentWarmTtlInProgressSec: number;
  residentWarmTtlTerminalSec: number;
  residentWarmTtlBlockedSec: number;
  residentWarmTtlUnknownSec: number;
  residentWarmTtlCancelledSec: number;
  residentWarmMaxLiveResidents: number;
  residentWarmMaxAggregateRssMb: number;
}

export const DEFAULT_RESIDENT_WARM_CONFIG: ResidentWarmConfig = {
  residentWarmTtlInProgressSec: RESIDENT_WARM_TTL_IN_PROGRESS_SEC,
  residentWarmTtlTerminalSec: RESIDENT_WARM_TTL_TERMINAL_SEC,
  residentWarmTtlBlockedSec: RESIDENT_WARM_TTL_BLOCKED_SEC,
  residentWarmTtlUnknownSec: RESIDENT_WARM_TTL_UNKNOWN_SEC,
  residentWarmTtlCancelledSec: RESIDENT_WARM_TTL_CANCELLED_SEC,
  residentWarmMaxLiveResidents: RESIDENT_WARM_MAX_LIVE,
  residentWarmMaxAggregateRssMb: RESIDENT_WARM_MAX_AGGREGATE_RSS_MB,
};

/**
 * Default OFF — Production enablement is an explicit ops flip
 * (`PAPERCLIP_RESIDENT_WARM_POLICY_V2=1`). Rollback: unset or set 0/false/off/no.
 */
export function isResidentWarmPolicyV2Enabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[RESIDENT_WARM_POLICY_V2_ENV]?.trim().toLowerCase();
  if (!raw) return false;
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

function clampTerminalTtl(sec: number): number {
  if (!Number.isFinite(sec)) return RESIDENT_WARM_TTL_TERMINAL_SEC;
  return Math.min(180, Math.max(120, Math.round(sec)));
}

export function resolveResidentWarmConfig(
  config: Record<string, unknown> | null | undefined,
): ResidentWarmConfig {
  const num = (key: string, fallback: number): number => {
    const raw = config?.[key];
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
    if (typeof raw === "string" && raw.trim() !== "") {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return fallback;
  };
  return {
    residentWarmTtlInProgressSec: num(
      "residentWarmTtlInProgressSec",
      DEFAULT_RESIDENT_WARM_CONFIG.residentWarmTtlInProgressSec,
    ),
    residentWarmTtlTerminalSec: clampTerminalTtl(
      num("residentWarmTtlTerminalSec", DEFAULT_RESIDENT_WARM_CONFIG.residentWarmTtlTerminalSec),
    ),
    residentWarmTtlBlockedSec: num(
      "residentWarmTtlBlockedSec",
      DEFAULT_RESIDENT_WARM_CONFIG.residentWarmTtlBlockedSec,
    ),
    residentWarmTtlUnknownSec: num(
      "residentWarmTtlUnknownSec",
      DEFAULT_RESIDENT_WARM_CONFIG.residentWarmTtlUnknownSec,
    ),
    residentWarmTtlCancelledSec: num(
      "residentWarmTtlCancelledSec",
      DEFAULT_RESIDENT_WARM_CONFIG.residentWarmTtlCancelledSec,
    ),
    residentWarmMaxLiveResidents: Math.max(
      1,
      Math.round(
        num(
          "residentWarmMaxLiveResidents",
          DEFAULT_RESIDENT_WARM_CONFIG.residentWarmMaxLiveResidents,
        ),
      ),
    ),
    residentWarmMaxAggregateRssMb: Math.max(
      1,
      Math.round(
        num(
          "residentWarmMaxAggregateRssMb",
          DEFAULT_RESIDENT_WARM_CONFIG.residentWarmMaxAggregateRssMb,
        ),
      ),
    ),
  };
}

/**
 * Disposition → TTL matrix (YIE-71 CONTRACT). Replaces the boolean keep/stop
 * when warm policy v2 is on.
 */
export function residentWarmTtlForDisposition(
  disposition: { status?: string } | null | undefined,
  opts?: {
    hasScheduledRetry?: boolean;
    config?: Partial<ResidentWarmConfig>;
  },
): ResidentWarmTtlResult {
  const cfg = { ...DEFAULT_RESIDENT_WARM_CONFIG, ...opts?.config };
  const status = disposition?.status?.trim();
  if (!status) {
    return {
      ttlSec: cfg.residentWarmTtlUnknownSec,
      reason: "disposition_unknown",
      keep: cfg.residentWarmTtlUnknownSec > 0,
    };
  }
  switch (status) {
    case "in_progress":
      return {
        ttlSec: cfg.residentWarmTtlInProgressSec,
        reason: "in_progress",
        keep: cfg.residentWarmTtlInProgressSec > 0,
      };
    case "done":
      return {
        ttlSec: cfg.residentWarmTtlTerminalSec,
        reason: "done",
        keep: cfg.residentWarmTtlTerminalSec > 0,
      };
    case "in_review":
      return {
        ttlSec: cfg.residentWarmTtlTerminalSec,
        reason: "in_review",
        keep: cfg.residentWarmTtlTerminalSec > 0,
      };
    case "blocked":
      return {
        ttlSec: cfg.residentWarmTtlBlockedSec,
        reason: "blocked",
        keep: cfg.residentWarmTtlBlockedSec > 0,
      };
    case "cancelled":
      return {
        ttlSec: cfg.residentWarmTtlCancelledSec,
        reason: "cancelled",
        keep: cfg.residentWarmTtlCancelledSec > 0,
      };
    case "failed":
      if (opts?.hasScheduledRetry) {
        return {
          ttlSec: cfg.residentWarmTtlInProgressSec,
          reason: "failed_retry",
          keep: cfg.residentWarmTtlInProgressSec > 0,
        };
      }
      return {
        ttlSec: cfg.residentWarmTtlTerminalSec,
        reason: "failed",
        keep: cfg.residentWarmTtlTerminalSec > 0,
      };
    default:
      // Unknown non-empty statuses (e.g. todo) keep the in_progress band.
      return {
        ttlSec: cfg.residentWarmTtlInProgressSec,
        reason: "in_progress",
        keep: cfg.residentWarmTtlInProgressSec > 0,
      };
  }
}

/** Legacy stop-on-terminal boolean (flag-off path). */
export function shouldKeepResidentForDispositionLegacy(
  disposition: { status?: string } | null | undefined,
): boolean {
  const status = disposition?.status?.trim();
  if (!status) return true;
  return !new Set(["done", "in_review", "blocked", "cancelled"]).has(status);
}

/**
 * Normalized cwd identity: realpath(path.resolve(cwd)).
 * Falls back to the resolved absolute path when realpath fails (missing path).
 */
export async function normalizeCwdIdentity(cwd: string): Promise<string> {
  const resolved = path.resolve(cwd || ".");
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

export function inertResidentTelemetry(reason: ResidentWarmReason = "flag_off"): {
  resident_start_decision: ResidentStartDecision;
  resident_warm_decision: ResidentWarmDecision;
  resident_warm_reason: ResidentWarmReason;
  resident_warm_ttl_seconds: number | null;
  resident_cwd_identity: string | null;
} {
  return {
    resident_start_decision: "n_a",
    resident_warm_decision: "n_a",
    resident_warm_reason: reason,
    resident_warm_ttl_seconds: null,
    resident_cwd_identity: null,
  };
}

/** Default /proc/<pid>/statm RSS reader (pages → MB). Field 2 = resident pages. */
export async function readResidentRssMbDefault(pid: number): Promise<number | null> {
  try {
    const raw = await fs.readFile(`/proc/${pid}/statm`, "utf8");
    const pages = Number(raw.trim().split(/\s+/)[1]);
    if (!Number.isFinite(pages) || pages < 0) return null;
    // Linux page size is typically 4096; avoid os.pagesize for portability in tests.
    const pageBytes = 4096;
    return (pages * pageBytes) / (1024 * 1024);
  } catch {
    return null;
  }
}
