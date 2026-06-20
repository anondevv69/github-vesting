import * as dotenv from "dotenv";
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

export const env = {
  PORT: parseInt(optional("PORT", "3000"), 10),
  NODE_ENV: optional("NODE_ENV", "development"),

  // GitHub App credentials
  GITHUB_APP_ID: required("GITHUB_APP_ID"),
  GITHUB_APP_PRIVATE_KEY: required("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
  GITHUB_WEBHOOK_SECRET: required("GITHUB_WEBHOOK_SECRET"),
  GITHUB_CLIENT_ID: required("GITHUB_CLIENT_ID"),
  GITHUB_CLIENT_SECRET: required("GITHUB_CLIENT_SECRET"),
  GITHUB_BOT_USERNAME: optional("GITHUB_BOT_USERNAME", "bankr-vesting[bot]"),

  // Oracle signer (hot wallet that calls GitEscrow.release)
  ORACLE_PRIVATE_KEY: required("ORACLE_PRIVATE_KEY"),
  BASE_RPC_URL: optional("BASE_RPC_URL", "https://mainnet.base.org"),
  BASE_SEPOLIA_RPC_URL: optional("BASE_SEPOLIA_RPC_URL", "https://sepolia.base.org"),
  GIT_ESCROW_ADDRESS: optional("GIT_ESCROW_ADDRESS"),

  // Redis
  REDIS_URL: required("REDIS_URL"),

  // Frontend / CORS
  FRONTEND_URL: optional("FRONTEND_URL", "http://localhost:5173"),
  // Public-facing URL of this backend — used for OAuth callback redirect_uri.
  // Set to the ngrok URL when running locally, or the deployed URL in prod.
  SERVER_URL: optional("SERVER_URL", "http://localhost:3000"),
  SESSION_SECRET: required("SESSION_SECRET"),

  // GitLawb (optional — Base-native git for agents)
  GITLAWB_NODE_URL: optional("GITLAWB_NODE_URL", "https://node.gitlawb.com"),
  GITLAWB_WEBHOOK_SECRET: optional("GITLAWB_WEBHOOK_SECRET", ""),
};
