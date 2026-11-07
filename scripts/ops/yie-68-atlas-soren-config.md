# YIE-68 config decisions (Atlas timeoutSec, Soren Anthropic)

Elena's decisions applied under YIE-68 scope. These are **live instance agent
config** changes on `paperclip1.agents.yieldmate.co` — not repo defaults.

Do **not** probe or mutate shared config from CI scratch tests. Apply once as
an operator (board session or authenticated API), then verify from production
telemetry on the next real runs (Corin QA gate / YIE-131).

## Atlas — `timeoutSec: 20000`

Atlas currently carries `timeoutSec: 0` (unlimited). Set a deliberate finite
value aligned with peer agents:

```bash
# Authenticated board/API session required. Replace AGENT_ID.
curl -sS -X PATCH "https://paperclip1.agents.yieldmate.co/api/agents/${ATLAS_AGENT_ID}" \
  -H "Authorization: Bearer ${PAPERCLIP_BOARD_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"adapterConfig":{"timeoutSec":20000}}'
```

## Soren — Anthropic / `claude-sonnet-5.5` credentials

Soren had "No Anthropic credentials" failures. Ensure provider + model + secret:

```bash
curl -sS -X PATCH "https://paperclip1.agents.yieldmate.co/api/agents/${SOREN_AGENT_ID}" \
  -H "Authorization: Bearer ${PAPERCLIP_BOARD_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "adapterConfig": {
      "provider": "anthropic",
      "model": "claude-sonnet-5.5",
      "env": {
        "ANTHROPIC_API_KEY": {"type":"secret_ref","secretId":"'"${SOREN_ANTHROPIC_SECRET_ID}"'","version":1}
      }
    }
  }'
```

Use the instance's existing Anthropic secret id (do not paste raw keys into
chat, tickets, or this file). Confirm `provider`/`model` match what Hermes
expects for Anthropic Sonnet 5.5.

## Verification (telemetry only — never probe)

- Next Atlas run: no exit-2 from unknown toolsets; `timeoutSec` logged as 20000.
- Next Soren run: authenticates (no "No Anthropic credentials" error).
