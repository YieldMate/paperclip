import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetResidentsForTests,
  __setResidentProcIoForTests,
  DEFAULT_RESIDENT_IDLE_SEC,
  enforceResidentWarmCap,
  getLiveResident,
  isResidentTtlExpired,
  legacyResidentStatePath,
  normalizeCwdIdentity,
  reapExpiredResidents,
  RESIDENT_STALE_MS,
  residentStatePath,
  setResidentTtl,
  shouldKeepResidentForDisposition,
  startResident,
  stopResident,
  submitResidentTurn,
  sweepStaleResidents,
  takeResidentEvictionReason,
  testOnly,
} from "./resident.js";
import { RESIDENT_WARM_POLICY_V2_ENV } from "./resident-warm-policy.js";

describe("shouldKeepResidentForDisposition", () => {
  const previous = process.env[RESIDENT_WARM_POLICY_V2_ENV];
  afterEach(() => {
    if (previous === undefined) delete process.env[RESIDENT_WARM_POLICY_V2_ENV];
    else process.env[RESIDENT_WARM_POLICY_V2_ENV] = previous;
  });

  it("flag off: keeps missing status and stops terminal statuses", () => {
    process.env[RESIDENT_WARM_POLICY_V2_ENV] = "0";
    expect(shouldKeepResidentForDisposition(null)).toBe(true);
    expect(shouldKeepResidentForDisposition({})).toBe(true);
    expect(shouldKeepResidentForDisposition({ status: "in_progress" })).toBe(true);
    expect(shouldKeepResidentForDisposition({ status: "todo" })).toBe(true);
    expect(shouldKeepResidentForDisposition({ status: "done" })).toBe(false);
    expect(shouldKeepResidentForDisposition({ status: "in_review" })).toBe(false);
    expect(shouldKeepResidentForDisposition({ status: "blocked" })).toBe(false);
    expect(shouldKeepResidentForDisposition({ status: "cancelled" })).toBe(false);
  });

  it("flag on: keeps terminal dispositions that grant a short TTL", () => {
    process.env[RESIDENT_WARM_POLICY_V2_ENV] = "1";
    expect(shouldKeepResidentForDisposition({ status: "done" })).toBe(true);
    expect(shouldKeepResidentForDisposition({ status: "blocked" })).toBe(true);
    expect(shouldKeepResidentForDisposition({ status: "cancelled" })).toBe(false);
    expect(shouldKeepResidentForDisposition(null)).toBe(true);
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

  it("starts a new resident when cwd changes for the same issue key (YIE-69 transition)", async () => {
    const first = await startResident({
      key,
      hermesCmd,
      model: "m1",
      provider: "auto",
      cwd: dir,
      env: {},
      statePath,
    });
    const firstPid = first.child.pid;
    const otherCwd = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-resident-cwd-"));
    try {
      const second = await startResident({
        key,
        hermesCmd,
        model: "m1",
        provider: "auto",
        cwd: otherCwd,
        env: {},
        statePath,
      });
      expect(second.cwd).toBe(otherCwd);
      expect(second.child.pid).not.toBe(firstPid);
      // Same-issue reuse requires matching cwd; a changed cwd replaces the handle.
      expect(second).not.toBe(first);
    } finally {
      await fs.rm(otherCwd, { recursive: true, force: true });
    }
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
  const previousFlag = process.env[RESIDENT_WARM_POLICY_V2_ENV];

  beforeEach(async () => {
    __resetResidentsForTests();
    // YIE-75 time-keyed cases seed disk-only records; disable v2 identity-mismatch.
    process.env[RESIDENT_WARM_POLICY_V2_ENV] = "0";
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
    if (previousFlag === undefined) delete process.env[RESIDENT_WARM_POLICY_V2_ENV];
    else process.env[RESIDENT_WARM_POLICY_V2_ENV] = previousFlag;
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

describe("cwdIdentity + TTL + LRU (YIE-71)", () => {
  let dir: string;
  let hermesCmd: string;
  let runtimeDir: string;
  const previousFlag = process.env[RESIDENT_WARM_POLICY_V2_ENV];

  beforeEach(async () => {
    __resetResidentsForTests();
    process.env[RESIDENT_WARM_POLICY_V2_ENV] = "1";
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-warm-"));
    runtimeDir = path.join(dir, "hermes-runtime");
    hermesCmd = path.join(dir, "hermes.cjs");
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
  });

  afterEach(async () => {
    __resetResidentsForTests();
    if (previousFlag === undefined) delete process.env[RESIDENT_WARM_POLICY_V2_ENV];
    else process.env[RESIDENT_WARM_POLICY_V2_ENV] = previousFlag;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reuses across spelling-equivalent cwds via cwdIdentity", async () => {
    const key = { companyId: "co", agentId: "ag", issueId: "cwd-iss" };
    const statePath = residentStatePath(runtimeDir, key.issueId);
    const identity = await normalizeCwdIdentity(dir);
    const a = await startResident({
      key,
      hermesCmd,
      model: "m1",
      provider: "auto",
      cwd: dir,
      cwdIdentity: identity,
      env: {},
      statePath,
    });
    const b = await startResident({
      key,
      hermesCmd,
      model: "m1",
      provider: "auto",
      cwd: path.join(dir, "."),
      cwdIdentity: identity,
      env: {},
      statePath,
    });
    expect(a).toBe(b);
    const raw = JSON.parse(await fs.readFile(statePath, "utf8")) as { cwdIdentity: string };
    expect(raw.cwdIdentity).toBe(identity);
    await stopResident(key);
  });

  it("refuses a moved directory and replaces the resident", async () => {
    const key = { companyId: "co", agentId: "ag", issueId: "moved" };
    const other = path.join(dir, "other");
    await fs.mkdir(other);
    const statePath = residentStatePath(runtimeDir, key.issueId);
    const first = await startResident({
      key,
      hermesCmd,
      model: "m1",
      provider: "auto",
      cwd: dir,
      cwdIdentity: await normalizeCwdIdentity(dir),
      env: {},
      statePath,
    });
    const second = await startResident({
      key,
      hermesCmd,
      model: "m1",
      provider: "auto",
      cwd: other,
      cwdIdentity: await normalizeCwdIdentity(other),
      env: {},
      statePath,
    });
    expect(second.child.pid).not.toBe(first.child.pid);
    expect(second.cwdIdentity).not.toBe(first.cwdIdentity);
    await stopResident(key);
  });

  it("adapter expiresAt beats a longer spawn idle; reapExpiredResidents stops it", async () => {
    let now = 1_000_000;
    __setResidentProcIoForTests({
      now: () => now,
      sleep: async () => undefined,
      async readRssMb() {
        return 100;
      },
    });
    const key = { companyId: "co", agentId: "ag", issueId: "ttl" };
    const handle = await startResident({
      key,
      hermesCmd,
      model: "m1",
      provider: "auto",
      cwd: dir,
      env: {},
      idleSec: 86_400,
      ttlSec: 180,
      statePath: residentStatePath(runtimeDir, key.issueId),
    });
    expect(handle.expiresAt).toBe(now + 180_000);
    expect(isResidentTtlExpired(handle)).toBe(false);
    now = now + 180_000;
    expect(isResidentTtlExpired(handle)).toBe(true);
    const stopped = await reapExpiredResidents();
    expect(stopped).toContain("ttl");
    expect(getLiveResident(key)).toBeNull();
  });

  it("LRU evicts by lastUsedAt under count cap with injected clock/RSS", async () => {
    let now = 5_000_000;
    __setResidentProcIoForTests({
      now: () => now,
      sleep: async () => undefined,
      async readRssMb() {
        return 100;
      },
    });
    const handles = [];
    for (let i = 0; i < 9; i += 1) {
      now += 10;
      const key = { companyId: "co", agentId: "ag", issueId: `cap-${i}` };
      const h = await startResident({
        key,
        hermesCmd,
        model: "m1",
        provider: "auto",
        cwd: dir,
        env: {},
        ttlSec: 900,
        statePath: residentStatePath(runtimeDir, key.issueId),
      });
      h.lastUsedAt = now;
      handles.push({ key, h });
    }
    expect(testOnly.snapshotResidents()).toHaveLength(9);
    const { evicted } = await enforceResidentWarmCap({
      protectIssueIds: ["cap-8"],
      config: { residentWarmMaxLiveResidents: 8, residentWarmMaxAggregateRssMb: 4096 },
    });
    expect(evicted).toContain("cap-0");
    expect(testOnly.snapshotResidents().length).toBeLessThanOrEqual(8);
    expect(takeResidentEvictionReason({ companyId: "co", agentId: "ag", issueId: "cap-0" })).toBe(
      "cap_evicted",
    );
    for (const { key } of handles) {
      await stopResident(key).catch(() => undefined);
    }
  });

  it("RSS cap evicts LRU victims", async () => {
    let now = 6_000_000;
    __setResidentProcIoForTests({
      now: () => now,
      sleep: async () => undefined,
      async readRssMb() {
        return 2000;
      },
    });
    const keys = [];
    for (let i = 0; i < 3; i += 1) {
      now += 10;
      const key = { companyId: "co", agentId: "ag", issueId: `rss-${i}` };
      const h = await startResident({
        key,
        hermesCmd,
        model: "m1",
        provider: "auto",
        cwd: dir,
        env: {},
        statePath: residentStatePath(runtimeDir, key.issueId),
      });
      h.lastUsedAt = now;
      keys.push(key);
    }
    const { evicted } = await enforceResidentWarmCap({
      protectIssueIds: ["rss-2"],
      config: { residentWarmMaxLiveResidents: 8, residentWarmMaxAggregateRssMb: 4096 },
    });
    expect(evicted.length).toBeGreaterThan(0);
    expect(testOnly.snapshotResidents().some((s) => s.issueId === "rss-2")).toBe(true);
    for (const key of keys) await stopResident(key).catch(() => undefined);
  });

  it("pending-wake issues are never LRU victims", async () => {
    let now = 7_000_000;
    __setResidentProcIoForTests({
      now: () => now,
      sleep: async () => undefined,
      async readRssMb() {
        return 100;
      },
    });
    const { setPendingWakeIssueIdsForAgent } = await import("./resident.js");
    setPendingWakeIssueIdsForAgent("co", "ag", ["pw-0"]);
    for (let i = 0; i < 9; i += 1) {
      now += 10;
      await startResident({
        key: { companyId: "co", agentId: "ag", issueId: `pw-${i}` },
        hermesCmd,
        model: "m1",
        provider: "auto",
        cwd: dir,
        env: {},
        statePath: residentStatePath(runtimeDir, `pw-${i}`),
      });
    }
    await enforceResidentWarmCap({
      config: { residentWarmMaxLiveResidents: 8, residentWarmMaxAggregateRssMb: 4096 },
    });
    expect(getLiveResident({ companyId: "co", agentId: "ag", issueId: "pw-0" })).not.toBeNull();
  });

  it("disk census count feeds the live cap", async () => {
    let now = 9_000_000;
    __setResidentProcIoForTests({
      now: () => now,
      sleep: async () => undefined,
      async readRssMb() {
        return 50;
      },
    });
    for (let i = 0; i < 6; i += 1) {
      now += 10;
      await startResident({
        key: { companyId: "co", agentId: "ag", issueId: `dc-${i}` },
        hermesCmd,
        model: "m1",
        provider: "auto",
        cwd: dir,
        env: {},
        statePath: residentStatePath(runtimeDir, `dc-${i}`),
      });
    }
    // Pretend 4 restart orphans still exist on disk beyond the live map.
    const { evicted } = await enforceResidentWarmCap({
      protectIssueIds: ["dc-5"],
      config: { residentWarmMaxLiveResidents: 8, residentWarmMaxAggregateRssMb: 4096 },
      diskCensusCount: 10,
    });
    expect(evicted.length).toBeGreaterThan(0);
    expect(testOnly.snapshotResidents().length).toBeLessThanOrEqual(8);
  });

  it("identity-mismatch reaps disk pid that is not the live-map entry", async () => {
    const kills: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
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
    const key = { companyId: "co", agentId: "ag", issueId: "mismatch" };
    const handle = await startResident({
      key,
      hermesCmd,
      model: "m1",
      provider: "auto",
      cwd: dir,
      env: {},
      statePath: residentStatePath(runtimeDir, key.issueId),
    });
    const statePath = residentStatePath(runtimeDir, key.issueId);
    // Corrupt disk pid so it no longer matches the live handle.
    await fs.writeFile(
      statePath,
      JSON.stringify({
        pid: 424242,
        companyId: key.companyId,
        agentId: key.agentId,
        issueId: key.issueId,
        startedAt: now,
        lastUsedAt: now,
        cwdIdentity: handle.cwdIdentity,
      }),
      "utf8",
    );
    await sweepStaleResidents(runtimeDir);
    expect(kills.some((k) => k.pid === 424242 && k.signal === "SIGTERM")).toBe(true);
    // Live handle remains and its state file is rewritten with the live pid.
    expect(getLiveResident(key)?.child.pid).toBe(handle.child.pid);
    const rewritten = JSON.parse(await fs.readFile(statePath, "utf8")) as { pid: number };
    expect(rewritten.pid).toBe(handle.child.pid);
    await stopResident(key);
  });

  it("setResidentTtl refreshes expiresAt from lastUsedAt", async () => {
    let now = 8_000_000;
    __setResidentProcIoForTests({ now: () => now, sleep: async () => undefined });
    const key = { companyId: "co", agentId: "ag", issueId: "grant" };
    const handle = await startResident({
      key,
      hermesCmd,
      model: "m1",
      provider: "auto",
      cwd: dir,
      env: {},
      ttlSec: 900,
      statePath: residentStatePath(runtimeDir, key.issueId),
    });
    handle.lastUsedAt = now;
    setResidentTtl(key, 180);
    expect(handle.expiresAt).toBe(now + 180_000);
    await stopResident(key);
  });
});
