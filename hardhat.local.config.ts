/**
 * TEST-ONLY Hardhat config for local E2E (kept at the repo root so
 * Hardhat's default paths resolve normally). Runs the local node with
 * chainId 8453 so the vesting server's built-in "base" chain config
 * (viem `base`, RPC from BASE_RPC_URL) matches the local chain.
 * No keys, no external networks are used with this config.
 */
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    hardhat: { chainId: 8453 },
    localhost: { url: "http://127.0.0.1:8545", chainId: 8453 },
  },
};

export default config;
