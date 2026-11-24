/**
 * proofofdev — shared MCP tool definitions for Proof of Dev.
 *
 * ONE source of truth for the MCP tool surface, consumed by:
 *   - the stdio server (mcp/src/server.ts) for local Claude installs, and
 *   - the remote Streamable HTTP endpoint (src/mcpHttp.ts, mounted at /mcp
 *     in src/index.ts) for the public link https://api.proofofdev.xyz/mcp.
 * A consistency check in the E2E suite diffs the tool lists of both
 * transports so they cannot drift.
 *
 * The tools wrap the Proof of Dev agent API:
 *   vesting_status     GET  /api/agent/status?repo=
 *   agent_briefing     GET  /api/agent/briefing?wallet=
 *   agent_grants       GET  /api/agent/grants?wallet=
 *   repo_recent_pushes GET  /api/vesting/recent-pushes
 *   prepare_lock       POST /api/agent/lock        (prepare ONLY — never signs)
 *   report_ship        POST /api/agent/report-ship (attestation signal only)
 *   ship_report        GET  /api/agent/ship-report?repo=&sha=
 *   link_status        GET  /api/dev/link-wallet/<login>
 *
 * Trust notes (same as the API itself — the MCP layer adds no privilege):
 * - Reads are unauthenticated; a wallet address is public information.
 * - prepare_lock returns unsigned transactions. Signing + submission is a
 *   separate step that belongs to a human or an agent wallet — this server
 *   holds no keys and cannot move funds.
 * - report_ship files an attestation claim. It NEVER releases tokens;
 *   settlement is the GitHub webhook → verifier → oracle, unchanged.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export function createProofofdevServer(rawBase: string): McpServer {
  const BASE = rawBase.replace(/\/+$/, "");

  async function api(
    method: "GET" | "POST",
    path: string,
    opts?: { body?: unknown; wallet?: string },
  ): Promise<ToolResult> {
    try {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(opts?.wallet ? { "x-wallet-address": opts.wallet } : {}),
        },
        ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
      const text = await res.text();
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* leave raw text */
      }
      if (!res.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `HTTP ${res.status} from ${method} ${path}:\n${pretty}` }],
        };
      }
      return { content: [{ type: "text", text: pretty }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `Proof of Dev API unreachable at ${BASE} (${method} ${path}): ${msg}. ` +
              `The backend appears offline — report that plainly; do not fabricate status.`,
          },
        ],
      };
    }
  }

  const server = new McpServer({ name: "proofofdev", version: "0.1.0" });

  // Registration goes through a loose structural type on purpose: the
  // SDK's generic tool() inference exceeds TypeScript's instantiation
  // depth (TS2589) for some zod schemas under the backend's tsc config.
  // This is a type-level cast only — the real zod schemas are still
  // passed through and validate every call at runtime.
  const reg = server as unknown as {
    tool: (
      name: string,
      description: string,
      paramsSchema: Record<string, z.ZodTypeAny>,
      cb: (args: any) => Promise<ToolResult>,
    ) => void;
  };

  reg.tool(
    "vesting_status",
    "Vesting progress for one repo (owner/repo): verified push count, pushes until next release, locked amount, grant status, recent counted pushes. No wallet needed.",
    { repo: z.string().describe("GitHub repo as owner/repo") },
    async ({ repo }) => api("GET", `/api/agent/status?repo=${encodeURIComponent(repo)}`),
  );

  reg.tool(
    "agent_briefing",
    "Summary of all vesting locks for a wallet address: per-grant repo, status, and push progress.",
    { wallet: z.string().describe("Wallet address (0x…) whose locks to summarize") },
    async ({ wallet }) => api("GET", `/api/agent/briefing?wallet=${encodeURIComponent(wallet)}`),
  );

  reg.tool(
    "agent_grants",
    "Detailed vesting grant list for a wallet address, including token, chain, totals, and recent pushes per grant.",
    { wallet: z.string().describe("Wallet address (0x…) whose grants to list") },
    async ({ wallet }) => api("GET", `/api/agent/grants?wallet=${encodeURIComponent(wallet)}`),
  );

  reg.tool(
    "repo_recent_pushes",
    "Most recent counted (verified) pushes across all Proof of Dev grants — who is actively shipping, newest first.",
    { limit: z.number().int().min(1).max(30).optional().describe("Max rows (default 10, cap 30)") },
    async ({ limit }) =>
      api("GET", `/api/vesting/recent-pushes${limit ? `?limit=${limit}` : ""}`),
  );

  reg.tool(
    "prepare_lock",
    "PREPARE a vesting lock: returns the unsigned approve+lock transactions for a wallet to sign. " +
      "This tool NEVER signs or submits anything and cannot move funds. Before calling, confirm with the user: " +
      "token, amount, repo, chain, total pushes, pushes per milestone. After calling, present the prepared " +
      "transactions for signing via the user's wallet route, then confirm with POST /api/agent/confirm-lock.",
    {
      wallet: z.string().describe("Funding wallet address (0x…) — the lock recipient"),
      repo: z.string().describe("GitHub repo as owner/repo"),
      token: z.string().describe("ERC-20 contract address (0x…) or symbol held by the wallet"),
      amount: z.string().describe("Human amount, e.g. \"1000\", \"3.49M\", \"1.5K\""),
      totalPushes: z.number().int().positive().optional().describe("Total counted pushes in the schedule (default 10)"),
      pushesPerMilestone: z.number().int().positive().optional().describe("Pushes per release (default = totalPushes, one release at the end)"),
      chain: z.enum(["base", "robinhood", "base-sepolia"]).optional().describe("Chain (default base)"),
    },
    async ({ wallet, repo, token, amount, totalPushes, pushesPerMilestone, chain }) => {
      const result = await api("POST", "/api/agent/lock", {
        wallet,
        body: {
          repo,
          token,
          amount,
          ...(totalPushes !== undefined ? { totalPushes } : {}),
          ...(pushesPerMilestone !== undefined ? { pushesPerMilestone } : {}),
          ...(chain !== undefined ? { chain } : {}),
        },
      });
      const warning =
        "⚠️ PREPARED ONLY — nothing was signed, submitted, or moved. The transactions below are " +
        "UNSIGNED. Signing + broadcast is a separate step for the user or an agent wallet, and only " +
        "after the user explicitly confirms token, amount, repo, chain, and schedule. After the lock " +
        "tx confirms on-chain, register it via POST /api/agent/confirm-lock.\n\n";
      return {
        ...result,
        content: result.content.map((c) => ({ ...c, text: warning + c.text })),
      };
    },
  );

  reg.tool(
    "report_ship",
    "File a ship report (attestation) for a commit you just shipped/merged: {repo, headSha}. " +
      "A report is a SIGNAL ONLY — it never releases tokens and never influences the verifier. " +
      "Settlement is the GitHub webhook; the report transitions reported → confirmed/paid/rejected/expired " +
      "as the webhook's real outcome arrives. Use ship_report to read the outcome and narrate it honestly " +
      "('reported' is not 'paid').",
    {
      repo: z.string().describe("GitHub repo as owner/repo"),
      headSha: z.string().describe("40-char hex head/merge commit SHA of the push"),
      prNumber: z.number().int().positive().optional().describe("Merged PR number, if known"),
      authorLogin: z.string().optional().describe("PR author GitHub login, if known — never guess"),
    },
    async ({ repo, headSha, prNumber, authorLogin }) =>
      api("POST", "/api/agent/report-ship", {
        body: {
          repo,
          headSha,
          ...(prNumber !== undefined ? { prNumber } : {}),
          ...(authorLogin !== undefined ? { authorLogin } : {}),
        },
      }),
  );

  reg.tool(
    "ship_report",
    "Read the current state of a ship report: reported (awaiting GitHub confirmation), confirmed (counted, " +
      "no payout on that push), paid (release and/or merge-reward tx hashes on the record), rejected (with the " +
      "verifier's reason), or expired (no webhook within 24h).",
    {
      repo: z.string().describe("GitHub repo as owner/repo"),
      sha: z.string().describe("40-char hex commit SHA that was reported"),
    },
    async ({ repo, sha }) =>
      api("GET", `/api/agent/ship-report?repo=${encodeURIComponent(repo)}&sha=${encodeURIComponent(sha)}`),
  );

  reg.tool(
    "link_status",
    "Wallets linked to a GitHub login (merge rewards pay the most recently linked wallet), plus any pendingRewards that accrued while no wallet was linked and their pendingRewardsTotal — pending rewards settle automatically when a wallet is linked. No auth needed.",
    { githubLogin: z.string().describe("GitHub login to look up") },
    async ({ githubLogin }) =>
      api("GET", `/api/dev/link-wallet/${encodeURIComponent(githubLogin)}`),
  );

  return server;
}
