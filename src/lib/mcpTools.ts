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
 *   verify_github      POST /api/launch/verify-github (LAUNCH GATE — Step 0)
 *   prepare_launch     POST /api/launch/prepare-launch (launch-SDK input;
 *                                                    REQUIRES the gate token;
 *                                                    launcher fee share → the
 *                                                    project's FeeLockVault)
 *   vesting_status     GET  /api/agent/status?repo=
 *   agent_briefing     GET  /api/agent/briefing?wallet=
 *   agent_grants       GET  /api/agent/grants?wallet=
 *   repo_recent_pushes GET  /api/vesting/recent-pushes
 *   prepare_lock       POST /api/agent/lock        (prepare ONLY — never signs;
 *                                                    REQUIRES a verification
 *                                                    token from verify_github)
 *   report_ship        POST /api/agent/report-ship (attestation signal only)
 *   ship_report        GET  /api/agent/ship-report?repo=&sha=
 *   link_status        GET  /api/dev/link-wallet/<login>
 *   enrol_reviewer     POST /api/agent/enrol-reviewer (swarm enrolment)
 *   review_queue       GET  /api/agent/review-queue?repo=&reviewerLogin=
 *   review_push        POST /api/agent/review-push   (swarm attestation)
 *
 * Trust notes (same as the API itself — the MCP layer adds no privilege):
 * - Reads are unauthenticated; a wallet address is public information.
 * - LAUNCH GATE: verify_github is Step 0 of any launch/deploy. The server
 *   checks (with the GitHub App's own credentials) that the App is
 *   installed on the repo, the GitHub login owns/admins it, and the wallet
 *   is linked to that login, then issues a short-lived token bound to
 *   {login, repo, wallet, chainId}. prepare_lock REQUIRES that token —
 *   an agent's self-assertion is not verification, and a launch without
 *   one gets no grant, no push counting, no rewards, no listing.
 * - prepare_lock returns unsigned transactions. Signing + submission is a
 *   separate step that belongs to a human or an agent wallet — this server
 *   holds no keys and cannot move funds.
 * - report_ship files an attestation claim. It NEVER releases tokens;
 *   settlement is the GitHub webhook → verifier → oracle, unchanged.
 * - REVIEWER SWARM: enrol_reviewer / review_queue / review_push let an
 *   agent act as an independent push reviewer. Swarm review is
 *   MANDATORY on every grant: a verifier-passing push opens a 6-hour
 *   window — 2 independent PASS count it early, any FAIL vetoes it,
 *   and at expiry it counts on the verifier alone (fallback). Reviews
 *   are an ADDITIONAL GATE, never a settlement trigger — no review (or
 *   quorum of reviews) can force a release or a reward. Reviewer
 *   rewards are paid by the oracle only for reviews on pushes that
 *   count via the swarm path, never at review time. Independence is
 *   enforced server-side: the author, the author's wallet, and the
 *   repo's launcher/claim wallets cannot review.
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
    "verify_github",
    "LAUNCH GATE — Step 0 before ANY launch/deploy: run the server-side GitHub App verification for " +
      "{githubLogin, repo, wallet, chain}. The server (never the agent) checks that the Proof of Dev " +
      "GitHub App is installed on the repo, that the login owns or admins the repo, and that the wallet " +
      "is linked to that login. On success it returns a verificationToken (valid ~15 minutes, bound to " +
      "exactly that login/repo/wallet/chain) which prepare_lock and confirm-lock REQUIRE. If this " +
      "refuses, stop: relay the error (app not installed / not owner or admin / wallet not linked) and " +
      "fix that precondition — do not proceed to prepare a launch unverified.",
    {
      githubLogin: z.string().describe("GitHub login that owns/admins the repo"),
      repo: z.string().describe("GitHub repo as owner/repo"),
      wallet: z.string().describe("Wallet address (0x…) linked to that GitHub login"),
      chain: z.enum(["base", "robinhood", "base-sepolia"]).optional().describe("Chain (default base)"),
    },
    async ({ githubLogin, repo, wallet, chain }) =>
      api("POST", "/api/launch/verify-github", {
        wallet,
        body: { githubLogin, repo, ...(chain !== undefined ? { chain } : {}) },
      }),
  );

  reg.tool(
    "prepare_launch",
    "PREPARE a platform token launch (Bankr launch-SDK input): REQUIRES a verificationToken from " +
      "verify_github (Step 0) bound to this exact repo + wallet + chain — without a valid one the server " +
      "refuses (403) and nothing is prepared. Returns the launch input with the production fee split " +
      "(2500 bps of the creator slice to the platform reward treasury, 7500 bps to the project's " +
      "feeLockVault — the launcher's fee share NEVER goes to a raw wallet; fees auto-lock and unlock by " +
      "counted pushes) and Bankr time-vesting explicitly off (vesting.bps = 0). PREPARED ONLY: this " +
      "tool never signs, broadcasts, or launches. Fails closed (503) while the platform reward " +
      "treasury wallet is undesignated.",
    {
      repo: z.string().describe("GitHub repo as owner/repo"),
      wallet: z.string().describe("Launcher wallet address (0x…) — must match the verification token"),
      verificationToken: z.string().describe("REQUIRED — token from verify_github for this exact repo + wallet + chain"),
      feeLockVault: z.string().describe("The project's FeeLockVault address (0x…) — launcher-share fee recipient"),
      name: z.string().describe("Token name for the launch input"),
      symbol: z.string().describe("Token symbol for the launch input"),
      chain: z.enum(["base", "robinhood", "base-sepolia"]).optional().describe("Chain (default base)"),
    },
    async ({ repo, wallet, verificationToken, feeLockVault, name, symbol, chain }) =>
      api("POST", "/api/launch/prepare-launch", {
        wallet,
        body: {
          repo,
          verificationToken,
          feeLockVault,
          launch: { name, symbol },
          ...(chain !== undefined ? { chain } : {}),
        },
      }),
  );

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
      "This tool NEVER signs or submits anything and cannot move funds. LAUNCH GATE: a verificationToken " +
      "from verify_github (Step 0) is REQUIRED, bound to this exact repo + wallet + chain — without a " +
      "valid one the server refuses (403) and nothing is prepared. Before calling, confirm with the user: " +
      "token, amount, repo, chain, total pushes, pushes per milestone. After calling, present the prepared " +
      "transactions for signing via the user's wallet route, then confirm with POST /api/agent/confirm-lock " +
      "(which requires the same verificationToken).",
    {
      wallet: z.string().describe("Funding wallet address (0x…) — the lock recipient"),
      repo: z.string().describe("GitHub repo as owner/repo"),
      token: z.string().describe("ERC-20 contract address (0x…) or symbol held by the wallet"),
      amount: z.string().describe("Human amount, e.g. \"1000\", \"3.49M\", \"1.5K\""),
      verificationToken: z.string().describe("REQUIRED — token from verify_github for this exact repo + wallet + chain"),
      totalPushes: z.number().int().positive().optional().describe("Total counted pushes in the schedule (default 10)"),
      pushesPerMilestone: z.number().int().positive().optional().describe("Pushes per release (default = totalPushes, one release at the end)"),
      chain: z.enum(["base", "robinhood", "base-sepolia"]).optional().describe("Chain (default base)"),
    },
    async ({ wallet, repo, token, amount, verificationToken, totalPushes, pushesPerMilestone, chain }) => {
      const result = await api("POST", "/api/agent/lock", {
        wallet,
        body: {
          repo,
          token,
          amount,
          verificationToken,
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
    "enrol_reviewer",
    "Enrol yourself (an agent with a linked wallet) as a Proof of Dev swarm reviewer: " +
      "{githubLogin, wallet}. The wallet MUST already be linked to the login (signature/magic-link " +
      "store) — reviewer rewards pay that wallet. Enrolment lets you review OTHER people's pushes; " +
      "you can never review your own pushes, pushes from your wallet, or repos whose launcher/claim " +
      "wallet is yours (the server refuses those with SWARM_REVIEW_NOT_INDEPENDENT).",
    {
      githubLogin: z.string().describe("Your GitHub login"),
      wallet: z.string().describe("Your wallet address (0x…) — must be linked to the login"),
    },
    async ({ githubLogin, wallet }) =>
      api("POST", "/api/agent/enrol-reviewer", { wallet, body: { githubLogin, wallet } }),
  );

  reg.tool(
    "review_queue",
    "List pushes awaiting swarm review on a repo, filtered for you: only pushes you are independent " +
      "of and have not already reviewed. Swarm review is mandatory on every grant — a verifier-passing " +
      "push waits in a 6-hour window for 2 independent PASS (any FAIL vetoes it) before counting via " +
      "verifier fallback at expiry. Each entry carries " +
      "the head SHA, the author, the server's diff fingerprint, any duplicate flag, and quorum progress.",
    {
      repo: z.string().describe("GitHub repo as owner/repo"),
      reviewerLogin: z.string().describe("Your GitHub login (must be enrolled)"),
    },
    async ({ repo, reviewerLogin }) =>
      api(
        "GET",
        `/api/agent/review-queue?repo=${encodeURIComponent(repo)}&reviewerLogin=${encodeURIComponent(reviewerLogin)}`,
      ),
  );

  reg.tool(
    "review_push",
    "Submit your independent review attestation for one push: {repo, headSha, reviewerLogin, verdict, " +
      "different, meaningful, checksPass, fingerprint}. Compute the fingerprint YOURSELF from the PR diff " +
      "using the published algorithm (per-file sha256 of filename|status|normalized content, then sha256 " +
      "over the sorted per-file hashes) — a PASS whose fingerprint does not match the server's does not " +
      "count toward quorum. Check three things: the code is genuinely DIFFERENT (not a copy of a prior " +
      "counted diff), MEANINGFUL (real code, not churn), and PASSING (checks/tests green). verdict=pass " +
      "requires all three true. A FAIL vetoes the push. DESIGN LAW: a review is a GATE, never a " +
      "settlement — it moves no money and counts nothing; the GitHub webhook remains the only path " +
      "that counts pushes and pays (your reviewer reward included).",
    {
      repo: z.string().describe("GitHub repo as owner/repo"),
      headSha: z.string().describe("40-char hex head/merge commit SHA of the push under review"),
      reviewerLogin: z.string().describe("Your GitHub login (must be enrolled)"),
      verdict: z.enum(["pass", "fail"]).describe("Your overall verdict"),
      different: z.boolean().describe("True if the diff is genuinely new code, not a duplicate/replay of a prior counted diff"),
      meaningful: z.boolean().describe("True if the diff is meaningful real code, not churn"),
      checksPass: z.boolean().describe("True if the PR's checks/tests pass"),
      fingerprint: z.string().describe("Your computed whole-diff fingerprint (64-char hex)"),
      note: z.string().optional().describe("Optional note, e.g. why a FAIL was given (duplicate, churn, red checks)"),
    },
    async ({ repo, headSha, reviewerLogin, verdict, different, meaningful, checksPass, fingerprint, note }) =>
      api("POST", "/api/agent/review-push", {
        body: {
          repo,
          headSha,
          reviewerLogin,
          verdict,
          different,
          meaningful,
          checksPass,
          fingerprint,
          ...(note !== undefined ? { note } : {}),
        },
      }),
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
