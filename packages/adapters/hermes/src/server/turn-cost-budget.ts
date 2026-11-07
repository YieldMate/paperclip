/**
 * YIE-73 per-agent turn/cost budget with checkpoint-and-continue (flag-gated).
 *
 * Soft turn budget (default 40) checkpoints at `checkpointThreshold` (default 80%)
 * with an `in_progress` disposition + registered `executionPolicy.monitor` wait
 * target so the harness re-wakes without deliberate_wait / disposition-repair.
 * Hard turn (or fail-safe cost) limit terminates with `blocked` and stops the
 * resident. Cost is advisory in v1 (R4): never auto-continue on bad cost data.
 *
 * Inert unless `PAPERCLIP_TURN_COST_BUDGET_V1` is on AND `budget.enabled` is true.
 */

import fs from "node:fs/promises";
import path from "node:path";

/** Paperclip flag. Default OFF; 1/true/on/yes enables. */
export const TURN_COST_BUDGET_V1_ENV = "PAPERCLIP_TURN_COST_BUDGET_V1";

export const DEFAULT_BUDGET_TURNS = 40;
export const DEFAULT_BUDGET_COST_USD = 1.5;
export const DEFAULT_BUDGET_TOKEN_TURNS = 8_000_000;
export const DEFAULT_BUDGET_CHECKPOINT_THRESHOLD = 0.8;

export const BUDGET_CHECKPOINT_COMMENT =
  "Checkpoint before budget limit – progress saved, resuming shortly. Remaining scope continues on the next wake.";
export const BUDGET_HARD_LIMIT_COMMENT =
  "Budget exceeded – run stopped. Turn or cost hard limit reached; human review required before continuing.";
export const BUDGET_CHECKPOINT_MONITOR_NOTES = "budget checkpoint";

export const BUDGET_CHECKPOINT_PHASE = "budget_checkpoint_fired";
export const BUDGET_HARD_LIMIT_PHASE = "budget_hard_limit_hit";

const TERMINAL_DISPOSITION_STATUSES = new Set([
  "done",
  "in_review",
  "blocked",
  "cancelled",
]);

export function isTurnCostBudgetV1Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[TURN_COST_BUDGET_V1_ENV]?.trim().toLowerCase();
  if (!raw) return false;
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

function cfgBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  }
  return undefined;
}

function cfgNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export interface TurnCostBudgetConfig {
  /** Combined gate: env flag AND adapterConfig.budget.enabled. */
  active: boolean;
  enabled: boolean;
  turns: number;
  costUsd: number;
  tokenTurns: number;
  checkpointThreshold: number;
  /** Soft stop for Hermes `--max-turns` (floor of turns * threshold, min 1). */
  softMaxTurns: number;
}

/**
 * Schema fields use dotted keys (`budget.enabled`) that the UI stores flat on
 * adapterConfig. API/tests may also pass a nested `budget` object. Nested wins.
 */
export function resolveBudgetConfig(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): TurnCostBudgetConfig {
  const nested =
    config.budget && typeof config.budget === "object"
      ? (config.budget as Record<string, unknown>)
      : null;
  const pick = (key: string): unknown =>
    nested && key in nested ? nested[key] : config[`budget.${key}`];

  const enabled = cfgBoolean(pick("enabled")) === true;
  const turnsRaw = cfgNumber(pick("turns"));
  const turns =
    turnsRaw !== undefined && turnsRaw > 0
      ? Math.floor(turnsRaw)
      : DEFAULT_BUDGET_TURNS;
  const costRaw = cfgNumber(pick("costUsd"));
  const costUsd =
    costRaw !== undefined && costRaw >= 0 ? costRaw : DEFAULT_BUDGET_COST_USD;
  const tokenRaw = cfgNumber(pick("tokenTurns"));
  const tokenTurns =
    tokenRaw !== undefined && tokenRaw > 0
      ? Math.floor(tokenRaw)
      : DEFAULT_BUDGET_TOKEN_TURNS;
  const thresholdRaw = cfgNumber(pick("checkpointThreshold"));
  const checkpointThreshold =
    thresholdRaw !== undefined && thresholdRaw > 0 && thresholdRaw <= 1
      ? thresholdRaw
      : DEFAULT_BUDGET_CHECKPOINT_THRESHOLD;
  const softMaxTurns = Math.max(1, Math.floor(turns * checkpointThreshold));
  const flagOn = isTurnCostBudgetV1Enabled(env);

  return {
    active: flagOn && enabled,
    enabled,
    turns,
    costUsd,
    tokenTurns,
    checkpointThreshold,
    softMaxTurns,
  };
}

