import * as dotenv from "dotenv";
dotenv.config();

const REQUIRED_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "ORACLE_PRIVATE_KEY",
  "REDIS_URL",
  "SESSION_SECRET",
] as const;

function get(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

/**
 * Canonical public origin of this backend in production. The GitHub
 * OAuth app for this platform accepts exactly ONE Authorization
 * callback URL (https://api.proofofdev.xyz/api/oauth/github/callback),
 * so the OAuth redirect_uri — and every other public link derived from
 * SERVER_URL (magic-link OAuth URL, agent confirm/claim URLs, GitLawb
 * webhook URL) — must never point at a deployment origin
 * (*.up.railway.app) or localhost in production.
 *
 * Incident 2026-11-26: production SERVER_URL was set to the raw
 * Railway origin, so GitHub rejected every OAuth start with "The
 * redirect_uri is not associated with this application." Guard: in
 * production, an unset / localhost / *.up.railway.app SERVER_URL is
 * rejected loudly and replaced with the canonical origin instead of
 * silently breaking OAuth.
 */
const PRODUCTION_SERVER_URL = "https://api.proofofdev.xyz";

function resolveServerUrl(): string {
  const raw = get("SERVER_URL", "").trim().replace(/\/+$/, "");
  if (get("NODE_ENV", "development") === "production") {
    let host = "";
    try {
      host = new URL(raw).hostname;
    } catch {
      /* unparseable → treated as invalid below */
    }
    if (!raw || host === "localhost" || host === "127.0.0.1" || host.endsWith(".up.railway.app")) {
      console.error(
        `[env] SERVER_URL=${raw || "<unset>"} is not a public origin in production; ` +
          `using ${PRODUCTION_SERVER_URL} instead. Set SERVER_URL=${PRODUCTION_SERVER_URL} to silence this.`,
      );
      return PRODUCTION_SERVER_URL;
    }
    return raw;
  }
  return raw || "http://localhost:3000";
}

export function getMissingEnvVars(): string[] {
  return REQUIRED_KEYS.filter((key) => !get(key).trim());
}

export const env = {
  HOST: get("HOST", "0.0.0.0"),
  PORT: parseInt(get("PORT", "3000"), 10),
  NODE_ENV: get("NODE_ENV", "development"),

  // GitHub App credentials
  GITHUB_APP_ID: get("GITHUB_APP_ID"),
  GITHUB_APP_PRIVATE_KEY: get("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
  GITHUB_WEBHOOK_SECRET: get("GITHUB_WEBHOOK_SECRET"),
  GITHUB_CLIENT_ID: get("GITHUB_CLIENT_ID"),
  GITHUB_CLIENT_SECRET: get("GITHUB_CLIENT_SECRET"),
  GITHUB_BOT_USERNAME: get("GITHUB_BOT_USERNAME", "bankr-vesting[bot]"),
  /**
   * GitHub REST API base URL. TEST-ONLY override hook: defaults to the real
   * https://api.github.com and should never be set in production. It exists
   * so local tests can point the GitHub App client at a fixture API server
   * (see tests/e2e/github-fixture.js).
   */
  GITHUB_API_BASE_URL: get("GITHUB_API_BASE_URL", "https://api.github.com"),

  // Oracle signer (hot wallet that calls GitEscrow.release)
  ORACLE_PRIVATE_KEY: get("ORACLE_PRIVATE_KEY"),
  BASE_RPC_URL: get("BASE_RPC_URL", "https://mainnet.base.org"),
  BASE_SEPOLIA_RPC_URL: get("BASE_SEPOLIA_RPC_URL", "https://sepolia.base.org"),
  ROBINHOOD_RPC_URL: get("ROBINHOOD_RPC_URL", "https://rpc.mainnet.chain.robinhood.com"),
  GIT_ESCROW_ADDRESS: get("GIT_ESCROW_ADDRESS"),
  /** Legacy (pre-v2) GitEscrow on Base — the escrow all pre-cutover
   *  production grants were created under. Grants record the escrow
   *  they were created under at registration; grants WITHOUT a stored
   *  escrow resolve to this address on Base so the v2 repoint never
   *  orphans them (v1→v2 cutover, 2026-11-26). Production sets this
   *  explicitly to the pre-cutover deployment
   *  (0x3625F879C678306E92E2C27F61b9BcD8015E81A7). Unset → no legacy
   *  resolution; unstored grants use the configured escrow. */
  GIT_ESCROW_LEGACY_ADDRESS: get("GIT_ESCROW_LEGACY_ADDRESS"),
  /** GitEscrowV2 on Base — the escrow that was "current" before the
   *  V3 repoint (multi-lock cutover). After GIT_ESCROW_ADDRESS points
   *  at GitEscrowV3, this keeps the V2 deployment in the chain's known
   *  escrow list (registration parsing) and pins escrowVersionOf's
   *  version-2 identity. Unset pre-cutover. */
  GIT_ESCROW_V2_ADDRESS: get("GIT_ESCROW_V2_ADDRESS"),
  /** FeeStreamEscrow (launcher fee-lock grants) on Base — see
   *  contracts/FeeStreamEscrow.sol. Unset disables fee-tranche releases. */
  FEE_STREAM_ESCROW_ADDRESS: get("FEE_STREAM_ESCROW_ADDRESS"),
  /** GitEscrow on Base Sepolia — must NOT fall back to the mainnet address (audit M8). */
  GIT_ESCROW_SEPOLIA_ADDRESS: get("GIT_ESCROW_SEPOLIA_ADDRESS"),
  // ShipRewards pool (spec §8B) — optional; unset address or 0 amount disables rewards.
  SHIP_REWARDS_ADDRESS: get("SHIP_REWARDS_ADDRESS"),
  /** ShipRewards pool on Robinhood Chain — separate deployment, no fallback to the Base address (audit M9). */
  SHIP_REWARDS_ROBINHOOD_ADDRESS: get("SHIP_REWARDS_ROBINHOOD_ADDRESS"),
  /** Flat per-counted-merge reward, in the reward token's smallest unit (wei). */
  SHIP_REWARD_PER_MERGE: get("SHIP_REWARD_PER_MERGE"),
  /**
   * Reviewer swarm: per-reviewer reward for a PASS review in a counted
   * push's quorum, in wei. Unset → defaults to 10% of
   * SHIP_REWARD_PER_MERGE (labelled placeholder — the reviewer share of
   * the reward schedule is Gregory's open decision, spec §8B.2).
   */
  SHIP_REVIEWER_REWARD_PER_MERGE: get("SHIP_REVIEWER_REWARD_PER_MERGE"),
  /** Reviewer swarm: independent PASS reviews required to count a
   *  swarm-gated push. Unset/invalid → 2. */
  SWARM_REVIEW_QUORUM: get("SWARM_REVIEW_QUORUM"),
  /**
   * Platform reward treasury wallet — the 25% fee recipient on Proof of
   * Dev platform SDK launches (see src/lib/launchFeeConfig.ts). Must be a
   * claim-capable wallet (claims are beneficiary-signed), NOT the
   * ShipRewards contract. TODO: no dedicated wallet designated yet —
   * leave unset until Gregory designates one; platform launch-template
   * building fails closed while this is empty.
   */
  PLATFORM_REWARD_TREASURY_WALLET: get("PLATFORM_REWARD_TREASURY_WALLET"),
  /** Canonical FeeLockVault implementation hash (masked template —
   *  the executable code with immutable slots zeroed; see
   *  src/lib/launchRecognition.ts). Unset → the in-code template
   *  constant computed from this repo's compiled artifact. Set only
   *  to pin the approved implementation externally. */
  APPROVED_FEE_LOCK_VAULT_CODEHASH: get("APPROVED_FEE_LOCK_VAULT_CODEHASH"),
  /** Bankr v4 launch factory + fee ledger (launch-record reads for
   *  launch recognition, src/lib/launchRecognition.ts). Default to the
   *  real Base/Robinhood addresses from the Bankr launch SDK; the E2E
   *  suites override both to a local mock implementing the same three
   *  views (poolOf / beneficiariesOf / creatorShareOf). */
  BANKR_FACTORY_ADDRESS: get("BANKR_FACTORY_ADDRESS"),
  BANKR_FEE_LEDGER_ADDRESS: get("BANKR_FEE_LEDGER_ADDRESS"),
  /** The Bankr fee ledger a FeeLockVault CLAIMS from (its immutable
   *  claimLedger binding, validated at prepare-launch — Codex
   *  round-4). In production this is the same Bankr ledger contract
   *  as BANKR_FEE_LEDGER_ADDRESS; it is a separate knob so test
   *  fixtures can model the claim source and the launch-record
   *  ledger with two mocks. Unset → the chain's fee-ledger default. */
  BANKR_CLAIM_LEDGER_ADDRESS: get("BANKR_CLAIM_LEDGER_ADDRESS"),
  /** The chain's canonical WETH — the fee token every platform
   *  FeeLockVault must be bound to (validated at prepare-launch).
   *  Unset → the chain default (Base/Base Sepolia canonical WETH). */
  WETH_ADDRESS: get("WETH_ADDRESS"),
  /** GitEscrow on Robinhood Chain mainnet (4663) */
  GIT_ESCROW_ROBINHOOD_ADDRESS: get("GIT_ESCROW_ROBINHOOD_ADDRESS"),
  /** Optional — protects POST /api/admin/delete-grant */
  ADMIN_SECRET: get("ADMIN_SECRET"),
  /** Default chain when request omits chain: base | robinhood | base-sepolia */
  DEFAULT_VESTING_CHAIN: get("DEFAULT_VESTING_CHAIN", get("VITE_CHAIN", "base")),
  VITE_CHAIN: get("VITE_CHAIN", "base"),

  // Redis
  REDIS_URL: get("REDIS_URL"),

  // Frontend / CORS
  FRONTEND_URL: get("FRONTEND_URL", "http://localhost:5173"),
  // Public-facing URL of this backend — used for OAuth callback redirect_uri.
  // Resolved through resolveServerUrl() so production can never silently
  // fall back to a deployment origin (see the incident note above).
  SERVER_URL: resolveServerUrl(),
  SESSION_SECRET: get("SESSION_SECRET"),

  // GitLawb (optional — Base-native git for agents)
  GITLAWB_NODE_URL: get("GITLAWB_NODE_URL", "https://node.gitlawb.com"),
  GITLAWB_WEBHOOK_SECRET: get("GITLAWB_WEBHOOK_SECRET", ""),
};

/** CORS origins: FRONTEND_URL plus optional CORS_ORIGINS, and www/apex twin. */
export function getAllowedCorsOrigins(): string[] {
  const origins = new Set<string>();
  const base = env.FRONTEND_URL.replace(/\/$/, "");
  if (base) origins.add(base);

  for (const part of get("CORS_ORIGINS", "").split(",")) {
    const trimmed = part.trim().replace(/\/$/, "");
    if (trimmed) origins.add(trimmed);
  }

  try {
    const u = new URL(base || "http://localhost:5173");
    const port = u.port ? `:${u.port}` : "";
    if (u.hostname.startsWith("www.")) {
      origins.add(`${u.protocol}//${u.hostname.slice(4)}${port}`);
    } else if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
      origins.add(`${u.protocol}//www.${u.hostname}${port}`);
    }
  } catch {
    /* ignore malformed FRONTEND_URL */
  }

  return [...origins];
}
