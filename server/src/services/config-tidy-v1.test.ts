import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../__tests__/helpers/external-test-database.js";
import {
  ATLAS_FLEET_TIMEOUT_SEC,
  AUDITOR_TIMEOUT_SEC,
  CONFIG_TIDY_V1_ENV,
  DEAD_ADAPTER_MODEL,
  DEAD_ADAPTER_TYPE,
  DEAD_EMBEDDED_POSTGRES_PORT,
  YIE74_LIVE_ROSTER_READY_NAMES,
  applyAtlasFleetTimeout,
  applyConfigTidyV1,
  demoteSmartModelRoutingToDotted,
  hasExternalDatabaseConnection,
  isConfigTidyV1Enabled,
  mergeConfigTidyBackup,
  migrateSmartModelRoutingToNested,
  operatorDumpHasForbiddenRefs,
  readConfigTidyBackup,
  readSmartModelRoutingFields,
  resolveConfigTidyBackupPath,
  rollbackConfigTidyV1,
  runConfigTidyV1OnStartup,
  serializeOperatorConfigDump,
  tidyInstanceConfig,
} from "./config-tidy-v1.js";

const externalDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_CONFIG_TIDY_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("config-tidy-v1 flag", () => {
  it("defaults off", () => {
    expect(isConfigTidyV1Enabled({})).toBe(false);
    expect(isConfigTidyV1Enabled({ [CONFIG_TIDY_V1_ENV]: "0" })).toBe(false);
  });

  it("enables via PAPERCLIP_CONFIG_TIDY_V1 or CONFIG_TIDY_V1", () => {
    expect(isConfigTidyV1Enabled({ [CONFIG_TIDY_V1_ENV]: "1" })).toBe(true);
    expect(isConfigTidyV1Enabled({ CONFIG_TIDY_V1: "true" })).toBe(true);
    expect(isConfigTidyV1Enabled({ CONFIG_TIDY_V1: "on" })).toBe(true);
  });
});

describe("tidyInstanceConfig", () => {
  it("strips dead adapter defaults and embeddedPostgresPort when external DB is set", () => {
    const raw = {
      adapterType: DEAD_ADAPTER_TYPE,
      model: DEAD_ADAPTER_MODEL,
      llm: { provider: "openai", adapterType: DEAD_ADAPTER_TYPE, model: DEAD_ADAPTER_MODEL },
      database: {
        mode: "postgres",
        connectionString: "postgres://paperclip:paperclip@127.0.0.1:5432/paperclip",
        embeddedPostgresPort: DEAD_EMBEDDED_POSTGRES_PORT,
      },
    };
    const result = tidyInstanceConfig(raw);
    expect(result.changed).toBe(true);
    expect(result.next.adapterType).toBeUndefined();
    expect(result.next.model).toBeUndefined();
    expect((result.next.llm as Record<string, unknown>).adapterType).toBeUndefined();
    expect((result.next.llm as Record<string, unknown>).model).toBeUndefined();
    expect((result.next.database as Record<string, unknown>).embeddedPostgresPort).toBeUndefined();
    expect((result.next.database as Record<string, unknown>).connectionString).toContain(":5432/");
    expect(hasExternalDatabaseConnection(result.next)).toBe(true);

    const dump = serializeOperatorConfigDump(result.next);
    const hits = operatorDumpHasForbiddenRefs(dump);
    expect(hits).toEqual({ custom_llm_local: false, nousHermes: false, port54329: false });
  });

  it("strips dead model under adapterConfig.model (live YieldMate shape)", () => {
    // Corin cycle-B: live dump has adapterType top-level + model under adapterConfig.
    const raw = {
      adapterType: DEAD_ADAPTER_TYPE,
      adapterConfig: {
        model: DEAD_ADAPTER_MODEL,
        timeoutSec: 20_000,
      },
      database: {
        mode: "postgres",
        connectionString: "postgres://paperclip:paperclip@127.0.0.1:5432/paperclip",
        embeddedPostgresPort: DEAD_EMBEDDED_POSTGRES_PORT,
      },
    };
    const result = tidyInstanceConfig(raw);
    expect(result.changed).toBe(true);
    expect(result.next.adapterType).toBeUndefined();
    expect((result.next.adapterConfig as Record<string, unknown>).model).toBeUndefined();
    expect((result.next.adapterConfig as Record<string, unknown>).timeoutSec).toBe(20_000);
    expect((result.removed.adapterConfig as Record<string, unknown>).model).toBe(DEAD_ADAPTER_MODEL);

    const hits = operatorDumpHasForbiddenRefs(serializeOperatorConfigDump(result.next));
    expect(hits.nousHermes).toBe(false);
    expect(hits.custom_llm_local).toBe(false);
    expect(hits.port54329).toBe(false);
  });

  it("keeps embeddedPostgresPort when no external connectionString (local/CLI path)", () => {
    const raw = {
      database: { mode: "embedded-postgres", embeddedPostgresPort: DEAD_EMBEDDED_POSTGRES_PORT },
    };
    const result = tidyInstanceConfig(raw);
    expect(result.changed).toBe(false);
    expect((result.next.database as Record<string, unknown>).embeddedPostgresPort).toBe(
      DEAD_EMBEDDED_POSTGRES_PORT,
    );
  });
});

