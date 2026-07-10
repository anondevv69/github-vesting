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

  // Oracle signer (hot wallet that calls GitEscrow.release)
  ORACLE_PRIVATE_KEY: get("ORACLE_PRIVATE_KEY"),
  BASE_RPC_URL: get("BASE_RPC_URL", "https://mainnet.base.org"),
  BASE_SEPOLIA_RPC_URL: get("BASE_SEPOLIA_RPC_URL", "https://sepolia.base.org"),
  ROBINHOOD_RPC_URL: get("ROBINHOOD_RPC_URL", "https://rpc.mainnet.chain.robinhood.com"),
  GIT_ESCROW_ADDRESS: get("GIT_ESCROW_ADDRESS"),
  /** GitEscrow on Robinhood Chain mainnet (4663) */
  GIT_ESCROW_ROBINHOOD_ADDRESS: get("GIT_ESCROW_ROBINHOOD_ADDRESS"),
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