export type BudgetDecisionKind = "none" | "checkpoint" | "hard_limit";

export interface BudgetDecisionInput {
  budget: TurnCostBudgetConfig;
  /** Measured turns from HERMES_USAGE_FILE.api_calls (primary signal in v1). */
  currentTurns: number;
  /** Estimated/reported cost when available; ignored for auto-continue (R4). */
  estimatedCostUsd?: number | null;
  /** Cost accounting status from usage merge (`reported` | `estimated` | `unpriced`). */
  costStatus?: "reported" | "estimated" | "unpriced" | null;
  /** When true, enforce hard cost fail-safe (terminal blocked) instead of advisory. */
  enforceHardCost?: boolean;
  /** Existing disposition status from the child/resident, if any. */
  dispositionStatus?: string | null;
}

export interface BudgetDecision {
  kind: BudgetDecisionKind;
  reason: string;
  currentTurns: number;
  budgetTurns: number;
  softMaxTurns: number;
  estimatedCostUsd: number | null;
  costStatus: string | null;
}

export function isTerminalDispositionStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return TERMINAL_DISPOSITION_STATUSES.has(status.trim().toLowerCase());
}

/**
 * Decide checkpoint vs hard-limit vs none.
 *
 * Priority: terminal agent disposition → none (T5). Hard turn/cost → hard_limit.
 * Soft threshold with non-terminal work → checkpoint. Cost alone never auto-continues.
 */
export function decideBudgetAction(input: BudgetDecisionInput): BudgetDecision {
  const { budget } = input;
  const currentTurns = Number.isFinite(input.currentTurns)
    ? Math.max(0, Math.floor(input.currentTurns))
    : 0;
  const estimatedCostUsd =
    typeof input.estimatedCostUsd === "number" && Number.isFinite(input.estimatedCostUsd)
      ? input.estimatedCostUsd
      : null;
  const costStatus = input.costStatus ?? null;
  const base = {
    currentTurns,
    budgetTurns: budget.turns,
    softMaxTurns: budget.softMaxTurns,
    estimatedCostUsd,
    costStatus,
  };

  if (!budget.active) {
    return { kind: "none", reason: "budget_inactive", ...base };
  }

  if (isTerminalDispositionStatus(input.dispositionStatus)) {
    return { kind: "none", reason: "terminal_disposition", ...base };
  }

  // R4: hard cost path fails SAFE when cost data is bad or over the advisory bar.
  if (input.enforceHardCost) {
    const costUntrustworthy =
      costStatus === "unpriced" ||
      costStatus == null ||
      estimatedCostUsd == null;
    if (costUntrustworthy) {
      return {
        kind: "hard_limit",
        reason: "hard_cost_untrustworthy",
        ...base,
      };
    }
    if (estimatedCostUsd > budget.costUsd) {
      return {
        kind: "hard_limit",
        reason: "hard_cost_exceeded",
        ...base,
      };
    }
  }

  if (currentTurns >= budget.turns) {
    return { kind: "hard_limit", reason: "hard_turns_exceeded", ...base };
  }

  // Soft threshold: Hermes --max-turns is softMaxTurns, so hitting that without
  // a terminal disposition is the checkpoint contract.
  if (currentTurns >= budget.softMaxTurns) {
    return { kind: "checkpoint", reason: "soft_turns_threshold", ...base };
  }

  return { kind: "none", reason: "under_budget", ...base };
}

export interface HermesDispositionWrite {
  status: string;
  comment: string;
  /** Optional monitor payload stamped into resultJson for harness apply (R2). */
  monitor?: {
    nextCheckAt: string;
    notes: string;
  };
}

/**
 * Atomic write-to-temp-then-rename so a partially written file is never read as
 * complete (T4). Path must already be the resolved absolute HERMES_DISPOSITION_FILE.
 */
