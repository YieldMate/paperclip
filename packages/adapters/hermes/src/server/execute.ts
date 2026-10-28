/**
 * Server-side execution logic for the Hermes Agent adapter.
 *
 * Spawns `hermes chat -q "..." -Q` as a child process, streams output,
 * and returns structured results to Paperclip.
 *
 * Verified CLI flags (hermes chat):
 *   -q/--query         single query (non-interactive)
 *   -Q/--quiet         quiet mode (no banner/spinner, only response + session_id)
 *   -m/--model         model name (e.g. anthropic/claude-sonnet-4)
 *   -t/--toolsets      comma-separated toolsets to enable
 *   --provider         inference provider (auto, openrouter, nous, etc.)
 *   -r/--resume        resume session by ID
 *   -w/--worktree      isolated git worktree
 *   -v/--verbose       verbose output
 *   --checkpoints      filesystem checkpoints
 *   --yolo             bypass dangerous-command approval prompts (agents have no TTY)
 *   --source           session source tag for filtering
 */

import fs from "node:fs/promises";
import path from "node:path";

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterRuntimeMcpServer,
  UsageSummary,
} from "@paperclipai/adapter-utils";

import {
  runChildProcess,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  renderTemplate,
  ensureAbsoluteDirectory,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  joinPromptSections,
  selectPaperclipPromptSections,
  stringifyPaperclipWakePayload,
  isPaperclipRecoveryWakePayload,
  resolvePaperclipInstanceRootForAdapter,
} from "@paperclipai/adapter-utils/server-utils";

import {
  HERMES_CLI,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_GRACE_SEC,
  DEFAULT_MODEL,
} from "../shared/constants.js";

import {
  detectModel,
  resolveProvider,
} from "./detect-model.js";
import { reconcileHermesPaperclipSkills } from "./skills.js";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function cfgString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function cfgNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function cfgBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function cfgStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((i) => typeof i === "string")
    ? (v as string[])
    : undefined;
}
function cfgEnvString(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  if (v && typeof v === "object" && "value" in v) {
    const value = (v as { value?: unknown }).value;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
  return undefined;
}

export function resolveHermesCommand(config: Record<string, unknown>): string {
  return cfgString(config.hermesCommand) || cfgString(config.command) || HERMES_CLI;
}

// ---------------------------------------------------------------------------
// Wake-up prompt builder
// ---------------------------------------------------------------------------

const HERMES_RUNTIME_IDENTITY_TEMPLATE = [
  'You are "{{agent.name}}", an AI agent employee in a Paperclip-managed company.',
  "",
  "Paperclip runtime identity:",
  "- Agent ID: {{agent.id}}",
  "- Company ID: {{agent.companyId}}",
  "- Run ID: {{run.id}}",
  "- API base: {{paperclipApiUrl}}",
].join("\n");

// Hermes applies this overlay at each API call, including after compaction,
// without storing it in conversation history. Keep run/task deltas in -q.
const HERMES_SYSTEM_PROMPT_TEMPLATE = [
  "Paperclip API guidance:",
  "- Use `curl` from the terminal for Paperclip API calls; browser/web extraction tools may not reach localhost.",
  "- Use `$PAPERCLIP_API_URL`, `$PAPERCLIP_API_KEY`, and `$PAPERCLIP_RUN_ID`; do not hard-code local ports or copy secrets into comments.",
  "- Displayed command logs may redact secrets; rely on environment variables instead of printed token values.",
  "- Include `-H \"Authorization: Bearer $PAPERCLIP_API_KEY\"` on API requests.",
  "- Include `-H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\"` on mutating issue requests.",
  "- For multiline comments or status updates, preserve newlines with `jq --arg` or a heredoc-fed helper rather than hand-escaping JSON.",
  "",
  "Safe multiline update pattern:",
  "```bash",
  "api=\"${PAPERCLIP_API_URL%/}\"",
  "case \"$api\" in */api) ;; *) api=\"$api/api\" ;; esac",
  "",
  "body=$(cat <<'MD'",
  "Summary line",
  "",
  "- Detail one",
  "- Detail two",
  "MD",
  ")",
  "jq -n --arg status done --arg comment \"$body\" '{status:$status, comment:$comment}' | \\",
  "  curl -sS -X PATCH \"$api/issues/$PAPERCLIP_TASK_ID\" \\",
  "    -H \"Authorization: Bearer $PAPERCLIP_API_KEY\" \\",
  "    -H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\" \\",
  "    -H \"Content-Type: application/json\" \\",
  "    --data-binary @-",
  "```",
  "",
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
].join("\n");

/** Appended to the ephemeral system prompt only when a runtime MCP overlay is written. */
const PAPERCLIP_RUNTIME_MCP_PROMPT = [
  "Paperclip connection tools:",
  "- Company connections for this run are MCP tools in toolsets named mcp-paperclip-*.",
  "- Use those tools for Linear and other Paperclip connections.",
  "- Do not use Hermes hosted connectors or manage_connections for those services.",
].join("\n");

function slugifyRuntimeMcpName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "server";
}

