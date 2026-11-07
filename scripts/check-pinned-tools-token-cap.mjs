#!/usr/bin/env node
// CI job `pinned-tools-token-cap` (YIE-70): every overlays/**/pinned-tools.json must stay within the
// hot-tool-pinning caps (10 tools, 10,000 schema tokens).
//
//   node scripts/check-pinned-tools-token-cap.mjs [overlays-dir-or-manifest ...]
//        [--engine auto|hermes|node] [--hermes-dir <path>] [--require-tiktoken] [--allow-missing-schemas]
//
// Engines:
//   hermes  Shell out to hermes-agent's scripts/ci/pinned_tools_token_cap.py (cl100k_base via tiktoken).
//   node    Built-in estimate of the same wire shape ({"type":"function","function":schema}, Python
//           json.dumps spacing) at chars/4, matching Hermes' no-tiktoken fallback. No tiktoken
//           dependency exists in this repo, so this is a lower-bound estimate; it fails loudly on tools
//           that carry no schema because their size cannot be checked.
//   auto    hermes when ../hermes-agent (or --hermes-dir / HERMES_AGENT_DIR) holds the script and runs,
//           otherwise node.
// Exit codes: 0 ok / nothing found, 1 over a cap, 2 unreadable manifest, missing schema or tool failure.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MAX_PINNED_TOOLS = 10;
export const MAX_PINNED_SCHEMA_TOKENS = 10_000;
export const MANIFEST_NAME = "pinned-tools.json";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function pyString(value) {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Python `json.dumps`-compatible serialization (", " and ": " separators, ASCII-escaped). */
export function pyJsonDumps(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return pyString(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(pyJsonDumps).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${pyString(k)}: ${pyJsonDumps(v)}`)
      .join(", ")}}`;
  }
  return "null";
}

export function estimateSchemaTokens(schema) {
  return Math.ceil(pyJsonDumps({ type: "function", function: schema }).length / 4);
}

function functionSchema(entry) {
  const schema = entry.schema;
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    return schema.function && typeof schema.function === "object" ? schema.function : schema;
  }
  return null;
}

export function findManifests(paths, cwd = process.cwd()) {
  const roots = paths.length > 0
    ? paths.map((p) => path.resolve(cwd, p))
    : [path.resolve(process.env.PAPERCLIP_OVERLAYS_ROOT || path.join(repoRoot, "overlays"))];
  const found = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === MANIFEST_NAME) found.add(full);
    }
  };
  for (const root of roots) {
    if (!existsSync(root)) continue;
    if (statSync(root).isFile()) found.add(root);
    else walk(root);
  }
  return [...found].sort();
}

/** Token budget for one manifest. Throws on unreadable JSON or malformed entries. */
export function measureManifest(manifest) {
  const data = JSON.parse(readFileSync(manifest, "utf8").replace(/^\uFEFF/, ""));
  const items = Array.isArray(data) ? data : data?.tools;
  if (!Array.isArray(items)) throw new Error(`${manifest}: expected a tools list`);
  const perTool = {};
  const unsized = [];
  for (const item of items) {
    const entry = typeof item === "string" ? { name: item } : item;
    if (!entry || typeof entry !== "object" || typeof entry.name !== "string" || !entry.name.trim()) {
      throw new Error(`${manifest}: tool entries need a string name`);
    }
    const schema = functionSchema(entry);
    if (schema) perTool[entry.name] = estimateSchemaTokens(schema);
    else unsized.push(entry.name);
  }
  const tokens = Object.values(perTool).reduce((sum, n) => sum + n, 0);
  return {
    manifest,
    agent: path.basename(path.dirname(manifest)),
    toolCount: items.length,
    tokens,
    perTool,
    unsized,
  };
}

export function evaluateBudget(budget, { allowMissingSchemas = false } = {}) {
  const problems = [];
  if (budget.toolCount > MAX_PINNED_TOOLS) {
    problems.push(`${budget.toolCount} tools exceed the cap of ${MAX_PINNED_TOOLS}`);
  }
  if (budget.tokens > MAX_PINNED_SCHEMA_TOKENS) {
    problems.push(`${budget.tokens} schema tokens exceed the cap of ${MAX_PINNED_SCHEMA_TOKENS}`);
  }
  const missing = !allowMissingSchemas && budget.unsized.length > 0
    ? `no schema for ${budget.unsized.join(", ")}; the token cap cannot be verified`
    : null;
  return { problems, missing };
}

