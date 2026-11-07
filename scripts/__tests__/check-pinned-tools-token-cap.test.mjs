import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  estimateSchemaTokens,
  evaluateBudget,
  findManifests,
  measureManifest,
  pyJsonDumps,
} from "../check-pinned-tools-token-cap.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "check-pinned-tools-token-cap.mjs");

function overlay(tools) {
  const root = mkdtempSync(path.join(tmpdir(), "pinned-cap-"));
  mkdirSync(path.join(root, "agent-1"));
  writeFileSync(path.join(root, "agent-1", "pinned-tools.json"), JSON.stringify({ version: 1, tools }));
  return root;
}

const tool = (name, description = "d") => ({ name, callCount: 1, schema: { name, description, parameters: {} } });

function run(root, ...args) {
  return spawnSync(process.execPath, [script, root, "--engine", "node", ...args], { encoding: "utf8" });
}

test("serializes like Python json.dumps so token estimates match Hermes' fallback", () => {
  const schema = { description: "é ü \u2603 \"q\"" };
  assert.equal(pyJsonDumps({ type: "function", function: schema }).length, 79);
  assert.equal(estimateSchemaTokens(schema), 20);
});

test("committed example overlay is well under the cap", () => {
  const [manifest] = findManifests([path.join(path.dirname(script), "..", "overlays")]);
  const budget = measureManifest(manifest);
  assert.ok(budget.tokens > 0 && budget.tokens < 1000);
  assert.deepEqual(evaluateBudget(budget), { problems: [], missing: null });
});

test("passes an agent under both caps", () => {
  const root = overlay([tool("a"), tool("b")]);
  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^ok: agent-1/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails over the 10k token cap and lists per-tool sizes", () => {
  const root = overlay([tool("big", "x".repeat(41_000))]);
  try {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /OVER CAP: agent-1/);
    assert.match(result.stdout, /exceed the cap of 10000/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails with more than 10 tools", () => {
  const root = overlay(Array.from({ length: 11 }, (_, i) => tool(`t${i}`)));
  try {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /11 tools exceed the cap of 10/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails loudly when a tool has no schema unless explicitly allowed", () => {
  const root = overlay([tool("a"), { name: "no_schema", callCount: 1 }]);
  try {
    const strict = run(root);
    assert.equal(strict.status, 2);
    assert.match(strict.stderr, /no schema for no_schema/);
    assert.equal(run(root, "--allow-missing-schemas").status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unreadable manifests exit 2; an empty overlays dir passes", () => {
  const bad = mkdtempSync(path.join(tmpdir(), "pinned-cap-bad-"));
  try {
    mkdirSync(path.join(bad, "agent-1"));
    writeFileSync(path.join(bad, "agent-1", "pinned-tools.json"), "{nope");
    assert.equal(run(bad).status, 2);
    rmSync(path.join(bad, "agent-1"), { recursive: true });
    const empty = run(bad);
    assert.equal(empty.status, 0);
    assert.match(empty.stdout, /no pinned-tools.json manifests found/);
  } finally {
    rmSync(bad, { recursive: true, force: true });
  }
});
