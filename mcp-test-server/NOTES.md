# mcp-test-server — reference notes

**Server A** of the FR2-MERCH-08 Faza 0 pair — SDK-based, **stateful** (pre-`2026-07-28`)
protocol: `initialize` handshake, `Mcp-Session-Id` header. Its sibling, `../mcp-test-server-stateless/`,
is Server B (hand-built `2026-07-28` stateless emulation — see that folder's `NOTES.md` for why).

Local test MCP server for the FR2-MERCH-08 (`AMS-CORE-API`) work. Not part of that repo —
standalone Node.js project for manual protocol verification, sitting outside all git repos on
purpose (see Ahoy-root discussion with the user, 2026-08-11).

## Public URL (ngrok)

`https://deviate-moonlight-repulsion.ngrok-free.dev`

This is this account's one reserved free static domain — **stable across restarts** as long as
you always point it at Server A (port 3000). Started with:

```bash
ngrok http 3000
```

**Important — this ngrok account/plan supports only one public hostname at a time, full stop.**
Confirmed 2026-08-11: even a solo tunnel with no domain specified still silently grabs this same
reserved domain — there's no free "random subdomain" fallback on this account. Do not run a
second `ngrok http ...` for Server B expecting a different URL; it will silently steal routing
for this same hostname instead of erroring, and `curl` against it will start hitting whichever
tunnel started last. Server B (`../mcp-test-server-stateless/`) uses **Cloudflare Tunnel**
instead — see its own `NOTES.md`. If you ever need a second simultaneous ngrok hostname, that
requires a paid ngrok plan (more reserved domains / multiple online endpoints), not a config
change.

## Running it

```bash
cd mcp-test-server
npm install         # first time only
node index.js       # listens on http://localhost:3000/mcp
ngrok http 3000      # separate terminal — exposes it publicly
```

Requires an ngrok account + authtoken (`ngrok config add-authtoken <token>`, one-time setup).

## Tools

Mirrored on Server B (`../mcp-test-server-stateless/`) under the same names, so the same
`pricing-config.json` and billing-test suite exercise both protocol eras identically.

| Tool | Purpose |
|---|---|
| `get_time` | Fast, non-streamed. Baseline "does the round trip work" check. **Not** in `pricing-config.json` — exercises the "valid tool, no price configured" unbilled path (spec §11). |
| `search` | Fake cheap lookup, takes `query: string`. Priced **$0.05**/call. |
| `generate_report` | Fake mid-cost tool, takes `topic: string`. Priced **$0.50**/call. |
| `run_heavy_task` | Long-running, priced **$1.00**/call. Takes `durationSeconds` (default 10, max 300) — push it near APIM's ~4-minute idle-connection ceiling (spec §2.1/§13) to test keepalive. Emits an MCP `notifications/progress` event per tick, one per second, when the caller sends `_meta.progressToken` — used to verify streaming survives whatever proxy sits in front (ngrok here, APIM later) instead of buffering into one deferred response. |

## Manual test sequence (curl)

MCP over Streamable HTTP is session-based here: `initialize` returns an `mcp-session-id`
response header that every subsequent request on that session must echo back.

```bash
# 1. initialize — capture the mcp-session-id response header
curl -sS -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -D headers.txt \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'

SID=$(grep -i mcp-session-id headers.txt | tr -d '\r' | awk '{print $2}')

# 2. notifications/initialized (required handshake step)
curl -sS -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3. tools/call — search, a priced tool
curl -sS -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"query":"test"}}}'

# 4. tools/call — run_heavy_task, with a progressToken to see the streamed ticks
curl -sS -N -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"run_heavy_task","arguments":{"durationSeconds":3},"_meta":{"progressToken":"p1"}}}'
```

`headers.txt` is a throwaway curl artifact — delete it after each run, don't commit it (this
folder isn't in git, but keep the habit).

Verified locally: progress events arrive one per second (not as a single response at the end).

## `pricing-config.json`

Sample `PerToolCallPricingConfig` (spec §3.1) shared with Server B, so a single test config
exercises billing identically regardless of which protocol the merchant server speaks.

## `simulate-metering.js`

Standalone script — no server needed. Simulates the full billing decision from spec §11 that
`ApimPolicyBuilder`'s inbound MCP policy is supposed to make: parses the JSON-RPC body,
cross-validates it against `Mcp-Method`/`Mcp-Name` headers when present (never trusts the header
alone), looks up the tool's price in `pricing-config.json`, and classifies the result as billed /
unpriced (benign) / `header_body_mismatch` or `parse_failure` (genuine integrity issue). Covers
both protocol eras — samples with no headers (stateful) and with headers, including a
deliberately malicious mismatch (client under-reporting via the header while calling an
expensive tool in the body).

```bash
node simulate-metering.js
```

## For the E2E team / colleague

- New request/response fields to expect once `AMS-CORE-API`'s FR2-MERCH-08 branch lands:
  `Service.McpConfiguration` (`BaseUrl`, `TimeoutSeconds`, rate-limit trio, `ForwardedHeaders`)
  and `Service.PerToolCallPricingConfig` (`ToolPrices: [{ToolName, PricePerCall}]`), surfaced as
  DTOs on create/update requests and on `ServiceResponse`.
- This server (or its ngrok URL, while running) is a stable target for
  `mcp-service-lifecycle.spec.ts`-style E2E tests: register a service with
  `ServiceType: "Mcp"` and `McpConfiguration.BaseUrl` pointing at it, `PricingModel: "PerToolCall"`
  with `PerToolCallPricingConfig` matching `pricing-config.json`.
- APIM-level behavior (real registration via `RegisterMcpAsync`, the actual policy, Event Hub
  delivery) cannot be verified from this local setup — there's no local APIM emulator. That still
  needs a real dev-environment pass (Faza 2/3/4 of the onboarding plan).
- Server B (`../mcp-test-server-stateless/`) is the required second POC target per spec
  Acceptance Criteria §14 — "POC explicitly includes a test MCP server running protocol
  `2026-07-28`."
