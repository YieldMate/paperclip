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
  /** After accounting/lifecycle heals, apply safe decisions-desk retries/resolves. */
  applyDeskTriage: z.boolean().optional().default(true),
  /** Cap for desk-triage applies nested under auto-heal. */
  maxDeskActions: z.number().int().min(1).max(50).optional().default(10),
});
export type PlatformHealthAutoHeal = z.input<typeof platformHealthAutoHealSchema>;

export const platformHealthEnsureMedicSchema = z.object({
  dryRun: z.boolean().optional().default(false),
  budgetMonthlyCents: z.number().int().nonnegative().max(10_000_000).optional().default(5_000),
  /** Fleet accounting/lifecycle wake interval. Connector reporting uses connectorCheckIntervalSec. */
  intervalSec: z.number().int().min(60).max(3_600).optional().default(180),
  /** How often MEDIC should escalate/report connector findings (default 1 hour). */
  connectorCheckIntervalSec: z.number().int().min(60).max(24 * 3_600).optional().default(3_600),
  model: z.string().trim().min(1).max(250).optional(),
  reportsToAgentId: z.string().uuid().optional(),
});
export type PlatformHealthEnsureMedic = z.input<typeof platformHealthEnsureMedicSchema>;

export const platformHealthApplyDeskTriageSchema = z.object({
  dryRun: z.boolean().optional().default(false),
  /** Max desk proposals to apply per call. */
  maxActions: z.number().int().min(1).max(50).optional().default(10),
  applyRetries: z.boolean().optional().default(true),
  applyResolves: z.boolean().optional().default(true),
});
export type PlatformHealthApplyDeskTriage = z.input<typeof platformHealthApplyDeskTriageSchema>;

export const platformHealthDiagnoseConnectorSchema = z.object({
  agentName: z.string().trim().min(1).max(200).optional(),
  agentId: z.string().uuid().optional(),
  applicationKey: z.string().trim().min(1).max(300).optional(),
  connectionId: z.string().uuid().optional(),
  connectionName: z.string().trim().min(1).max(300).optional(),
  /** Re-run the live health probe (default true). */
  probe: z.boolean().optional().default(true),
});
export type PlatformHealthDiagnoseConnector = z.input<typeof platformHealthDiagnoseConnectorSchema>;

export const platformHealthProbeConnectorSchema = z.object({
  connectionId: z.string().uuid(),
});
export type PlatformHealthProbeConnector = z.input<typeof platformHealthProbeConnectorSchema>;

export type PlatformHealthIssueClass =
  | "pending_incomplete_receipt"
  | "pre_provider_failure"
  | "bad_unpriced_event"
  | "stuck_resuming"
  | "true_overspend"
  | "stranded_failed_run"
  | "stranded_recovery_action"
  | "workspace_validation_stranded"
  | "blocker_attention"
  | "connector_unhealthy"
  | "connector_stale_probe"
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
  | "repair_project_workspace_git"
  | "probe_connection_health"
  | "escalate_connector"
  | "escalate";
