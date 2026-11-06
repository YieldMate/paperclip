import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetResidentsForTests,
  getLiveResident,
  shouldKeepResidentForDisposition,
  startResident,
  stopResident,
  submitResidentTurn,
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
  let statePath: string;
  const key = { companyId: "co", agentId: "ag", issueId: "iss" };

  beforeEach(async () => {
    __resetResidentsForTests();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-resident-"));
    hermesCmd = path.join(dir, "hermes.cjs");
    statePath = path.join(dir, "resident.json");
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
      statePath,
    });
    await expect(
      submitResidentTurn(handle, { prompt: "slow" }, { timeoutSec: 1 }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/timed out/i), timedOut: true });
  });
});
