# Config drift tidy v1 (YIE-74)

Flag-gated tidy for the YieldMate live instance config drift: dead adapter
defaults, unused `embeddedPostgresPort` on external Postgres, dotted → nested
`smartModelRouting`, and Atlas `timeoutSec: 0` → `20000`.

## Flag

```bash
PAPERCLIP_CONFIG_TIDY_V1=1
```

Alias (Steve r2): `CONFIG_TIDY_V1=true`

**Default: OFF.** Do not enable on paperclip1 without coordinator OK.

## Behavior (flag ON)

1. **Instance config.json** (raw file, no zod re-default of port):
   - Remove `adapterType: custom_llm_local` and `model: nous-hermes-3-llama-3-70b`
     (top-level or under `llm`) when those exact dead values are present.
   - When `database.connectionString` is set (or `database.mode === "postgres"`),
     remove `database.embeddedPostgresPort`.
2. **Per-agent adapterConfig**:
   - Migrate `smartModelRouting.*` dotted keys → nested `smartModelRouting` object.
   - Partial keys preserved: Soren (`cheapModel` only, no `enabled`) stays without
     an `enabled` key (absent stays absent).
   - Atlas with `timeoutSec: 0` → `20000`. AUDITOR `8000` is untouched.
3. Backup written beside config as `config.tidy-v1.backup.json` for rollback.
4. Read path already supports **both** dotted and nested shapes
   (`cfgSmartModelRouting` in the Hermes adapter); migration cutover is flag-on.

## What this does NOT do

- Does **not** delete the embedded-postgres code path used by local/CLI/tests
  (`server/src/index.ts`, worktree sibling ports, CLI onboard, packages/db
  defaults, etc.). That path remains load-bearing for OSS.
- Does **not** set `adapterConfig.cwd` / `workspaceDir` (STRUCK — YIE-69).

## Rollback (flag OFF)

Unset or set `PAPERCLIP_CONFIG_TIDY_V1=0` and restart:

1. Restores the pre-tidy instance `config.json` from `config.tidy-v1.backup.json`.
2. Restores each migrated agent's `adapterConfig` (dotted smartModelRouting +
   prior Atlas timeout).
3. Deletes the backup file after a successful restore.
4. Agents start without credential/toolset errors; no residual tidy state.

## CI / Corin spot-check

Assert **operator-facing tidied config dumps** contain zero of:

- `custom_llm_local`
- `nous-hermes-3-llama-3-70b`
- `54329`

Do **not** require zero hits across the whole repository (54329 remains the
embedded-postgres default for local/CLI/tests).

## Measurement

- Startup log: `YIE-74 config tidy v1 applied` with
  `instanceChanged` / `agentsChanged` / `terminatedTolerated`.
- Smart-routing behaviour for Steve/Remy unchanged post-migration (Hermes
  dual-shape read; nested wins when both present during transition).
