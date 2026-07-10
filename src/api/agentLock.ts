/**
 * Agent lock flow — prepare on-chain txs + confirm registration for Bankr chat / X.
 *
 * POST /api/agent/prepare-lock
 * POST /api/agent/confirm-lock
 * POST /api/agent/lock          (prepare + instructions in one call)
 * GET  /api/agent/fee-tokens
 */

import type { Request, Response } from "express";
import {
  createPublicClient,
  http,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hash,
} from "viem";
import { env } from "../lib/env";
import { isValidWallet, formatTokenAmount } from "../lib/grantsHelper";
import { prepareLockTransactions, parseVestingChain } from "../lib/lockBuilder";
import { handleRegister } from "./register";
import { resolveInstallationForRepo, validateRepoAccess, getRepoInfo } from "../github/githubApp";
import { normalizeRepoFullName, splitRepo } from "../lib/repoId";
import { getRepoClaim } from "../lib/repoClaims";
import { Octokit } from "@octokit/rest";
import { fetchBankrTokenInfo } from "./bankr";
import knownEscrow from "../../skills/bankr-vesting/known-escrow.json";
import {
  fetchFeeRecipientTokens,
  listLockableTokens,
  resolveTokenForWallet,
} from "../lib/walletTokens";
import {
  defaultVestingChain,
  getVestingChainConfig,
  type VestingChainKey,
} from "../lib/chains";

function resolveChain(req: Request): VestingChainKey {
  const raw = String(
    req.body?.chain ?? req.query["chain"] ?? defaultVestingChain(),
  ).trim();
  return parseVestingChain(raw);
}

function chainLabel(key: VestingChainKey): string {
  return getVestingChainConfig(key).label;
}

const GITHUB_APP_SLUG = process.env.GITHUB_APP_SLUG ?? "bankr-vesting";
const BANKR_API = "https://api.bankr.bot";

const ESCROW_ABI = parseAbi([
  "event Locked(bytes32 indexed repoId, address indexed recipient, address indexed token, uint256 amount, uint256 totalPushesRequired, uint256 releasesPerMilestone, uint256 tokensPerMilestone)",
]);

function resolveWallet(req: Request): string | null {
  const header = req.headers["x-wallet-address"];
  const body = req.body?.wallet ?? req.body?.recipient;
  const query = req.query["wallet"] ?? req.query["recipient"];
  const raw = String(header ?? body ?? query ?? "").trim();
  if (!isValidWallet(raw)) return null;
  return raw.toLowerCase();
}

function lockUrl(repoFullName: string): string {
  const [owner, name] = repoFullName.split("/");
  return `${env.FRONTEND_URL}/lock/${owner}/${name}`;
}

function githubAppInstallUrl(): string {
  return `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`;
}

async function validateGithubRepo(repoFullName: string): Promise<{
  ok: boolean;
  error?: string;
  hint?: string;
  suggestions?: string[];
}> {
  const normalized = normalizeRepoFullName(repoFullName);
  const [owner, repo] = splitRepo(normalized, "github");
  const installId = await resolveInstallationForRepo(owner, repo);
  if (installId) {
    try {
      await getRepoInfo(installId, owner, repo);
      return { ok: true };
    } catch {
      /* fall through */
    }
  }
  try {
    const octokit = new Octokit();
    await octokit.repos.get({ owner, repo });
    return { ok: true };
  } catch {
    const octokit = new Octokit();
    let suggestions: string[] = [];
    try {
      const { data } = await octokit.repos.listForUser({ username: owner, per_page: 100 });
      const needle = repo.toLowerCase().replace(/[^a-z0-9]/g, "");
      suggestions = data
        .map((r) => r.full_name)
        .filter((n): n is string => Boolean(n))
        .filter((full) => {
          const short = full.split("/")[1]!.toLowerCase();
          return short.includes(needle) || needle.includes(short.slice(0, 6));
        })
        .slice(0, 5);
    } catch { /* ignore */ }
    const hint =
      suggestions.length > 0
        ? `Did you mean: ${suggestions.join(", ")}?`
        : "Create the repo on GitHub first, or check spelling.";
    return { ok: false, error: `Repository ${normalized} not found on GitHub`, hint, suggestions };
  }
}

