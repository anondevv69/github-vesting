/**
 * TEST-ONLY: set the MockBankrLaunchRecord's fee recipients for the
 * fee suite's PTK token (the recognition registrations each need a
 * different "actual launch" record). Local Hardhat node only.
 *   RECORD=0x… RECIPIENTS_JSON='[["0x…",2500],["0x…",7500]]' \
 *     npx hardhat run … tests/e2e/set-launch-record.ts
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const recordAddr = process.env.RECORD;
  const recipientsJson = process.env.RECIPIENTS_JSON;
  if (!recordAddr || !recipientsJson) throw new Error("RECORD and RECIPIENTS_JSON env required");
  const fee = JSON.parse(fs.readFileSync(path.join(__dirname, "state-fee.json"), "utf8"));
  const recipients = JSON.parse(recipientsJson) as Array<[string, number]>;
  const record = await ethers.getContractAt("MockBankrLaunchRecord", recordAddr);
  const poolId = ethers.keccak256(ethers.toUtf8Bytes(`mock-pool:${(fee.ptk as string).toLowerCase()}`));
  const bucketId = ethers.solidityPackedKeccak256(["bytes32", "string"], [poolId, "creator"]);
  const tx = await record.setLaunch(
    fee.ptk,
    poolId,
    bucketId,
    recipients.map(([r]) => r),
    recipients.map(([, bps]) => BigInt(bps) * 10n ** 14n),
  );
  await tx.wait();
  console.log("RECORD_SET", recordAddr, JSON.stringify(recipients));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
