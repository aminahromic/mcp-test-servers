// Standard MCP Streamable HTTP server that speaks the REAL protocol (initialize,
// tools/list, tools/call — same as ../mcp-test-server) but WITHOUT session tracking:
// no Mcp-Session-Id is issued or required, matching the SDK's officially supported
// "stateless mode" (sessionIdGenerator: undefined). Every request gets a fresh
// server+transport pair.
//
// Purpose: isolate whether Azure APIM's native "expose as MCP server" gateway fails
// to discover tools specifically because ../mcp-test-server requires a session, or for
// some other reason. This server is spec-standard, so if tools/list still comes back
// empty against THIS server, the problem isn't about session requirements at all.

const express = require("express");
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");

function createServer() {
  const server = new McpServer({ name: "mcp-test-server-standard-stateless", version: "1.0.0" });

  server.tool(
    "get_time",
    "Returns the current server time.",
    {},
    async () => ({
      content: [{ type: "text", text: new Date().toISOString() }],
    })
  );

  server.tool(
    "search",
    "Fake, cheap lookup tool.",
    { query: z.string().describe("Search query") },
    async ({ query }) => ({
      content: [{ type: "text", text: `3 fake results for "${query}"` }],
    })
  );

  return server;
}

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  // Stateless mode per the SDK docs: no sessionIdGenerator, fresh transport/server
  // per request, no Mcp-Session-Id issued or expected.
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = process.env.PORT || 3098;
app.listen(PORT, () => {
  console.log(`mcp-test-server-standard-stateless listening on http://localhost:${PORT}/mcp`);
});
