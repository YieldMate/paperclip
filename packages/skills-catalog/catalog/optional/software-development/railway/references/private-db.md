# Private Railway database access

## Why direct TCP fails

Managed Postgres on Railway typically listens on the **private** network
(`*.railway.internal`). The Paperclip host is outside that network. Unless an
operator created a public TCP proxy for the database service, connections from
this VM to the DB host/port will time out or refuse. Agents must not “fix”
this by inventing public hostnames or enabling proxies without approval.

Hosted MCP / connected-app variable tools usually return **names only**, so you
cannot build a working `DATABASE_URL` from MCP output alone.

## Preferred path A — Container SSH via Paperclip connector

Use when Container access is enrolled on the Paperclip Railway connection
(Permissions → Container access: Ed25519 key registered in Railway + verified
`ssh.railway.com` known_hosts). Tool: `paperclip-railway-run-command`.

1. Resolve IDs with connector list/status tools:
   - workspace → project → environment → **app** service (e.g. `api`) that
     already has `DATABASE_URL` (or `${{Postgres.DATABASE_URL}}`) injected
   - pick a **running** deployment and its **instance** ID (SSH username)
2. Run a short noninteractive command (≤60s, ≤64 KiB output), for example:

```sh
# presence check only — do not echo the full URL into logs/comments
test -n "$DATABASE_URL" && echo DATABASE_URL_set=yes
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c 'select 1 as ok;'
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c 'select current_database(), current_user;'
```

3. Prefer app-native commands when they exist (Prisma migrate status, health
   scripts) over ad-hoc SQL.
4. Target the **app** container, not the Postgres plugin container, unless you
   have a documented reason. The app already has network + credentials.

If `run-command` fails with SSH / host-key / enrollment errors: stop and ask an
operator to finish Container access setup. Do not disable host-key checks.

## Preferred path B — Host CLI tunnel

Use when the host `railway` CLI is installed and `railway whoami` succeeds, and
local `psql` (or the matching client) is available.

```bash
export PATH="$HOME/.railway/bin:$PATH"
railway whoami --json
# Force the SSH tunnel when there is no public TCP proxy:
railway connect <PostgresServiceNameOrId> --ssh \
  --project <projectId> \
  --environment <environmentNameOrId>
```

`railway connect` opens the DB client through Railway’s tunnel. Default behavior
tries a public TCP proxy first and falls back to SSH; use `--ssh` for private
DBs. Use `--no-ssh` only when a public proxy is known to exist.

Noninteractive one-shot via an app service:

```bash
railway run --service <appService> --project <projectId> --environment <env> -- \
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c 'select 1;'
```

## Path C — Evidence without live SQL

When neither Container SSH nor CLI login is available:

- Bounded deploy/runtime logs via connector (`read-logs`)
- CI e2e / migration job output from the repo
- Ask an operator to enroll Container access or complete `railway login --browserless`

Do not block the issue claiming the DB is unreachable without stating which of
A/B/C you tried and what failed.

## Safety

- Default to the **test** / non-production environment unless the issue names
  production.
- Confirm before `DROP`/`TRUNCATE`/destructive migrations.
- Redact credentials in comments; never paste full `DATABASE_URL`.
- `run-command` is privileged: it can read secrets and reach private network
  peers. Keep commands minimal and on-task.