export async function writeHermesDispositionReport(
  filePath: string,
  disposition: HermesDispositionWrite,
): Promise<void> {
  if (!path.isAbsolute(filePath)) {
    throw new Error(
      `HERMES_DISPOSITION_FILE must be an absolute path (got ${filePath})`,
    );
  }
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const body = JSON.stringify({
    status: disposition.status,
    comment: disposition.comment,
  });
  await fs.writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, filePath);
}

export function buildBudgetCheckpointDisposition(now: Date = new Date()): HermesDispositionWrite {
  return {
    status: "in_progress",
    comment: BUDGET_CHECKPOINT_COMMENT,
    monitor: {
      nextCheckAt: now.toISOString(),
      notes: BUDGET_CHECKPOINT_MONITOR_NOTES,
    },
  };
}

export function buildBudgetHardLimitDisposition(reason: string): HermesDispositionWrite {
  return {
    status: "blocked",
    comment: `${BUDGET_HARD_LIMIT_COMMENT} (${reason})`,
  };
}

export interface PatchBudgetMonitorInput {
  apiBaseUrl: string;
  apiKey: string;
  issueId: string;
  runId?: string | null;
  nextCheckAt: string;
  notes: string;
  fetchImpl?: typeof fetch;
}

function normalizeApiBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

/**
 * PATCH the issue with a registered executionPolicy.monitor wait target (R2).
 * Comment-only child names are NOT a wait target.
 */
export async function patchIssueBudgetMonitor(
  input: PatchBudgetMonitorInput,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = normalizeApiBaseUrl(input.apiBaseUrl);
  const url = `${base}/issues/${encodeURIComponent(input.issueId)}`;
  try {
    const response = await fetchImpl(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(input.runId ? { "X-Paperclip-Run-Id": input.runId } : {}),
      },
      body: JSON.stringify({
        executionPolicy: {
          monitor: {
            nextCheckAt: input.nextCheckAt,
            notes: input.notes,
          },
        },
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        status: response.status,
        error: text.slice(0, 500) || `HTTP ${response.status}`,
      };
    }
    return { ok: true, status: response.status };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface BudgetTelemetryPayload {
  phase: typeof BUDGET_CHECKPOINT_PHASE | typeof BUDGET_HARD_LIMIT_PHASE;
  budgetTurns: number;
  measuredTurns: number;
  softMaxTurns: number;
  budgetCostUsd: number;
  measuredCostUsd: number | null;
  costStatus: string | null;
  reason: string;
  companyId: string | null;
  agentId: string | null;
  issueId: string | null;
  runId: string | null;
}

export function buildBudgetTelemetryPayload(
  decision: BudgetDecision,
  budget: TurnCostBudgetConfig,
  ids: {
    companyId?: string | null;
    agentId?: string | null;
    issueId?: string | null;
    runId?: string | null;
  },
): BudgetTelemetryPayload | null {
  if (decision.kind === "none") return null;
  return {
    phase:
      decision.kind === "checkpoint"
        ? BUDGET_CHECKPOINT_PHASE
        : BUDGET_HARD_LIMIT_PHASE,
    budgetTurns: budget.turns,
    measuredTurns: decision.currentTurns,
    softMaxTurns: budget.softMaxTurns,
    budgetCostUsd: budget.costUsd,
    measuredCostUsd: decision.estimatedCostUsd,
    costStatus: decision.costStatus,
    reason: decision.reason,
    companyId: ids.companyId ?? null,
    agentId: ids.agentId ?? null,
    issueId: ids.issueId ?? null,
    runId: ids.runId ?? null,
  };
}

/** Effective Hermes `--max-turns` when budget is active (soft cap). */
export function resolveBudgetMaxTurns(
  budget: TurnCostBudgetConfig,
  configuredMaxTurns: number | undefined,
): number | undefined {
  if (!budget.active) return configuredMaxTurns;
  // Soft cap is the Hermes stop; hard limit is enforced adapter-side after exit
  // when turns somehow reach budget.turns (threshold=1) or hard cost fires.
  if (configuredMaxTurns !== undefined && configuredMaxTurns > 0) {
    return Math.min(configuredMaxTurns, budget.softMaxTurns);
  }
  return budget.softMaxTurns;
}
