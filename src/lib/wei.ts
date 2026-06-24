/** Parse wei amounts stored as integer strings, numbers, or scientific notation (legacy bug). */
export function parseWei(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  const s = String(value).trim();
  if (!s) return 0n;
  if (/^\d+$/.test(s)) return BigInt(s);

  const lower = s.toLowerCase();
  if (lower.includes("e")) {
    const [mantissa, expStr] = lower.split("e");
    const exp = Number.parseInt(expStr ?? "0", 10);
    const parts = (mantissa ?? "0").split(".");
    const intPart = parts[0] ?? "0";
    const fracPart = parts[1] ?? "";
    const digits = intPart + fracPart;
    const shift = exp - fracPart.length;
    if (shift < 0) return BigInt(digits.slice(0, digits.length + shift) || "0");
    return BigInt(digits + "0".repeat(shift));
  }

  if (s.includes(".")) {
    const [intPart, frac] = s.split(".");
    if (frac?.replace(/0+$/, "")) throw new Error(`Non-integer wei: ${s}`);
    return BigInt(intPart || "0");
  }

  return BigInt(s);
}

export function normalizeWeiString(value: string | number | bigint): string {
  return parseWei(value).toString();
}
