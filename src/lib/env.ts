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
  GIT_ESCROW_ADDRESS: get("GIT_ESCROW_ADDRESS"),

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
