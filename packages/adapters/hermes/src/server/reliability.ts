/**
 * YIE-68 reliability helpers for hermes_local.
 *
 * Flag-guarded (adapterConfig.reliability.*). Defaults are ON so production
 * gets fail-open reconcile, toolset pre-validation, and disposition safety.
 * Rollback: set the relevant flag to false on the agent (or instance-wide via
 * a temporary agentConfig override) and redeploy/restart; no schema migration.
 */

export interface HermesReliabilityFlags {
  /** Warn + skip skill symlink collisions instead of killing the run. */
  failOpenSkillReconcile: boolean;
  /** Fail fast before spawn when -t names unresolved toolsets. */
  preValidateToolsets: boolean;
  /** Reject unexpanded $-token disposition paths; loud-fail missing disposition. */
  dispositionSafety: boolean;
  /** Treat optional tool / system-lib install failures as degrade, not fatal. */
  optionalInstallNonFatal: boolean;
}

const DEFAULT_FLAGS: HermesReliabilityFlags = {
  failOpenSkillReconcile: true,
  preValidateToolsets: true,
  dispositionSafety: true,
  optionalInstallNonFatal: true,
};

/**
 * Hermes static TOOLSETS keys (plus all/*) that Paperclip may put on `-t`.
 * Keep in sync with hermes-agent `toolsets.TOOLSETS` / `BUILTIN_TOOLSET_NAMES`.
 * Runtime MCP overlays are accepted separately via overlaySlugs.
 */
export const KNOWN_HERMES_BUILTIN_TOOLSETS = new Set([
  "all",
  "*",
  "bot_room",
  "browser",
  "catalog",
  "clarify",
  "code_execution",
  "coding",
  "computer_use",
  "connections",
  "context_engine",
  "cronjob",
  "debugging",
  "delegation",
  "desktop_ui",
  "discord",
  "discord_admin",
  "feishu_doc",
  "feishu_drive",
  "file",
  "hermes-acp",
  "hermes-api-server",
  "hermes-bluebubbles",
  "hermes-cli",
  "hermes-cron",
  "hermes-dingtalk",
  "hermes-discord",
  "hermes-email",
  "hermes-feishu",
  "hermes-gateway",
  "hermes-matrix",
  "hermes-mattermost",
  "hermes-qqbot",
  "hermes-signal",
  "hermes-slack",
  "hermes-sms",
  "hermes-telegram",
  "hermes-webhook",
  "hermes-wecom",
  "hermes-wecom-callback",
  "hermes-weixin",
  "hermes-whatsapp",
  "hermes-yuanbao",
  "image_gen",
  "kanban",
  "memory",
  "onboarding",
  "project",
  "safe",
  "search",
  "session_search",
  "skills",
  "terminal",
  "todo",
  "tts",
  "video",
  "video_gen",
  "vision",
  "web",
  "x_search",
  "yuanbao",
]);

export function resolveHermesReliabilityFlags(
  config: Record<string, unknown>,
): HermesReliabilityFlags {
  const nested =
    config.reliability && typeof config.reliability === "object" && !Array.isArray(config.reliability)
      ? (config.reliability as Record<string, unknown>)
      : {};
  const bool = (key: keyof HermesReliabilityFlags): boolean => {
    const fromNested = nested[key];
    if (typeof fromNested === "boolean") return fromNested;
    const dotted = config[`reliability.${key}`];
    if (typeof dotted === "boolean") return dotted;
    return DEFAULT_FLAGS[key];
  };
  return {
    failOpenSkillReconcile: bool("failOpenSkillReconcile"),
    preValidateToolsets: bool("preValidateToolsets"),
    dispositionSafety: bool("dispositionSafety"),
    optionalInstallNonFatal: bool("optionalInstallNonFatal"),
  };
}

/** True when a path still contains an unexpanded shell/env token (`$FOO` or `${FOO}`). */
export function dispositionPathHasUnexpandedToken(filePath: string): boolean {
  return /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(filePath);
}

export interface ToolsetPrevalidationResult {
  ok: boolean;
  resolved: string;
  unresolved: string[];
  errorMessage?: string;
}

/**
 * Validate a resolved `-t` list against known builtins + allowed MCP overlay slugs.
 * Unknown entries (e.g. legacy `creative` / `productivity`) fail fast with a clear config error.
 */
export function preValidateHermesToolsets(
  resolvedToolsets: string,
  overlaySlugs: ReadonlyArray<string> = [],
): ToolsetPrevalidationResult {
  const parts = resolvedToolsets
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const overlayAliases = new Set<string>();
  for (const slug of overlaySlugs) {
    const name = slug.trim();
    if (!name) continue;
    overlayAliases.add(name);
    overlayAliases.add(name.startsWith("mcp-") ? name.slice(4) : `mcp-${name}`);
  }

  const unresolved: string[] = [];
  const valid: string[] = [];
  for (const name of parts) {
    if (KNOWN_HERMES_BUILTIN_TOOLSETS.has(name) || overlayAliases.has(name)) {
      valid.push(name);
      continue;
    }
    unresolved.push(name);
  }

  if (unresolved.length > 0) {
    return {
      ok: false,
      resolved: parts.join(","),
      unresolved,
      errorMessage:
        `Hermes toolset config error: toolset(s) not found/resolved/valid: ${unresolved.join(", ")}. ` +
        `Fix adapterConfig.toolsets (remove unknown names such as creative/productivity) or install the matching Hermes toolset.`,
    };
  }
  if (valid.length === 0) {
    return {
      ok: false,
      resolved: "",
      unresolved: [],
      errorMessage:
        "Hermes toolset config error: -t resolved to no valid toolsets. Set adapterConfig.toolsets to known Hermes toolsets.",
    };
  }
  return { ok: true, resolved: valid.join(","), unresolved: [] };
}

/**
 * Heuristic: agent output looks like it intended a terminal issue disposition.
 * Prefer explicit status/disposition assignment over bare words like "done".
 * Negated phrasing ("not …", "don't …") must not trip the loud-fail path.
 */
export function looksLikeTerminalDispositionComment(text: string | null | undefined): boolean {
  if (!text || !text.trim()) return false;
  const sample = text.slice(0, 4000);
  const patterns: RegExp[] = [
    /\b(moved|moving|marked|marking|set|setting|changed|changing)\s+(the\s+)?(issue|ticket|task)\s+(to|as)\s+(done|cancelled|canceled|blocked|in[_\s-]?review)\b/i,
    /\b(status|disposition)\s*[:=]\s*["']?(done|in_review|blocked|cancelled|canceled)\b/i,
    /\b(moved|moving|marked|marking|set|setting)\s+(the\s+)?(issue|ticket|task)\s+ready for review\b/i,
    /\b["']?(done|in_review|blocked|cancelled|canceled)["']?\s+(status|disposition)\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(sample);
    if (!match) continue;
    const prefix = sample.slice(Math.max(0, match.index - 24), match.index);
    if (/\b(not|don't|dont|do not|never|avoid)\b[\s\S]*$/i.test(prefix)) continue;
    return true;
  }
  return false;
}
