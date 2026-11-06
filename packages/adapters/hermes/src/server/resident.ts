/**
 * Per-issue Hermes resident process manager.
 *
 * Keeps one `hermes chat --resident` child alive for a company/agent/issue so
 * later heartbeats submit a turn instead of cold-starting Python. Falls back
 * to oneshot when no resident matches.
 *
 * Durable state lives at `hermes-runtime/residents/<issueId>.json` (per-issue,
 * with lastUsedAt). A time-keyed sweep reaps records idle strictly longer than
 * 24h. This is the shared per-issue resident-state mechanism (YIE-75 / YIE-71).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

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
  sessionId: string | null;
  issueId: string;
  companyId: string;
  agentId: string;
  startedAt: number;
  lastUsedAt: number;
  statePath: string;
  pending: PendingWaiter[];
}

interface ResidentStateFile {
  pid?: number;
  companyId?: string;
  agentId?: string;
  issueId?: string;
  sessionId?: string | null;
  model?: string;
  cwd?: string;
  startedAt?: number;
  lastUsedAt?: number;
}

const residents = new Map<string, ResidentHandle>();
/** Serialize startResident per key so concurrent wakes cannot orphan children. */
const startLocks = new Map<string, Promise<ResidentHandle>>();

/** Adapter default idle for Paperclip-launched residents (24h). CLI humans stay at 900. */
export const DEFAULT_RESIDENT_IDLE_SEC = 86_400;
/** Reap when idle is strictly greater than this (exactly 24h is kept). */
export const RESIDENT_STALE_MS = 24 * 60 * 60 * 1000;
const KILL_GRACE_MS = 30_000;
const HOURLY_SWEEP_MS = 60 * 60 * 1000;
const TERMINAL_STATUSES = new Set(["done", "in_review", "blocked", "cancelled"]);

let hourlySweepTimer: ReturnType<typeof setInterval> | null = null;
let hourlySweepResolveRoot: (() => string | null) | null = null;

/** Test/prod seam for signals and /proc reads. */
export interface ResidentProcIo {
  kill(pid: number, signal?: NodeJS.Signals | number): boolean;
  readCmdline(pid: number): Promise<string | null>;
  readStarttime(pid: number): Promise<number | null>;
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
    startedAt: handle.startedAt,
    lastUsedAt: handle.lastUsedAt,
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

export function shouldKeepResidentForDisposition(
  disposition: { status?: string } | null | undefined,
): boolean {
  const status = disposition?.status?.trim();
  if (!status) return true;
  return !TERMINAL_STATUSES.has(status);
}

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

async function reapStateRecord(
  statePath: string,
  parsed: ResidentStateFile,
  opts?: { forceRemoveFile?: boolean },
): Promise<"reaped" | "skipped" | "quarantined"> {
  const now = procIo.now();
  const live =
    parsed.companyId && parsed.agentId && parsed.issueId
      ? getLiveResident({
          companyId: parsed.companyId,
          agentId: parsed.agentId,
          issueId: parsed.issueId,
        })
      : null;
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
 * Time-keyed only (never cwd-keyed). Fail-open.
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
  env: Record<string, string>;
  sessionId?: string;
  idleSec?: number;
  statePath: string;
}): Promise<ResidentHandle> {
  const existing = getLiveResident(opts.key);
  if (existing) {
    if (existing.model === opts.model && existing.cwd === opts.cwd) {
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
  const handle: ResidentHandle = {
    key: keyOf(opts.key),
    child,
    rl: readline.createInterface({ input: child.stdout }),
    model: opts.model,
    cwd: opts.cwd,
    sessionId: opts.sessionId ?? null,
    issueId: opts.key.issueId,
    companyId: opts.key.companyId,
    agentId: opts.key.agentId,
    startedAt: now,
    lastUsedAt: now,
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
    handle.lastUsedAt = procIo.now();
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
  env: Record<string, string>;
  sessionId?: string;
  idleSec?: number;
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
  if (hourlySweepTimer) {
    clearInterval(hourlySweepTimer);
    hourlySweepTimer = null;
  }
  hourlySweepResolveRoot = null;
  procIo = defaultProcIo;
}
