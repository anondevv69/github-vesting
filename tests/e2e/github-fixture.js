/**
 * TEST-ONLY fixture GitHub REST API server.
 *
 * Implements just enough of the GitHub App + Pulls API for prCredit.ts to
 * resolve a merged PR against it, when the vesting server is started with
 * GITHUB_API_BASE_URL=http://127.0.0.1:8977 (see src/github/githubApp.ts —
 * the env hook defaults to https://api.github.com in production).
 *
 * Endpoints served:
 *   GET  /repos/testowner/testrepo/installation                 -> { id: 777 }
 *   POST /app/installations/777/access_tokens                   -> fake token
 *   GET  /repos/testowner/testrepo/pulls/42                     -> merged PR, human author (@testauthor)
 *   GET  /repos/testowner/testrepo/pulls/42/files               -> 11 code files, 55 lines
 *   GET  /repos/testowner/testrepo/pulls/43                     -> merged PR, bot author (dependabot[bot])
 *   GET  /repos/testowner/testrepo/pulls/43/files               -> 11 code files, 55 lines
 *
 * The merge_commit_sha values below MUST match the `after` SHAs used by the
 * prhuman / prbot cases in send-webhook.mjs (prCredit refuses to credit a
 * push whose head SHA is not the PR's merge commit).
 */
const http = require("http");

const HUMAN_SHA = "c0ffee0000000000000000000000000000000042";
const BOT_SHA = "b070000000000000000000000000000000000043";
const INSTALLATION_ID = 777;

const codeFiles = (prefix) =>
  Array.from({ length: 11 }, (_, i) => ({
    filename: `src/feature/${prefix}${i + 1}.ts`,
    status: "added",
    additions: 5,
    deletions: 0,
    changes: 5,
  }));

const PRS = {
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
    if (req.method === "GET" && path === "/repos/testowner/testrepo/installation") {
      return send(200, { id: INSTALLATION_ID, app_id: 123456 });
    }
    const prMatch = path.match(/^\/repos\/testowner\/testrepo\/pulls\/(\d+)(\/files)?$/);
    if (req.method === "GET" && prMatch) {
      const pr = PRS[Number(prMatch[1])];
      if (!pr) return send(404, { message: "Not Found" });
      if (prMatch[2]) return send(200, pr.files);
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