function runNode(manifests, { allowMissingSchemas }) {
  if (manifests.length === 0) {
    console.log("pinned-tools-token-cap: no pinned-tools.json manifests found");
    return 0;
  }
  let status = 0;
  for (const file of manifests) {
    let budget;
    try {
      budget = measureManifest(file);
    } catch (err) {
      console.error(`pinned-tools-token-cap: ${err.message}`);
      return 2;
    }
    const { problems, missing } = evaluateBudget(budget, { allowMissingSchemas });
    const label = problems.length > 0 ? "OVER CAP" : "ok";
    console.log(`${label}: ${budget.agent} (${file}) ${budget.toolCount} tools, ${budget.tokens}/${MAX_PINNED_SCHEMA_TOKENS} tokens (estimate)`);
    for (const problem of problems) console.log(`    ${problem}`);
    if (problems.length > 0) {
      for (const [name, n] of Object.entries(budget.perTool).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${String(n).padStart(6)}  ${name}`);
      }
      status = Math.max(status, 1);
    }
    if (missing) {
      console.error(`pinned-tools-token-cap: ${file}: ${missing}`);
      status = 2;
    }
  }
  return status;
}

function hermesScript(hermesDir) {
  const script = path.join(hermesDir, "scripts", "ci", "pinned_tools_token_cap.py");
  return existsSync(script) ? script : null;
}

/** Hermes' verdict (exit 0/1 with a report on stdout), or `usable: false` when the script itself crashed. */
function runHermes(script, manifests, { requireTiktoken }) {
  const args = [script, ...manifests, ...(requireTiktoken ? ["--require-tiktoken"] : [])];
  const result = spawnSync(process.env.PYTHON || "python3", args, {
    cwd: path.dirname(path.dirname(path.dirname(script))),
    encoding: "utf8",
  });
  const status = result.error ? 2 : (result.status ?? 2);
  const reported = (status === 0 || status === 1) && /^(ok|OVER CAP): /m.test(result.stdout || "");
  return { status, reported, stdout: result.stdout || "", stderr: result.stderr || String(result.error ?? "") };
}

export function parseArgs(argv) {
  const opts = {
    paths: [],
    engine: "auto",
    hermesDir: process.env.HERMES_AGENT_DIR || path.resolve(repoRoot, "..", "hermes-agent"),
    requireTiktoken: false,
    allowMissingSchemas: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--engine") opts.engine = argv[++i];
    else if (arg === "--hermes-dir") opts.hermesDir = path.resolve(argv[++i]);
    else if (arg === "--require-tiktoken") opts.requireTiktoken = true;
    else if (arg === "--allow-missing-schemas") opts.allowMissingSchemas = true;
    else opts.paths.push(arg);
  }
  if (!["auto", "hermes", "node"].includes(opts.engine)) {
    throw new Error(`unknown --engine ${opts.engine}`);
  }
  return opts;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const manifests = findManifests(opts.paths);
  const script = opts.engine === "node" ? null : hermesScript(opts.hermesDir);
  if (opts.engine === "hermes" && !script) {
    console.error(`pinned-tools-token-cap: hermes script not found under ${opts.hermesDir}`);
    return 2;
  }
  if (script) {
    if (manifests.length === 0) {
      console.log("pinned-tools-token-cap: no pinned-tools.json manifests found");
      return 0;
    }
    const hermes = runHermes(script, manifests, opts);
    if (opts.engine === "hermes" || hermes.reported) {
      process.stdout.write(hermes.stdout);
      process.stderr.write(hermes.stderr);
      return hermes.status;
    }
    const detail = hermes.stderr.trim().split("\n").pop() || `exit ${hermes.status}`;
    console.error(`pinned-tools-token-cap: hermes check unavailable (${detail}); falling back to the node estimate`);
  }
  return runNode(manifests, opts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
