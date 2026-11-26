import type { Hex } from "viem";

/**
 * Base Builder Code attribution (ERC-8021).
 *
 * Proof of Dev is registered on the Base Dashboard (registered by Gregory,
 * 2026-11-26) with builder code `bc_xh14tmi5`. Every transaction the
 * platform originates carries the ERC-8021 data suffix so Base can
 * attribute the activity (dashboard KPIs, rewards, visibility).
 *
 * The suffix is the value the dashboard's "Encoded String" format shows
 * for this code, derived with the `ox/erc8021` Attribution module:
 *   Attribution.toDataSuffix({ codes: ["bc_xh14tmi5"] })
 * and verified locally on 2026-11-26: `Attribution.fromData` round-trips
 * it to `{ codes: ["bc_xh14tmi5"], id: 0 }`, and the byte layout reads
 * backwards as the docs specify — ASCII codes, a 1-byte length (0x0b),
 * a 1-byte schema id (0x00), then the 16-byte marker
 * 0x80218021802180218021802180218021. The same derivation reproduces the
 * docs' worked example for `bc_b7k3p9da` exactly.
 *
 * The suffix is appended AFTER the call data and never alters a
 * transaction's target, value, or function arguments; contracts ignore
 * the trailing bytes. It is configured once per wallet client (viem
 * `dataSuffix`) — never append it at individual call sites.
 *
 * Docs: https://docs.base.org/specifications/builder-codes/overview
 */
export const BUILDER_CODE = "bc_xh14tmi5";

export const BUILDER_DATA_SUFFIX: Hex =
  "0x62635f78683134746d69350b0080218021802180218021802180218021";
