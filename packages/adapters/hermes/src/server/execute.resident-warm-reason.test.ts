/**
 * YIE-71 / Corin QA F1: dispatch rejection reasons must survive the warm step.
 * Live path: moved-directory → cwd_mismatch sticks; TTL-expired → ttl_expired sticks.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

import { execute, resolveManagedHermesRuntimeStateDir } from "./execute.js";
import {
  __resetResidentsForTests,
  getLiveResident,
  normalizeCwdIdentity,
  residentStatePath,
  startResident,
  stopResident,
} from "./resident.js";
import { RESIDENT_WARM_POLICY_V2_ENV } from "./resident-warm-policy.js";

const SESSION_ID = "20261106_warm_reason_abcdef";
const FIXTURE_INSTANCE_ID = "hermes-warm-reason-test";
const COMPANY_ID = "company-warm";
const AGENT_ID = "agent-warm";
const ISSUE_ID = "issue-warm";
const MODEL = "fixture-model";

describe("execute() preserves dispatch rejection warm reasons (YIE-71 F1)", () => {
  let dir: string;
  let otherDir: string;
  let paperclipHome: string;
  let command: string;
  let previousFlag: string | undefined;
  let previousHome: string | undefined;
  let previousInstance: string | undefined;
  const key = { companyId: COMPANY_ID, agentId: AGENT_ID, issueId: ISSUE_ID };

  beforeEach(async () => {
    __resetResidentsForTests();
    previousFlag = process.env[RESIDENT_WARM_POLICY_V2_ENV];
    previousHome = process.env.PAPERCLIP_HOME;
    previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
    process.env[RESIDENT_WARM_POLICY_V2_ENV] = "1";

    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-warm-reason-"));
    otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-warm-moved-"));
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-warm-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = FIXTURE_INSTANCE_ID;

    command = path.join(dir, "hermes.cjs");
    await fs.writeFile(
      command,
      `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const args = process.argv.slice(2);
if (args.includes("--resident")) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.shutdown) { process.exit(0); return; }
    process.stdout.write(JSON.stringify({
      ok: true,
      response: "resident-ok",
      session_id: "${SESSION_ID}",
      disposition: { status: "in_progress", comment: "working" },
    }) + "\\n");
  });
} else {
  if (process.env.HERMES_DISPOSITION_FILE) {
    fs.writeFileSync(
      process.env.HERMES_DISPOSITION_FILE,
      JSON.stringify({ status: "done", comment: "oneshot done" }),
    );
  }
  console.log("Fixture completed\\nsession_id: ${SESSION_ID}");
}
`,
      { mode: 0o700 },
    );
  });

  afterEach(async () => {
    await stopResident(key).catch(() => undefined);
    __resetResidentsForTests();
    if (previousFlag === undefined) delete process.env[RESIDENT_WARM_POLICY_V2_ENV];
    else process.env[RESIDENT_WARM_POLICY_V2_ENV] = previousFlag;
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(otherDir, { recursive: true, force: true });
    await fs.rm(paperclipHome, { recursive: true, force: true });
  });

  function context(cwd: string): AdapterExecutionContext {
    return {
      runId: "run-warm-reason",
      agent: {
        id: AGENT_ID,
        companyId: COMPANY_ID,
        name: "Hermes warm-reason fixture",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: ISSUE_ID,
      },
      config: {
        hermesCommand: command,
        provider: "openrouter",
        model: MODEL,
        cwd,
        env: {},
        timeoutSec: 15,
        graceSec: 1,
        residentSession: true,
      },
      context: {
        issueId: ISSUE_ID,
        paperclipWake: {
          reason: "issue_assigned",
          issue: { id: ISSUE_ID, title: "Warm reason", status: "todo" },
          comments: [],
          commentWindow: { requestedCount: 0, returnedCount: 0, missingCount: 0 },
          fallbackFetchNeeded: false,
        },
      },
      onLog: async () => undefined,
    };
  }

  async function seedLiveResident(cwd: string, opts?: { ttlSec?: number }) {
    const runtimeDir = resolveManagedHermesRuntimeStateDir(
      {
        PAPERCLIP_HOME: paperclipHome,
        PAPERCLIP_INSTANCE_ID: FIXTURE_INSTANCE_ID,
      },
      COMPANY_ID,
      AGENT_ID,
    );
    await fs.mkdir(path.join(runtimeDir, "residents"), { recursive: true });
    const cwdIdentity = await normalizeCwdIdentity(cwd);
    return startResident({
      key,
      hermesCmd: command,
      model: MODEL,
      provider: "openrouter",
      cwd,
      cwdIdentity,
      env: {},
      ttlSec: opts?.ttlSec ?? 900,
      statePath: residentStatePath(runtimeDir, ISSUE_ID),
    });
  }

  it("moved-directory cold start keeps resident_warm_reason=cwd_mismatch after re-warm", async () => {
    await seedLiveResident(dir);
    expect(getLiveResident(key)).not.toBeNull();

    const result = await execute(context(otherDir));
    const telemetry = (result.resultJson ?? {}) as Record<string, unknown>;

    expect(telemetry.resident_start_decision).toBe("cold");
    expect(telemetry.resident_warm_decision).toBe("warmed");
    expect(telemetry.resident_warm_reason).toBe("cwd_mismatch");
    // Must not be clobbered by disposition_done from the oneshot warm step.
    expect(telemetry.resident_warm_reason).not.toBe("disposition_done");
  });

  it("TTL-expired dispatch keeps resident_warm_reason=ttl_expired after re-warm", async () => {
    const handle = await seedLiveResident(dir, { ttlSec: 900 });
    // Keep a pending waiter so reapExpiredResidents skips this handle, then the
    // dispatch guard still sees isResidentTtlExpired → ttl_expired.
    handle.expiresAt = Date.now() - 1_000;
    handle.pending.push({
      settled: false,
      resolve: () => undefined,
      reject: () => undefined,
    });

    const result = await execute(context(dir));
    const telemetry = (result.resultJson ?? {}) as Record<string, unknown>;

    expect(telemetry.resident_start_decision).toBe("cold");
    expect(telemetry.resident_warm_decision).toBe("warmed");
    expect(telemetry.resident_warm_reason).toBe("ttl_expired");
    expect(telemetry.resident_warm_reason).not.toBe("disposition_done");
  });

  it("TTL-reaped resident sticks ttl_expired via sticky marker (not disposition_*)", async () => {
    const handle = await seedLiveResident(dir, { ttlSec: 900 });
    handle.expiresAt = Date.now() - 1_000;
    // No pending → reapExpiredResidents stops it and stamps sticky ttl_expired.

    const result = await execute(context(dir));
    const telemetry = (result.resultJson ?? {}) as Record<string, unknown>;

    expect(telemetry.resident_start_decision).toBe("cold");
    expect(telemetry.resident_warm_decision).toBe("warmed");
    expect(telemetry.resident_warm_reason).toBe("ttl_expired");
  });

  it("plain cold start records disposition_done after warm (no_live_resident not sticky)", async () => {
    expect(getLiveResident(key)).toBeNull();

    const result = await execute(context(dir));
    const telemetry = (result.resultJson ?? {}) as Record<string, unknown>;

    expect(telemetry.resident_start_decision).toBe("cold");
    expect(telemetry.resident_warm_decision).toBe("warmed");
    expect(telemetry.resident_warm_reason).toBe("disposition_done");
  });
});
