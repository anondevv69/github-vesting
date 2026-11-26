import type { Hex } from "viem";

/**
 * Base Builder Code attribution (ERC-8021).
 *
 * Proof of Dev is registered on the Base Dashboard with builder code
 * `bc_xh14tmi5`. User-signed transactions created in this frontend carry
 * the ERC-8021 data suffix so Base attributes the activity to the app.
 * The suffix is the dashboard's "Encoded String" for the code, derived
 * with `ox/erc8021` Attribution.toDataSuffix and verified by round-trip
 * decode (see the backend copy in src/lib/builderCode.ts for the full
 * derivation record — the two constants must stay identical).
 *
 * Configured once on each wallet client (viem `dataSuffix`); the suffix
 * only appends trailing bytes and never changes a call's semantics.
 */
export const BUILDER_CODE = "bc_xh14tmi5";

export const BUILDER_DATA_SUFFIX: Hex =
  "0x62635f78683134746d69350b0080218021802180218021802180218021";
