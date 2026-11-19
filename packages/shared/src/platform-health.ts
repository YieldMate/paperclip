import { z } from "zod";

export const PLATFORM_HEALTH_AGENT_NAME = "MEDIC";

export const platformHealthSettleModeSchema = z.enum([
  "auto",
  "hermes_estimate",
  "pre_provider",
  "clear_unpriced",
]);
export type PlatformHealthSettleMode = z.infer<typeof platformHealthSettleModeSchema>;

export const platformHealthSettlePendingRunSchema = z.object({
  runId: z.string().uuid(),
  mode: platformHealthSettleModeSchema.default("auto"),
  dryRun: z.boolean().optional().default(false),
  /** Optional operator-supplied estimate when Hermes DB is unavailable. */
  costUsd: z.number().finite().nonnegative().optional(),
  evidence: z.string().trim().min(1).max(1000).optional(),
  /** Required when mode is clear_unpriced and event id is known. */
  costEventId: z.string().uuid().optional(),
});
export type PlatformHealthSettlePendingRun = z.input<typeof platformHealthSettlePendingRunSchema>;

export const platformHealthReconcileResumeSchema = z.object({
  agentId: z.string().uuid(),
  dryRun: z.boolean().optional().default(false),
});
export type PlatformHealthReconcileResume = z.input<typeof platformHealthReconcileResumeSchema>;

export const platformHealthAutoHealSchema = z.object({
  dryRun: z.boolean().optional().default(true),
  /** Max auto-heals for the same fingerprint within a UTC day. */
  maxHealsPerFingerprint: z.number().int().min(1).max(20).optional().default(3),
  /** Max applied (or proposed) auto-safe remediations per call. */
  maxActions: z.number().int().min(1).max(50).optional().default(10),
  /** Pending runs older than this many minutes are candidates. */
  pendingAgeMinutes: z.number().int().min(1).max(24 * 60).optional().default(5),
  /** Resuming agents older than this many minutes get a lifecycle kick. */
  resumingAgeMinutes: z.number().int().min(1).max(24 * 60).optional().default(2),
});
export type PlatformHealthAutoHeal = z.input<typeof platformHealthAutoHealSchema>;

export const platformHealthEnsureMedicSchema = z.object({
  dryRun: z.boolean().optional().default(false),
  budgetMonthlyCents: z.number().int().nonnegative().max(10_000_000).optional().default(5_000),
  intervalSec: z.number().int().min(60).max(3_600).optional().default(180),
  model: z.string().trim().min(1).max(250).optional(),
  reportsToAgentId: z.string().uuid().optional(),
});
export type PlatformHealthEnsureMedic = z.input<typeof platformHealthEnsureMedicSchema>;

export type PlatformHealthIssueClass =
  | "pending_incomplete_receipt"
  | "pre_provider_failure"
  | "bad_unpriced_event"
  | "stuck_resuming"
  | "true_overspend"
  | "stranded_failed_run"
  | "stranded_recovery_action"
  | "blocker_attention"
  | "unknown";

export type PlatformHealthAction =
  | "propose"
  | "settle_hermes_estimate"
  | "settle_pre_provider"
  | "clear_unpriced"
  | "reconcile_resume"
  | "kick_lifecycle"
  | "retry_failed_run"
  | "resolve_recovery_action"
  | "escalate";
