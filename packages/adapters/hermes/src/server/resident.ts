/**
 * Per-issue Hermes resident process manager.
 *
 * Keeps one `hermes chat --resident` child alive for a company/agent/issue so
 * later heartbeats submit a turn instead of cold-starting Python. Falls back
 * to oneshot when no resident matches.
 *
 * Durable state lives at `hermes-runtime/residents/<issueId>.json` (per-issue,
 * with lastUsedAt + cwdIdentity). A single sweep reaps time-stale (>24h) and
 * identity-mismatch orphans. Warm-policy TTL/LRU (YIE-71) is flag-gated.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

import {
  DEFAULT_RESIDENT_WARM_CONFIG,
  isResidentWarmPolicyV2Enabled,
  normalizeCwdIdentity,
  readResidentRssMbDefault,
  RESIDENT_RSS_CACHE_MS,
  RESIDENT_WARM_PENDING_WAKE_RESERVATION,
  residentWarmTtlForDisposition,
  shouldKeepResidentForDispositionLegacy,
  type ResidentWarmConfig,
} from "./resident-warm-policy.js";

export interface ResidentKey {
  companyId: string;
  agentId: string;
  issueId: string;
}

export interface ResidentTurnRequest {
  prompt: string;
  ephemeralSystemPrompt?: string;
  mcpOverlayPath?: string;
  env?: Record<string, string>;
  model?: string;
  provider?: string;
  toolsets?: string;
  sessionId?: string;
}

export interface ResidentTurnResult {
  ok: boolean;
  response?: string;
  sessionId?: string | null;
  disposition?: { status?: string; comment?: string } | null;
  error?: string;
  timedOut?: boolean;
}

interface PendingWaiter {
  resolve: (value: ResidentTurnResult) => void;
  reject: (err: Error) => void;
  settled: boolean;
}

interface ResidentHandle {
  key: string;
  child: ChildProcessWithoutNullStreams;
  rl: readline.Interface;
  model: string;
  cwd: string;
  /** realpath(path.resolve(cwd)) — used for reuse + state identity. */
  cwdIdentity: string;
  sessionId: string | null;
  issueId: string;
  companyId: string;
  agentId: string;
  startedAt: number;
  lastUsedAt: number;
  /** Adapter-side idle deadline (lastUsedAt + ttl). Authoritative over spawn timer. */
  expiresAt: number | null;
  /** Last granted TTL seconds (for refreshing expiresAt after a turn). */
  ttlSec: number | null;
  statePath: string;
  pending: PendingWaiter[];
  /** Sticky reason for the next run after LRU eviction. */
  evictionReason?: "cap_evicted";
}

interface ResidentStateFile {
  pid?: number;
  companyId?: string;
  agentId?: string;
  issueId?: string;
  sessionId?: string | null;
  model?: string;
  cwd?: string;
  cwdIdentity?: string;
  startedAt?: number;
  lastUsedAt?: number;
  expiresAt?: number | null;
}

/** Public snapshot shape for tests (YIE-71 acceptance item 6). */
export interface ResidentSnapshot {
  key: string;
  issueId: string;
  companyId: string;
  agentId: string;
  pid: number | undefined;
  model: string;
  cwd: string;
  cwdIdentity: string;
  startedAt: number;
  lastUsedAt: number;
  expiresAt: number | null;
  pendingCount: number;
  evictionReason?: "cap_evicted";
}

const residents = new Map<string, ResidentHandle>();
/** Serialize startResident per key so concurrent wakes cannot orphan children. */
const startLocks = new Map<string, Promise<ResidentHandle>>();
/**
 * Pending-wake protection keyed by `companyId:agentId` → issueId set.
 * Avoids a process-global replace wiping concurrent agents' reservations.
 */
const pendingWakeByAgent = new Map<string, Set<string>>();
/** Sticky warm-reason markers (keyOf → reason) until the next run consumes them. */
const evictionMarkers = new Map<string, "cap_evicted" | "ttl_expired">();
/** RSS cache: pid → { mb, at }. */
const rssCache = new Map<number, { mb: number; at: number }>();

function agentWakeKey(companyId: string, agentId: string): string {
  return `${companyId}:${agentId}`;
}

function isPendingWakeIssue(companyId: string, agentId: string, issueId: string): boolean {
  return pendingWakeByAgent.get(agentWakeKey(companyId, agentId))?.has(issueId) ?? false;
}

