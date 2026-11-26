/**
 * TEST-ONLY: register the stitched repo's fee grant through the
 * round-3 REGISTRAR path — FeeStreamEscrow.registerFeeGrant is
 * onlyOwner, and the deployer (Hardhat #0) is the escrow owner.
 * Exact fields: recipient = launcher claim wallet, token = WETH,
 * vault = the project's FeeLockVault, pushesPerTranche = 2. The
 * contract validates the vault's bindings on-chain before
 * accepting. Prints the stored grant for driver assertions.
 * Local Hardhat node only.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state-stitched.json"), "utf8"));
  const [deployer] = await ethers.getSigners();
  const feeEscrow = await ethers.getContractAt("FeeStreamEscrow", state.feeStreamEscrow);
  const tx = await feeEscrow
    .connect(deployer)
    .registerFeeGrant(state.repoId, state.recipient, state.weth, state.feeLockVault, 2);
  await tx.wait();
  console.log(`FEE_GRANT_REGISTERED tx=${tx.hash}`);
  const g = await feeEscrow.feeGrants(state.repoId);
  console.log(
    `FEE_GRANT recipient=${g.recipient} token=${g.token} vault=${g.vault} pushesPerTranche=${g.pushesPerTranche} registered=${g.registered}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
