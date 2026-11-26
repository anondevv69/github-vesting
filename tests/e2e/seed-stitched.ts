/**
 * TEST-ONLY seed for the stitched E2E suite: wallet links ONLY.
 * The grant itself is created through POST /api/vesting/register in
 * the driver (stage 5) — nothing is pre-seeded, so the stitched run
 * exercises the real registration path.
 *   @testowner -> recipient (the launcher wallet; verify-github
 *                 requires the launch wallet linked to the login)
 *   @testauthor -> author (PR #42's author; the per-merge reward
 *                 pays the author's linked wallet)
 */
import * as fs from "fs";
import * as path from "path";
import { addLinkedWallet } from "../../src/lib/devWallets";

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state-stitched.json"), "utf8"));
  const ownerWallets = await addLinkedWallet("testowner", state.recipient, "signed");
  console.log("linked wallets for @testowner:", JSON.stringify(ownerWallets));
  const authorWallets = await addLinkedWallet("testauthor", state.author, "signed");
  console.log("linked wallets for @testauthor:", JSON.stringify(authorWallets));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
