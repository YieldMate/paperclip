# YIE-74 self-review / bugbot notes

`/review-bugbot` is not attached to Project workers. Self-review against the
YIE-72 tip base. Committed so reviewers can see it on the branch.

Branch: `cursor/yie-74-config-drift-tidy-7e52`  
Base: YIE-72 tip `920e49fdc1c37bd1fd2cd500c6600301cc72f4a7`

## Scope check

| Item | Status |
|------|--------|
| Dead adapter defaults strip (`custom_llm_local` / `nous-hermes-3-llama-3-70b`) | Done — raw instance config tidy |
| `embeddedPostgresPort` strip when external `connectionString` | Done — operator dump only |
| Keep OSS embedded-postgres path | Done — not deleted |
| smartModelRouting dotted → nested; Soren no invented `enabled` | Done |
| Dual-shape read | Done (`readSmartModelRoutingFields` + existing Hermes `cfgSmartModelRouting`) |
| Atlas `timeoutSec` 0 → 20000; AUDITOR 8000 | Done |
| Flag `PAPERCLIP_CONFIG_TIDY_V1` default OFF + rollback backup | Done |
| cwd / workspaceDir | STRUCK — not touched |
| 4 mandatory E2Es | Done — 13 tests green |

## Findings

### F1 — Steve r2 module anchors were fictional (info / documented)

r2 named `packages/config`, `packages/worktree`, `apps/api` / `startEmbeddedPostgres`. Real load-bearing path is `server/src/{config,index,worktree-config}.ts` + CLI/db defaults. Posted as Linear erratum; carve: do not gut OSS.

### F2 — Zod default would re-inject 54329 (mitigated)

`packages/shared` schema defaults `embeddedPostgresPort` to 54329 on parse. Tidy writes **raw JSON** (no re-parse) so the operator-facing file can omit the key. CI asserts on that dump, not whole-repo grep.

### F3 — Agent updates bypass lifecycle transaction (accepted)

Startup apply uses direct `agents.adapterConfig` update (same class as other boot reconcilers). Rollback restores from `config.tidy-v1.backup.json`.

### F4 — Dual-shape read is always-on in Hermes execute (ok)

Spec said “behind the flag”; Hermes already reads both shapes. Flag gates the **write cutover / rollback**.

## Residual risks

- Enabling on paperclip1 without coordinator OK would rewrite live config + agent rows (backup exists; still needs a planned window).
- Flag-off restores the **original** backup, not intermediate post-tidy hand edits.

## Verdict

**Ship to In Review** (no deploy / no `PAPERCLIP_CONFIG_TIDY_V1=1`).
