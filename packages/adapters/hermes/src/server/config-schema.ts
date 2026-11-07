import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";

import {
  DEFAULT_GRACE_SEC,
  DEFAULT_TIMEOUT_SEC,
  VALID_PROVIDERS,
} from "../shared/constants.js";

function providerLabel(provider: string): string {
  if (provider === "auto") return "Auto";
  if (provider === "openai-codex") return "OpenAI Codex";
  if (provider === "kimi-coding") return "Kimi Coding";
  if (provider === "minimax-cn") return "MiniMax China";
  return provider
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "provider",
        label: "Provider",
        type: "select",
        default: "auto",
        options: VALID_PROVIDERS.map((provider) => ({
          value: provider,
          label: providerLabel(provider),
        })),
        hint: "Usually auto. Set this only when Hermes cannot infer the provider from the model or ~/.hermes/config.yaml.",
      },
      {
        key: "timeoutSec",
        label: "Timeout seconds",
        type: "number",
        default: DEFAULT_TIMEOUT_SEC,
      },
      {
        key: "graceSec",
        label: "Grace seconds",
        type: "number",
        default: DEFAULT_GRACE_SEC,
        hint: "Seconds to wait after SIGTERM before killing the Hermes process.",
      },
      {
        key: "maxTurnsPerRun",
        label: "Max turns per run",
        type: "number",
        hint: "Optional Hermes --max-turns limit for tool-calling iterations.",
      },
      {
        key: "toolsets",
        label: "Toolsets",
        type: "text",
        hint: "Optional comma-separated Hermes toolsets, such as terminal,file,web.",
      },
      {
        key: "persistSession",
        label: "Persist session",
        type: "toggle",
        default: true,
        hint: "Resume Hermes sessions across Paperclip heartbeats.",
      },
      {
        key: "worktreeMode",
        label: "Hermes worktree mode",
        type: "toggle",
        default: false,
        hint: "Pass Hermes --worktree.",
      },
      {
        key: "checkpoints",
        label: "Checkpoints",
        type: "toggle",
        default: false,
        hint: "Pass Hermes --checkpoints.",
      },
      {
        key: "quiet",
        label: "Quiet output",
        type: "toggle",
        default: true,
        hint: "Pass Hermes --quiet for cleaner Paperclip run transcripts.",
      },
      {
        key: "verbose",
        label: "Verbose output",
        type: "toggle",
        default: false,
        hint: "Pass Hermes --verbose.",
      },
      {
        key: "paperclipApiUrl",
        label: "Paperclip API URL",
        type: "text",
        hint: "Optional API base override. Defaults to PAPERCLIP_API_URL.",
      },
      {
        key: "promptTemplate",
        label: "Prompt template",
        type: "textarea",
        hint: "Optional custom prompt template with {{variable}} placeholders.",
      },
      {
        key: "smartModelRouting.enabled",
        label: "Smart model routing",
        type: "toggle",
        default: false,
        hint: "On a fresh issue wake, run a short cheap-model preflight, then optionally use the cheap model for early primary-agent requests before tools start.",
      },
      {
        key: "smartModelRouting.cheapModel",
        label: "Cheap model",
        type: "text",
        hint: "Same-provider model id used for preflight and early primary requests. Must be serveable by the resolved provider.",
      },
      {
        key: "smartModelRouting.maxPreflightTurns",
        label: "Max preflight turns",
        type: "number",
        default: 2,
        hint: "Hermes --max-turns cap for the cheap preflight child.",
      },
      {
        key: "smartModelRouting.maxCheapInputTokens",
        label: "Max cheap input tokens",
        type: "number",
        default: 12000,
        hint: "Inside the primary agent, lock to the primary model once rough input tokens reach this cap.",
      },
      {
        key: "smartModelRouting.perTurn",
        label: "Per-turn routing",
        type: "toggle",
        default: true,
        hint: "When enabled, the primary child may rewrite early API requests to the cheap model until tools start.",
      },
      {
        key: "smartModelRouting.separatePreflight",
        label: "Separate preflight child",
        type: "toggle",
        default: false,
        hint: "When enabled, spawn a second cheap-model process before the primary. Off by default — prefer per-turn routing inside one process.",
      },
      {
        key: "budget.enabled",
        label: "Turn/cost budget",
        type: "toggle",
        default: false,
        hint: "YIE-73. Soft per-run turn budget with checkpoint-and-continue. Requires PAPERCLIP_TURN_COST_BUDGET_V1=1 (default off).",
      },
      {
        key: "budget.turns",
        label: "Budget turns",
        type: "number",
        default: 40,
        hint: "YIE-73. Soft turn budget per run. Checkpoint fires at checkpointThreshold × turns.",
      },
      {
        key: "budget.costUsd",
        label: "Budget cost (USD)",
        type: "number",
        default: 1.5,
        hint: "YIE-73. Advisory cost bar in v1. Hard cost enforcement only when budget.enforceHardCost is on (fail-safe blocked on bad cost data).",
      },
      {
        key: "budget.tokenTurns",
        label: "Budget token-turns",
        type: "number",
        default: 8_000_000,
        hint: "YIE-73. Token-turn guideline (telemetry); turn count is the primary enforcement signal in v1.",
      },
      {
        key: "budget.checkpointThreshold",
        label: "Budget checkpoint threshold",
        type: "number",
        default: 0.8,
        hint: "YIE-73. Fraction of budget.turns that triggers checkpoint (default 0.8 → 32 of 40).",
      },
      {
        key: "budget.enforceHardCost",
        label: "Enforce hard cost cap",
        type: "toggle",
        default: false,
        hint: "YIE-73. When on, over-budget or untrustworthy cost terminates with blocked (R4 fail-safe). Off = cost advisory only.",
      },
      {
        key: "residentSession",
        label: "Resident session",
        type: "toggle",
        default: false,
        hint: "hermes_local only. Keep a Hermes process alive per issue (`hermes chat --resident`) so later wakes reuse the agent. Requires a Hermes build that supports --resident. Not available on hermes_gateway.",
      },
      {
        key: "residentIdleSec",
        label: "Resident idle timeout (sec)",
        type: "number",
        default: 86400,
        hint: "Exit the resident process after this many seconds without a turn. Paperclip default is 24h so warm reuse survives between wakes; the adapter also sweeps per-issue state idle >24h.",
      },
      {
        key: "residentWarmTtlInProgressSec",
        label: "Resident warm TTL — in_progress / failed+retry (sec)",
        type: "number",
        default: 900,
        hint: "YIE-71. Idle lifetime granted after in_progress or failed-with-retry. Requires PAPERCLIP_RESIDENT_WARM_POLICY_V2=1 (default off).",
      },
      {
        key: "residentWarmTtlTerminalSec",
        label: "Resident warm TTL — done / in_review / failed (sec)",
        type: "number",
        default: 180,
        hint: "YIE-71. Tunable 120–180. Short TTL after terminal dispositions (except cancelled).",
      },
      {
        key: "residentWarmTtlBlockedSec",
        label: "Resident warm TTL — blocked (sec)",
        type: "number",
        default: 900,
        hint: "YIE-71. Full TTL while blocked so a resume reuses the resident.",
      },
      {
        key: "residentWarmTtlUnknownSec",
        label: "Resident warm TTL — disposition unknown (sec)",
        type: "number",
        default: 180,
        hint: "YIE-71. TTL when disposition is missing/empty (F9 class). Never treated as in_progress.",
      },
      {
        key: "residentWarmTtlCancelledSec",
        label: "Resident warm TTL — cancelled (sec)",
        type: "number",
        default: 0,
        hint: "YIE-71. 0 stops the resident on cancelled.",
      },
      {
        key: "residentWarmMaxLiveResidents",
        label: "Resident warm max live (count)",
        type: "number",
        default: 8,
        hint: "YIE-71. Per-process live resident cap before LRU eviction (+2 pending-wake reservation).",
      },
      {
        key: "residentWarmMaxAggregateRssMb",
        label: "Resident warm max aggregate RSS (MB)",
        type: "number",
        default: 4096,
        hint: "YIE-71. Aggregate idle resident RSS cap before LRU eviction.",
      },
      {
        key: "reliability.failOpenSkillReconcile",
        label: "Fail-open skill reconcile",
        type: "toggle",
        default: true,
        hint: "YIE-68. When on, skill symlink collisions warn and skip instead of killing the run. Set false to restore fatal collisions (rollback).",
      },
      {
        key: "reliability.preValidateToolsets",
        label: "Pre-validate toolsets",
        type: "toggle",
        default: true,
        hint: "YIE-68. Fail fast before spawn when -t names unknown toolsets (e.g. creative/productivity). Set false to restore previous spawn-then-fail behaviour.",
      },
      {
        key: "reliability.dispositionSafety",
        label: "Disposition safety",
        type: "toggle",
        default: true,
        hint: "YIE-68. Reject unexpanded $-token disposition paths and fail loudly when a terminal-looking comment has no disposition file. Set false to roll back.",
      },
      {
        key: "reliability.optionalInstallNonFatal",
        label: "Optional install non-fatal",
        type: "toggle",
        default: true,
        hint: "YIE-68. Treat optional browser/system-lib install failures as degrade (warn + continue) rather than fatal. Set false to roll back messaging/policy.",
      },
    ],
  };
}