describe("mergeConfigTidyBackup", () => {
  it("returns null when this boot changed nothing (do not rewrite)", () => {
    expect(
      mergeConfigTidyBackup({
        existing: {
          version: 1,
          createdAt: "2026-11-07T00:00:00.000Z",
          instanceConfigPath: "/x/config.json",
          instanceConfigBefore: { adapterType: DEAD_ADAPTER_TYPE },
          agents: [{ id: "a1", name: "Steve", adapterConfig: { "smartModelRouting.enabled": true } }],
        },
        configPath: "/x/config.json",
        instanceChanged: false,
        instanceConfigBefore: { already: "tidied" },
        agentBackups: [],
      }),
    ).toBeNull();
  });

  it("keeps original instanceConfigBefore and merges new agent entries only", () => {
    const existing = {
      version: 1 as const,
      createdAt: "2026-11-07T00:00:00.000Z",
      instanceConfigPath: "/x/config.json",
      instanceConfigBefore: {
        adapterType: DEAD_ADAPTER_TYPE,
        adapterConfig: { model: DEAD_ADAPTER_MODEL },
      },
      agents: [{ id: "steve", name: "Steve", adapterConfig: { "smartModelRouting.enabled": true } }],
    };
    const merged = mergeConfigTidyBackup({
      existing,
      configPath: "/x/config.json",
      instanceChanged: true,
      instanceConfigBefore: { already: "tidied-should-not-win" },
      agentBackups: [
        { id: "steve", name: "Steve", adapterConfig: { smartModelRouting: { enabled: true } } },
        { id: "atlas", name: "Atlas", adapterConfig: { timeoutSec: 0 } },
      ],
    });
    expect(merged!.instanceConfigBefore).toEqual(existing.instanceConfigBefore);
    expect(merged!.agents).toHaveLength(2);
    expect(merged!.agents.find((a) => a.id === "steve")!.adapterConfig).toEqual({
      "smartModelRouting.enabled": true,
    });
    expect(merged!.agents.find((a) => a.id === "atlas")!.adapterConfig).toEqual({ timeoutSec: 0 });
  });
});

