/** Parse "owner/repo" from plain text or a full GitHub URL. */
export function normalizeRepoFullName(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/github\.com[/:]([^/]+)\/([^/.#?]+)/i);
  if (match) return `${match[1]}/${match[2]}`;
  return trimmed.replace(/\/$/, "");
}

export function splitRepo(full: string): [string, string] {
  const normalized = normalizeRepoFullName(full);
  const slash = normalized.indexOf("/");
  if (slash === -1) throw new Error(`Invalid repo: ${full}`);
  return [normalized.slice(0, slash), normalized.slice(slash + 1)];
}
