/**
 * TEST-ONLY fixture GitHub REST API server.
 *
 * Implements just enough of the GitHub App + Pulls API for prCredit.ts to
 * resolve a merged PR against it, when the vesting server is started with
 * GITHUB_API_BASE_URL=http://127.0.0.1:8977 (see src/github/githubApp.ts —
 * the env hook defaults to https://api.github.com in production).
 *
 * Endpoints served (any repo in REPOS below):
 *   GET  /repos/:owner/:repo/installation                 -> { id: 777 }
 *   POST /app/installations/777/access_tokens              -> fake token
 *   GET  /repos/:owner/:repo/pulls/:n                      -> PR meta
 *   GET  /repos/:owner/:repo/pulls/:n/files                -> PR files
 *   GET  /repos/:owner/:repo                               -> repo metadata
 *        (owner = :owner; used by the launch gate's ownership check and
 *        by validateRepoAccess)
 *   GET  /repos/:owner/:repo/collaborators/:user/permission
 *        -> { permission: "admin" } when :user == :owner, else "read"
 *
 * Launch-gate fixtures (run-launch-gate.sh):
 *   any repo named "notinstalled"  -> installation lookup 404s (app absent)
 *   testauthor/launchrepo          -> installed, owned by testauthor
 *   otherowner/theirrepo           -> installed, owned by otherowner
 *
 * Repos:
 *   testowner/testrepo — the grant repo (seed.ts):
 *     PR #42 merged, human author (@testauthor)
 *     PR #43 merged, bot author (dependabot[bot])
 *     PR #47 merged, human author (@testauthor) — swarm happy path
 *     PR #48 merged, human author (@testauthor) — swarm duplicate case:
 *       its file list is IDENTICAL to PR #47's, so its diff fingerprint
 *       exactly equals PR #47's counted fingerprint
 *     PRs #49/#50/#51 merged, human author (@testauthor) — swarm
 *       mandatory-window suite (run-swarm-window.sh): distinct diffs
 *       for the quorum / FAIL-veto / 1-PASS-fallback cases
 *   testowner/nogrant — NO vesting grant (grant-less reward tests):
 *     PR #44 merged, human author (@testauthor, wallet linked)
 *     PR #45 merged, human author (@ghostdev, NO wallet linked)
 *
 * The merge_commit_sha values below MUST match the `after` SHAs used by
 * the matching cases in send-webhook.mjs (prCredit refuses to credit a
 * push whose head SHA is not the PR's merge commit).
 */
const http = require("http");

const HUMAN_SHA = "c0ffee0000000000000000000000000000000042";
const BOT_SHA = "b070000000000000000000000000000000000043";
const SWARM_SHA = "47".repeat(20); // PR #47 merge commit (swarm happy path)
const SWARM_DUP_SHA = "48".repeat(20); // PR #48 merge commit (duplicate diff)
const SWARM_WINDOW_QUORUM_SHA = "49".repeat(20); // PR #49 (window suite: quorum)
const SWARM_WINDOW_VETO_SHA = "50".repeat(20); // PR #50 (window suite: FAIL veto)
const SWARM_WINDOW_FALLBACK_SHA = "51".repeat(20); // PR #51 (window suite: 1-PASS fallback)
const GRANTLESS_LINKED_SHA = "44".repeat(20); // PR #44 merge commit
const GRANTLESS_UNLINKED_SHA = "45".repeat(20); // PR #45 merge commit
const INSTALLATION_ID = 777;

const codeFiles = (prefix) =>
  Array.from({ length: 11 }, (_, i) => ({
    filename: `src/feature/${prefix}${i + 1}.ts`,
    status: "added",
    additions: 5,
    deletions: 0,
    changes: 5,
  }));

