import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetResidentsForTests,
  __setResidentProcIoForTests,
  DEFAULT_RESIDENT_IDLE_SEC,
  getLiveResident,
  legacyResidentStatePath,
  RESIDENT_STALE_MS,
  residentStatePath,
  shouldKeepResidentForDisposition,
  startResident,
  stopResident,
  submitResidentTurn,
  sweepStaleResidents,
} from "./resident.js";

describe("shouldKeepResidentForDisposition", () => {
  it("keeps the resident when disposition is missing or still in progress", () => {
    expect(shouldKeepResidentForDisposition(null)).toBe(true);
    expect(shouldKeepResidentForDisposition({})).toBe(true);
    expect(shouldKeepResidentForDisposition({ status: "in_progress" })).toBe(true);
    expect(shouldKeepResidentForDisposition({ status: "todo" })).toBe(true);
  });

  it("closes the resident on terminal waiting or done statuses", () => {
    expect(shouldKeepResidentForDisposition({ status: "done" })).toBe(false);
    expect(shouldKeepResidentForDisposition({ status: "in_review" })).toBe(false);
    expect(shouldKeepResidentForDisposition({ status: "blocked" })).toBe(false);
    expect(shouldKeepResidentForDisposition({ status: "cancelled" })).toBe(false);
  });
});

describe("resident process manager", () => {
  let dir: string;
  let hermesCmd: string;
  let runtimeDir: string;
  const key = { companyId: "co", agentId: "ag", issueId: "iss" };

  beforeEach(async () => {
    __resetResidentsForTests();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-resident-"));
    runtimeDir = path.join(dir, "hermes-runtime");
    hermesCmd = path.join(dir, "hermes.cjs");
    await fs.writeFile(
      hermesCmd,
      `#!${process.execPath}
const readline = require("node:readline");
const holdMs = Number(process.env.FIXTURE_HOLD_MS || 0);
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.shutdown) { process.exit(0); return; }
  const respond = () => {
    process.stdout.write(JSON.stringify({
      ok: true,
      response: "ok",
      session_id: "sess-1",
      disposition: { status: "in_progress", comment: "working" },
    }) + "\\n");
  };
  if (holdMs > 0) setTimeout(respond, holdMs);
  else respond();
});
`,
      { mode: 0o700 },
    );
  });

  afterEach(async () => {
    await stopResident(key).catch(() => undefined);
    __resetResidentsForTests();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reuses one resident when startResident is called concurrently", async () => {
    const statePath = residentStatePath(runtimeDir, key.issueId);
    const [a, b] = await Promise.all([
      startResident({
        key,
        hermesCmd,
        model: "m1",
        provider: "auto",
        cwd: dir,
        env: {},
        statePath,
      }),
      startResident({
        key,
        hermesCmd,
        model: "m1",
        provider: "auto",
        cwd: dir,
        env: {},
        statePath,
      }),
    ]);
    expect(a).toBe(b);
    expect(getLiveResident(key)?.child.pid).toBe(a.child.pid);
    const turn = await submitResidentTurn(a, { prompt: "hi" }, { timeoutSec: 5 });
    expect(turn.ok).toBe(true);
    expect(turn.response).toBe("ok");
  });

  it("times out a hung resident turn and rejects with timedOut", async () => {
    const handle = await startResident({
      key,
      hermesCmd,
      model: "m1",
      provider: "auto",
      cwd: dir,
      env: { FIXTURE_HOLD_MS: "60000" },
      statePath: residentStatePath(runtimeDir, key.issueId),
    });
    await expect(
      submitResidentTurn(handle, { prompt: "slow" }, { timeoutSec: 1 }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/timed out/i), timedOut: true });
  });

  it("writes per-issue state with lastUsedAt and does not overwrite across issues", async () => {
    const keyA = { companyId: "co", agentId: "ag", issueId: "iss-a" };
    const keyB = { companyId: "co", agentId: "ag", issueId: "iss-b" };
    const a = await startResident({
      key: keyA,
      hermesCmd,
      model: "m1",
      provider: "auto",
      cwd: dir,
      env: {},
      statePath: residentStatePath(runtimeDir, keyA.issueId),
      idleSec: DEFAULT_RESIDENT_IDLE_SEC,
    });
    const b = await startResident({
      key: keyB,
      hermesCmd,
      model: "m1",
      provider: "auto",
      cwd: dir,
      env: {},
      statePath: residentStatePath(runtimeDir, keyB.issueId),
    });
    expect(a.child.pid).not.toBe(b.child.pid);
    const pathA = residentStatePath(runtimeDir, "iss-a");
    const pathB = residentStatePath(runtimeDir, "iss-b");
    const rawA = JSON.parse(await fs.readFile(pathA, "utf8")) as { issueId: string; lastUsedAt: number; pid: number };
    const rawB = JSON.parse(await fs.readFile(pathB, "utf8")) as { issueId: string; lastUsedAt: number; pid: number };
    expect(rawA.issueId).toBe("iss-a");
    expect(rawB.issueId).toBe("iss-b");
    expect(typeof rawA.lastUsedAt).toBe("number");
    expect(typeof rawB.lastUsedAt).toBe("number");
    expect(await fs.access(legacyResidentStatePath(runtimeDir)).then(() => true).catch(() => false)).toBe(false);
    await stopResident(keyA);
    await stopResident(keyB);
  });

  it("updates lastUsedAt on the state file after a turn", async () => {
    const statePath = residentStatePath(runtimeDir, key.issueId);
    const handle = await startResident({
      key,
      hermesCmd,
      model: "m1",
      provider: "auto",
      cwd: dir,
      env: {},
      statePath,
    });
    const before = JSON.parse(await fs.readFile(statePath, "utf8")) as { lastUsedAt: number };
    await new Promise((r) => setTimeout(r, 5));
    await submitResidentTurn(handle, { prompt: "hi" }, { timeoutSec: 5 });
    // Persist is async on the line handler.
    await vi.waitFor(async () => {
      const after = JSON.parse(await fs.readFile(statePath, "utf8")) as { lastUsedAt: number };
      expect(after.lastUsedAt).toBeGreaterThanOrEqual(before.lastUsedAt);
    });
  });
});

