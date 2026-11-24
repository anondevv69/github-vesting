/**
 * TEST-ONLY client for the ship-report (attestation) endpoints.
 * Usage:
 *   node tests/e2e/ship-report.mjs post <case>     POST a report for a case sha
 *   node tests/e2e/ship-report.mjs get <sha>       GET one report
 *   node tests/e2e/ship-report.mjs list            GET recent reports for the repo
 *   node tests/e2e/ship-report.mjs post-raw <json> POST a raw body (malformed tests)
 * Cases mirror send-webhook.mjs `after` SHAs exactly (same pad/slice).
 */
const BASE = "http://127.0.0.1:3210";
const REPO = "testowner/testrepo";

const norm = (s) => s.padEnd(40, "0").slice(0, 40);
export const SHAS = {
  prhuman: norm("c0ffee0000000000000000000000000000000042"),
  docs: norm("d0c500000000000000000000000000000000000002"),
  orphan: norm("e11e00000000000000000000000000000000000099"),
  old: norm("01d000000000000000000000000000000000000077"),
};

const [cmd, arg, extra] = process.argv.slice(2);

async function main() {
  if (cmd === "post") {
    const sha = SHAS[arg];
    if (!sha) throw new Error(`unknown case ${arg}`);
    const body = { repo: REPO, headSha: sha };
    if (arg === "prhuman") {
      body.prNumber = 42;
      body.authorLogin = "testauthor";
    }
    const res = await fetch(`${BASE}/api/agent/report-ship`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    console.log(`[report:post:${arg}] HTTP ${res.status}`);
    console.log(await res.text());
    return;
  }
  if (cmd === "post-raw") {
    const res = await fetch(`${BASE}/api/agent/report-ship`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: arg,
    });
    console.log(`[report:post-raw] HTTP ${res.status}`);
    console.log(await res.text());
    return;
  }
  if (cmd === "get") {
    const sha = SHAS[arg] ?? norm(arg);
    const res = await fetch(
      `${BASE}/api/agent/ship-report?repo=${encodeURIComponent(REPO)}&sha=${sha}`,
    );
    console.log(`[report:get:${arg}] HTTP ${res.status}`);
    console.log(await res.text());
    return;
  }
  if (cmd === "list") {
    const res = await fetch(
      `${BASE}/api/agent/ship-reports?repo=${encodeURIComponent(REPO)}`,
    );
    console.log(`[report:list] HTTP ${res.status}`);
    console.log(await res.text());
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
