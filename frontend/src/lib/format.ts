export function formatTokens(wei: string): string {
  const n = Number(wei) / 1e18;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}k`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
