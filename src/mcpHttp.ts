/**
 * Remote MCP endpoint — Streamable HTTP transport, mounted at /mcp.
 *
 * Public link (once deployed): https://api.proofofdev.xyz/mcp
 * Any MCP client (Claude Code, Claude clients, other agents) connects
 * with just that URL — no local install, no skill file.
 *
 * Tool definitions are shared with the stdio server via
 * src/lib/mcpTools.ts (createProofofdevServer) so the two transports
 * cannot drift; the E2E suite diffs their tool lists.
 *
 * STATELESS by design: a fresh server+transport per request, no session
 * store, JSON responses. Survives process restarts and needs no sticky
 * sessions behind Railway's router.
 *
 * EXPOSURE: this endpoint exposes exactly what the public agent API
 * already exposes — unauthenticated reads, prepare_lock (UNSIGNED
 * transactions only), and report_ship (the by-design unauthenticated
 * attestation signal). It adds NO new privileged surface: nothing here
 * signs, submits, confirms locks, or touches admin endpoints. The tools
 * call the agent API over loopback (POD_API_URL if set, else
 * http://127.0.0.1:<PORT>) so requests never leave the box.
 */

import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createProofofdevServer } from "./lib/mcpTools";
import { env } from "./lib/env";

export async function handleMcpHttp(req: Request, res: Response): Promise<void> {
  const base = process.env.POD_API_URL ?? `http://127.0.0.1:${env.PORT}`;
  const server = createProofofdevServer(base);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal error" },
        id: null,
      });
    }
  }
}
