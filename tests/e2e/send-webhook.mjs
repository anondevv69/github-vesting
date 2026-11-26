/**
 * TEST-ONLY webhook sender: builds a GitHub push payload, HMAC-SHA256
 * signs it with the test webhook secret, POSTs it to the local server.
 * Usage: REPO=owner/repo node tests/e2e/send-webhook.mjs <case>
 *   case = plain | docs | squash | prhuman | prbot | gl44 | gl45 | gldocs
 *        | swarm47 | swarm48 (reviewer-swarm driver, grant repo)
 *   REPO defaults to testowner/testrepo; the gl* cases target
 *   testowner/nogrant (the grant-less repo) and need the fixture GitHub
 *   API running (github-fixture.js) with the server started with
 *   GITHUB_API_BASE_URL pointing at it.
 */
import { createHmac } from "crypto";

const SECRET = "test-webhook-secret";
const URL = "http://127.0.0.1:3210/api/webhook/github";

const codeFiles = (prefix, n) =>
  Array.from({ length: n }, (_, i) => `src/feature/${prefix}${i + 1}.ts`);

const CASES = {
  plain: {
    after: "a11ce00000000000000000000000000000000001",
    message: "feat: add feature module",
    added: codeFiles("f", 11),
    modified: [],
  },
  plain2: {
    after: "b22ce00000000000000000000000000000000004",
    message: "feat: second feature module",
    added: codeFiles("h", 11),
    modified: [],
  },
  plain3: {
    after: "c33ce00000000000000000000000000000000005",
    message: "feat: third feature module",
    added: codeFiles("i", 11),
    modified: [],
  },
  small: {
    after: "d44ce00000000000000000000000000000000006",
    message: "feat: tiny change",
    added: codeFiles("t", 1),
    modified: [],
  },
  small2: {
    after: "e55ce00000000000000000000000000000000007",
    message: "feat: another tiny change",
    added: codeFiles("u", 1),
    modified: [],
  },
  docs: {
    after: "d0c500000000000000000000000000000000000002",
    message: "docs: update readme",
    added: ["README.md", "docs/guide.md"],
    modified: [],
  },
  latedocs: {
    after: "1a7e000000000000000000000000000000000001",
    message: "docs: update readme again",
    added: ["README.md", "docs/guide.md"],
    modified: [],
  },
  squash: {
    after: "59aa550000000000000000000000000000000003",
    message: "feat: shiny thing (#42)",
    added: codeFiles("g", 11),
    modified: [],
  },
  // Positive PR-credit cases: `after` MUST equal the fixture API's
  // merge_commit_sha for the PR (tests/e2e/github-fixture.js).
  prhuman: {
    after: "c0ffee0000000000000000000000000000000042",
    message: "feat: shiny thing (#42)",
    added: codeFiles("p", 11),
    modified: [],
  },
  prbot: {
    after: "b070000000000000000000000000000000000043",
    message: "chore: bump deps (#43)",
    added: codeFiles("b", 11),
    modified: [],
  },
  // Grant-less cases (REPO=testowner/nogrant): `after` MUST equal the
  // fixture API's merge_commit_sha for the PR (github-fixture.js).
  gl44: {
    after: "44".repeat(20),
    message: "feat: grantless thing (#44)",
    added: codeFiles("n", 11),
    modified: [],
  },
  gl45: {
    after: "45".repeat(20),
    message: "feat: ghost thing (#45)",
    added: codeFiles("h", 11),
    modified: [],
  },
  gldocs: {
    after: "dd".repeat(20),
    message: "docs: update readme",
    added: ["README.md", "docs/guide.md"],
    modified: [],
  },
  // Reviewer-swarm cases (grant repo testowner/testrepo): `after` MUST
  // equal the fixture API's merge_commit_sha for PRs #47/#48.
  swarm47: {
    after: "47".repeat(20),
    message: "feat: swarm-reviewed thing (#47)",
    added: codeFiles("s", 11),
    modified: [],
  },
  swarm48: {
    after: "48".repeat(20),
    message: "feat: same code again (#48)",
    added: codeFiles("s", 11),
    modified: [],
  },
  // Mandatory-window suite cases: PRs #49/#50/#51 (distinct diffs).
  swarm49: {
    after: "49".repeat(20),
    message: "feat: window quorum thing (#49)",
    added: codeFiles("w", 11),
    modified: [],
  },
  swarm50: {
    after: "50".repeat(20),
    message: "feat: window veto thing (#50)",
    added: codeFiles("x", 11),
    modified: [],
  },
  swarm51: {
    after: "51".repeat(20),
    message: "feat: window fallback thing (#51)",
    added: codeFiles("y", 11),
    modified: [],
  },
};

const c = CASES[process.argv[2]];
if (!c) {
  console.error("unknown case:", process.argv[2]);
  process.exit(1);
}
// ensure valid 40-char hex sha
c.after = c.after.padEnd(40, "0").slice(0, 40);

const payload = {
  ref: "refs/heads/main",
  forced: false,
  before: "0".repeat(40),
  after: c.after,
  commits: [
    {
      id: c.after,
      message: c.message,
      added: c.added,
      removed: [],
      modified: c.modified,
      timestamp: new Date().toISOString(),
    },
  ],
  repository: { full_name: process.env.REPO ?? "testowner/testrepo" },
  pusher: { name: "testdev" },
  sender: { login: "testdev", type: "User" },
};

const body = JSON.stringify(payload);
const sig = "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");

const started = Date.now();
const res = await fetch(URL, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-hub-signature-256": sig,
    "x-github-event": "push",
  },
  body,
});
const text = await res.text();
console.log(`[webhook:${process.argv[2]}] HTTP ${res.status} in ${Date.now() - started}ms`);
console.log(text);