const REPOS = {
  "testowner/testrepo": {
    42: {
      number: 42,
      title: "feat: shiny thing",
      merged_at: "2026-11-23T12:00:00Z",
      merge_commit_sha: HUMAN_SHA,
      user: { login: "testauthor", type: "User" },
      files: codeFiles("p"),
    },
    43: {
      number: 43,
      title: "chore: bump deps",
      merged_at: "2026-11-23T12:05:00Z",
      merge_commit_sha: BOT_SHA,
      user: { login: "dependabot[bot]", type: "Bot" },
      files: codeFiles("b"),
    },
    47: {
      number: 47,
      title: "feat: swarm-reviewed thing",
      merged_at: "2026-11-25T12:00:00Z",
      merge_commit_sha: SWARM_SHA,
      user: { login: "testauthor", type: "User" },
      files: codeFiles("s"),
    },
    48: {
      number: 48,
      title: "feat: same code again",
      merged_at: "2026-11-25T12:05:00Z",
      merge_commit_sha: SWARM_DUP_SHA,
      user: { login: "testauthor", type: "User" },
      // IDENTICAL file list to PR #47 — same diff fingerprint.
      files: codeFiles("s"),
    },
    49: {
      number: 49,
      title: "feat: window quorum thing",
      merged_at: "2026-11-26T12:00:00Z",
      merge_commit_sha: SWARM_WINDOW_QUORUM_SHA,
      user: { login: "testauthor", type: "User" },
      files: codeFiles("w"),
    },
    50: {
      number: 50,
      title: "feat: window veto thing",
      merged_at: "2026-11-26T12:05:00Z",
      merge_commit_sha: SWARM_WINDOW_VETO_SHA,
      user: { login: "testauthor", type: "User" },
      files: codeFiles("x"),
    },
    51: {
      number: 51,
      title: "feat: window fallback thing",
      merged_at: "2026-11-26T12:10:00Z",
      merge_commit_sha: SWARM_WINDOW_FALLBACK_SHA,
      user: { login: "testauthor", type: "User" },
      files: codeFiles("y"),
    },
  },
  "testowner/nogrant": {
    44: {
      number: 44,
      title: "feat: grantless thing",
      merged_at: "2026-11-23T12:10:00Z",
      merge_commit_sha: GRANTLESS_LINKED_SHA,
      user: { login: "testauthor", type: "User" },
      files: codeFiles("n"),
    },
    45: {
      number: 45,
      title: "feat: ghost thing",
      merged_at: "2026-11-23T12:15:00Z",
      merge_commit_sha: GRANTLESS_UNLINKED_SHA,
      user: { login: "ghostdev", type: "User" },
      files: codeFiles("h"),
    },
  },
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://fixture.local");
  const path = url.pathname;
  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { "content-type": "application/json" });
    res.end(body);
    console.log(`[fixture] ${req.method} ${path} -> ${code}`);
  };

  // Drain request bodies (access-token POST) before responding.
  req.on("data", () => {});
  req.on("end", () => {
    if (req.method === "POST" && path === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
      return send(201, {
        token: "fixture-installation-token",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        permissions: { contents: "read", metadata: "read" },
        repository_selection: "selected",
      });
    }
    const instMatch = path.match(/^\/repos\/([^/]+)\/([^/]+)\/installation$/);
    if (req.method === "GET" && instMatch) {
      if (instMatch[2] === "notinstalled") {
        return send(404, { message: "Not Found" }); // launch-gate: app absent
      }
      return send(200, { id: INSTALLATION_ID, app_id: 123456 });
    }
    const permMatch = path.match(/^\/repos\/([^/]+)\/([^/]+)\/collaborators\/([^/]+)\/permission$/);
    if (req.method === "GET" && permMatch) {
      const isOwner = permMatch[3].toLowerCase() === permMatch[1].toLowerCase();
      return send(200, {
        permission: isOwner ? "admin" : "read",
        user: { login: permMatch[3], type: "User" },
      });
    }
    const repoMatch = path.match(/^\/repos\/([^/]+)\/([^/]+)$/);
    if (req.method === "GET" && repoMatch) {
      return send(200, {
        id: 424242,
        full_name: `${repoMatch[1]}/${repoMatch[2]}`,
        name: repoMatch[2],
        private: false,
        default_branch: "main",
        owner: { login: repoMatch[1], type: "User" },
      });
    }
    const prMatch = path.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)(\/files)?$/);
    if (req.method === "GET" && prMatch) {
      const pr = REPOS[`${prMatch[1]}/${prMatch[2]}`]?.[Number(prMatch[3])];
      if (!pr) return send(404, { message: "Not Found" });
      if (prMatch[4]) return send(200, pr.files);
      const { files, ...meta } = pr;
      return send(200, meta);
    }
    return send(404, { message: `fixture: no route for ${req.method} ${path}` });
  });
});

const PORT = 8977;
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[fixture] GitHub API fixture listening on http://127.0.0.1:${PORT}`);
});
