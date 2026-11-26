import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { repoIdFromFullName } from "../../src/lib/repoId";
import { saveLaunchOnboarding } from "../../src/lib/redis";

/**
 * Resumability fixture: simulates an onboarding attempt that deployed
 * the FeeLockVault and then FAILED at grant registration (crash,
 * registrar tx failure, …). It deploys a genuine vault for
 * testauthor/resumerepo with the exact platform bindings and records
 * the partial onboarding state (status vault_deployed, deploy tx
 * recorded, NO grant registered) — then run-onboard.sh calls
 * POST /api/launch/onboard and proves the retry registers the grant
 * against THIS vault instead of deploying a second one.
 */
async function main() {
  const state = JSON.parse(
    fs.readFileSync(path.join(__dirname, "state-onboard.json"), "utf8"),
  ) as { escrow: string; weth: string; source: string; recipient: string };

  const signers = await ethers.getSigners();
  const oracle = signers[1]!;
  const repo = "testauthor/resumerepo";
  const repoId = repoIdFromFullName(repo);

  const Vault = await ethers.getContractFactory("FeeLockVault", oracle);
  const vault = await Vault.deploy(
    state.escrow,
    state.weth,
    `0x${repoId}`,
    state.recipient,
    state.source,
  );
  await vault.waitForDeployment();
  const vaultAddress = (await vault.getAddress()).toLowerCase();
  const deployTx = vault.deploymentTransaction()?.hash ?? "";

  const now = new Date().toISOString();
  await saveLaunchOnboarding({
    repo,
    wallet: state.recipient.toLowerCase(),
    chain: "base",
    chainId: 8453,
    repoId,
    githubLogin: "testauthor",
    feeLockVault: vaultAddress,
    feePushesPerTranche: 2,
    status: "vault_deployed",
    deployTxHash: deployTx,
    lastError: "simulated registration failure (fixture)",
    createdAt: now,
    updatedAt: now,
  });

  fs.writeFileSync(
    path.join(__dirname, "state-onboard-partial.json"),
    JSON.stringify({ repo, vault: vaultAddress, deployTx }, null, 2),
  );
  console.log("partial onboarding seeded:", { repo, vault: vaultAddress, deployTx });
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
