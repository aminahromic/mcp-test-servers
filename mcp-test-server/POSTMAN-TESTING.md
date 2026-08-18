# Testing `mcp-test-server` Through Postman

## Server under test

**`mcp-test-server` — STATEFUL.**

This is the session-based Streamable HTTP MCP server. It:

- Requires an `initialize` handshake before anything else. The server returns an
  `Mcp-Session-Id` response header on `initialize`, and **every subsequent request
  must echo that header back**.
- Enforces auth at the merchant-backend layer (`X-AMS-Auth`, an APIM-minted RS256
  JWT) — you never set this yourself, see [Authentication model](#authentication-model)
  below.
- Exposes 4 tools: `get_time`, `search`, `generate_report`, `run_heavy_task`.

Two sibling folders (`../mcp-test-server-stateless`, `../mcp-test-server-standard-stateless`)
contain **stateless** variants with different behavior. Don't mix up their instructions with
this document — see the [comparison table](#appendix-comparison-with-sibling-test-servers) at
the bottom if you need to test those instead.

## Authentication model

Two different keys exist in this system, at two different layers — do not confuse them:

| Layer | Header | Who sets it | Value |
|---|---|---|---|
| Client → APIM gateway | `X-AMS-Api-Key` | **You**, in Postman | Your consumer API key (`ams_k_...`) |
| APIM → this server | `X-AMS-Auth` | **APIM**, automatically | Short-lived RS256 JWT, minted after APIM validates your `X-AMS-Api-Key` |

You will only ever set `X-AMS-Api-Key`. If you call this server's URL directly (bypassing
APIM/ngrok — e.g. hitting `localhost` or the raw ngrok URL instead of the gateway URL), it will
reject you with `Missing or malformed X-AMS-Auth header`, because only APIM can produce a valid
`X-AMS-Auth` JWT. Always go through the gateway URL for end-to-end tests.

## Prerequisites

- Node.js and npm installed
- Dependencies installed in this folder: run `npm install` from inside `mcp-test-server/` once
- A Postman desktop app, connected to this local workspace folder
- An AMS consumer API key (`ams_k_...`) scoped to the MCP service you'll create below

All commands below are written to be run **from inside the `mcp-test-server/` folder**
(i.e. `cd mcp-test-server` first, or open a terminal there).

---

## Step 1 — Install and initialize ngrok

```bash
brew install ngrok
```

Sign up at https://dashboard.ngrok.com/signup, then copy your authtoken from
https://dashboard.ngrok.com/get-started/your-authtoken and run:

```bash
ngrok config add-authtoken <YOUR_AUTHTOKEN>
```

This writes the token to `~/Library/Application Support/ngrok/ngrok.yml`. You only need to do
this once per machine.

## Step 2 — Start `mcp-test-server` locally

Port 3000 is commonly already taken by other local services (e.g. a Next.js dev server) — use
3002 to avoid collisions:

```bash
PORT=3002 node index.js
```

You should see:

```
mcp-test-server (stateful) listening on http://localhost:3002/mcp
```

Leave this running. Open a **new terminal tab** for the next steps.

## Step 3 — Expose it via ngrok

```bash
ngrok http 3002
```

Copy the `https://....ngrok-free.dev` (or `.ngrok-free.app`) forwarding URL ngrok prints —
this is your **backend base URL**, e.g.:

```
https://deviate-moonlight-repulsion.ngrok-free.dev
```

Leave this running too. Open a **third terminal tab** if you still need one, or move on to
the dashboard.

## Step 4 — Register it as an AMS service and get a scoped API key

1. Open the AMS-WEB merchant dashboard and go to **Services → New Service**.
2. Set:
   - **Service Type**: `MCP`
   - **Backend Base URL**: the ngrok URL from Step 3 (e.g.
     `https://deviate-moonlight-repulsion.ngrok-free.dev`)
   - **Pricing Model**: `PerToolCall`, with per-tool prices matching `pricing-config.json` in
     this folder if you want billing behavior to match what the test server expects
     (`search` $0.05, `generate_report` $0.50, `run_heavy_task` $1.00; leave `get_time`
     unpriced — it's deliberately excluded from `pricing-config.json` to exercise the
     unbilled-tool path)
3. Submit the service. It needs **Admin approval** before AMS registers it in APIM — check
   with whoever administers your AMS-dev environment if it doesn't go live.
4. Once approved, note the **gateway URL** APIM assigns, of the form:
   ```
   https://ams-dev-apim.azure-api.net/<your-service-slug>/mcp
   ```
5. Go to **API Keys → New API Key**, scope it to include this new service, and copy the
   generated key (`ams_k_...`) — it's shown only once.

You now have everything needed for Postman: the **gateway URL** and the **API key**.

---

## Step 5 — Set up Postman

### 5a. Create an environment

In Postman, create a new Environment (e.g. "AMS Dev — mcp-test-server") with these variables:

| Variable | Initial value |
|---|---|
| `gateway_url` | `https://ams-dev-apim.azure-api.net/<your-service-slug>/mcp` |
| `api_key` | `ams_k_...` (your key from Step 4.5 — store this in **Vault**, not plain text, if your Postman plan supports it) |
| `session_id` | *(leave empty — filled automatically by Request 1)* |

Select this environment from the top-right environment dropdown before sending any request.

### 5b. Create a collection

Create a new Collection (e.g. `mcp-test-server`) and add the four requests below, in order.
**Order matters** — `initialize` must run first (it creates the session), the
`notifications/initialized` handshake should run second, and only then can you call
`tools/list` or `tools/call`.

---

### Request 1 — `MCP Initialize`

| Setting | Value |
|---|---|
| Method | `POST` |
| URL | `{{gateway_url}}` |

**Headers:**

| Key | Value |
|---|---|
| `Content-Type` | `application/json` |
| `Accept` | `application/json, text/event-stream` |
| `X-AMS-Api-Key` | `{{api_key}}` |

**Body** → raw → JSON:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": { "name": "postman", "version": "1.0.0" }
  }
}
```

**Scripts tab → Post-response**, add this so the session ID is captured automatically:

```javascript
pm.environment.set("session_id", pm.response.headers.get("Mcp-Session-Id"));
```

Send it. Expected response is a `text/event-stream` body containing a `result` with
`protocolVersion`, `capabilities`, and `serverInfo`. Confirm `{{session_id}}` got set by
checking the environment quick-look (eye icon, top right).

---

### Request 2 — `MCP Initialized`

This is a required handshake notification — it has no `id` field and expects no meaningful
response body.

| Setting | Value |
|---|---|
| Method | `POST` |
| URL | `{{gateway_url}}` |

**Headers:** same three as Request 1, **plus**:

| Key | Value |
|---|---|
| `Mcp-Session-Id` | `{{session_id}}` |

**Body** → raw → JSON:

```json
{ "jsonrpc": "2.0", "method": "notifications/initialized" }
```

---

### Request 3 — `MCP Tools List`

| Setting | Value |
|---|---|
| Method | `POST` |
| URL | `{{gateway_url}}` |

**Headers:** identical to Request 2 (including `Mcp-Session-Id: {{session_id}}`).

**Body** → raw → JSON:

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }
```

