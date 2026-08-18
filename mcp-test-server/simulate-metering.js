// Simulates the full billing decision from spec §11 (ApimPolicyBuilder's inbound MCP policy),
// against BOTH protocol eras:
//   - pre-2026-07-28 (stateful): no Mcp-Method/Mcp-Name headers — body is the only source
//   - 2026-07-28+ (stateless):   headers present — cross-validated against the parsed body,
//                                 never trusted alone
//
// Mirrors the decision tree in the spec exactly:
//   1. Parse the request body (method / params.name). Unparseable -> requestIntegrityIssue: "parse_failure"
//   2. If Mcp-Method/Mcp-Name headers are present, compare to the parsed body.
//      Mismatch -> requestIntegrityIssue: "header_body_mismatch", never billed on either value.
//   3. Not tools/call (e.g. tools/list, ping, initialize) -> not billed, no issue.
//   4. tools/call with no matching price in pricing-config.json -> pricePerCallSnapshot: null,
//      tracked in unpricedToolUsage, not an error.
//   5. tools/call with a matching price -> billed, pricePerCallSnapshot captured now (not
//      re-resolved later — spec's fix for the ADR-0006 reproducibility gap).
//
// Run: node simulate-metering.js

const pricing = require("./pricing-config.json");

function priceFor(toolName) {
  const entry = pricing.toolPrices.find((p) => p.toolName === toolName);
  return entry ? entry.pricePerCall : null;
}

function simulateMcpMetering(rawRequestBody, headers = {}) {
  let body;
  try {
    body = JSON.parse(rawRequestBody);
  } catch {
    return {
      toolName: null,
      pricePerCallSnapshot: null,
      requestIntegrityIssue: "parse_failure",
      billed: false,
    };
  }

  const bodyMethod = body.method ?? null;
  const bodyToolName = body.params?.name ?? null;

  const headerMethod = headers["mcp-method"];
  const headerName = headers["mcp-name"];
  const headersPresent = headerMethod !== undefined || headerName !== undefined;

  if (headersPresent) {
    const methodMatches = headerMethod === bodyMethod;
    const nameMatches = bodyMethod !== "tools/call" || headerName === bodyToolName;
    if (!methodMatches || !nameMatches) {
      return {
        toolName: null,
        pricePerCallSnapshot: null,
        requestIntegrityIssue: "header_body_mismatch",
        billed: false,
      };
    }
  }

  if (bodyMethod !== "tools/call") {
    return { toolName: null, pricePerCallSnapshot: null, requestIntegrityIssue: null, billed: false };
  }

  const price = priceFor(bodyToolName);
  return {
    toolName: bodyToolName,
    pricePerCallSnapshot: price,
    requestIntegrityIssue: null,
    billed: price !== null,
  };
}

const samples = [
  {
    label: "stateful: initialize (not billed)",
    body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
    headers: {},
  },
  {
    label: "stateful: tools/call get_time (valid tool, no price -> unpriced, not billed)",
    body: '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_time","arguments":{}}}',
    headers: {},
  },
  {
    label: "stateful: tools/call search (priced -> billed $0.05)",
    body: '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search","arguments":{"query":"x"}}}',
    headers: {},
  },
  {
    label: "stateless: tools/call run_heavy_task, headers match body (billed $1.00)",
    body: '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"run_heavy_task","arguments":{}}}',
    headers: { "mcp-method": "tools/call", "mcp-name": "run_heavy_task" },
  },
  {
    label: "stateless: MALICIOUS — header claims tools/list, body actually calls run_heavy_task",
    body: '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"run_heavy_task","arguments":{}}}',
    headers: { "mcp-method": "tools/list" },
  },
  {
    label: "stateless: header/name mismatch (body calls search, header claims generate_report)",
    body: '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"search","arguments":{}}}',
    headers: { "mcp-method": "tools/call", "mcp-name": "generate_report" },
  },
  {
    label: "malformed / unparseable body",
    body: "not json at all",
    headers: {},
  },
];

for (const { label, body, headers } of samples) {
  console.log(label, "->", simulateMcpMetering(body, headers));
}