async function checkGithubInstallation(repoFullName: string): Promise<{
  ok: boolean;
  installationId?: number;
  error?: string;
  hint?: string;
  installUrl: string;
}> {
  const normalized = normalizeRepoFullName(repoFullName);
  const [owner, repo] = splitRepo(normalized, "github");
  const installUrl = githubAppInstallUrl();
  const resolvedId = await resolveInstallationForRepo(owner, repo);

  if (!resolvedId) {
    return {
      ok: false,
      error: "GitHub App not installed on this repo",
      hint: "Install the app and select this repository, then retry.",
      installUrl,
    };
  }

  const access = await validateRepoAccess(resolvedId, owner, repo);
  if (!access.valid) {
    return {
      ok: false,
      installationId: resolvedId,
      error: access.error ?? "GitHub App cannot access this repo",
      hint: `Re-install: ${installUrl}`,
      installUrl,
    };
  }

  return { ok: true, installationId: resolvedId, installUrl };
}

function parseHumanAmount(raw: string): string | null {
  const s = raw.trim().replace(/,/g, "").replace(/\$/g, "");
  const m = s.match(/^([\d.]+)\s*([kKmMbB])?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const suffix = (m[2] ?? "").toLowerCase();
  const mult = suffix === "k" ? 1e3 : suffix === "m" ? 1e6 : suffix === "b" ? 1e9 : 1;
  return String(n * mult);
}

async function resolveTokenInput(
  token: string,
  wallet: string,
  chainKey: VestingChainKey,
): Promise<{ address: Address } | { error: string }> {
  const resolved = await resolveTokenForWallet(wallet, token, chainKey);
  if ("error" in resolved) return { error: resolved.error };
  return { address: resolved.address };
}

async function parseLockBody(req: Request): Promise<
  | {
      wallet: string;
      repo: string;
      token: Address;
      amount: string;
      totalPushes: number;
      pushesPerMilestone: number;
      chain: VestingChainKey;
    }
  | { error: string }
> {
  const chain = resolveChain(req);
  const wallet = resolveWallet(req);
  if (!wallet) return { error: "wallet required (x-wallet-address header or body)" };

  const repo = String(req.body?.repo ?? req.body?.repoFullName ?? req.query["repo"] ?? "").trim();
  const tokenRaw = String(req.body?.token ?? req.body?.tokenAddress ?? req.query["token"] ?? "").trim();
  const amountRaw = String(req.body?.amount ?? req.query["amount"] ?? "").trim();

  if (!repo.includes("/")) return { error: "repo required (owner/name)" };
  if (!amountRaw) return { error: "amount required (e.g. 3490000 or 3.49M)" };

  const amount = parseHumanAmount(amountRaw) ?? (Number(amountRaw) > 0 ? amountRaw : null);
  if (!amount) return { error: "amount must be a positive number (supports 3.49M, 1.5K)" };

  const tokenResolved = await resolveTokenInput(tokenRaw, wallet, chain);
  if ("error" in tokenResolved) return tokenResolved;

  const totalPushes = Number(req.body?.totalPushes ?? req.query["totalPushes"] ?? 10);
  const pushesPerMilestone = Number(
    req.body?.pushesPerMilestone ?? req.query["pushesPerMilestone"] ?? totalPushes,
  );

  return {
    wallet,
    repo,
    token: tokenResolved.address,
    amount,
    totalPushes,
    pushesPerMilestone,
    chain,
  };
}

function buildBankrPrompt(
  prep: Awaited<ReturnType<typeof prepareLockTransactions>>,
  repo: string,
  wallet: string,
): string {
  const txList = prep.transactions
    .map((t, i) => `${i + 1}. ${t.description} → to ${t.to}`)
    .join("\n");

  return (
    `Execute GitHub vesting lock on ${chainLabel(prep.chain)} for wallet ${wallet}:\n` +
    `Repo: ${repo}\n` +
    `Token: ${prep.tokenSymbol} (${prep.amountFormatted})\n` +
    `Schedule: ${prep.totalPushes} verified pushes, release every ${prep.pushesPerMilestone}\n\n` +
    `Submit these ${prep.transactions.length} transaction(s) in order on ${chainLabel(prep.chain)} (chainId ${prep.transactions[0]?.chainId}):\n` +
    `${txList}\n\n` +
    `After the lock transaction confirms, call:\n` +
    `POST ${env.SERVER_URL}/api/agent/confirm-lock\n` +
    `body: { "repo": "${repo}", "lockTxHash": "<lock tx hash>" }\n` +
    `header: x-wallet-address: ${wallet}`
  );
}

export async function handleAgentFeeTokens(req: Request, res: Response): Promise<void> {
  const wallet = resolveWallet(req);
  if (!wallet) {
    res.status(400).json({ ok: false, error: "wallet required" });
    return;
  }

  const chain = resolveChain(req);
  const label = chainLabel(chain);

  try {
    const [lockable, feeRecipient] = await Promise.all([
      listLockableTokens(wallet as Address, chain),
      fetchFeeRecipientTokens(wallet),
    ]);

    const walletHoldings = lockable.filter((t) => t.source === "wallet");
    const feeSet = new Set(feeRecipient.map((t) => t.address.toLowerCase()));

    const tokens = lockable.map((t) => ({
      address: t.address,
      name: t.name,
      symbol: t.symbol,
      source: t.source,
      feeRecipient: feeSet.has(t.address.toLowerCase()),
      balanceRaw: t.balanceRaw !== "0" ? t.balanceRaw : undefined,
    }));

    const lines = walletHoldings.length
      ? walletHoldings.map((t) => `${t.symbol || t.name} — ${t.address}`).join("\n")
      : lockable.map((t) => `${t.symbol || t.name} — ${t.address}`).join("\n");

    const replyText =
      `Tokens you can lock on ${label} (any ERC-20 in your wallet):\n${lines || "(none indexed yet — use 0x address)"}\n\n` +
      `To lock: "lock 855M TMP on owner/repo for 10 pushes" or use a 0x contract address.`;

    res.json({
      ok: true,
      wallet,
      tokens,
      walletHoldings,
      feeRecipientTokens: feeRecipient,
      replyText,
      tweetReply: replyText,
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: err instanceof Error ? err.message : "Failed to list wallet tokens",
    });
  }
}

export async function handleAgentPrepareLock(req: Request, res: Response): Promise<void> {
  const parsed = await parseLockBody(req);
  if ("error" in parsed) {
    res.status(400).json({ ok: false, error: parsed.error });
    return;
  }

  const { wallet, repo, token, amount, totalPushes, pushesPerMilestone, chain } = parsed;
  const normalizedRepo = normalizeRepoFullName(repo);

  const repoCheck = await validateGithubRepo(normalizedRepo);
  if (!repoCheck.ok) {
    res.status(404).json({
      ok: false,
      error: repoCheck.error,
      hint: repoCheck.hint,
      suggestions: repoCheck.suggestions,
    });
    return;
  }

  const gh = await checkGithubInstallation(normalizedRepo);
  if (!gh.ok) {
    const replyText =
      `GitHub App required for ${normalizedRepo}.\n` +
      `Install: ${gh.installUrl}\n` +
      `Then retry: lock ${amount} tokens on ${normalizedRepo}`;
    res.status(400).json({
      ok: false,
      error: gh.error,
      hint: gh.hint,
      installUrl: gh.installUrl,
      replyText,
      tweetReply: replyText,
    });
    return;
  }

  try {
    const prep = await prepareLockTransactions({
      wallet: wallet as Address,
      repoFullName: normalizedRepo,
      token: token as Address,
      amount,
      totalPushes,
      pushesPerMilestone,
      chain,
    });

    const repoClaim = await getRepoClaim(normalizedRepo);
    const claimVerified =
      repoClaim?.status === "verified" && repoClaim.wallet === wallet.toLowerCase();

    const scheduleSummary =
      pushesPerMilestone === totalPushes
        ? `all tokens after ${totalPushes} verified pushes`
        : `every ${pushesPerMilestone} pushes (${totalPushes / pushesPerMilestone} releases)`;

    const replyText =
      `Ready to lock ${prep.amountFormatted} ${prep.tokenSymbol} on ${normalizedRepo}.\n` +
      `${prep.transactions.length} ${chainLabel(chain)} tx(s): ${prep.needsApprove ? "approve + lock" : "lock only"}.\n` +
      `Schedule: ${scheduleSummary}.\n\n` +
      `Bankr: submit transactions from this response, then POST confirm-lock with the lock tx hash.` +
      (prep.needsApprove
        ? `\n\nIf Bankr blocks approve (untrusted_address), use web UI: ${env.FRONTEND_URL}/create`
        : "");

    res.json({
      ok: true,
      apiBase: env.SERVER_URL,
      webFallback: `${env.FRONTEND_URL}/create`,
      wallet,
      repo: normalizedRepo,
      installationId: gh.installationId,
      ...prep,
      repoClaim: {
        verified: claimVerified,
        status: repoClaim?.status ?? "none",
        githubLogin: repoClaim?.githubLogin,
        claimUrl: `${env.SERVER_URL}/api/repo-claims/challenge`,
        verifyHint: claimVerified
          ? undefined
          : `Optional: POST /api/repo-claims/challenge then push .proofofdev/claim.json before locking`,
      },
      statusUrl: lockUrl(normalizedRepo),
      bankrPrompt: buildBankrPrompt(prep, normalizedRepo, wallet),
      bankrSubmitUrl: `${BANKR_API}/agent/submit`,
      confirmUrl: `${env.SERVER_URL}/api/agent/confirm-lock`,
      replyText,
      tweetReply: replyText,
    });
  } catch (err) {
    res.status(400).json({
      ok: false,
      error: err instanceof Error ? err.message : "Failed to prepare lock",
    });
  }
}

export async function handleAgentConfirmLock(req: Request, res: Response): Promise<void> {
  const wallet = resolveWallet(req);
  if (!wallet) {
    res.status(400).json({ ok: false, error: "wallet required" });
    return;
  }

  const repo = String(req.body?.repo ?? req.body?.repoFullName ?? req.query["repo"] ?? "").trim();
  const lockTxHash = String(req.body?.lockTxHash ?? req.body?.tx ?? req.query["lockTxHash"] ?? "").trim();

  if (!repo.includes("/")) {
    res.status(400).json({ ok: false, error: "repo required (owner/name)" });
    return;
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(lockTxHash)) {
    res.status(400).json({ ok: false, error: "lockTxHash required (0x…)" });
    return;
  }

  const chain = resolveChain(req);
  const cfg = getVestingChainConfig(chain);
  const normalizedRepo = normalizeRepoFullName(repo);
  const client = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpcUrl) });

  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: lockTxHash as Hash });
  } catch {
    res.status(400).json({ ok: false, error: `Transaction not found on ${cfg.label}` });
    return;
  }

  if (receipt.status !== "success") {
    res.status(400).json({ ok: false, error: "Lock transaction reverted on-chain" });
    return;
  }

  const logs = parseEventLogs({ abi: ESCROW_ABI, logs: receipt.logs, eventName: "Locked" });
  const locked = logs[0]?.args;
  if (!locked) {
    res.status(400).json({ ok: false, error: "No Locked event in transaction" });
    return;
  }

  if (locked.recipient.toLowerCase() !== wallet) {
    res.status(403).json({ ok: false, error: "Lock recipient does not match wallet" });
    return;
  }

  const gh = await checkGithubInstallation(normalizedRepo);
  const bankrMeta = await fetchBankrTokenInfo(locked.token);
  const chainId = cfg.chainId;
  const chainTokens =
    (knownEscrow as { chains?: Record<string, { supportedTokens?: typeof knownEscrow.supportedTokens }> })
      .chains?.[String(chainId)]?.supportedTokens ?? knownEscrow.supportedTokens;
  const streaming =
    bankrMeta !== null ||
    Object.values(chainTokens).some(
      (t) => t.streaming && t.address.toLowerCase() === locked.token.toLowerCase(),
    );

  const registerBody = {
    repoFullName: normalizedRepo,
    platform: "github" as const,
    recipient: wallet,
    token: locked.token,
    chain,
    totalLocked: locked.amount.toString(),
    totalPushesRequired: Number(locked.totalPushesRequired),
    pushesPerMilestone: Number(locked.releasesPerMilestone),
    tokensPerMilestone: locked.tokensPerMilestone.toString(),
    onChainTxHash: lockTxHash,
    installationId: gh.installationId ?? 0,
    streaming,
  };

  const mockRes = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: unknown) {
      this.body = data;
      return this;
    },
  };

  await handleRegister({ body: registerBody } as Request, mockRes as unknown as Response);

  if (mockRes.statusCode === 409) {
    const link = lockUrl(normalizedRepo);
    const replyText = `Lock already active for ${normalizedRepo}.\n${link}`;
    res.json({ ok: true, alreadyRegistered: true, replyText, tweetReply: replyText, statusUrl: link });
    return;
  }

  if (mockRes.statusCode >= 400) {
    const errBody = mockRes.body as { error?: string; hint?: string };
    res.status(mockRes.statusCode).json({
      ok: false,
      error: errBody?.error ?? "Registration failed",
      hint: errBody?.hint,
      installUrl: gh.installUrl ?? githubAppInstallUrl(),
    });
    return;
  }

  const link = lockUrl(normalizedRepo);
  const replyText =
    `GitHub vesting lock created — ${normalizedRepo}\n` +
    `${formatTokenAmount(locked.amount.toString())} locked · ` +
    `${locked.totalPushesRequired} verified pushes to complete\n\n` +
    link;

  res.json({
    ok: true,
    grant: (mockRes.body as { grant?: unknown })?.grant,
    statusUrl: link,
    replyText,
    tweetReply: replyText,
  });
}

