#!/usr/bin/env tsx
/**
 * proofofdev — MCP server (stdio transport) wrapping the Proof of Dev
 * agent API, for local Claude Code / Claude client installs.
 *
 * Tool definitions live in ONE shared module — src/lib/mcpTools.ts —
 * which also powers the remote Streamable HTTP endpoint at
 * https://api.proofofdev.xyz/mcp (src/mcpHttp.ts). Do not add tools here;
 * add them to the shared module so both transports stay identical.
 *
 * API base: POD_API_URL (default https://api.proofofdev.xyz).
 * Logs go to stderr; stdout is protocol-only.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createProofofdevServer } from "../../src/lib/mcpTools.ts";

const BASE = process.env.POD_API_URL ?? "https://api.proofofdev.xyz";

const server = createProofofdevServer(BASE);
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[proofofdev-mcp] ready — API base ${BASE}`);