/** Adapter default idle for Paperclip-launched residents (24h). CLI humans stay at 900. */
export const DEFAULT_RESIDENT_IDLE_SEC = 86_400;
/** Reap when idle is strictly greater than this (exactly 24h is kept). */
export const RESIDENT_STALE_MS = 24 * 60 * 60 * 1000;
const KILL_GRACE_MS = 30_000;
const HOURLY_SWEEP_MS = 60 * 60 * 1000;
const EXPIRES_REAPER_MS = 15_000;

let hourlySweepTimer: ReturnType<typeof setInterval> | null = null;
let hourlySweepResolveRoot: (() => string | null) | null = null;
let expiresReaperTimer: ReturnType<typeof setInterval> | null = null;

/** Test/prod seam for signals and /proc reads. */
export interface ResidentProcIo {
  kill(pid: number, signal?: NodeJS.Signals | number): boolean;
  readCmdline(pid: number): Promise<string | null>;
  readStarttime(pid: number): Promise<number | null>;
  readRssMb(pid: number): Promise<number | null>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

const defaultProcIo: ResidentProcIo = {
  kill(pid, signal) {
    return process.kill(pid, signal);
  },
  async readCmdline(pid) {
    try {
      const raw = await fs.readFile(`/proc/${pid}/cmdline`);
      return raw.toString("utf8");
    } catch {
      return null;
    }
  },
  async readStarttime(pid) {
    try {
      const raw = await fs.readFile(`/proc/${pid}/stat`, "utf8");
      const closeParen = raw.lastIndexOf(")");
      const rest = closeParen >= 0 ? raw.slice(closeParen + 2) : raw;
      const fields = rest.trim().split(/\s+/);
      // /proc/pid/stat field 22 (1-indexed) is starttime; after comm this is index 19.
      const value = Number(fields[19]);
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  },
  readRssMb(pid) {
    return readResidentRssMbDefault(pid);
  },
  now() {
    return Date.now();
  },
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};

let procIo: ResidentProcIo = defaultProcIo;

/** Test helper: swap process/proc IO (fake timers + kill spies). */
export function __setResidentProcIoForTests(next: Partial<ResidentProcIo> | null): void {
  procIo = next ? { ...defaultProcIo, ...next } : defaultProcIo;
  rssCache.clear();
}

/** Inject pending-wake issue IDs for one company/agent (server or tests). */
export function setPendingWakeIssueIdsForAgent(
  companyId: string,
  agentId: string,
  issueIds: Iterable<string>,
): void {
  pendingWakeByAgent.set(agentWakeKey(companyId, agentId), new Set(issueIds));
}

/** @deprecated Prefer setPendingWakeIssueIdsForAgent — kept for narrow unit tests. */
export function setPendingWakeIssueIds(issueIds: Iterable<string>): void {
  // Test helper: apply under a wildcard agent key used only when company/agent unknown.
  pendingWakeByAgent.set(agentWakeKey("*", "*"), new Set(issueIds));
}

export function getPendingWakeIssueIdsForAgent(
  companyId: string,
  agentId: string,
): ReadonlySet<string> {
  return pendingWakeByAgent.get(agentWakeKey(companyId, agentId)) ?? new Set();
}

export function keyOf(k: ResidentKey): string {
  return `${k.companyId}:${k.agentId}:${k.issueId}`;
}

export function residentStatePath(runtimeDir: string, issueId: string): string {
  return path.join(runtimeDir, "residents", `${issueId}.json`);
}

export function legacyResidentStatePath(runtimeDir: string): string {
  return path.join(runtimeDir, "resident.json");
}

export function residentsDir(runtimeDir: string): string {
  return path.join(runtimeDir, "residents");
}

function parseResultLine(line: string): ResidentTurnResult {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.ok === true) {
      const disposition =
        parsed.disposition && typeof parsed.disposition === "object"
          ? (parsed.disposition as { status?: string; comment?: string })
          : null;
      return {
        ok: true,
        response: typeof parsed.response === "string" ? parsed.response : "",
        sessionId: typeof parsed.session_id === "string" ? parsed.session_id : null,
        disposition,
      };
    }
    return {
      ok: false,
      error: typeof parsed.error === "string" ? parsed.error : "resident turn failed",
      sessionId: typeof parsed.session_id === "string" ? parsed.session_id : null,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function statePayload(handle: ResidentHandle): ResidentStateFile {
  return {
    pid: handle.child.pid,
    companyId: handle.companyId,
    agentId: handle.agentId,
    issueId: handle.issueId,
    sessionId: handle.sessionId,
    model: handle.model,
    cwd: handle.cwd,
    cwdIdentity: handle.cwdIdentity,
    startedAt: handle.startedAt,
    lastUsedAt: handle.lastUsedAt,
    expiresAt: handle.expiresAt,
  };
}

async function writeResidentState(handle: ResidentHandle): Promise<void> {
  await fs.mkdir(path.dirname(handle.statePath), { recursive: true });
  await fs.writeFile(handle.statePath, JSON.stringify(statePayload(handle)), "utf8");
}

async function removeStateFiles(runtimeDirOrStatePath: string, issueId?: string): Promise<void> {
  if (issueId) {
    await fs.rm(residentStatePath(runtimeDirOrStatePath, issueId), { force: true }).catch(() => undefined);
    await fs.rm(legacyResidentStatePath(runtimeDirOrStatePath), { force: true }).catch(() => undefined);
    return;
  }
  await fs.rm(runtimeDirOrStatePath, { force: true }).catch(() => undefined);
}

export function getLiveResident(key: ResidentKey): ResidentHandle | null {
  const handle = residents.get(keyOf(key));
  if (!handle) return null;
  if (handle.child.exitCode !== null || handle.child.killed) {
    residents.delete(keyOf(key));
    return null;
  }
  return handle;
}

export async function stopResident(key: ResidentKey): Promise<void> {
  const handle = residents.get(keyOf(key));
  if (!handle) return;
  residents.delete(keyOf(key));
  try {
    handle.child.stdin.write(`${JSON.stringify({ shutdown: true })}\n`);
  } catch {
    // ignore
  }
  try {
    handle.child.kill("SIGTERM");
  } catch {
    // ignore
  }
  for (const waiter of handle.pending) {
    if (waiter.settled) continue;
    waiter.settled = true;
    waiter.reject(new Error("resident stopped"));
  }
  handle.pending = [];
  const runtimeDir = path.dirname(path.dirname(handle.statePath));
  await removeStateFiles(runtimeDir, handle.issueId);
  await fs.rm(handle.statePath, { force: true }).catch(() => undefined);
}

/**
 * Keep/stop decision. Flag off → legacy stop-on-terminal. Flag on → TTL matrix
 * (`keep` when ttlSec > 0). Prefer `residentWarmTtlForDisposition` for the TTL.
 */
export function shouldKeepResidentForDisposition(
  disposition: { status?: string } | null | undefined,
  opts?: { hasScheduledRetry?: boolean; config?: Partial<ResidentWarmConfig> },
): boolean {
  if (!isResidentWarmPolicyV2Enabled()) {
    return shouldKeepResidentForDispositionLegacy(disposition);
  }
  return residentWarmTtlForDisposition(disposition, opts).keep;
}

export { residentWarmTtlForDisposition, normalizeCwdIdentity };

/** True when /proc cmdline looks like a Paperclip resident invocation. */
export async function pidMatchesResidentInvocation(pid: number): Promise<boolean> {
  const cmdline = await procIo.readCmdline(pid);
  if (!cmdline) return false;
  const text = cmdline.replace(/\u0000/g, " ");
  return text.includes("chat") && text.includes("--resident") && text.includes("--resident-idle-sec");
}

async function pidStarttimeMatches(pid: number, startedAtMs: number | undefined): Promise<boolean> {
  if (typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs)) return false;
  const starttime = await procIo.readStarttime(pid);
  if (starttime == null) return false;
  // starttime is clock ticks since boot. Approximate process age with CLK_TCK=100
  // and accept when it matches recorded startedAt within 120s (pid-reuse guard).
  try {
    const uptimeRaw = await fs.readFile("/proc/uptime", "utf8");
    const uptimeSec = Number(uptimeRaw.split(/\s+/)[0]);
    if (!Number.isFinite(uptimeSec)) return false;
    const ageMs = procIo.now() - startedAtMs;
    if (ageMs < 0) return false;
    const clkTck = 100;
    const procAgeSec = uptimeSec - starttime / clkTck;
    return Math.abs(procAgeSec - ageMs / 1000) <= 120;
  } catch {
    return false;
  }
}

export async function confirmResidentPid(
  pid: number,
  startedAtMs?: number,
): Promise<boolean> {
  if (await pidMatchesResidentInvocation(pid)) return true;
  return pidStarttimeMatches(pid, startedAtMs);
}

function terminatePid(pid: number): void {
  try {
    procIo.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  // Do not block the wake-path sweep on the 30s grace — escalate in the background.
  void procIo.sleep(KILL_GRACE_MS).then(() => {
    try {
      procIo.kill(pid, 0);
      procIo.kill(pid, "SIGKILL");
    } catch {
      // already dead
    }
  });
}

function rejectPending(handle: ResidentHandle, message: string): void {
  for (const waiter of handle.pending) {
    if (waiter.settled) continue;
    waiter.settled = true;
    waiter.reject(new Error(message));
  }
  handle.pending = [];
}

/**
 * Identity-mismatch orphan (YIE-71, flag-gated): disk record whose pid is not
 * the live-map entry for that exact {companyId, agentId, issueId}. Covers
 * restart orphans (no live entry) and replaced-pid drift. SIGTERM + delete.
 */
function isIdentityMismatchOrphan(
  parsed: ResidentStateFile,
  live: ResidentHandle | null,
): boolean {
  if (!isResidentWarmPolicyV2Enabled()) return false;
  if (!parsed.companyId || !parsed.agentId || !parsed.issueId) return false;
  const pid = parsed.pid;
  if (typeof pid !== "number" || !Number.isFinite(pid)) return false;
  if (!live) return true;
  return live.child.pid !== pid;
}

async function reapStateRecord(
  statePath: string,
  parsed: ResidentStateFile,
  opts?: { forceRemoveFile?: boolean },
): Promise<"reaped" | "skipped" | "quarantined" | "identity_mismatch"> {
  const now = procIo.now();
  const live =
    parsed.companyId && parsed.agentId && parsed.issueId
      ? getLiveResident({
          companyId: parsed.companyId,
          agentId: parsed.agentId,
          issueId: parsed.issueId,
        })
      : null;

  // YIE-71: identity-mismatch orphan predicate runs on the same pass as time-stale.
  if (isIdentityMismatchOrphan(parsed, live) && !opts?.forceRemoveFile) {
    const pid = parsed.pid;
    if (typeof pid === "number" && Number.isFinite(pid)) {
      const confirmed = await confirmResidentPid(pid, parsed.startedAt);
      if (!confirmed) {
        // Keep the file — an unconfirmed pid must not become an invisible orphan.
        return "skipped";
      }
      terminatePid(pid);
      // If a live handle exists for this key with a different pid, rewrite its state
      // so the warm resident stays durable after the stale disk pid is cleared.
      if (live && live.child.pid !== pid) {
        await writeResidentState(live).catch(() => undefined);
        return "identity_mismatch";
      }
      if (live && live.child.pid === pid) {
        residents.delete(live.key);
        rejectPending(live, "resident reaped as identity mismatch");
      }
      await fs.rm(statePath, { force: true }).catch(() => undefined);
      return "identity_mismatch";
    }
    return "skipped";
  }

  // Prefer in-memory lastUsedAt when present so a lagged disk write cannot
  // reap an actively warmed resident.
  const diskAnchor = parsed.lastUsedAt ?? parsed.startedAt;
  const memoryAnchor = live ? live.lastUsedAt : undefined;
  const anchor =
    typeof memoryAnchor === "number" && Number.isFinite(memoryAnchor)
      ? typeof diskAnchor === "number" && Number.isFinite(diskAnchor)
        ? Math.max(diskAnchor, memoryAnchor)
        : memoryAnchor
      : diskAnchor;
  if (typeof anchor !== "number" || !Number.isFinite(anchor)) {
    await fs.rm(statePath, { force: true }).catch(() => undefined);
    return "quarantined";
  }
  // Strictly greater than 24h — exactly 24h is kept.
  if (now - anchor <= RESIDENT_STALE_MS && !opts?.forceRemoveFile) {
    return "skipped";
  }

  const pid = parsed.pid;
  if (typeof pid === "number" && Number.isFinite(pid)) {
    const confirmed = await confirmResidentPid(pid, parsed.startedAt);
    if (!confirmed) {
      await fs.rm(statePath, { force: true }).catch(() => undefined);
      return "quarantined";
    }
    if (live && live.child.pid === pid) {
      residents.delete(live.key);
      rejectPending(live, "resident reaped as stale");
    }
    terminatePid(pid);
  }

  await fs.rm(statePath, { force: true }).catch(() => undefined);
  return "reaped";
}

/**
 * Sweep every per-issue residents file under a hermes-runtime dir.
 * Time-keyed + identity-mismatch orphan predicates (never cwd-keyed). Fail-open.
 */
export async function sweepStaleResidents(runtimeDir: string): Promise<void> {
  try {
    const legacyPath = legacyResidentStatePath(runtimeDir);
    try {
      const raw = await fs.readFile(legacyPath, "utf8");
      const parsed = JSON.parse(raw) as ResidentStateFile;
      // Legacy agent-level file: time-keyed reap when stale; drop when pid is dead.
      const outcome = await reapStateRecord(legacyPath, parsed);
      if (outcome === "skipped" && typeof parsed.pid === "number") {
        try {
          procIo.kill(parsed.pid, 0);
        } catch {
          await fs.rm(legacyPath, { force: true }).catch(() => undefined);
        }
      }
    } catch {
      // missing
    }

    const dir = residentsDir(runtimeDir);
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const statePath = path.join(dir, name);
      try {
        const raw = await fs.readFile(statePath, "utf8");
        const parsed = JSON.parse(raw) as ResidentStateFile;
        await reapStateRecord(statePath, parsed);
      } catch {
        // unreadable — leave for next pass
      }
    }
  } catch {
    // fail-open: never block a run
  }
}

/** Walk companies/<id>/agents/<id>/hermes-runtime under an instance root. */
export async function discoverHermesRuntimeDirs(instanceRoot: string): Promise<string[]> {
  const found: string[] = [];
  const companiesDir = path.join(instanceRoot, "companies");
  let companies: string[] = [];
  try {
    companies = await fs.readdir(companiesDir);
  } catch {
    return found;
  }
  for (const companyId of companies) {
    const agentsDir = path.join(companiesDir, companyId, "agents");
    let agents: string[] = [];
    try {
      agents = await fs.readdir(agentsDir);
    } catch {
      continue;
    }
    for (const agentId of agents) {
      const runtimeDir = path.join(agentsDir, agentId, "hermes-runtime");
      try {
        const st = await fs.stat(runtimeDir);
        if (st.isDirectory()) found.push(runtimeDir);
      } catch {
        // skip
      }
    }
  }
  return found;
}

/** Hourly sweep for quiet hosts; safe to call repeatedly. Fail-open. */
export function ensureHourlyResidentSweep(resolveInstanceRoot: () => string | null): void {
  hourlySweepResolveRoot = resolveInstanceRoot;
  if (hourlySweepTimer) return;
  const tick = () => {
    void (async () => {
      try {
        const root = hourlySweepResolveRoot?.() ?? null;
        if (!root) return;
        for (const dir of await discoverHermesRuntimeDirs(root)) {
          await sweepStaleResidents(dir);
        }
      } catch {
        // fail-open
      }
    })();
  };
  tick();
  hourlySweepTimer = setInterval(tick, HOURLY_SWEEP_MS);
  // Do not keep the event loop alive solely for the sweeper in short-lived tools.
  if (typeof hourlySweepTimer === "object" && hourlySweepTimer && "unref" in hourlySweepTimer) {
    hourlySweepTimer.unref();
  }
  ensureExpiresReaper();
}

/** @deprecated Prefer sweepStaleResidents; kept for single-file migration callers. */
export async function reapStaleResidentState(statePath: string): Promise<void> {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as ResidentStateFile;
    if (
      parsed.companyId &&
      parsed.agentId &&
      parsed.issueId &&
      getLiveResident({
        companyId: parsed.companyId,
        agentId: parsed.agentId,
        issueId: parsed.issueId,
      })
    ) {
      return;
    }
    await reapStateRecord(statePath, parsed, { forceRemoveFile: true });
  } catch {
    // missing or unreadable
  }
}

async function startResidentUnlocked(opts: {
  key: ResidentKey;
  hermesCmd: string;
  model: string;
  provider: string;
  toolsets?: string;
  cwd: string;
  cwdIdentity?: string;
  env: Record<string, string>;
  sessionId?: string;
  idleSec?: number;
  ttlSec?: number;
  statePath: string;
}): Promise<ResidentHandle> {
  const cwdIdentity = opts.cwdIdentity ?? (await normalizeCwdIdentity(opts.cwd));
  const existing = getLiveResident(opts.key);
  if (existing) {
    const sameCwd =
      isResidentWarmPolicyV2Enabled()
        ? existing.cwdIdentity === cwdIdentity
        : existing.cwd === opts.cwd;
    if (existing.model === opts.model && sameCwd) {
      if (typeof opts.ttlSec === "number" && opts.ttlSec > 0) {
        existing.ttlSec = opts.ttlSec;
        existing.expiresAt = existing.lastUsedAt + opts.ttlSec * 1000;
        void writeResidentState(existing).catch(() => undefined);
      }
      return existing;
    }
    await stopResident(opts.key);
  }

  const args = [
    "chat",
    "--resident",
    "--resident-idle-sec",
    String(opts.idleSec ?? DEFAULT_RESIDENT_IDLE_SEC),
    "-m",
    opts.model,
    "--source",
    "tool",
    "--yolo",
  ];
  if (opts.provider && opts.provider !== "auto") {
    args.push("--provider", opts.provider);
  }
  if (opts.toolsets) {
    args.push("-t", opts.toolsets);
  }
  if (opts.sessionId) {
    args.push("--resume", opts.sessionId);
  }

  const child = spawn(opts.hermesCmd, args, {
    cwd: opts.cwd,
    env: { ...opts.env, HERMES_INPROCESS_CHAT: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const now = procIo.now();
  const ttlSec = opts.ttlSec;
  const handle: ResidentHandle = {
    key: keyOf(opts.key),
    child,
    rl: readline.createInterface({ input: child.stdout }),
    model: opts.model,
    cwd: opts.cwd,
    cwdIdentity,
    sessionId: opts.sessionId ?? null,
    issueId: opts.key.issueId,
    companyId: opts.key.companyId,
    agentId: opts.key.agentId,
    startedAt: now,
    lastUsedAt: now,
    expiresAt:
      typeof ttlSec === "number" && ttlSec > 0 ? now + ttlSec * 1000 : null,
    ttlSec: typeof ttlSec === "number" && ttlSec > 0 ? ttlSec : null,
    statePath: opts.statePath,
    pending: [],
  };

  handle.rl.on("line", (line) => {
    let waiter = handle.pending.shift();
    while (waiter?.settled) {
      waiter = handle.pending.shift();
    }
    if (!waiter) return;
    waiter.settled = true;
    const result = parseResultLine(line);
    if (result.sessionId) handle.sessionId = result.sessionId;
    const usedAt = procIo.now();
    handle.lastUsedAt = usedAt;
    if (handle.ttlSec != null && handle.ttlSec > 0) {
      handle.expiresAt = usedAt + handle.ttlSec * 1000;
    }
    void writeResidentState(handle).catch(() => undefined);
    waiter.resolve(result);
  });

  child.on("exit", () => {
    residents.delete(handle.key);
    for (const waiter of handle.pending) {
      if (waiter.settled) continue;
      waiter.settled = true;
      waiter.reject(new Error("resident exited"));
    }
    handle.pending = [];
  });

  residents.set(handle.key, handle);
  await writeResidentState(handle);
  // One-release migration: drop the legacy agent-level file when a per-issue file exists.
  const runtimeDir = path.dirname(path.dirname(opts.statePath));
  await fs.rm(legacyResidentStatePath(runtimeDir), { force: true }).catch(() => undefined);

  return handle;
}

export async function startResident(opts: {
  key: ResidentKey;
  hermesCmd: string;
  model: string;
  provider: string;
  toolsets?: string;
  cwd: string;
  cwdIdentity?: string;
  env: Record<string, string>;
  sessionId?: string;
  idleSec?: number;
  ttlSec?: number;
  statePath: string;
}): Promise<ResidentHandle> {
  const k = keyOf(opts.key);

  // Chain concurrent starts on the same key so only one child survives.
  const prior = startLocks.get(k);
  const startPromise = (prior ?? Promise.resolve(null))
    .catch(() => null)
    .then(async () => startResidentUnlocked(opts));

  startLocks.set(k, startPromise);
  try {
    return await startPromise;
  } finally {
    if (startLocks.get(k) === startPromise) {
      startLocks.delete(k);
    }
  }
}

export function submitResidentTurn(
  handle: ResidentHandle,
  turn: ResidentTurnRequest,
  opts?: { timeoutSec?: number },
): Promise<ResidentTurnResult> {
  return new Promise((resolve, reject) => {
    const waiter: PendingWaiter = {
      settled: false,
      resolve,
      reject,
    };
    handle.pending.push(waiter);

    const timeoutSec = opts?.timeoutSec;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (typeof timeoutSec === "number" && timeoutSec > 0) {
      timer = setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        const idx = handle.pending.indexOf(waiter);
        if (idx >= 0) handle.pending.splice(idx, 1);
        reject(
          Object.assign(new Error(`resident turn timed out after ${timeoutSec}s`), {
            timedOut: true,
          }),
        );
      }, timeoutSec * 1000);
    }

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const originalResolve = waiter.resolve;
    const originalReject = waiter.reject;
    waiter.resolve = (value) => {
      clearTimer();
      originalResolve(value);
    };
    waiter.reject = (err) => {
      clearTimer();
      originalReject(err);
    };

    const payload = {
      prompt: turn.prompt,
      ephemeral_system_prompt: turn.ephemeralSystemPrompt,
      mcp_overlay: turn.mcpOverlayPath,
      env: turn.env,
      model: turn.model,
      provider: turn.provider,
      toolsets: turn.toolsets,
      session_id: turn.sessionId ?? handle.sessionId,
    };
    try {
      handle.child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (err) {
      if (waiter.settled) return;
      waiter.settled = true;
      const idx = handle.pending.indexOf(waiter);
      if (idx >= 0) handle.pending.splice(idx, 1);
      clearTimer();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Refresh adapter-side expiresAt after a disposition-driven TTL grant. */
export function setResidentTtl(key: ResidentKey, ttlSec: number): void {
  const handle = getLiveResident(key);
  if (!handle) return;
  if (ttlSec <= 0) {
    handle.ttlSec = null;
    handle.expiresAt = null;
    return;
  }
  handle.ttlSec = ttlSec;
  handle.expiresAt = handle.lastUsedAt + ttlSec * 1000;
  void writeResidentState(handle).catch(() => undefined);
}

/** Consume and clear a sticky warm-reason marker (cap_evicted / ttl_expired). */
export function takeResidentEvictionReason(
  key: ResidentKey,
): "cap_evicted" | "ttl_expired" | null {
  const k = keyOf(key);
  const marked = evictionMarkers.get(k) ?? null;
  if (marked) evictionMarkers.delete(k);
  const handle = residents.get(k);
  if (handle?.evictionReason) {
    delete handle.evictionReason;
    // Handle sticky wins over a stale map entry only when no map mark was taken.
    return marked ?? "cap_evicted";
  }
  return marked;
}

async function cachedRssMb(pid: number | undefined): Promise<number> {
  if (typeof pid !== "number" || !Number.isFinite(pid)) return 0;
  const now = procIo.now();
  const cached = rssCache.get(pid);
  if (cached && now - cached.at <= RESIDENT_RSS_CACHE_MS) return cached.mb;
  const mb = (await procIo.readRssMb(pid)) ?? 0;
  rssCache.set(pid, { mb, at: now });
  return mb;
}

/**
 * Startup / wake census: disk resident records under a runtime dir (for the
 * memory cap). Does not mutate. Fail-open → [].
 */
export async function censusResidentStateFiles(
  runtimeDir: string,
): Promise<ResidentStateFile[]> {
  const out: ResidentStateFile[] = [];
  try {
    const dir = residentsDir(runtimeDir);
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return out;
    }
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(dir, name), "utf8");
        out.push(JSON.parse(raw) as ResidentStateFile);
      } catch {
        // skip
      }
    }
  } catch {
    // fail-open
  }
  return out;
}

function isProtectedFromLru(
  handle: ResidentHandle,
  protectIssueIds: ReadonlySet<string>,
): boolean {
  if (protectIssueIds.has(handle.issueId)) return true;
  if (handle.pending.length > 0) return true;
  if (isPendingWakeIssue(handle.companyId, handle.agentId, handle.issueId)) return true;
  if (pendingWakeByAgent.get(agentWakeKey("*", "*"))?.has(handle.issueId)) return true;
  return false;
}

/**
 * Enforce live-count + aggregate RSS caps via LRU eviction (flag-gated).
 * Protected: in-flight issues, pending waiters, pending-wake reservation.
 */
export async function enforceResidentWarmCap(opts?: {
  protectIssueIds?: Iterable<string>;
  config?: Partial<ResidentWarmConfig>;
  /** Disk census size (restart orphans) counted toward the live cap. */
  diskCensusCount?: number;
}): Promise<{ evicted: string[] }> {
  const evicted: string[] = [];
  if (!isResidentWarmPolicyV2Enabled()) return { evicted };

  const cfg = { ...DEFAULT_RESIDENT_WARM_CONFIG, ...opts?.config };
  const protect = new Set(opts?.protectIssueIds ?? []);
  const maxLive = cfg.residentWarmMaxLiveResidents;
  const maxRss = cfg.residentWarmMaxAggregateRssMb;
  const reservation = RESIDENT_WARM_PENDING_WAKE_RESERVATION;

  const snapshot = [...residents.values()].filter(
    (h) => h.child.exitCode === null && !h.child.killed,
  );

  const diskExtra = Math.max(0, (opts?.diskCensusCount ?? 0) - snapshot.length);

  const pickVictim = (): ResidentHandle | null => {
    const candidates = snapshot
      .filter((h) => !isProtectedFromLru(h, protect))
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    return candidates[0] ?? null;
  };

  // Count cap (+ pending-wake reservation above the soft max).
  const hardMax = maxLive + reservation;
  while (snapshot.length + diskExtra > hardMax) {
    const victim = pickVictim();
    if (!victim) break;
    evictionMarkers.set(victim.key, "cap_evicted");
    await stopResident({
      companyId: victim.companyId,
      agentId: victim.agentId,
      issueId: victim.issueId,
    });
    evicted.push(victim.issueId);
    const idx = snapshot.indexOf(victim);
    if (idx >= 0) snapshot.splice(idx, 1);
  }

  // Soft count cap: prefer staying at maxLive when unprotected victims exist.
  while (snapshot.length + diskExtra > maxLive) {
    const victim = pickVictim();
    if (!victim) break;
    evictionMarkers.set(victim.key, "cap_evicted");
    await stopResident({
      companyId: victim.companyId,
      agentId: victim.agentId,
      issueId: victim.issueId,
    });
    evicted.push(victim.issueId);
    const idx = snapshot.indexOf(victim);
    if (idx >= 0) snapshot.splice(idx, 1);
  }

  // RSS cap.
  let aggregate = 0;
  for (const h of snapshot) {
    aggregate += await cachedRssMb(h.child.pid);
  }
  while (aggregate > maxRss) {
    const victim = pickVictim();
    if (!victim) break;
    const rss = await cachedRssMb(victim.child.pid);
    evictionMarkers.set(victim.key, "cap_evicted");
    await stopResident({
      companyId: victim.companyId,
      agentId: victim.agentId,
      issueId: victim.issueId,
    });
    evicted.push(victim.issueId);
    aggregate -= rss;
    const idx = snapshot.indexOf(victim);
    if (idx >= 0) snapshot.splice(idx, 1);
  }

  return { evicted };
}

/** Reap live residents whose adapter expiresAt has passed. */
export async function reapExpiredResidents(): Promise<string[]> {
  const stopped: string[] = [];
  if (!isResidentWarmPolicyV2Enabled()) return stopped;
  const now = procIo.now();
  for (const handle of [...residents.values()]) {
    if (handle.expiresAt == null) continue;
    if (now < handle.expiresAt) continue;
    if (handle.pending.length > 0) continue;
    // Sticky so the next wake records ttl_expired (not silent no_live_resident → disposition_*).
    evictionMarkers.set(handle.key, "ttl_expired");
    await stopResident({
      companyId: handle.companyId,
      agentId: handle.agentId,
      issueId: handle.issueId,
    });
    stopped.push(handle.issueId);
  }
  return stopped;
}

function ensureExpiresReaper(): void {
  if (expiresReaperTimer) return;
  if (!isResidentWarmPolicyV2Enabled()) return;
  expiresReaperTimer = setInterval(() => {
    void reapExpiredResidents().catch(() => undefined);
  }, EXPIRES_REAPER_MS);
  if (typeof expiresReaperTimer === "object" && expiresReaperTimer && "unref" in expiresReaperTimer) {
    expiresReaperTimer.unref();
  }
}

/** True when a live resident has passed its adapter expiresAt. */
export function isResidentTtlExpired(handle: {
  expiresAt: number | null;
}): boolean {
  if (handle.expiresAt == null) return false;
  return procIo.now() >= handle.expiresAt;
}

export const testOnly = {
  snapshotResidents(): ResidentSnapshot[] {
    return [...residents.values()].map((h) => ({
      key: h.key,
      issueId: h.issueId,
      companyId: h.companyId,
      agentId: h.agentId,
      pid: h.child.pid,
      model: h.model,
      cwd: h.cwd,
      cwdIdentity: h.cwdIdentity,
      startedAt: h.startedAt,
      lastUsedAt: h.lastUsedAt,
      expiresAt: h.expiresAt,
      pendingCount: h.pending.length,
      evictionReason: h.evictionReason,
    }));
  },
};

/** Test helper: clear in-memory resident state between unit tests. */
export function __resetResidentsForTests(): void {
  for (const handle of residents.values()) {
    try {
      handle.child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
  residents.clear();
  startLocks.clear();
  pendingWakeByAgent.clear();
  evictionMarkers.clear();
  rssCache.clear();
  if (hourlySweepTimer) {
    clearInterval(hourlySweepTimer);
    hourlySweepTimer = null;
  }
  if (expiresReaperTimer) {
    clearInterval(expiresReaperTimer);
    expiresReaperTimer = null;
  }
  hourlySweepResolveRoot = null;
  procIo = defaultProcIo;
}