/** One-shot: prepare lock + full Bankr execution instructions */
export async function handleAgentLock(req: Request, res: Response): Promise<void> {
  const parsed = await parseLockBody(req);
  if ("error" in parsed) {
    res.status(400).json({ ok: false, error: parsed.error });
    return;
  }

  // Delegate to prepare-lock logic by reusing handler internals
  const mockPrepareRes = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: unknown) {
      this.body = data;
      return this;
    },
  };

  await handleAgentPrepareLock(req, mockPrepareRes as unknown as Response);

  if (mockPrepareRes.statusCode >= 400) {
    res.status(mockPrepareRes.statusCode).json(mockPrepareRes.body);
    return;
  }

  const prep = mockPrepareRes.body as Record<string, unknown>;
  const repo = String(prep.repo ?? parsed.repo);
  const symbol = String(prep.tokenSymbol ?? "");
  const amount = String(prep.amountFormatted ?? parsed.amount);

  const chain = resolveChain(req);
  const label = chainLabel(chain);
  const tweetReply =
    `Locking ${amount} ${symbol} on ${repo} via Bankr.\n` +
    `Submit ${(prep.transactions as unknown[])?.length ?? 1} ${label} tx(s), then confirm.\n` +
    `Track: ${prep.statusUrl ?? lockUrl(repo)}`;

  res.json({
    ...prep,
    tweetReply,
    steps: [
      `Submit each transaction in transactions[] via Bankr wallet (agent/submit on ${label})`,
      "Wait for lock tx confirmation",
      `POST ${env.SERVER_URL}/api/agent/confirm-lock with lockTxHash`,
    ],
  });
}
