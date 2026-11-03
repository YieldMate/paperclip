/**
 * Per-issue Hermes resident process manager.
 *
 * Keeps one `hermes chat --resident` child alive for a company/agent/issue so
 * later heartbeats submit a turn instead of cold-starting Python. Falls back
 * to oneshot when no resident matches.
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
  startedAt: number;
  lastUsedAt: number;
  pending: PendingWaiter[];
}

const residents = new Map<string, ResidentHandle>();
/** Serialize startResident per key so concurrent wakes cannot orphan children. */
const startLocks = new Map<string, Promise<ResidentHandle>>();
const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const TERMINAL_STATUSES = new Set(["done", "in_review", "blocked", "cancelled"]);

function keyOf(k: ResidentKey): string {
  return `${k.companyId}:${k.agentId}:${k.issueId}`;
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
  handle.child.kill("SIGTERM");
  for (const waiter of handle.pending) {
    if (waiter.settled) continue;
    waiter.settled = true;
    waiter.reject(new Error("resident stopped"));
  }
  handle.pending = [];
}

export function shouldKeepResidentForDisposition(
  disposition: { status?: string } | null | undefined,
): boolean {
  const status = disposition?.status?.trim();
  if (!status) return true;
  return !TERMINAL_STATUSES.has(status);
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
    String(opts.idleSec ?? DEFAULT_IDLE_MS / 1000),
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

  const handle: ResidentHandle = {
    key: keyOf(opts.key),
    child,
    rl: readline.createInterface({ input: child.stdout }),
    model: opts.model,
    cwd: opts.cwd,
    sessionId: opts.sessionId ?? null,
    issueId: opts.key.issueId,
    startedAt: Date.now(),
    lastUsedAt: Date.now(),
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
    handle.lastUsedAt = Date.now();
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

  await fs.mkdir(path.dirname(opts.statePath), { recursive: true });
  await fs.writeFile(
    opts.statePath,
    JSON.stringify({
      pid: child.pid,
      companyId: opts.key.companyId,
      agentId: opts.key.agentId,
      issueId: opts.key.issueId,
      sessionId: opts.sessionId ?? null,
      model: opts.model,
      cwd: opts.cwd,
      startedAt: handle.startedAt,
    }),
    "utf8",
  );

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

/** Reap a stale resident.json pid that is not the live map entry. */
export async function reapStaleResidentState(statePath: string): Promise<void> {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number; issueId?: string; agentId?: string; companyId?: string };
    if (typeof parsed.pid !== "number") return;
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
    try {
      process.kill(parsed.pid, 0);
      process.kill(parsed.pid, "SIGTERM");
    } catch {
      // already dead
    }
    await fs.rm(statePath, { force: true });
  } catch {
    // missing or unreadable
  }
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
}
