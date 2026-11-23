---
name: railway
description: >
  Operate Railway from Paperclip Hermes agents: route between the Paperclip
  Railway connector (hosted MCP + paperclip-railway-* tools) and the host
  railway CLI, including private-database access when Postgres is not
  internet-exposed. Use whenever the task mentions Railway, deployments,
  Railway logs, Railway variables, Container SSH, railway connect, private
  networking, or DATABASE_URL on Railway.
key: paperclipai/optional/software-development/railway
recommendedForRoles:
  - engineer
  - devops
  - qa
  - ceo
tags:
  - railway
  - mcp
  - connectors
  - deploy
  - database
  - postgres
  - ssh
requires:
  - curl
---

# Railway (Paperclip Hermes)

Use this skill for Railway work inside Paperclip. Do **not** follow Cursor-only
`use-railway` / project `.cursor/skills/infra-railway` flows that assume a local
editor MCP session or that secret env values come back from connected-app
variable listings.

## Auth model (two channels)

| Channel | What it is | When you need it |
| --- | --- | --- |
| Paperclip Railway connector | OAuth via Apps → Railway; tools arrive through the run MCP gateway | Default for list/status/logs/redeploy and Container SSH `run-command` |
| Host `railway` CLI | Binary on the Paperclip host (`~/.railway/bin/railway`); separate `railway login` | Cwd deploys, IaC, `railway run` / `shell`, `railway connect --ssh` |

CLI login is **not** the same as the connector. Never paste OAuth tokens, project
tokens, or SSH private keys into prompts, issues, or skill notes.

Ensure the CLI is on PATH before shelling out:

```bash
command -v railway || { test -x "$HOME/.railway/bin/railway" && export PATH="$HOME/.railway/bin:$PATH"; }
railway whoami --json
```

If `whoami` is unauthorized and the task needs the CLI path, run
`railway login --browserless` in the background, relay the activate URL/code to
the human immediately, and wait. Do not block without surfacing the link.

## Tool routing

Prefer the Paperclip Railway connector for platform reads and controlled
mutations:

- Discovery: `paperclip-railway-list-projects`, `list-services`, `list-environments`
- Status: `service-status`, `list-deployments`, `deployment-status`
- Logs: `paperclip-railway-read-logs` / hosted bounded log tools (≤500 lines)
- Mutations: `redeploy`, `restart`, `rollback` (confirm first; treat as destructive)
- Container shell: `paperclip-railway-run-command` (privileged; see private DB)

Prefer the host **railway CLI** when the job needs local machine state:

- Deploy from cwd / create project: `railway up`, `railway up -y`, `railway up --new`
- IaC: `railway config plan` / `apply` / `pull`
- Local env injection: `railway run …`, `railway shell`
- Interactive DB client via tunnel: `railway connect <db-service> --ssh`
- Exact CLI JSON for scripts: `railway status --json`, `railway variable list` (CLI session only)

**Blocked / unavailable in Paperclip** (do not call or invent workarounds):

- Hosted `railway-agent`
- `accept-deploy`
- `paperclip-railway-deploy-revision` / source deploy binding

If a hosted MCP tool and a `paperclip-railway-*` tool overlap, prefer the
explicit `paperclip-railway-*` tool with concrete IDs.

## Context rules

1. If the user pastes a Railway dashboard URL, extract `projectId`, `serviceId`,
   and `environmentId` from it. URL IDs win over linked CLI state.
2. Pass explicit project / environment / service / deployment / instance IDs to
   connector tools. Do not thrash `railway link` unless the CLI cwd must be bound.
3. After mutations, read status or logs back before claiming success.
4. Confirm with the human before deleting services/environments/projects,
   resizing/removing volumes, overwriting production variables, or running
   destructive SQL.
5. Name the target **environment** (e.g. `test` vs `production`) before any DB
   read/write. Do not touch production unless the issue explicitly says so.

## Variables and secrets

Connected-app / hosted MCP variable tools often return **names only**
(“Values are not shown to connected apps”). Never invent `DATABASE_URL` or other
secrets from name-only listings. To use a secret:

- Run inside an app container that already has it injected (`run-command`), or
- Use a logged-in host CLI session (`railway variable` / `railway run` /
  `railway connect`), or
- Ask an operator to confirm the value via the Railway dashboard.

Never print full connection strings in issue comments. Redact passwords and
query params; prefer `select 1` / row counts over dumping rows with PII.

## Private databases

Railway Postgres is usually **private-network only**. Read
[references/private-db.md](references/private-db.md) before any DB task.

Summary: do not TCP from the Paperclip host to `*.railway.internal` or guess a
public proxy. Prefer `paperclip-railway-run-command` on a running **app** service
that already references the DB, else `railway connect <Postgres> --ssh` on the
host.

## Quick CLI cheatsheet

```bash
export PATH="$HOME/.railway/bin:$PATH"
railway whoami --json
railway status --json
railway logs -n 100 --service <service>
railway connect <PostgresService> --ssh
railway run --service <app> -- printenv DATABASE_URL >/dev/null  # verify presence only
railway config plan
```

## Don't

- Assume the DB is on the public internet
- Expect MCP `list-variables` to return secret values
- Call blocked Railway agent / accept-deploy / deploy-revision tools
- Paste tokens, private keys, or full `DATABASE_URL` into chat or issues
- Use production DB for exploratory queries without explicit task approval
