/**
 * TEST-ONLY deploy for the LAUNCH RECOGNITION section of the fee-lock
 * driver (Codex round-2, finding 2). Local Hardhat node only.
 *
 * Deploys (all bindings against the fee suite's FeeStreamEscrow):
 *   - MockBankrLaunchRecord — plays BOTH Bankr roles for the backend
 *     (factory poolOf + ledger beneficiariesOf/creatorShareOf); the
 *     driver exports its address as BANKR_FACTORY_ADDRESS and
 *     BANKR_FEE_LEDGER_ADDRESS before the server starts.
 *   - One FeeLockVault per recognition repo (feeproj..feeproj5),
 *     bound (feeEscrow, repoId(repo), recipient) — EXCEPT feeproj3's
 *     vault, deliberately bound to a DIFFERENT repo's id.
 *   - MockVaultImpostor for feeproj2: correct-looking bindings,
 *     different bytecode (the codehash-substitution case).
 *   - A second GitEscrowV2 (escrowB) — feeproj5's lock goes there, so
 *     its Locked event comes from a non-configured escrow.
 * Launch records are set for the fee suite's PTK token with the
 * production split (deployer-as-treasury 2500 / launcher position
 * 7500) — EXCEPT feeproj4, whose record puts the recipient's RAW
 * WALLET in the launcher position (the prepared input was not used).
 * Writes tests/e2e/state-recognition.json.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const fee = JSON.parse(fs.readFileSync(path.join(__dirname, "state-fee.json"), "utf8"));
  const [deployer, oracle, recipient] = await ethers.getSigners();
  const feeEscrow = fee.feeStreamEscrow as string;
  const weth = fee.weth as string;
  const source = fee.feeClaimSource as string;
  const ptk = fee.ptk as string;
  const rid = (repo: string) => ethers.keccak256(ethers.toUtf8Bytes(repo));

  const Record = await ethers.getContractFactory("MockBankrLaunchRecord");
  const record = await Record.deploy();
  const recordAddr = await record.getAddress();

  const Vault = await ethers.getContractFactory("FeeLockVault");
  const deployVault = async (repo: string, boundRepo: string = repo) => {
    const v = await Vault.deploy(feeEscrow, weth, rid(boundRepo), recipient.address, source);
    return v.getAddress();
  };

  const vault1 = await deployVault("testowner/feeproj");
  const vault2 = await deployVault("testowner/feeproj2");
  const vault3 = await deployVault("testowner/feeproj3", "testowner/otherproj");
  const vault4 = await deployVault("testowner/feeproj4");
  const vault5 = await deployVault("testowner/feeproj5");
  // Round-3 lock-event mismatch trio: correctly-bound vaults for
  // feeproj6/7/8 — the mismatch is in the LOCK EVENT each driver
  // step presents (different repo / recipient / token), not here.
  const vault6 = await deployVault("testowner/feeproj6");
  const vault7 = await deployVault("testowner/feeproj7");
  const vault8 = await deployVault("testowner/feeproj8");

  const Impostor = await ethers.getContractFactory("MockVaultImpostor");
  const impostor = await Impostor.deploy(feeEscrow, weth, rid("testowner/feeproj2"), recipient.address, source);
  const impostorAddr = await impostor.getAddress();

  const EscrowV2 = await ethers.getContractFactory("GitEscrowV2");
  const escrowB = await EscrowV2.deploy(oracle.address);
  const escrowBAddr = await escrowB.getAddress();

  const set = async (recipients: Array<[string, number]>) => {
    // The mock's setLaunch takes the real shapes: a poolId, the
    // creator bucket derived from it (keccak256(encodePacked(poolId,
    // "creator")) — the SDK lens's derivation), and shares as wad.
    const poolId = ethers.keccak256(ethers.toUtf8Bytes(`mock-pool:${ptk.toLowerCase()}`));
    const bucketId = ethers.solidityPackedKeccak256(["bytes32", "string"], [poolId, "creator"]);
    await (await record.setLaunch(
      ptk,
      poolId,
      bucketId,
      recipients.map(([r]) => r),
      recipients.map(([, bps]) => BigInt(bps) * 10n ** 14n),
    )).wait();
  };
  // One record contract serves every repo's reads in this fixture;
  // the token is the same PTK, so records are set per registration
  // step by the driver instead — see state + run-fee-lock.sh step 20
  // note. Here we only set the DEFAULT (happy) record; the driver
  // re-sets it between registrations via set-launch-record.ts.
  await set([[deployer.address, 2500], [vault1, 7500]]);

  const state = {
    record: recordAddr,
    vault1,
    vault2,
    vault3,
    vault4,
    vault5,
    vault6,
    vault7,
    vault8,
    impostor2: impostorAddr,
    escrowB: escrowBAddr,
  };
  fs.writeFileSync(path.join(__dirname, "state-recognition.json"), JSON.stringify(state, null, 2));
  console.log("state-recognition written:", JSON.stringify(state, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
