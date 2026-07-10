/**
 * GitLawb node HTTP client (read-only public API).
 * @see https://github.com/gitlawb/node
 */

import { env } from "../lib/env";
import { splitRepo } from "../lib/repoId";

export type GitlawbRepoInfo = {
  owner: string;
  name: string;
  ownerDid?: string;
  description?: string;
  defaultBranch?: string;
  cloneUrl?: string;
};
export type GitlawbPushWebhook = {
  ref: string;
  before: string;
  after: string;
  created?: boolean;
  forced?: boolean;
  pusher?: { did?: string };
  repository?: {
    id?: string;
    name?: string;
    owner_did?: string;
    clone_url?: string;
  };
};

function nodeBase(): string {
  return env.GITLAWB_NODE_URL.replace(/\/$/, "");
}

export async function fetchGitlawbRepo(owner: string, name: string): Promise<GitlawbRepoInfo | null> {
  const url = `${nodeBase()}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    return {
      owner,
      name,
      ownerDid: String(data["owner_did"] ?? data["ownerDid"] ?? ""),
      description: String(data["description"] ?? ""),
      defaultBranch: String(data["default_branch"] ?? data["defaultBranch"] ?? "main"),
      cloneUrl: String(data["clone_url"] ?? data["cloneUrl"] ?? ""),
    };
  } catch {
    return null;
  }
}

export async function verifyGitlawbRepoExists(repoFullName: string): Promise<boolean> {
  const [owner, name] = splitRepo(repoFullName, "gitlawb");
  const info = await fetchGitlawbRepo(owner, name);
  return info !== null;
}

export function gitlawbRepoFullNameFromWebhook(payload: GitlawbPushWebhook): string | null {
  const ownerDid = payload.repository?.owner_did;
  const name = payload.repository?.name;
  if (!ownerDid || !name) return null;
  const ownerShort = ownerDid.split(":").pop() ?? ownerDid;
  return `${ownerShort}/${name}`;
}
