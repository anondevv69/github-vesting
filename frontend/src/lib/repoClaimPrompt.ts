const SKILL_INSTALL =
  "install GitHub Vesting skill at https://github.com/anondevv69/github-vesting/tree/main/skills/bankr-vesting";

export function buildRepoClaimAgentPrompt(opts: {
  repoFullName: string;
  wallet: string;
  claimJson: string;
  filePath?: string;
  commitMessage?: string;
  apiBase?: string;
}): string {
  const {
    repoFullName,
    wallet,
    claimJson,
    filePath = ".proofofdev/claim.json",
    commitMessage = `Proof of Dev: verify repo ownership`,
    apiBase = "https://api.proofofdev.xyz",
  } = opts;

  const statusUrl =
    `${apiBase}/api/repo-claims/status?repo=${encodeURIComponent(repoFullName)}` +
    `&wallet=${wallet}&poll=1`;

  return (
    `Verify Proof of Dev repo ownership — push a signed claim file to GitHub.\n\n` +
    `Repo: ${repoFullName}\n` +
    `Branch: main\n` +
    `File: ${filePath}\n` +
    `Wallet: ${wallet}\n\n` +
    `Steps:\n` +
    `1. Clone or open ${repoFullName} (you need push access to main).\n` +
    `2. Create ${filePath} with exactly this JSON:\n\n` +
    `${claimJson}\n\n` +
    `3. Commit with message: ${commitMessage}\n` +
    `4. Push to main on https://github.com/${repoFullName}\n\n` +
    `Important: this push does NOT count toward vesting milestones.\n\n` +
    `5. After push, verify (optional):\n` +
    `GET ${statusUrl}\n` +
    `Expect "verified": true.\n\n` +
    `---\n` +
    `@bankrbot / Bankr terminal:\n` +
    `${SKILL_INSTALL}\n` +
    `Push ${filePath} to ${repoFullName} on main using the JSON above.`
  );
}
