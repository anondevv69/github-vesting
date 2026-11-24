/**
 * TEST-ONLY: link a wallet to a GitHub login through the REAL Flow A HTTP
 * endpoints (POST /api/dev/link-wallet/challenge → personal_sign →
 * POST /api/dev/link-wallet/confirm). The GitHub session is created
 * directly in Redis via the repo's own createGithubSession (standing in
 * for the OAuth login a browser would do); everything after that goes
 * over HTTP exactly as the site's link flow does.
 *
 * Env: LINK_LOGIN (default "ghostdev"), LINK_KEY (test private key whose
 * address gets linked). Prints LINK_WALLET=<address> for the driver.
 * Run with the same test env as the server (REDIS_URL etc.).
 */
import { privateKeyToAccount } from "viem/accounts";
import { createGithubSession } from "../../src/lib/githubSession";

const API = "http://127.0.0.1:3210";
const LOGIN = process.env.LINK_LOGIN ?? "ghostdev";
const KEY = (process.env.LINK_KEY ?? `0x${"22".repeat(32)}`) as `0x${string}`;

async function main() {
  const account = privateKeyToAccount(KEY);
  console.log(`LINK_WALLET=${account.address}`);

  const sessionId = await createGithubSession({
    login: LOGIN,
    id: 987654,
    name: null,
    avatarUrl: "",
    accessToken: "test-access-token",
  });
  const cookie = `github_vesting_session=${sessionId}`;

  const chRes = await fetch(`${API}/api/dev/link-wallet/challenge`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "x-wallet-address": account.address },
    body: "{}",
  });
  const ch = (await chRes.json()) as { ok?: boolean; signMessage?: string; error?: string };
  console.log("challenge:", JSON.stringify(ch));
  if (!ch.ok || !ch.signMessage) throw new Error(`challenge failed: ${ch.error ?? chRes.status}`);

  const signature = await account.signMessage({ message: ch.signMessage });

  const cfRes = await fetch(`${API}/api/dev/link-wallet/confirm`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ wallet: account.address, signature, signMessage: ch.signMessage }),
  });
  const cf = (await cfRes.json()) as { ok?: boolean; error?: string };
  console.log("confirm:", JSON.stringify(cf));
  if (!cf.ok) throw new Error(`confirm failed: ${cf.error ?? cfRes.status}`);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