describe("smartModelRouting dual-shape + Soren partial key", () => {
  it("migrates Steve/Remy enabled+cheapModel to nested", () => {
    const before = {
      "smartModelRouting.enabled": true,
      "smartModelRouting.cheapModel": "deepseek-chat",
    };
    const result = migrateSmartModelRoutingToNested(before);
    expect(result.changed).toBe(true);
    expect(result.afterShape).toBe("nested");
    expect(result.nested).toEqual({ enabled: true, cheapModel: "deepseek-chat" });
    expect(result.next["smartModelRouting.enabled"]).toBeUndefined();
    expect(result.next["smartModelRouting.cheapModel"]).toBeUndefined();
    expect(readSmartModelRoutingFields(result.next)).toEqual({
      enabled: true,
      cheapModel: "deepseek-chat",
    });
  });

  it("migrates Soren cheapModel-only without inventing enabled", () => {
    const before = { "smartModelRouting.cheapModel": "deepseek-chat" };
    const result = migrateSmartModelRoutingToNested(before);
    expect(result.nested).toEqual({ cheapModel: "deepseek-chat" });
    expect(Object.prototype.hasOwnProperty.call(result.nested!, "enabled")).toBe(false);
    expect(readSmartModelRoutingFields(result.next)).toEqual({ cheapModel: "deepseek-chat" });
    expect(Object.prototype.hasOwnProperty.call(readSmartModelRoutingFields(result.next), "enabled")).toBe(
      false,
    );
  });

  it("reads BOTH shapes (dotted and nested) during migration", () => {
    expect(
      readSmartModelRoutingFields({
        "smartModelRouting.enabled": true,
        "smartModelRouting.cheapModel": "cheap-a",
      }),
    ).toEqual({ enabled: true, cheapModel: "cheap-a" });

    expect(
      readSmartModelRoutingFields({
        smartModelRouting: { enabled: true, cheapModel: "cheap-b" },
      }),
    ).toEqual({ enabled: true, cheapModel: "cheap-b" });

    // Nested wins when mixed.
    expect(
      readSmartModelRoutingFields({
        "smartModelRouting.enabled": false,
        "smartModelRouting.cheapModel": "dotted",
        smartModelRouting: { enabled: true, cheapModel: "nested" },
      }),
    ).toEqual({ enabled: true, cheapModel: "nested" });
  });

  it("demotes nested back to dotted with no data loss (incl. Soren)", () => {
    const nestedOnly = { smartModelRouting: { cheapModel: "deepseek-chat" } };
    const demoted = demoteSmartModelRoutingToDotted(nestedOnly);
    expect(demoted.next).toEqual({ "smartModelRouting.cheapModel": "deepseek-chat" });
    expect(Object.prototype.hasOwnProperty.call(demoted.next, "smartModelRouting.enabled")).toBe(false);

    const full = { smartModelRouting: { enabled: true, cheapModel: "x" } };
    expect(demoteSmartModelRoutingToDotted(full).next).toEqual({
      "smartModelRouting.enabled": true,
      "smartModelRouting.cheapModel": "x",
    });
  });
});

describe("Atlas timeoutSec", () => {
  it("sets Atlas 0 → 20000 and leaves AUDITOR 8000 alone", () => {
    const atlas = applyAtlasFleetTimeout("Atlas", { timeoutSec: 0 });
    expect(atlas.changed).toBe(true);
    expect(atlas.next.timeoutSec).toBe(ATLAS_FLEET_TIMEOUT_SEC);

    const auditor = applyAtlasFleetTimeout("AUDITOR", { timeoutSec: AUDITOR_TIMEOUT_SEC });
    expect(auditor.changed).toBe(false);
    expect(auditor.next.timeoutSec).toBe(AUDITOR_TIMEOUT_SEC);
  });
});

