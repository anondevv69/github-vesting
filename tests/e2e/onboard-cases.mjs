/**
 * Onboarding cases for run-onboard.sh (HTTP-level, real backend).
 *
 * Env: ONBOARD_STATE (path to state-onboard.json),
 *      ONBOARD_PARTIAL_STATE (path to state-onboard-partial.json).
 * Prints PASS/FAIL lines + a final "ONBOARD_CASES pass=N fail=M".
 */
import * as fs from "fs";

const API = process.env.ONBOARD_API ?? "http://127.0.0.1:3210";
const state = JSON.parse(fs.readFileSync(process.env.ONBOARD_STATE, "utf8"));
const partial = JSON.parse(fs.readFileSync(process.env.ONBOARD_PARTIAL_STATE, "utf8"));
const RECIPIENT = state.recipient;
const REPO = "testauthor/onboardrepo";

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`PASS: ${name}`);
  } else {
    fail++;
    console.log(`FAIL: ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

async function post(path, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch { /* leave null */ }
  return { status: res.status, json };
}

async function verify(repo) {
  const r = await post("/api/launch/verify-github", {
    githubLogin: "testauthor",
    repo,
    wallet: RECIPIENT,
    chain: "base",
  });
  if (!r.json?.verificationToken) throw new Error(`verify failed for ${repo}: ${JSON.stringify(r.json)}`);
  return r.json.verificationToken;
}

// ── 1. Unauthenticated refusal (fail closed, nothing deployed) ──────
{
  const noToken = await post("/api/launch/onboard", { repo: REPO, wallet: RECIPIENT, chain: "base" });
  check("onboard with NO token is refused 403", noToken.status === 403, `got ${noToken.status}`);
  check(
    "no-token refusal code is LAUNCH_VERIFICATION_REQUIRED",
    noToken.json?.code === "LAUNCH_VERIFICATION_REQUIRED",
    `got ${noToken.json?.code}`,
  );
  const garbage = await post("/api/launch/onboard", {
    repo: REPO,
    wallet: RECIPIENT,
    chain: "base",
    verificationToken: "aaaa.bbbb",
  });
  check("onboard with a GARBAGE token is refused 403", garbage.status === 403, `got ${garbage.status}`);
}

// ── 2. First onboard: deploys one vault + registers the grant ───────
const token1 = await verify(REPO);
const first = await post("/api/launch/onboard", {
  repo: REPO,
  wallet: RECIPIENT,
  chain: "base",
  verificationToken: token1,
  feePushesPerTranche: 2,
});
check("first onboard succeeds (200)", first.status === 200 && first.json?.ok === true, JSON.stringify(first.json));
const vault1 = first.json?.feeLockVault ?? "";
check("first onboard returns a vault address", /^0x[0-9a-f]{40}$/.test(vault1), vault1);
check(
  "first onboard is not flagged alreadyOnboarded",
  first.json?.alreadyOnboarded === false,
  `got ${first.json?.alreadyOnboarded}`,
);
check(
  "first onboard reports the grant registered against the vault",
  first.json?.feeGrant?.registered === true &&
    first.json?.feeGrant?.vault === vault1 &&
    first.json?.feeGrant?.recipient === RECIPIENT.toLowerCase() &&
    first.json?.feeGrant?.token === state.weth.toLowerCase() &&
    first.json?.feeGrant?.pushesPerTranche === 2,
  JSON.stringify(first.json?.feeGrant),
);
check(
  "first onboard logs deploy + register tx hashes",
  /^0x[0-9a-f]{64}$/.test(first.json?.deployTxHash ?? "") &&
    /^0x[0-9a-f]{64}$/.test(first.json?.registerTxHash ?? ""),
  JSON.stringify({ d: first.json?.deployTxHash, r: first.json?.registerTxHash }),
);

// ── 3. The onboarded vault passes prepare-launch's own checks ───────
{
  const prep = await post(
    "/api/launch/prepare-launch",
    {
      repo: REPO,
      wallet: RECIPIENT,
      chain: "base",
      verificationToken: token1,
      feeLockVault: vault1,
      feePushesPerTranche: 2,
      launch: { name: "Onboard Token", symbol: "ONBD" },
    },
    { "x-wallet-address": RECIPIENT },
  );
  check(
    "prepare-launch ACCEPTS the onboarded vault (bindings + grant + impl)",
    prep.status === 200 && prep.json?.prepared === true,
    JSON.stringify(prep.json),
  );
  const recips = prep.json?.launchInput?.feeRecipients ?? [];
  check(
    "prepare-launch names the onboarded vault as the 75% fee recipient",
    recips.some((r) => r.recipient?.toLowerCase() === vault1 && r.shareBps === 7500),
    JSON.stringify(recips),
  );
}

// ── 4. Idempotency: second onboard returns the same vault ───────────
{
  const again = await post("/api/launch/onboard", {
    repo: REPO,
    wallet: RECIPIENT,
    chain: "base",
    verificationToken: token1,
    feePushesPerTranche: 2,
  });
  check("second onboard succeeds (200)", again.status === 200 && again.json?.ok === true, JSON.stringify(again.json));
  check(
    "second onboard returns the SAME vault (no duplicate deployment)",
    again.json?.feeLockVault === vault1,
    `first=${vault1} second=${again.json?.feeLockVault}`,
  );
  check(
    "second onboard is flagged alreadyOnboarded",
    again.json?.alreadyOnboarded === true,
    `got ${again.json?.alreadyOnboarded}`,
  );
  check(
    "second onboard reports the same deploy tx (nothing re-deployed)",
    again.json?.deployTxHash === first.json?.deployTxHash,
    `first=${first.json?.deployTxHash} second=${again.json?.deployTxHash}`,
  );
}

// ── 5. Token binding: repo A's token cannot onboard repo B ──────────
{
  const cross = await post("/api/launch/onboard", {
    repo: partial.repo,
    wallet: RECIPIENT,
    chain: "base",
    verificationToken: token1,
  });
  check(
    "onboard with a token bound to another repo is refused 403",
    cross.status === 403 && cross.json?.code === "LAUNCH_TOKEN_REPO_MISMATCH",
    `got ${cross.status} ${cross.json?.code}`,
  );
}

// ── 6. Resumability: partial state completes against the SAME vault ──
{
  const token2 = await verify(partial.repo);
  const resumed = await post("/api/launch/onboard", {
    repo: partial.repo,
    wallet: RECIPIENT,
    chain: "base",
    verificationToken: token2,
  });
  check("resume onboard succeeds (200)", resumed.status === 200 && resumed.json?.ok === true, JSON.stringify(resumed.json));
  check(
    "resume registers against the EXISTING vault (no second deployment)",
    resumed.json?.feeLockVault === partial.vault,
    `expected=${partial.vault} got=${resumed.json?.feeLockVault}`,
  );
  check(
    "resume preserves the original deploy tx hash",
    resumed.json?.deployTxHash === partial.deployTx,
    `expected=${partial.deployTx} got=${resumed.json?.deployTxHash}`,
  );
  check(
    "resume reports the grant now registered",
    resumed.json?.feeGrant?.registered === true && resumed.json?.feeGrant?.vault === partial.vault,
    JSON.stringify(resumed.json?.feeGrant),
  );
  const prep = await post(
    "/api/launch/prepare-launch",
    {
      repo: partial.repo,
      wallet: RECIPIENT,
      chain: "base",
      verificationToken: token2,
      feeLockVault: partial.vault,
      launch: { name: "Resume Token", symbol: "RSME" },
    },
    { "x-wallet-address": RECIPIENT },
  );
  check(
    "prepare-launch ACCEPTS the resumed vault too",
    prep.status === 200 && prep.json?.prepared === true,
    JSON.stringify(prep.json),
  );
  const again = await post("/api/launch/onboard", {
    repo: partial.repo,
    wallet: RECIPIENT,
    chain: "base",
    verificationToken: token2,
  });
  check(
    "resumed project is idempotent afterwards",
    again.json?.alreadyOnboarded === true && again.json?.feeLockVault === partial.vault,
    JSON.stringify(again.json),
  );
}

console.log(`ONBOARD_CASES pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
