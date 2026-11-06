/**
 * Server-side adapter module exports.
 */

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { detectModel, parseModelFromConfig, resolveProvider, inferProviderFromModel } from "./detect-model.js";
export { getConfigSchema } from "./config-schema.js";
export {
  listHermesSkills as listSkills,
  syncHermesSkills as syncSkills,
  resolveHermesDesiredSkillNames as resolveDesiredSkillNames,
} from "./skills.js";
export {
  setResidentTtl,
  setPendingWakeIssueIdsForAgent,
} from "./resident.js";
export {
  isResidentWarmPolicyV2Enabled,
  RESIDENT_WARM_TTL_IN_PROGRESS_SEC,
} from "./resident-warm-policy.js";

export {
  HOT_TOOL_PINNING_V1_ENV,
  HOT_TOOL_REFRESH_INTERVAL_MS,
  HOT_TOOL_WINDOW_MS,
  MAX_PINNED_SCHEMA_TOKENS,
  MAX_PINNED_TOOLS,
  buildPinnedToolsManifest,
  deriveHotSet,
  estimateSchemaTokens,
  isHotToolPinningV1Enabled,
  isSafeOverlayAgentId,
  parsePinnedToolsManifest,
  pinnedToolsManifestPath,
  resolveOverlaysRoot,
  serializePinnedToolsManifest,
} from "./hot-tool-pinning.js";
export type {
  HotSetResult,
  HotToolCount,
  HotToolPinningLogger,
  PinnedToolEntry,
  PinnedToolsManifest,
} from "./hot-tool-pinning.js";

import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Session codec for structured validation and migration of session parameters.
 *
 * Hermes Agent uses a single `sessionId` for cross-heartbeat session continuity
 * via the `--resume` CLI flag. The codec validates and normalizes this field.
 */
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ??
      readNonEmptyString(record.session_id);
    if (!sessionId) return null;
    return { sessionId };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id);
    if (!sessionId) return null;
    return { sessionId };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
  },
};
