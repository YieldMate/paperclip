# Hermes cost backfill and Portal reconciliation (2026-11-07)

Operator notes for recovering early-November Hermes spend gaps and aligning Month Spend with Nous Portal.

## Prerequisites

- Paperclip board access for the company.
- Hermes worker build that includes Nous dated-model pricing fallbacks in `agent/usage_pricing.py` (DeepSeek `…-YYYYMMDD` → OpenRouter/bundled rates). Redeploy Hermes before expecting new heartbeats to price DeepSeek traffic.
- `sqlite3` CLI for the dump script.

## Hermes session_model_usage → estimated cost_events

1. Dump rows from the agent’s Hermes `state.db` (UTC window):

```sh
node scripts/hermes-usage-backfill-dump.mjs \
  --db ~/.hermes/state.db \
  --from 2026-11-01T00:00:00.000Z \
  --to 2026-11-08T00:00:00.000Z \
  > /tmp/hermes-nov-rows.json
```

2. Dry-run (default) against Paperclip:

```sh
curl -sS -X POST "$PAPERCLIP_API/api/companies/$COMPANY_ID/accounting/hermes-usage-backfill" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg agentId "$AGENT_ID" \
    --arg from "2026-11-01T00:00:00.000Z" \
    --arg to "2026-11-08T00:00:00.000Z" \
    --slurpfile rows /tmp/hermes-nov-rows.json \
    '{agentId:$agentId, from:$from, to:$to, dryRun:true, rows:$rows[0]}')"
```

3. Apply with `"dryRun": false` after reviewing `wouldInsert` / skip reasons.
   - Idempotent keys: `hermes-backfill:session:…`
   - Never overwrites non-zero `reported` rows for the same agent+model+day
   - Skips days with pending run accounting

## Nous Portal CSV → finance events

CSV columns: `day,amount_usd[,description[,kind]]` where `kind` is one of
`inference|fee|credit|tools|hosting|other`.

```sh
curl -sS -X POST "$PAPERCLIP_API/api/companies/$COMPANY_ID/accounting/nous-portal/import-csv" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg csv "$(cat portal-nov.csv)" --arg id "portal-2026-11" \
    '{csv:$csv, externalId:$id, dryRun:true}')"
```

Portal spend appears on the Dashboard Month Spend card and Costs overview as
**Portal $X · known ledger $Y**. It does **not** reprice heartbeat `cost_events`.

## Semantics

| Surface | Meaning |
|---------|---------|
| Month Spend (known) | Sum of priced `cost_events` for the UTC month |
| Unpriced / pending | Inference usage not yet valued or not yet settled |
| Portal | Imported Portal bill (tools + hosting + inference) |
