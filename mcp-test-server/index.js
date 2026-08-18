const express = require("express");
const { randomUUID } = require("node:crypto");
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { isInitializeRequest } = require("@modelcontextprotocol/sdk/types.js");
const { AmsAuthVerifier, requireAmsAuth } = require("@ams/sdk");

const amsAuthVerifier = new AmsAuthVerifier({
  jwksUrl: "https://ams-dev-api.ashydune-a07992fa.westeurope.azurecontainerapps.io/.well-known/jwks.json",
  issuer: "https://api.ams.dev",
  merchantId: "4fdc84c9-edf2-4c53-bad9-9dc38612fb38",
});

// Tool set mirrors ../mcp-test-server-stateless/index.js so the same
// PerToolCallPricingConfig (pricing-config.json) exercises both protocol eras
// identically. get_time is deliberately left out of pricing-config.json to
// exercise the "valid tool, no price configured" unbilled path (spec §11).

function createServer() {
  const server = new McpServer({ name: "mcp-test-server-stateful", version: "1.0.0" });

  server.tool(
    "get_time",
    "Returns the current server time. Fast, non-streamed response. Not in pricing-config.json — exercises the unpriced-tool path.",
    {},
    async () => ({
      content: [{ type: "text", text: new Date().toISOString() }],
    })
  );

  server.tool(
    "search",
    "Fake, cheap lookup tool. Priced at $0.05/call in pricing-config.json — baseline 'small tool call' billing check.",
    { query: z.string().describe("Search query") },
    async ({ query }) => ({
      content: [{ type: "text", text: `3 fake results for "${query}"` }],
    })
  );

  server.tool(
    "generate_report",
    "Fake, mid-cost report tool. Priced at $0.50/call in pricing-config.json.",
    { topic: z.string().describe("Report topic") },
    async ({ topic }) => ({
      content: [{ type: "text", text: `# Report: ${topic}\n\nThis is a fake generated report.` }],
    })
  );

  server.tool(
    "run_heavy_task",
    "Long-running, expensive tool ($1.00/call in pricing-config.json). Counts 1..N, one tick per " +
      "second, emitting an MCP progress notification per tick when the caller sends " +
      "_meta.progressToken. Use `durationSeconds` (default 10, max 300) to push close to APIM's " +
      "~4-minute idle-connection ceiling and verify streaming/keepalive survive whatever proxy " +
      "sits in front (ngrok now, APIM later) instead of buffering into one deferred response.",
    { durationSeconds: z.number().int().min(1).max(300).default(10) },
    async ({ durationSeconds }, extra) => {
      const progressToken = extra._meta?.progressToken;
      const parts = [];
      for (let i = 1; i <= durationSeconds; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        parts.push({ type: "text", text: String(i) });
        if (progressToken !== undefined) {
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress: i, total: durationSeconds },
          });
        }
      }
      return { content: parts };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

// sessionId -> transport, per the SDK's documented Streamable HTTP session pattern.
const transports = {};

app.post("/mcp", requireAmsAuth(amsAuthVerifier), async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  let transport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };

    const server = createServer();
    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid session ID provided" },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`mcp-test-server (stateful) listening on http://localhost:${PORT}/mcp`);
});