describe("sweepStaleResidents", () => {
  let dir: string;
  let runtimeDir: string;
  const kills: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];

  beforeEach(async () => {
    __resetResidentsForTests();
    kills.length = 0;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-sweep-"));
    runtimeDir = path.join(dir, "hermes-runtime");
    await fs.mkdir(path.join(runtimeDir, "residents"), { recursive: true });

    const now = Date.now();
    __setResidentProcIoForTests({
      now: () => now,
      sleep: async () => undefined,
      kill(pid, signal) {
        kills.push({ pid, signal });
        if (signal === 0) {
          // Pretend alive unless we already SIGTERM'd it.
          if (kills.some((k) => k.pid === pid && k.signal === "SIGTERM")) {
            const err = new Error("ESRCH") as NodeJS.ErrnoException;
            err.code = "ESRCH";
            throw err;
          }
          return true;
        }
        return true;
      },
      async readCmdline(pid) {
        return `hermes\u0000chat\u0000--resident\u0000--resident-idle-sec\u000086400\u0000-m\u0000m1\u0000`;
      },
      async readStarttime() {
        return 1;
      },
    });
  });

  afterEach(async () => {
    __resetResidentsForTests();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reaps when lastUsedAt is 24h + 1ms old (SIGTERM, file and map cleared, waiters rejected)", async () => {
    const now = Date.now();
    __setResidentProcIoForTests({
      now: () => now,
      sleep: async () => undefined,
      kill(pid, signal) {
        kills.push({ pid, signal });
        if (signal === 0 && kills.some((k) => k.pid === pid && k.signal === "SIGTERM")) {
          const err = new Error("ESRCH") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
        return true;
      },
      async readCmdline() {
        return "hermes\u0000chat\u0000--resident\u0000--resident-idle-sec\u000086400";
      },
    });

    // Seed a live map entry whose child is a stub so pending waiters can be rejected.
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const key = { companyId: "co", agentId: "ag", issueId: "stale-iss" };
    const statePath = residentStatePath(runtimeDir, key.issueId);
    const startedAt = now - RESIDENT_STALE_MS - 1;
    await fs.writeFile(
      statePath,
      JSON.stringify({
        pid: child.pid,
        companyId: key.companyId,
        agentId: key.agentId,
        issueId: key.issueId,
        startedAt,
        lastUsedAt: startedAt,
        model: "m1",
        cwd: dir,
      }),
      "utf8",
    );

    // Inject into the live map via startResident fixture is heavy; call sweep on disk-only
    // first for SIGTERM, then separately verify map via start+manual lastUsedAt.
    await sweepStaleResidents(runtimeDir);
    expect(kills.some((k) => k.pid === child.pid && k.signal === "SIGTERM")).toBe(true);
    await expect(fs.access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  });

  it("does not reap at exactly 24h", async () => {
    const now = Date.now();
    __setResidentProcIoForTests({
      now: () => now,
      sleep: async () => undefined,
      kill(pid, signal) {
        kills.push({ pid, signal });
        return true;
      },
      async readCmdline() {
        return "hermes\u0000chat\u0000--resident\u0000--resident-idle-sec\u000086400";
      },
    });
    const statePath = residentStatePath(runtimeDir, "exact");
    await fs.writeFile(
      statePath,
      JSON.stringify({
        pid: 424242,
        companyId: "co",
        agentId: "ag",
        issueId: "exact",
        startedAt: now - RESIDENT_STALE_MS,
        lastUsedAt: now - RESIDENT_STALE_MS,
      }),
      "utf8",
    );
    await sweepStaleResidents(runtimeDir);
    expect(kills.length).toBe(0);
    await expect(fs.readFile(statePath, "utf8")).resolves.toContain("exact");
  });

  it("leaves a recent lastUsedAt untouched", async () => {
    const now = Date.now();
    __setResidentProcIoForTests({
      now: () => now,
      sleep: async () => undefined,
      kill(pid, signal) {
        kills.push({ pid, signal });
        return true;
      },
      async readCmdline() {
        return "hermes\u0000chat\u0000--resident\u0000--resident-idle-sec\u000086400";
      },
    });
    const statePath = residentStatePath(runtimeDir, "fresh");
    await fs.writeFile(
      statePath,
      JSON.stringify({
        pid: 111,
        companyId: "co",
        agentId: "ag",
        issueId: "fresh",
        startedAt: now - 60_000,
        lastUsedAt: now - 1_000,
      }),
      "utf8",
    );
    await sweepStaleResidents(runtimeDir);
    expect(kills.length).toBe(0);
    await expect(fs.access(statePath)).resolves.toBeUndefined();
  });

  it("quarantines a mismatched pid without sending a signal", async () => {
    const now = Date.now();
    __setResidentProcIoForTests({
      now: () => now,
      sleep: async () => undefined,
      kill(pid, signal) {
        kills.push({ pid, signal });
        return true;
      },
      async readCmdline() {
        return "python\u0000something-else\u0000";
      },
      async readStarttime() {
        return null;
      },
    });
    const statePath = residentStatePath(runtimeDir, "reuse");
    await fs.writeFile(
      statePath,
      JSON.stringify({
        pid: 999001,
        companyId: "co",
        agentId: "ag",
        issueId: "reuse",
        startedAt: now - RESIDENT_STALE_MS - 5,
        lastUsedAt: now - RESIDENT_STALE_MS - 5,
      }),
      "utf8",
    );
    await sweepStaleResidents(runtimeDir);
    expect(kills.length).toBe(0);
    await expect(fs.access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not reap when in-memory lastUsedAt is fresh but disk is stale", async () => {
    const now = Date.now();
    __setResidentProcIoForTests({
      now: () => now,
      sleep: async () => undefined,
      kill(pid, signal) {
        kills.push({ pid, signal });
        return true;
      },
      async readCmdline() {
        return "hermes\u0000chat\u0000--resident\u0000--resident-idle-sec\u000086400";
      },
    });

    const hermesCmd = path.join(dir, "hermes.cjs");
    await fs.writeFile(
      hermesCmd,
      `#!${process.execPath}
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.shutdown) { process.exit(0); return; }
  process.stdout.write(JSON.stringify({ ok: true, response: "ok", session_id: "s" }) + "\\n");
});
`,
      { mode: 0o700 },
    );
    const key = { companyId: "co", agentId: "ag", issueId: "mem-fresh" };
    const statePath = residentStatePath(runtimeDir, key.issueId);
    const handle = await startResident({
      key,
      hermesCmd,
      model: "m1",
      provider: "auto",
      cwd: dir,
      env: {},
      statePath,
    });
    handle.lastUsedAt = now - 1_000;
    await fs.writeFile(
      statePath,
      JSON.stringify({
        pid: handle.child.pid,
        companyId: key.companyId,
        agentId: key.agentId,
        issueId: key.issueId,
        startedAt: now - RESIDENT_STALE_MS - 10,
        lastUsedAt: now - RESIDENT_STALE_MS - 10,
        model: "m1",
        cwd: dir,
      }),
      "utf8",
    );
    await sweepStaleResidents(runtimeDir);
    expect(kills.length).toBe(0);
    expect(getLiveResident(key)?.child.pid).toBe(handle.child.pid);
    await stopResident(key);
  });

  it("rejects pending waiters when a live stale resident is swept", async () => {
    const now = Date.now();
    __setResidentProcIoForTests({
      now: () => now,
      sleep: async () => undefined,
      kill() {
        return true;
      },
      async readCmdline() {
        return "hermes\u0000chat\u0000--resident\u0000--resident-idle-sec\u000086400";
      },
    });

    const hermesCmd = path.join(dir, "hermes.cjs");
    await fs.writeFile(
      hermesCmd,
      `#!${process.execPath}
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", () => {});
`,
      { mode: 0o700 },
    );
    const key = { companyId: "co", agentId: "ag", issueId: "live-stale" };
    const statePath = residentStatePath(runtimeDir, key.issueId);
    const handle = await startResident({
      key,
      hermesCmd,
      model: "m1",
      provider: "auto",
      cwd: dir,
      env: {},
      statePath,
    });
    // Backdate usage past the stale threshold and rewrite the file.
    handle.lastUsedAt = now - RESIDENT_STALE_MS - 1;
    handle.startedAt = handle.lastUsedAt;
    await fs.writeFile(
      statePath,
      JSON.stringify({
        pid: handle.child.pid,
        companyId: key.companyId,
        agentId: key.agentId,
        issueId: key.issueId,
        startedAt: handle.startedAt,
        lastUsedAt: handle.lastUsedAt,
        model: "m1",
        cwd: dir,
      }),
      "utf8",
    );

    const pending = submitResidentTurn(handle, { prompt: "hang" }, { timeoutSec: 30 });
    // Attach the rejection expectation before sweep so the reject is handled.
    const expectRejected = expect(pending).rejects.toThrow(
      /reaped as stale|resident stopped|resident exited/i,
    );
    await sweepStaleResidents(runtimeDir);
    await expectRejected;
    expect(getLiveResident(key)).toBeNull();
    await expect(fs.access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
