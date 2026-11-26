/**
 * TEST-ONLY swarm reviewer client: acts as an external reviewer agent
 * against the local server + fixture GitHub API.
 *
 *   tsx tests/e2e/swarm-review.ts fingerprint <prNumber>
 *   tsx tests/e2e/swarm-review.ts enrol <login> <wallet>
 *   tsx tests/e2e/swarm-review.ts review <login> <sha> <prNumber> <pass|fail-dupe>
 *   tsx tests/e2e/swarm-review.ts queue <repo> <login>
 *   tsx tests/e2e/swarm-review.ts reviews <repo> <sha>
 *
 * The fingerprint is computed HERE, from the fixture PR's file list,
 * using the published algorithm (src/lib/swarmReview.ts) — exactly
 * what a real external reviewer agent would do from the real PR diff.
 */
import { computeDiffFingerprint } from "../../src/lib/swarmReview";
import { isMeaningfulFile } from "../../src/github/pushVerifier";

const API = "http://127.0.0.1:3210";
const FIXTURE = "http://127.0.0.1:8977";
const REPO = "testowner/testrepo";

async function fixtureFingerprint(prNumber: number): Promise<string> {
  const res = await fetch(`${FIXTURE}/repos/${REPO}/pulls/${prNumber}/files`);
  if (!res.ok) throw new Error(`fixture files fetch failed: ${res.status}`);
  const files = (await res.json()) as Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>;
  return computeDiffFingerprint(files.filter((f) => isMeaningfulFile(f.filename)));
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "fingerprint") {
    console.log(await fixtureFingerprint(Number(rest[0])));
    return;
  }
  if (cmd === "enrol") {
    const [login, wallet] = rest;
    console.log(JSON.stringify(await post("/api/agent/enrol-reviewer", { githubLogin: login, wallet })));
    return;
  }
  if (cmd === "review") {
    const [login, sha, pr, kind] = rest;
    const fingerprint = await fixtureFingerprint(Number(pr));
    const body =
      kind === "pass"
        ? { verdict: "pass", different: true, meaningful: true, checksPass: true }
        : { verdict: "fail", different: false, meaningful: true, checksPass: true, note: "duplicate of a previously counted diff" };
    console.log(
      JSON.stringify(
        await post("/api/agent/review-push", {
          repo: REPO,
          headSha: sha,
          reviewerLogin: login,
          fingerprint,
          ...body,
        }),
      ),
    );
    return;
  }
  if (cmd === "queue") {
    const [repo, login] = rest;
    const res = await fetch(
      `${API}/api/agent/review-queue?repo=${encodeURIComponent(repo!)}&reviewerLogin=${encodeURIComponent(login!)}`,
    );
    console.log(JSON.stringify(await res.json()));
    return;
  }
  if (cmd === "reviews") {
    const [repo, sha] = rest;
    const res = await fetch(
      `${API}/api/agent/push-reviews?repo=${encodeURIComponent(repo!)}&sha=${encodeURIComponent(sha!)}`,
    );
    console.log(JSON.stringify(await res.json()));
    return;
  }
  console.error("unknown command:", cmd);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