Expected response: a `tools` array listing `get_time`, `search`, `generate_report`, and
`run_heavy_task`, each with its `inputSchema`.

---

### Request 4 — `MCP Tool Call`

Same headers as Request 3. Swap the body depending on which tool you're testing:

**`search`** (cheap, $0.05/call):

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": { "name": "search", "arguments": { "query": "test" } }
}
```

**`generate_report`** (mid-cost, $0.50/call):

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": { "name": "generate_report", "arguments": { "topic": "quarterly sales" } }
}
```

**`get_time`** (free, no arguments):

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": { "name": "get_time", "arguments": {} }
}
```

**`run_heavy_task`** (expensive, $1.00/call — streams a `notifications/progress` event once
per second; useful for checking APIM's ~4-minute idle-connection ceiling doesn't kill the
stream):

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "run_heavy_task",
    "arguments": { "durationSeconds": 10 },
    "_meta": { "progressToken": "p1" }
  }
}
```

---

## Reading the response

Every response comes back as `Content-Type: text/event-stream`, so Postman shows raw SSE
text (`event: message`, `data: {...}`) in the Body tab rather than pretty JSON — that's
expected, not an error. Response headers (including `Mcp-Session-Id` on the `initialize`
response) are in the **response** Headers tab at the bottom of the window — this is a
different tab from the **request** Headers tab above the URL bar. Don't confuse the two.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `{"error":"Missing or malformed X-AMS-Auth header"}` | You hit the backend/ngrok URL directly instead of the gateway URL | Use `{{gateway_url}}` (the APIM URL), not the raw ngrok URL |
| `{"error":"token verification failed: ... Invalid Compact JWS"}` | You put the raw `ams_k_...` key in an `X-AMS-Auth` header | Use `X-AMS-Api-Key` instead — APIM handles minting `X-AMS-Auth` itself |
| `{"error":{"code":-32000,"message":"Bad Request: No valid session ID provided"}}` | Missing or stale `Mcp-Session-Id` header | Re-run `MCP Initialize`, re-copy `{{session_id}}`, make sure the header is present on this request |
| `{"error":"This key does not have access to this service","code":"SERVICE_NOT_IN_SCOPE"}` | Your API key isn't scoped to this service | Generate/use a key scoped to the correct service (Step 4.5) |
| Postman shows raw `event: message` / `data: {...}` text | Normal — response is SSE, not plain JSON | Read the JSON inside the `data:` line |

---

## Appendix: comparison with sibling test servers

| | `mcp-test-server` (this folder) | `mcp-test-server-stateless` | `mcp-test-server-standard-stateless` |
|---|---|---|---|
| Session (`Mcp-Session-Id`) | **Required** | Not used at all | Not used at all (SDK's official stateless mode) |
| `initialize` handshake | **Required first** | Doesn't exist — every request self-contained | Supported but **optional** — `tools/call` works without it |
| Routing mechanism | JSON-RPC body only | `Mcp-Method`/`Mcp-Name` headers + body (2026-07-28 draft spec) | JSON-RPC body only |
| Auth (`X-AMS-Auth`) enforced by backend | **Yes** | No | No |
| Tools available | `get_time`, `search`, `generate_report`, `run_heavy_task` | Same 4 tools | Only `get_time`, `search` |
| Default port | 3000 | 3001 | 3098 |
| Purpose | Realistic stateful protocol era | Hand-built emulation of the future stateless draft spec | Isolates whether APIM issues are session-related, using a spec-standard SDK stateless server |
