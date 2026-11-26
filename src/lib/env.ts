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
  /** Bankr v4 launch factory + fee ledger (launch-record reads for
   *  launch recognition, src/lib/launchRecognition.ts). Default to the
   *  real Base/Robinhood addresses from the Bankr launch SDK; the E2E
   *  suites override both to a local mock implementing the same three
   *  views (poolOf / beneficiariesOf / creatorShareOf). */
  BANKR_FACTORY_ADDRESS: get("BANKR_FACTORY_ADDRESS"),
  BANKR_FEE_LEDGER_ADDRESS: get("BANKR_FEE_LEDGER_ADDRESS"),
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
  SERVER_URL: get("SERVER_URL", "http://localhost:3000"),
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
