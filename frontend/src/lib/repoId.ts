/** Parse "owner/repo" from plain text or a full GitHub URL. */
export function normalizeRepoFullName(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/github\.com[/:]([^/]+)\/([^/.#?]+)/i);
  if (match) return `${match[1]}/${match[2]}`;
  return trimmed.replace(/\/$/, "");
}

export function isValidRepoFullName(input: string): boolean {
  const normalized = normalizeRepoFullName(input);
  if (normalized.includes("://") || normalized.startsWith("http")) return false;
  const slash = normalized.indexOf("/");
  if (slash <= 0 || slash >= normalized.length - 1) return false;
  const owner = normalized.slice(0, slash);
  const name = normalized.slice(slash + 1);
  return owner.length > 0 && name.length > 0 && !owner.includes(" ");
}

export function splitRepo(full: string): [string, string] {
  const normalized = normalizeRepoFullName(full);
  if (!isValidRepoFullName(normalized)) {
    throw new Error(`Invalid repo — use owner/repo or a full GitHub URL`);
  }
  const slash = normalized.indexOf("/");
  return [normalized.slice(0, slash), normalized.slice(slash + 1)];
}

/** React-router path for a lock page, e.g. /lock/owner/repo. */
export function lockPathFromRepo(input: string): string {
  const [owner, name] = splitRepo(input);
  return `/lock/${owner}/${name}`;
}