function nonEmptyEnv(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Agent-scoped runtime state (not shared `/tmp`) for per-run MCP overlays. */
export function resolveManagedHermesRuntimeStateDir(
  env: NodeJS.ProcessEnv,
  companyId: string,
  agentId: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmptyEnv(env.PAPERCLIP_HOME),
    instanceId: nonEmptyEnv(env.PAPERCLIP_INSTANCE_ID),
    env,
  });
  return path.join(instanceRoot, "companies", companyId, "agents", agentId, "hermes-runtime");
}

async function writeExclusiveOverlayFile(filePath: string, contents: string): Promise<void> {
  try {
    await fs.writeFile(filePath, contents, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Stale leftover from a prior crash — replace exclusively.
    await fs.rm(filePath, { force: true });
    await fs.writeFile(filePath, contents, { mode: 0o600, flag: "wx" });
  }
}

/** Build Hermes HERMES_MCP_OVERLAY JSON: slug → { url, headers? }. */
export function buildHermesRuntimeMcpOverlay(
  servers: ReadonlyArray<Pick<AdapterRuntimeMcpServer, "name" | "url"> & { token?: string }>,
): Record<string, { url: string; headers?: Record<string, string> }> {
  const used = new Set<string>();
  const overlay: Record<string, { url: string; headers?: Record<string, string> }> = {};
  for (const server of servers) {
    if (typeof server.url !== "string" || server.url.length === 0) continue;
    const base = slugifyRuntimeMcpName(server.name);
    let slug = base;
    let n = 2;
    while (used.has(slug)) {
      slug = `${base}-${n}`;
      n += 1;
    }
    used.add(slug);
    const entry: { url: string; headers?: Record<string, string> } = { url: server.url };
    if (typeof server.token === "string" && server.token.length > 0) {
      entry.headers = { Authorization: `Bearer ${server.token}` };
    }
    overlay[slug] = entry;
  }
  return overlay;
}

function renderConditionalSections(template: string, vars: Record<string, unknown>): string {
  const isTruthy = (key: string) => {
    if (key === "noTask") return !vars.taskId;
    const value = vars[key];
    if (Array.isArray(value)) return value.length > 0;
    return Boolean(value);
  };
  return template.replace(
    /\{\{#([a-zA-Z0-9_.-]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_match, key: string, body: string) => (isTruthy(key) ? body : ""),
  );
}

export function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  options: { resumedSession?: boolean } = {},
): string {
  const context = (ctx as any).context || {};
  const template = cfgString(config.promptTemplate);
  const taskId = cfgString(context.taskId) || cfgString(context.issueId) || cfgString(ctx.config?.taskId);
  const taskTitle = cfgString(context.taskTitle) || cfgString(ctx.config?.taskTitle) || "";
  const taskBody = cfgString(context.taskBody) || cfgString(ctx.config?.taskBody) || "";
  const commentId = cfgString(context.commentId) || cfgString(context.wakeCommentId) || cfgString(ctx.config?.commentId) || "";
  const wakeReason = cfgString(context.wakeReason) || cfgString(ctx.config?.wakeReason) || "";
  const agentName = ctx.agent?.name || "Hermes Agent";
  const companyName = cfgString(context.companyName) || cfgString(ctx.config?.companyName) || "";
  const projectName = cfgString(context.projectName) || cfgString(ctx.config?.projectName) || "";

  // Build API URL — ensure it has the /api path
  let paperclipApiUrl =
    cfgString(config.paperclipApiUrl) ||
    process.env.PAPERCLIP_API_URL ||
    "http://127.0.0.1:3100/api";
  // Ensure /api suffix
  if (!paperclipApiUrl.endsWith("/api")) {
    paperclipApiUrl = paperclipApiUrl.replace(/\/+$/, "") + "/api";
  }

  const { taskContextNote: taskContextMarkdown, wakePrompt } = selectPaperclipPromptSections(context, {
    resumedSession: options.resumedSession === true,
    includeCommunicationGuidance: true,
  });
  // Keep the historical variable available to custom templates. Automatic
  // assembly uses the ownership-aware assignment variant below.
  const paperclipTaskMarkdown = cfgString(context.paperclipTaskMarkdown)?.trim() || "";
  const sessionHandoffMarkdown = cfgString(context.paperclipSessionHandoffMarkdown)?.trim() || "";
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake) || "";

  const vars: Record<string, unknown> = {
    agentId: ctx.agent?.id || "",
    agentName,
    companyId: ctx.agent?.companyId || "",
    companyName,
    runId: ctx.runId || "",
    agent: ctx.agent || {},
    company: { id: ctx.agent?.companyId || "", name: companyName },
    run: { id: ctx.runId || "", source: "on_demand" },
    context,
    taskId: taskId || "",
    taskTitle,
    taskBody,
    commentId,
    wakeReason,
    projectName,
    paperclipApiUrl,
    paperclipWakePrompt: wakePrompt,
    paperclipTaskMarkdown,
    taskContext: paperclipTaskMarkdown,
    taskContextMarkdown,
    paperclipWakeJson: wakePayloadJson,
    wakePayloadJson,
    paperclipApiKeyEnv: "PAPERCLIP_API_KEY",
    paperclipRunIdEnv: "PAPERCLIP_RUN_ID",
  };

  const rendered = template && !isPaperclipRecoveryWakePayload(context.paperclipWake)
    ? renderTemplate(renderConditionalSections(template, vars), vars)
    : "";
  return joinPromptSections([
    renderTemplate(HERMES_RUNTIME_IDENTITY_TEMPLATE, vars),
    wakePrompt,
    sessionHandoffMarkdown,
    taskContextMarkdown,
    rendered,
  ]);
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/** Regex to extract session ID from Hermes quiet-mode output: "session_id: <id>" */
const SESSION_ID_REGEX = /^session_id:\s*(\S+)/m;

/** Regex for legacy session output format */
const SESSION_ID_REGEX_LEGACY = /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i;

/** Regex to extract token usage from Hermes output. */
const TOKEN_USAGE_REGEX =
  /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i;

/** Regex to extract cost from Hermes output. */
const COST_REGEX = /(?:cost|spent)[:\s]*\$?([\d.]+)/i;

interface ParsedOutput {
  sessionId?: string;
  response?: string;
  usage?: UsageSummary;
  costUsd?: number;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Response cleaning
// ---------------------------------------------------------------------------

/** Strip noise lines from a Hermes response (tool output, system messages, etc.) */
function cleanResponse(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true; // keep blank lines for paragraph separation
      if (t.startsWith("[tool]") || t.startsWith("[hermes]") || t.startsWith("[paperclip]")) return false;
      if (t.startsWith("session_id:")) return false;
      if (/^\[\d{4}-\d{2}-\d{2}T/.test(t)) return false;
      if (/^\[done\]\s*┊/.test(t)) return false;
      if (/^┊\s*[\p{Emoji_Presentation}]/u.test(t) && !/^┊\s*💬/.test(t)) return false;
      if (/^\p{Emoji_Presentation}\s*(Completed|Running|Error)?\s*$/u.test(t)) return false;
      return true;
    })
    .map((line) => {
      let t = line.replace(/^[\s]*┊\s*💬\s*/, "").trim();
      t = t.replace(/^\[done\]\s*/, "").trim();
      return t;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

function parseHermesOutput(stdout: string, stderr: string): ParsedOutput {
  const combined = stdout + "\n" + stderr;
  const result: ParsedOutput = {};

  // In quiet mode, Hermes outputs:
  //   <response text>
  //
  //   session_id: <id>
  const sessionMatch = stdout.match(SESSION_ID_REGEX);
  if (sessionMatch?.[1]) {
    result.sessionId = sessionMatch?.[1] ?? null;
    // The response is everything before the session_id line
    const sessionLineIdx = stdout.lastIndexOf("\nsession_id:");
    if (sessionLineIdx > 0) {
      result.response = cleanResponse(stdout.slice(0, sessionLineIdx));
    }
  } else {
    // Legacy format (non-quiet mode)
    const legacyMatch = combined.match(SESSION_ID_REGEX_LEGACY);
    if (legacyMatch?.[1]) {
      result.sessionId = legacyMatch?.[1] ?? null;
    }
    // In non-quiet mode, extract clean response from stdout by
    // filtering out tool lines, system messages, and noise
    const cleaned = cleanResponse(stdout);
    if (cleaned.length > 0) {
      result.response = cleaned;
    }
  }

  // Extract token usage
  const usageMatch = combined.match(TOKEN_USAGE_REGEX);
  if (usageMatch) {
    result.usage = {
      inputTokens: parseInt(usageMatch[1], 10) || 0,
      outputTokens: parseInt(usageMatch[2], 10) || 0,
    };
  }

  // Extract cost
  const costMatch = combined.match(COST_REGEX);
  if (costMatch?.[1]) {
    result.costUsd = parseFloat(costMatch[1]);
  }

  // Check for error patterns in stderr
  if (stderr.trim()) {
    const errorLines = stderr
      .split("\n")
      .filter((line) => /error|exception|traceback|failed/i.test(line))
      .filter((line) => !/INFO|DEBUG|warn/i.test(line)); // skip log-level noise
    if (errorLines.length > 0) {
      result.errorMessage = errorLines.slice(0, 5).join("\n");
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Smart model routing
// ---------------------------------------------------------------------------

const PREFLIGHT_TIMEOUT_SEC = 120;
const PREFLIGHT_HANDOFF_MAX_CHARS = 4000;
const DEFAULT_MAX_PREFLIGHT_TURNS = 2;
const DEFAULT_MAX_CHEAP_INPUT_TOKENS = 12000;

export interface SmartModelRoutingConfig {
  enabled: boolean;
  cheapModel: string;
  maxPreflightTurns: number;
  maxCheapInputTokens: number;
  perTurn: boolean;
}

/**
 * Schema fields use dotted keys (`smartModelRouting.enabled`) that the UI stores
 * flat on adapterConfig. API/tests may also pass a nested `smartModelRouting` object.
 * Nested values win when both are present.
 */
function cfgSmartModelRouting(config: Record<string, unknown>): SmartModelRoutingConfig {
  const nested =
    config.smartModelRouting && typeof config.smartModelRouting === "object"
      ? (config.smartModelRouting as Record<string, unknown>)
      : null;
  const pick = (key: string): unknown =>
    nested && key in nested ? nested[key] : config[`smartModelRouting.${key}`];
  return {
    enabled: cfgBoolean(pick("enabled")) === true,
    cheapModel: cfgString(pick("cheapModel")) || "",
    maxPreflightTurns: cfgNumber(pick("maxPreflightTurns")) ?? DEFAULT_MAX_PREFLIGHT_TURNS,
    maxCheapInputTokens: cfgNumber(pick("maxCheapInputTokens")) ?? DEFAULT_MAX_CHEAP_INPUT_TOKENS,
    perTurn: cfgBoolean(pick("perTurn")) !== false,
  };
}

const PREFLIGHT_HANDOFF_INSTRUCTION = [
  "Paperclip cheap-model preflight:",
  "- Inspect the issue and connection tools (mcp-paperclip-*) read-only.",
  "- Do not edit files, mutate connections, change issue status, or mark the task complete.",
  "- Summarize findings and a recommended next action for the primary agent.",
].join("\n");

function wakeReasonFor(ctx: AdapterExecutionContext, config: Record<string, unknown>): string {
  const context = ((ctx as { context?: Record<string, unknown> }).context) || {};
  const wake = context.paperclipWake;
  const wakeReasonFromPayload =
    wake && typeof wake === "object"
      ? cfgString((wake as Record<string, unknown>).reason)
      : undefined;
  return (
    cfgString(context.wakeReason) ||
    wakeReasonFromPayload ||
    cfgString(config.wakeReason) ||
    ""
  );
}

function issueOrTaskIdFor(ctx: AdapterExecutionContext, config: Record<string, unknown>): string | undefined {
  const context = ((ctx as { context?: Record<string, unknown> }).context) || {};
  return (
    cfgString(context.taskId) ||
    cfgString(context.issueId) ||
    cfgString(config.taskId)
  );
}

/** Fresh issue/task wake with routing on and no resumed Hermes session. */
export function isSmartRoutingPreflightEligible(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  sessionId: string | undefined,
  routing: SmartModelRoutingConfig,
): boolean {
  if (!routing.enabled || !routing.cheapModel) return false;
  if (sessionId) return false;
  if (!issueOrTaskIdFor(ctx, config)) return false;
  const wakeReason = wakeReasonFor(ctx, config);
  if (wakeReason.startsWith("execution_")) return false;
  if (wakeReason.startsWith("approval_")) return false;
  return true;
}

interface HermesChildSpawnOptions {
  hermesCmd: string;
  model: string;
  prompt: string;
  provider: string;
  toolsets?: string;
  maxTurns?: number;
  worktreeMode: boolean;
  checkpoints: boolean;
  verbose: boolean;
  quiet: boolean;
  extraArgs?: string[];
  sessionId?: string;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onSpawn?: AdapterExecutionContext["onSpawn"];
  runId: string;
}

interface HermesChildResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  parsed: ParsedOutput;
}

function buildHermesChatArgs(opts: {
  prompt: string;
  model: string;
  provider: string;
  toolsets?: string;
  maxTurns?: number;
  worktreeMode: boolean;
  checkpoints: boolean;
  verbose: boolean;
  quiet: boolean;
  extraArgs?: string[];
  sessionId?: string;
}): string[] {
  const args: string[] = ["chat", "-q", opts.prompt];
  if (opts.quiet) args.push("-Q");
  if (opts.model) args.push("-m", opts.model);
  if (opts.provider !== "auto") args.push("--provider", opts.provider);
  if (opts.toolsets) args.push("-t", opts.toolsets);
  if (opts.maxTurns && opts.maxTurns > 0) args.push("--max-turns", String(opts.maxTurns));
  if (opts.worktreeMode) args.push("-w");
  if (opts.checkpoints) args.push("--checkpoints");
  if (opts.verbose) args.push("-v");
  args.push("--source", "tool");
  args.push("--yolo");
  if (opts.sessionId) args.push("--resume", opts.sessionId);
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  return args;
}

async function spawnHermesChild(opts: HermesChildSpawnOptions): Promise<HermesChildResult> {
  const args = buildHermesChatArgs(opts);
  const result = await runChildProcess(opts.runId, opts.hermesCmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    timeoutSec: opts.timeoutSec,
    graceSec: opts.graceSec,
    onLog: opts.onLog,
    onSpawn: opts.onSpawn,
  });
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    parsed: parseHermesOutput(result.stdout || "", result.stderr || ""),
  };
}

interface HermesUsageReport {
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  estimated_cost_usd?: number;
  usage_by_model?: Array<{
    model?: string;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    estimated_cost_usd?: number;
  }>;
}

async function readHermesUsageReport(filePath: string | undefined): Promise<HermesUsageReport | null> {
  if (!filePath) return null;
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as HermesUsageReport;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Merge preflight + primary usage reports into totals and per-model parts. */
export function mergeHermesUsageReports(
  reports: Array<HermesUsageReport | null | undefined>,
  primaryModel: string,
): {
  usage?: UsageSummary;
  costUsd?: number;
  usageByModel?: Array<{ model: string; usage: UsageSummary; costUsd: number }>;
} {
  const byModel = new Map<string, { inputTokens: number; outputTokens: number; cachedInputTokens: number; costUsd: number }>();

  const addPart = (
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    cachedInputTokens: number,
    costUsd: number,
  ) => {
    const id = modelId.trim() || primaryModel;
    const prev = byModel.get(id) || { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 };
    prev.inputTokens += inputTokens;
    prev.outputTokens += outputTokens;
    prev.cachedInputTokens += cachedInputTokens;
    prev.costUsd += costUsd;
    byModel.set(id, prev);
  };

  for (const report of reports) {
    if (!report) continue;
    const nested = Array.isArray(report.usage_by_model) ? report.usage_by_model : null;
    if (nested && nested.length > 0) {
      for (const part of nested) {
        if (!part || typeof part !== "object") continue;
        addPart(
          typeof part.model === "string" ? part.model : primaryModel,
          Number(part.input_tokens) || 0,
          Number(part.output_tokens) || 0,
          Number(part.cache_read_tokens) || 0,
          Number(part.estimated_cost_usd) || 0,
        );
      }
      continue;
    }
    addPart(
      typeof report.model === "string" ? report.model : primaryModel,
      Number(report.input_tokens) || 0,
      Number(report.output_tokens) || 0,
      Number(report.cache_read_tokens) || 0,
      Number(report.estimated_cost_usd) || 0,
    );
  }

  if (byModel.size === 0) return {};

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let costUsd = 0;
  const usageByModel: Array<{ model: string; usage: UsageSummary; costUsd: number }> = [];
  for (const [modelId, part] of byModel) {
    inputTokens += part.inputTokens;
    outputTokens += part.outputTokens;
    cachedInputTokens += part.cachedInputTokens;
    costUsd += part.costUsd;
    usageByModel.push({
      model: modelId,
      usage: {
        inputTokens: part.inputTokens,
        outputTokens: part.outputTokens,
        ...(part.cachedInputTokens > 0 ? { cachedInputTokens: part.cachedInputTokens } : {}),
      },
      costUsd: part.costUsd,
    });
  }

  const usage: UsageSummary = {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
  };

  // Omit usageByModel when a single part would duplicate the top-level receipt with no split,
  // or when ids collide after merge (already unique via Map). Always attach when multiple models.
  const out: {
    usage?: UsageSummary;
    costUsd?: number;
    usageByModel?: Array<{ model: string; usage: UsageSummary; costUsd: number }>;
  } = { usage, costUsd };
  if (usageByModel.length > 1) {
    out.usageByModel = usageByModel;
  } else if (usageByModel.length === 1) {
    // Still attach when the single part matches totals (run-cost-accounting accepts unique ids).
    out.usageByModel = usageByModel;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main execute
// ---------------------------------------------------------------------------

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const config = (ctx.config ?? ctx.agent?.adapterConfig ?? {}) as Record<string, unknown>;

  // ── Resolve configuration ──────────────────────────────────────────────
  const hermesCmd = resolveHermesCommand(config);
  const model = cfgString(config.model) || DEFAULT_MODEL;
  const timeoutSec = cfgNumber(config.timeoutSec) || DEFAULT_TIMEOUT_SEC;
  const graceSec = cfgNumber(config.graceSec) || DEFAULT_GRACE_SEC;
  const maxTurns = cfgNumber(config.maxTurnsPerRun);
  const toolsets = cfgString(config.toolsets) || cfgStringArray(config.enabledToolsets)?.join(",");
  const extraArgs = cfgStringArray(config.extraArgs);
  const persistSession = cfgBoolean(config.persistSession) !== false;
  const worktreeMode = cfgBoolean(config.worktreeMode) === true;
  const checkpoints = cfgBoolean(config.checkpoints) === true;
  const smartRouting = cfgSmartModelRouting(config);
  const prevSessionId = cfgString(
    (ctx.runtime?.sessionParams as Record<string, unknown> | null)?.sessionId,
  );

  // The server adds this runtime inventory at the run boundary. Requiring the
  // marker avoids touching a developer's real Hermes home in direct unit or
  // library calls that did not opt into Paperclip runtime skills.
  if (Object.prototype.hasOwnProperty.call(config, "paperclipRuntimeSkills")) {
    try {
      const selectedSkills = await reconcileHermesPaperclipSkills(config);
      if (selectedSkills.length > 0) {
        await ctx.onLog(
          "stdout",
          `[hermes] Reconciled ${selectedSkills.length} Paperclip-managed skill(s) into the Hermes skills home.\n`,
        );
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await ctx.onLog("stderr", `[hermes] Cannot start without the required Paperclip-managed skills: ${reason}\n`);
      throw err;
    }
  }

  // ── Resolve provider (defense in depth) ────────────────────────────────
  // Priority chain:
  //   1. Explicit provider in adapterConfig (user override)
  //   2. Provider from ~/.hermes/config.yaml (detected at runtime)
  //   3. Provider inferred from model name prefix
  //   4. "auto" (let Hermes decide)
  //
  // This ensures that even if the agent was created before provider tracking
  // was added, or if the model was changed without updating provider, the
  // correct provider is still used.
  let detectedConfig: Awaited<ReturnType<typeof detectModel>> | null = null;
  const explicitProvider = cfgString(config.provider);

  if (!explicitProvider) {
    try {
      detectedConfig = await detectModel();
    } catch {
      // Non-fatal — detection failure shouldn't block execution
    }
  }

  const { provider: resolvedProvider, resolvedFrom } = resolveProvider({
    explicitProvider,
    detectedProvider: detectedConfig?.provider,
    detectedModel: detectedConfig?.model,
    detectedBaseUrl: detectedConfig?.baseUrl,
    detectedHasApiKey: detectedConfig?.hasApiKey,
    detectedApiMode: detectedConfig?.apiMode,
    model,
  });

  // ── Load agent instructions file (Paperclip instruction bundles) ──────
  // Paperclip can materialize managed instructions into instructionsFilePath;
  // when present, reapply that bundle through Hermes's native system overlay.
  const instructionsFilePath = cfgString(config.instructionsFilePath);
  let agentInstructions = "";
  if (instructionsFilePath) {
    try {
      agentInstructions = await fs.readFile(instructionsFilePath, "utf-8");
      const loadedInstructionsLength = agentInstructions.length;
      const instructionsFileDir = path.dirname(instructionsFilePath);
      agentInstructions += `\nThe above agent instructions were loaded from ${instructionsFilePath}. Resolve any relative file references from ${instructionsFileDir}/.`;
      await ctx.onLog(
        "stdout",
        `[hermes] Loaded agent instructions from ${instructionsFilePath} (${loadedInstructionsLength} chars)\n`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Non-fatal: log to stdout with an explicit "Warning:" prefix so the
      // Paperclip UI doesn't render this as a red error (stderr output is
      // surfaced as an error signal even when execution continues).
      await ctx.onLog(
        "stdout",
        `[hermes] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }

  // ── Build prompt ───────────────────────────────────────────────────────
  const userEnvForPrompt = config.env as Record<string, unknown> | undefined;
  const promptConfig: Record<string, unknown> = { ...config };
  if (!cfgString(promptConfig.paperclipApiUrl) && userEnvForPrompt && typeof userEnvForPrompt === "object") {
    const configuredPaperclipApiUrl = cfgEnvString(userEnvForPrompt.PAPERCLIP_API_URL);
    if (configuredPaperclipApiUrl) {
      promptConfig.paperclipApiUrl = configuredPaperclipApiUrl;
    }
  }

  const sessionId = persistSession ? prevSessionId : undefined;
  const prompt = buildPrompt(ctx, promptConfig, { resumedSession: Boolean(sessionId) });
  const useQuiet = cfgBoolean(config.quiet) === true; // default false
  const useVerbose = cfgBoolean(config.verbose) === true;
  const runPreflight = isSmartRoutingPreflightEligible(ctx, config, sessionId, smartRouting);

  // ── Build environment ──────────────────────────────────────────────────
  const userEnv = config.env as Record<string, string> | undefined;
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(userEnv && typeof userEnv === "object" ? userEnv : {}),
    ...buildPaperclipEnv(ctx.agent, ctx.agentIdentity),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };

  // Always run `hermes chat -q` in this child so HERMES_MCP_OVERLAY applies
  // (shared gateway would not see a per-run overlay).
  env.HERMES_INPROCESS_CHAT = "1";

  const runtimeMcpServers = (ctx.runtimeMcp?.getServers() ?? []).filter(
    (server) => typeof server.url === "string" && server.url.length > 0,
  );
  const runtimeMcpRunId = typeof ctx.runId === "string" ? ctx.runId.trim() : "";
  let runtimeCleanupDir: string | undefined;
  let runtimeMcpOverlayPath: string | undefined;
  let preflightUsagePath: string | undefined;
  let primaryUsagePath: string | undefined;
  // Overlay write and every await after it must stay inside this try/finally so a
  // rejected startup log (or later setup failure) still removes the bearer-token file.
  try {
    // Keep credentials out of shared/world-listable temp. Mirror Claude: write under the
    // agent-scoped Paperclip runtime tree with a 0700 directory and exclusive 0600 create.
    // Refuse empty/missing run ids so we do not attach MCP without a run key.
    const needsRunStateDir =
      runtimeMcpRunId.length > 0 &&
      (runtimeMcpServers.length > 0 || runPreflight || smartRouting.enabled);
    if (needsRunStateDir) {
      const stateDir = resolveManagedHermesRuntimeStateDir(
        env,
        ctx.agent.companyId,
        ctx.agent.id,
      );
      runtimeCleanupDir = path.join(stateDir, "runs", runtimeMcpRunId);
      const mcpDir = path.join(runtimeCleanupDir, "mcp");
      await fs.mkdir(mcpDir, { recursive: true, mode: 0o700 });
      await fs.chmod(mcpDir, 0o700);

      if (runtimeMcpServers.length > 0) {
        const overlay = buildHermesRuntimeMcpOverlay(runtimeMcpServers);
        runtimeMcpOverlayPath = path.join(mcpDir, "overlay.json");
        await writeExclusiveOverlayFile(runtimeMcpOverlayPath, JSON.stringify(overlay));
        env.HERMES_MCP_OVERLAY = runtimeMcpOverlayPath;
      }

      if (runPreflight || smartRouting.enabled) {
        preflightUsagePath = path.join(mcpDir, `${runtimeMcpRunId}.preflight-usage.json`);
        primaryUsagePath = path.join(mcpDir, `${runtimeMcpRunId}.usage.json`);
      }
    }

    // Scope the overlay to this child process. Read the current bundle on every
    // invocation; never infer its availability from a persisted session ID.
    // Preserve an operator's explicit overlay before Paperclip's instructions.
    const baseEphemeralPrompt = joinPromptSections([
      env.HERMES_EPHEMERAL_SYSTEM_PROMPT,
      agentInstructions,
      renderTemplate(HERMES_SYSTEM_PROMPT_TEMPLATE, {
        agent: ctx.agent,
      }),
      runtimeMcpOverlayPath ? PAPERCLIP_RUNTIME_MCP_PROMPT : "",
    ]);
    env.HERMES_EPHEMERAL_SYSTEM_PROMPT = baseEphemeralPrompt;

    if (ctx.runId) env.PAPERCLIP_RUN_ID = ctx.runId;

    // PAPERCLIP_API_KEY is never accepted from config — the harness-minted run
    // token is the only source of Paperclip API identity.
    delete env.PAPERCLIP_API_KEY;
    // Wake context travels in the prompt; drop both inherited and configured copies.
    delete env.PAPERCLIP_WAKE_PAYLOAD_JSON;
    if ((ctx as any).authToken) env.PAPERCLIP_API_KEY = (ctx as any).authToken;

    // BUG FIX: Read task context from ctx.context (wake context), not ctx.config (adapter config)
    const ctxContext = (ctx as any).context || {};
    const envTaskId = cfgString(ctxContext.taskId) || cfgString(ctxContext.issueId) || cfgString(ctx.config?.taskId);
    if (envTaskId) env.PAPERCLIP_TASK_ID = envTaskId;
    const envWakeReason = cfgString(ctxContext.wakeReason) || cfgString(ctx.config?.wakeReason);
    if (envWakeReason) env.PAPERCLIP_WAKE_REASON = envWakeReason;
    const envCommentId = cfgString(ctxContext.commentId) || cfgString(ctxContext.wakeCommentId) || cfgString(ctx.config?.commentId);
    if (envCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = envCommentId;

    // ── Resolve working directory ──────────────────────────────────────────
    const workspace = ctx.context?.paperclipWorkspace;
    const workspaceCwd = workspace && typeof workspace === "object"
      ? cfgString((workspace as Record<string, unknown>).cwd)
      : undefined;
    const cwd =
      cfgString(config.cwd) || workspaceCwd || cfgString(ctx.config?.workspaceDir) || ".";
    try {
      await ensureAbsoluteDirectory(cwd);
    } catch {
      // Non-fatal
    }

    // ── Log start ──────────────────────────────────────────────────────────
    await ctx.onLog(
      "stdout",
      `[hermes] Starting Hermes Agent (model=${model}, provider=${resolvedProvider} [${resolvedFrom}], timeout=${timeoutSec}s${maxTurns ? `, max_turns=${maxTurns}` : ""})\n`,
    );
    if (sessionId) {
      await ctx.onLog(
        "stdout",
        `[hermes] Resuming session: ${sessionId}\n`,
      );
    }
    if (runtimeMcpOverlayPath) {
      await ctx.onLog(
        "stdout",
        `[hermes] Attached ${runtimeMcpServers.length} Paperclip MCP server(s) for this run.\n`,
      );
    }

    // Hermes writes non-error noise to stderr (MCP init, INFO logs, etc).
    // Paperclip renders all stderr as red/error in the UI.
    // Wrap onLog to reclassify benign stderr lines as stdout.
    const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
      if (stream === "stderr") {
        const trimmed = chunk.trimEnd();
        const isBenign = /^\[?\d{4}[-/]\d{2}[-/]\d{2}T/.test(trimmed) ||
          /^[A-Z]+:\s+(INFO|DEBUG|WARN|WARNING)\b/.test(trimmed) ||
          /Successfully registered all tools/.test(trimmed) ||
          /MCP [Ss]erver/.test(trimmed) ||
          /tool registered successfully/.test(trimmed) ||
          /Application initialized/.test(trimmed);
        if (isBenign) {
          return ctx.onLog("stdout", chunk);
        }
      }
      return ctx.onLog(stream, chunk);
    };

    const sharedChildOpts = {
      hermesCmd,
      provider: resolvedProvider,
      toolsets,
      worktreeMode,
      checkpoints,
      verbose: useVerbose,
      quiet: useQuiet,
      extraArgs,
      cwd,
      graceSec,
      onLog: wrappedOnLog,
      runId: ctx.runId,
    };

    const modelRoutingPhases: string[] = [];
    let preflightHandoff = "";

    // ── Optional cheap preflight child (same overlay, no resume) ─────────
    if (runPreflight) {
      await ctx.onLog(
        "stdout",
        `[hermes] Smart routing preflight (model=${smartRouting.cheapModel}, max_turns=${smartRouting.maxPreflightTurns})\n`,
      );
      const preflightEnv: Record<string, string> = {
        ...env,
        HERMES_EPHEMERAL_SYSTEM_PROMPT: joinPromptSections([
          baseEphemeralPrompt,
          PREFLIGHT_HANDOFF_INSTRUCTION,
        ]),
      };
      delete preflightEnv.HERMES_PAPERCLIP_MODEL_ROUTE;
      if (preflightUsagePath) preflightEnv.HERMES_USAGE_FILE = preflightUsagePath;

      try {
        const preflight = await spawnHermesChild({
          ...sharedChildOpts,
          model: smartRouting.cheapModel,
          prompt,
          maxTurns: smartRouting.maxPreflightTurns > 0
            ? smartRouting.maxPreflightTurns
            : DEFAULT_MAX_PREFLIGHT_TURNS,
          env: preflightEnv,
          timeoutSec: PREFLIGHT_TIMEOUT_SEC,
          // Preflight is short-lived; Paperclip must record the primary child's PID.
        });
        modelRoutingPhases.push("cheap_preflight");
        if (
          !preflight.timedOut &&
          preflight.exitCode === 0 &&
          preflight.parsed.response
        ) {
          preflightHandoff = preflight.parsed.response.slice(0, PREFLIGHT_HANDOFF_MAX_CHARS);
        } else {
          const reason = preflight.timedOut
            ? "timed out"
            : `exit ${preflight.exitCode ?? "null"}`;
          await ctx.onLog(
            "stdout",
            `[hermes] Smart routing preflight ${reason}; continuing with primary (no handoff).\n`,
          );
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await ctx.onLog(
          "stdout",
          `[hermes] Smart routing preflight failed (${reason}); continuing with primary (no handoff).\n`,
        );
      }
    }

    // ── Primary child ────────────────────────────────────────────────────
    const primaryEnv: Record<string, string> = { ...env };
    if (primaryUsagePath) primaryEnv.HERMES_USAGE_FILE = primaryUsagePath;
    if (smartRouting.enabled && smartRouting.cheapModel && smartRouting.perTurn) {
      primaryEnv.HERMES_PAPERCLIP_MODEL_ROUTE = JSON.stringify({
        primaryModel: model,
        cheapModel: smartRouting.cheapModel,
        maxCheapInputTokens: smartRouting.maxCheapInputTokens,
      });
    } else {
      delete primaryEnv.HERMES_PAPERCLIP_MODEL_ROUTE;
    }

    const primaryPrompt = preflightHandoff
      ? joinPromptSections([
          prompt,
          "Paperclip cheap-model preflight handoff:",
          preflightHandoff,
        ])
      : prompt;

    const child = await spawnHermesChild({
      ...sharedChildOpts,
      model,
      prompt: primaryPrompt,
      maxTurns,
      sessionId,
      env: primaryEnv,
      timeoutSec,
      onSpawn: ctx.onSpawn,
    });
    modelRoutingPhases.push("primary");
    const parsed = child.parsed;

    await ctx.onLog(
      "stdout",
      `[hermes] Exit code: ${child.exitCode ?? "null"}, timed out: ${child.timedOut}\n`,
    );
    if (parsed.sessionId) {
      await ctx.onLog("stdout", `[hermes] Session: ${parsed.sessionId}\n`);
    }

    // ── Usage files (preflight + primary) ────────────────────────────────
    const usageReports = await Promise.all([
      readHermesUsageReport(preflightUsagePath),
      readHermesUsageReport(primaryUsagePath),
    ]);
    const mergedUsage = mergeHermesUsageReports(usageReports, model);

    // ── Build result ───────────────────────────────────────────────────────
    const executionResult: AdapterExecutionResult = {
      exitCode: child.exitCode,
      signal: child.signal,
      timedOut: child.timedOut,
      provider: resolvedProvider,
      model,
    };

    if (parsed.errorMessage) {
      executionResult.errorMessage = parsed.errorMessage;
    } else if (!child.timedOut && typeof child.exitCode === "number" && child.exitCode !== 0) {
      executionResult.errorMessage = `Hermes exited with code ${child.exitCode}`;
    }

    if (mergedUsage.usage) {
      executionResult.usage = mergedUsage.usage;
    } else if (parsed.usage) {
      executionResult.usage = parsed.usage;
    }

    if (mergedUsage.costUsd !== undefined) {
      executionResult.costUsd = mergedUsage.costUsd;
    } else if (parsed.costUsd !== undefined) {
      executionResult.costUsd = parsed.costUsd;
    }

    // Only attach usageByModel when parts sum to the run totals (unique model ids).
    if (mergedUsage.usageByModel && mergedUsage.usage && mergedUsage.costUsd !== undefined) {
      const parts = mergedUsage.usageByModel;
      const tokensMatch =
        parts.reduce((s, p) => s + p.usage.inputTokens, 0) === mergedUsage.usage.inputTokens &&
        parts.reduce((s, p) => s + p.usage.outputTokens, 0) === mergedUsage.usage.outputTokens &&
        parts.reduce((s, p) => s + (p.usage.cachedInputTokens ?? 0), 0) ===
          (mergedUsage.usage.cachedInputTokens ?? 0);
      const costMatch =
        Math.abs(parts.reduce((s, p) => s + p.costUsd, 0) - mergedUsage.costUsd) < 1e-9;
      const unique = new Set(parts.map((p) => p.model)).size === parts.length;
      if (tokensMatch && costMatch && unique) {
        executionResult.usageByModel = parts;
      }
    }

    if (parsed.response) {
      executionResult.summary = parsed.response.slice(0, 2000);
    }

    executionResult.resultJson = {
      result: parsed.response || "",
      session_id: parsed.sessionId || null,
      usage: executionResult.usage || null,
      cost_usd: executionResult.costUsd ?? null,
      ...(modelRoutingPhases.length > 1 || runPreflight || smartRouting.enabled
        ? { modelRouting: { phases: modelRoutingPhases } }
        : {}),
    };

    // Persist session ID only from the primary child.
    if (persistSession && parsed.sessionId) {
      executionResult.sessionParams = { sessionId: parsed.sessionId };
      executionResult.sessionDisplayId = parsed.sessionId.slice(0, 16);
    }

    return executionResult;
  } finally {
    if (runtimeCleanupDir) {
      await fs.rm(runtimeCleanupDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