describeEmbeddedPostgres("YIE-74 config tidy E2E", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let tempDir!: string;
  let configPath!: string;

  beforeAll(async () => {
    if (externalDatabaseUrl) db = createDb(externalDatabaseUrl);
    else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-config-tidy-");
      db = createDb(tempDb.connectionString);
    }
  }, 90_000);

  afterEach(async () => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    tempDir = undefined as unknown as string;
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const [company] = await db
      .insert(companies)
      .values({
        name: `YIE-74 ${Date.now()}`,
        status: "active",
        issuePrefix: `T${randomUUID().replace(/-/g, "").slice(0, 7)}`,
      })
      .returning();
    return company;
  }

  async function seedAgent(
    companyId: string,
    name: string,
    adapterConfig: Record<string, unknown>,
    opts: { lifecycleState?: string; status?: string } = {},
  ) {
    const [row] = await db
      .insert(agents)
      .values({
        companyId,
        name,
        adapterType: "hermes_local",
        adapterConfig,
        lifecycleState: (opts.lifecycleState as "ready") ?? "ready",
        status: (opts.status as "idle") ?? "idle",
      })
      .returning();
    return row;
  }

  /**
   * Redacted live YieldMate instance shape (Corin cycle-B probe):
   * top-level adapterType + dead model under adapterConfig.model (not top-level model).
   */
  function writeDriftedInstanceConfig(connectionString: string) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-config-tidy-"));
    configPath = path.join(tempDir, "config.json");
    const drifted = {
      adapterType: DEAD_ADAPTER_TYPE,
      adapterConfig: {
        model: DEAD_ADAPTER_MODEL,
        timeoutSec: ATLAS_FLEET_TIMEOUT_SEC,
      },
      database: {
        mode: "postgres",
        connectionString,
        embeddedPostgresPort: DEAD_EMBEDDED_POSTGRES_PORT,
      },
      server: { deploymentMode: "local_trusted", exposure: "private", port: 3100 },
      logging: { mode: "file" },
      $meta: { version: 1, updatedAt: new Date().toISOString(), source: "configure" },
    };
    fs.writeFileSync(configPath, `${JSON.stringify(drifted, null, 2)}\n`);
    return drifted;
  }

  it("E2E1: config-load with removals; adapter resolution for full live roster (terminated tolerated)", async () => {
    const company = await seedCompany();
    const dbUrl = externalDatabaseUrl ?? tempDb!.connectionString;
    writeDriftedInstanceConfig(dbUrl);

    for (const name of YIE74_LIVE_ROSTER_READY_NAMES) {
      const adapterConfig: Record<string, unknown> = {
        model: "fixture-model",
        timeoutSec: name === "Atlas" ? 0 : name === "AUDITOR" ? AUDITOR_TIMEOUT_SEC : ATLAS_FLEET_TIMEOUT_SEC,
      };
      if (name === "Steve" || name === "Remy") {
        adapterConfig["smartModelRouting.enabled"] = true;
        adapterConfig["smartModelRouting.cheapModel"] = "cheap-model";
      }
      if (name === "Soren") {
        adapterConfig["smartModelRouting.cheapModel"] = "cheap-model";
      }
      await seedAgent(company.id, name, adapterConfig);
    }
    await seedAgent(
      company.id,
      "Atlas-dup-terminated",
      { model: "fixture-model", timeoutSec: 0 },
      { lifecycleState: "terminated", status: "terminated" },
    );

    const result = await applyConfigTidyV1({
      db,
      configPath,
      env: { [CONFIG_TIDY_V1_ENV]: "1" },
    });

    expect(result.enabled).toBe(true);
    expect(result.instanceChanged).toBe(true);
    expect(result.agentsScanned).toBe(YIE74_LIVE_ROSTER_READY_NAMES.length + 1);
    expect(result.terminatedTolerated).toBe(1);

    const written = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(written.adapterType).toBeUndefined();
    expect((written.adapterConfig as Record<string, unknown>).model).toBeUndefined();
    expect((written.database as Record<string, unknown>).embeddedPostgresPort).toBeUndefined();
    expect((written.database as Record<string, unknown>).connectionString).toBe(dbUrl);

    const dumpHits = operatorDumpHasForbiddenRefs(serializeOperatorConfigDump(written));
    expect(dumpHits).toEqual({ custom_llm_local: false, nousHermes: false, port54329: false });
    expect(dumpHits.nousHermes).toBe(false);

    const rows = await db.select().from(agents);
    const ready = rows.filter((r) => r.lifecycleState !== "terminated" && r.status !== "terminated");
    expect(ready).toHaveLength(YIE74_LIVE_ROSTER_READY_NAMES.length);
    for (const row of ready) {
      const cfg = row.adapterConfig as Record<string, unknown>;
      expect(cfg.model).toBe("fixture-model");
      if (row.name === "Atlas") expect(cfg.timeoutSec).toBe(ATLAS_FLEET_TIMEOUT_SEC);
      if (row.name === "AUDITOR") expect(cfg.timeoutSec).toBe(AUDITOR_TIMEOUT_SEC);
      if (row.name === "Steve" || row.name === "Remy") {
        expect(cfg.smartModelRouting).toEqual({ enabled: true, cheapModel: "cheap-model" });
      }
      if (row.name === "Soren") {
        expect(cfg.smartModelRouting).toEqual({ cheapModel: "cheap-model" });
        expect(Object.prototype.hasOwnProperty.call(cfg.smartModelRouting as object, "enabled")).toBe(
          false,
        );
      }
    }

  });

  it("E2E2: Postgres connect via external connectionString after tidy (health-check path)", async () => {
    const dbUrl = externalDatabaseUrl ?? tempDb!.connectionString;
    writeDriftedInstanceConfig(dbUrl);

    await applyConfigTidyV1({
      db,
      configPath,
      env: { [CONFIG_TIDY_V1_ENV]: "1" },
    });

    const written = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const connectionString = String((written.database as Record<string, unknown>).connectionString);
    expect(connectionString.length).toBeGreaterThan(0);
    expect(serializeOperatorConfigDump(written)).not.toContain(String(DEAD_EMBEDDED_POSTGRES_PORT));

    // Health-check path: open a client against the external connectionString and SELECT 1.
    const healthDb = createDb(connectionString);
    try {
      const rows = await healthDb.execute(sql`select 1::int as ok`);
      const list = Array.isArray(rows) ? rows : (rows as { rows: Array<{ ok: number }> }).rows;
      expect(Number((list[0] as { ok: number }).ok)).toBe(1);
    } finally {
      await healthDb.$client.end({ timeout: 1 });
    }
  });

  it("E2E3: smartModelRouting BOTH shapes behind flag; cutover + value equality", async () => {
    const company = await seedCompany();
    const dbUrl = externalDatabaseUrl ?? tempDb!.connectionString;
    writeDriftedInstanceConfig(dbUrl);

    const steveBefore = {
      "smartModelRouting.enabled": true,
      "smartModelRouting.cheapModel": "cheap-steve",
    };
    const remyBefore = {
      "smartModelRouting.enabled": true,
      "smartModelRouting.cheapModel": "cheap-remy",
    };
    const sorenBefore = { "smartModelRouting.cheapModel": "cheap-soren" };
    const alreadyNested = {
      smartModelRouting: { enabled: true, cheapModel: "cheap-nested" },
    };

    await seedAgent(company.id, "Steve", steveBefore);
    await seedAgent(company.id, "Remy", remyBefore);
    await seedAgent(company.id, "Soren", sorenBefore);
    await seedAgent(company.id, "Elena", alreadyNested);

    // Dual-shape read before cutover.
    expect(readSmartModelRoutingFields(steveBefore)).toEqual({
      enabled: true,
      cheapModel: "cheap-steve",
    });
    expect(readSmartModelRoutingFields(alreadyNested)).toEqual({
      enabled: true,
      cheapModel: "cheap-nested",
    });

    await applyConfigTidyV1({
      db,
      configPath,
      env: { [CONFIG_TIDY_V1_ENV]: "1" },
    });

    const rows = await db.select().from(agents);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.adapterConfig as Record<string, unknown>]));
    expect(readSmartModelRoutingFields(byName.Steve!)).toEqual({
      enabled: true,
      cheapModel: "cheap-steve",
    });
    expect(readSmartModelRoutingFields(byName.Remy!)).toEqual({
      enabled: true,
      cheapModel: "cheap-remy",
    });
    expect(readSmartModelRoutingFields(byName.Soren!)).toEqual({ cheapModel: "cheap-soren" });
    expect(readSmartModelRoutingFields(byName.Elena!)).toEqual({
      enabled: true,
      cheapModel: "cheap-nested",
    });
  });

  it("E2E4: flag-off rollback restores dotted keys + removed instance keys", async () => {
    const company = await seedCompany();
    const dbUrl = externalDatabaseUrl ?? tempDb!.connectionString;
    const drifted = writeDriftedInstanceConfig(dbUrl);

    await seedAgent(company.id, "Steve", {
      "smartModelRouting.enabled": true,
      "smartModelRouting.cheapModel": "cheap-steve",
    });
    await seedAgent(company.id, "Soren", { "smartModelRouting.cheapModel": "cheap-soren" });
    await seedAgent(company.id, "Atlas", { timeoutSec: 0, model: "fixture-model" });

    await applyConfigTidyV1({
      db,
      configPath,
      env: { [CONFIG_TIDY_V1_ENV]: "1" },
    });

    const backupPath = resolveConfigTidyBackupPath(configPath);
    expect(fs.existsSync(backupPath)).toBe(true);

    // Cutover state.
    let steve = (await db.select().from(agents)).find((r) => r.name === "Steve")!;
    expect((steve.adapterConfig as Record<string, unknown>).smartModelRouting).toEqual({
      enabled: true,
      cheapModel: "cheap-steve",
    });

    const rollback = await rollbackConfigTidyV1({
      db,
      configPath,
      env: { [CONFIG_TIDY_V1_ENV]: "0" },
    });
    expect(rollback.restored).toBe(true);
    expect(fs.existsSync(backupPath)).toBe(false);

    const restoredConfig = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(restoredConfig.adapterType).toBe(drifted.adapterType);
    expect((restoredConfig.adapterConfig as Record<string, unknown>).model).toBe(DEAD_ADAPTER_MODEL);
    expect((restoredConfig.database as Record<string, unknown>).embeddedPostgresPort).toBe(
      DEAD_EMBEDDED_POSTGRES_PORT,
    );

    const rows = await db.select().from(agents);
    steve = rows.find((r) => r.name === "Steve")!;
    const soren = rows.find((r) => r.name === "Soren")!;
    const atlas = rows.find((r) => r.name === "Atlas")!;
    expect(steve.adapterConfig).toEqual({
      "smartModelRouting.enabled": true,
      "smartModelRouting.cheapModel": "cheap-steve",
    });
    expect(soren.adapterConfig).toEqual({ "smartModelRouting.cheapModel": "cheap-soren" });
    expect(atlas.adapterConfig).toEqual({ timeoutSec: 0, model: "fixture-model" });

    // Startup helper is a no-op rollback without backup when flag off.
    const again = await runConfigTidyV1OnStartup({
      db,
      configPath,
      env: { [CONFIG_TIDY_V1_ENV]: "0" },
    });
    expect("restored" in again && again.restored).toBe(false);
  });

  it("E2E5: flag-on apply → flag-on restart → flag-off restores ORIGINAL (no backup clobber)", async () => {
    const company = await seedCompany();
    const dbUrl = externalDatabaseUrl ?? tempDb!.connectionString;
    const drifted = writeDriftedInstanceConfig(dbUrl);

    await seedAgent(company.id, "Steve", {
      "smartModelRouting.enabled": true,
      "smartModelRouting.cheapModel": "cheap-steve",
    });
    await seedAgent(company.id, "Atlas", { timeoutSec: 0, model: "fixture-model" });

    // Boot 1: flag-on apply.
    const boot1 = await applyConfigTidyV1({
      db,
      configPath,
      env: { [CONFIG_TIDY_V1_ENV]: "1" },
    });
    expect(boot1.instanceChanged).toBe(true);
    expect(boot1.agentsChanged).toBe(2);

    const backupPath = resolveConfigTidyBackupPath(configPath);
    const backupAfterBoot1 = readConfigTidyBackup(backupPath)!;
    expect(backupAfterBoot1.instanceConfigBefore).toEqual(drifted);
    expect(backupAfterBoot1.agents.map((a) => a.name).sort()).toEqual(["Atlas", "Steve"]);

    // Boot 2: flag-on restart (idempotent — nothing left to change).
    const boot2 = await applyConfigTidyV1({
      db,
      configPath,
      env: { [CONFIG_TIDY_V1_ENV]: "1" },
    });
    expect(boot2.instanceChanged).toBe(false);
    expect(boot2.agentsChanged).toBe(0);

    const backupAfterBoot2 = readConfigTidyBackup(backupPath)!;
    // Must still be the ORIGINAL drifted material — not the tidied file.
    expect(backupAfterBoot2.instanceConfigBefore).toEqual(drifted);
    expect(backupAfterBoot2.instanceConfigBefore).toMatchObject({
      adapterType: DEAD_ADAPTER_TYPE,
      adapterConfig: { model: DEAD_ADAPTER_MODEL },
      database: { embeddedPostgresPort: DEAD_EMBEDDED_POSTGRES_PORT },
    });
    expect(backupAfterBoot2.agents).toHaveLength(2);
    expect(backupAfterBoot2.agents.find((a) => a.name === "Steve")!.adapterConfig).toEqual({
      "smartModelRouting.enabled": true,
      "smartModelRouting.cheapModel": "cheap-steve",
    });
    expect(backupAfterBoot2.agents.find((a) => a.name === "Atlas")!.adapterConfig).toEqual({
      timeoutSec: 0,
      model: "fixture-model",
    });

    // Boot 3: flag-off rollback must restore ORIGINAL.
    const boot3 = await rollbackConfigTidyV1({
      db,
      configPath,
      env: { [CONFIG_TIDY_V1_ENV]: "0" },
    });
    expect(boot3.restored).toBe(true);

    const restored = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(restored.adapterType).toBe(DEAD_ADAPTER_TYPE);
    expect((restored.adapterConfig as Record<string, unknown>).model).toBe(DEAD_ADAPTER_MODEL);
    expect((restored.database as Record<string, unknown>).embeddedPostgresPort).toBe(
      DEAD_EMBEDDED_POSTGRES_PORT,
    );

    const rows = await db.select().from(agents);
    expect(rows.find((r) => r.name === "Steve")!.adapterConfig).toEqual({
      "smartModelRouting.enabled": true,
      "smartModelRouting.cheapModel": "cheap-steve",
    });
    expect(rows.find((r) => r.name === "Atlas")!.adapterConfig).toEqual({
      timeoutSec: 0,
      model: "fixture-model",
    });
  });
});
