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
 *
 * Repos:
 *   testowner/testrepo — the grant repo (seed.ts):
 *     PR #42 merged, human author (@testauthor)
 *     PR #43 merged, bot author (dependabot[bot])
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
      return send(200, { id: INSTALLATION_ID, app_id: 123456 });
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
