/**
 * Canonical FeeLockVault implementation guard (Codex round-3,
 * blocker 2). Run: npx hardhat run tests/vault-impl-test.ts
 *
 * The platform has ONE approved FeeLockVault implementation. Because
 * the contract's immutables are embedded in its deployed code, a raw
 * codehash differs per project; identity is the MASKED-TEMPLATE hash
 * (immutable slots zeroed) computed in src/lib/launchRecognition.ts.
 * This test pins the relationship between the contract source and
 * that constant:
 *  1. The template parameters embedded in launchRecognition
 *     (byteLength + immutable offsets) equal the ones in the CURRENT
 *     compiled artifact's build-info — if the contract source
 *     changes, this fails until the constant is deliberately updated
 *     in the same commit.
 *  2. The artifact's masked hash equals APPROVED_VAULT_TEMPLATE.codehash
 *     and canonicalVaultCodehash().
 *  3. Two live vault instances with DIFFERENT immutable bindings
 *     share the canonical implementation hash.
 *  4. A different contract exposing the same getters
 *     (MockVaultImpostor) does NOT match — getters alone are not
 *     identity.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import {
  APPROVED_VAULT_TEMPLATE,
  canonicalVaultCodehash,
  vaultImplCodehash,
} from "../src/lib/launchRecognition";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra !== undefined ? ` (${String(extra)})` : ""}`);
  if (!cond) failures++;
}

async function main() {
  // 1+2. Artifact ↔ constant agreement.
  const artifact = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "artifacts", "contracts", "FeeLockVault.sol", "FeeLockVault.json"),
      "utf8",
    ),
  ) as { deployedBytecode: string };
  const template = artifact.deployedBytecode.replace(/^0x/, "");
  let artifactOffsets: Array<[number, number]> | null = null;
  const buildInfoDir = path.join(__dirname, "..", "artifacts", "build-info");
  for (const f of fs.readdirSync(buildInfoDir)) {
    const d = JSON.parse(fs.readFileSync(path.join(buildInfoDir, f), "utf8")) as {
      output?: { contracts?: Record<string, Record<string, {
        evm: { deployedBytecode: { object: string; immutableReferences?: Record<string, Array<{ start: number; length: number }>> } };
      }>> };
    };
    const c = d.output?.contracts?.["contracts/FeeLockVault.sol"]?.FeeLockVault;
    if (c && c.evm.deployedBytecode.object === template) {
      artifactOffsets = Object.values(c.evm.deployedBytecode.immutableReferences ?? {})
        .flat()
        .map((o) => [o.start, o.length] as [number, number])
        .sort((a, b) => a[0] - b[0]);
      break;
    }
  }
  check("build-info for the current FeeLockVault artifact found", artifactOffsets !== null);
  check(
    "embedded template byteLength matches the artifact",
    APPROVED_VAULT_TEMPLATE.byteLength === template.length / 2,
    `${APPROVED_VAULT_TEMPLATE.byteLength} vs ${template.length / 2}`,
  );
  check(
    "embedded immutable offsets match the artifact's immutableReferences",
    JSON.stringify(APPROVED_VAULT_TEMPLATE.immutableOffsets) === JSON.stringify(artifactOffsets),
  );
  const artifactMasked = vaultImplCodehash(artifact.deployedBytecode as `0x${string}`);
  check(
    "artifact masked hash equals the embedded canonical constant",
    artifactMasked === APPROVED_VAULT_TEMPLATE.codehash,
    artifactMasked,
  );
  check(
    "canonicalVaultCodehash() returns the artifact hash (no env override in tests)",
    canonicalVaultCodehash() === artifactMasked,
  );

  // 3+4. Live instances.
  const [deployer, oracle, recipient] = await ethers.getSigners();
  const Mock = await ethers.getContractFactory("MockERC20");
  const weth = await Mock.deploy("Wrapped Ether", "WETH", 18);
  const wethAddr = await weth.getAddress();
  const Source = await ethers.getContractFactory("MockFeeClaimSource");
  const source = await Source.deploy(wethAddr);
  const sourceAddr = await source.getAddress();
  const FeeEscrow = await ethers.getContractFactory("FeeStreamEscrow");
  const feeEscrow = await FeeEscrow.deploy(oracle.address);
  const feeEscrowAddr = await feeEscrow.getAddress();

  const Vault = await ethers.getContractFactory("FeeLockVault");
  const repoA = ethers.keccak256(ethers.toUtf8Bytes("testowner/proj-a"));
  const repoB = ethers.keccak256(ethers.toUtf8Bytes("testowner/proj-b"));
  const v1 = await Vault.deploy(feeEscrowAddr, wethAddr, repoA, recipient.address, sourceAddr);
  const v2 = await Vault.deploy(feeEscrowAddr, wethAddr, repoB, deployer.address, sourceAddr);
  const code1 = (await ethers.provider.getCode(await v1.getAddress())) as `0x${string}`;
  const code2 = (await ethers.provider.getCode(await v2.getAddress())) as `0x${string}`;
  check("two genuine vaults have different RAW codehashes (immutables embedded)", ethers.keccak256(code1) !== ethers.keccak256(code2));
  check("vault instance A matches the canonical implementation", vaultImplCodehash(code1) === canonicalVaultCodehash());
  check("vault instance B (different bindings) matches the canonical implementation", vaultImplCodehash(code2) === canonicalVaultCodehash());

  const Impostor = await ethers.getContractFactory("MockVaultImpostor");
  const imp = await Impostor.deploy(feeEscrowAddr, wethAddr, repoA, recipient.address, sourceAddr);
  const impCode = (await ethers.provider.getCode(await imp.getAddress())) as `0x${string}`;
  check("impostor with the same getters does NOT match the canonical implementation", vaultImplCodehash(impCode) !== canonicalVaultCodehash());

  console.log(`\nvault-impl: ${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
