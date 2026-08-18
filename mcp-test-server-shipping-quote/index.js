// Stateless MCP Streamable HTTP server (SDK's official stateless mode — no
// Mcp-Session-Id issued or required) exposing a single realistic tool:
// calculate_shipping_quote, modeled after a typical merchant checkout API.

const express = require("express");
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");

// Mock rate card. Real systems pull this from a carrier-rates table; kept
// static here so quotes are deterministic across test runs.
const ZONES = {
  US: { zone: "domestic", baseFee: 5, perKg: 1.2, businessDays: 3 },
  CA: { zone: "neighboring", baseFee: 12, perKg: 2.5, businessDays: 6 },
  MX: { zone: "neighboring", baseFee: 12, perKg: 2.5, businessDays: 6 },
};
const REST_OF_WORLD = { zone: "international", baseFee: 25, perKg: 4.0, businessDays: 12 };

function quoteFor(weightKg, countryCode, express) {
  const rate = ZONES[countryCode] || REST_OF_WORLD;
  let cost = rate.baseFee + rate.perKg * weightKg;
  let businessDays = rate.businessDays;

  if (express) {
    cost *= 1.6;
    businessDays = Math.max(1, Math.ceil(businessDays * 0.4));
  }

  return {
    zone: rate.zone,
    costUsd: Math.round(cost * 100) / 100,
    estimatedBusinessDays: businessDays,
  };
}

function createServer() {
  const server = new McpServer({ name: "mcp-test-server-shipping-quote", version: "1.0.0" });

  server.tool(
    "calculate_shipping_quote",
    "Estimates shipping cost and delivery time for a package given its weight and destination country.",
    {
      weight_kg: z.number().positive().describe("Package weight in kilograms"),
      destination_country: z
        .string()
        .length(2)
        .describe("Destination country as an ISO 3166-1 alpha-2 code, e.g. 'US', 'CA', 'DE'"),
      express: z.boolean().optional().describe("Request expedited shipping (default false)"),
    },
    async ({ weight_kg, destination_country, express: isExpress }) => {
      const countryCode = destination_country.toUpperCase();
      const quote = quoteFor(weight_kg, countryCode, isExpress ?? false);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                destination_country: countryCode,
                weight_kg,
                express: isExpress ?? false,
                ...quote,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = process.env.PORT || 3099;
app.listen(PORT, () => {
  console.log(`mcp-test-server-shipping-quote listening on http://localhost:${PORT}/mcp`);
});
