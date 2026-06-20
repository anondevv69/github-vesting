import { keccak256, toBytes } from "viem";

export type RepoPlatform = "github" | "gitlawb";

/** Parse "owner/repo" from plain text or a full GitHub URL. */
export function normalizeRepoFullName(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/github\.com[/:]([^/]+)\/([^/.#?]+)/i);
  if (match) return `${match[1]}/${match[2]}`;
  return trimmed.replace(/\/$/, "");
}

/**
 * GitLawb repos use `{ownerShort}/{repoName}` where ownerShort is the last segment
 * of the owner DID (e.g. did:key:z6Mkabc... → z6Mkabc.../my-project).
 */
export function normalizeGitlawbRepo(input: string): string {
  let trimmed = input.trim().replace(/\/$/, "");
  const urlMatch = trimmed.match(/gitlawb:\/\/(?:did:key:)?([^/]+)\/([^/?#]+)/i);
  if (urlMatch) return `${urlMatch[1]}/${urlMatch[2]}`;

  const didMatch = trimmed.match(/^(did:key:[^/]+)\/(.+)$/i);
  if (didMatch) {
    const short = didMatch[1]!.split(":").pop()!;
    return `${short}/${didMatch[2]}`;
  }

  return trimmed;
}

export function detectPlatform(input: string): RepoPlatform {
  const t = input.trim().toLowerCase();
  if (t.includes("github.com") || t.startsWith("github:")) return "github";
  if (
    t.startsWith("gitlawb:") ||
    t.startsWith("gitlawb://") ||
    t.startsWith("did:key:") ||
    /^z6mk[a-z0-9]+\//i.test(t)
  ) {
    return "gitlawb";
  }
  return "github";
}

export function normalizeRepo(input: string, platform: RepoPlatform): string {
  return platform === "gitlawb" ? normalizeGitlawbRepo(input) : normalizeRepoFullName(input);
}

/** On-chain + backend repoId — must match frontend lock() keccak input. */
export function repoIdFromPlatform(platform: RepoPlatform, repoFullName: string): string {
  const normalized = normalizeRepo(repoFullName, platform);
  const seed = platform === "gitlawb" ? `gitlawb:${normalized}` : normalized;
  return keccak256(toBytes(seed)).slice(2);
}

/** @deprecated use repoIdFromPlatform */
export function repoIdFromFullName(repoFullName: string): string {
  return repoIdFromPlatform("github", repoFullName);
}

export function repoIdToBytes32(repoId: string): `0x${string}` {
  const hex = repoId.startsWith("0x") ? repoId.slice(2) : repoId;
  return `0x${hex}` as `0x${string}`;
}

export function splitRepo(full: string, platform: RepoPlatform = "github"): [string, string] {
  const normalized = normalizeRepo(full, platform);
  const slash = normalized.indexOf("/");
  if (slash === -1) throw new Error(`Invalid repoFullName: ${full}`);
  return [normalized.slice(0, slash), normalized.slice(slash + 1)];
}

export function repoStorageKey(platform: RepoPlatform, repoFullName: string): string {
  return `${platform}:${normalizeRepo(repoFullName, platform).toLowerCase()}`;
}

export function gitlawbProfileUrl(ownerShort: string): string {
  return `https://gitlawb.com/${ownerShort.slice(0, 8)}`;
}

export function gitlawbRepoWebUrl(ownerShort: string, repoName: string): string {
  return `https://gitlawb.com/node/repos/${ownerShort}/${repoName}`;
}
