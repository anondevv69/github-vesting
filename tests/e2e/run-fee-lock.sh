#!/usr/bin/env bash
# TEST-ONLY driver for the FEE-LOCK system (Gregory's decided launcher
# rule, 2026-11-25) + the platform LAUNCH-PREP surface.
# Same local stack as the other drivers (fake redis + Hardhat node
# chainId 8453 + fixture GitHub API + vesting server). Proves:
#   launch-prep (POST /api/launch/prepare-launch):
#     - no verification token        -> 403 LAUNCH_VERIFICATION_REQUIRED
#     - valid token                  -> launch input with production
#                                       25/75 split: treasury 2500,
#                                       fee-lock VAULT 7500 (never the
#                                       launcher's raw wallet), vesting
#                                       explicitly { bps: 0 }
#     - no feeLockVault              -> 400 LAUNCH_FEE_VAULT_REQUIRED
#   vault outbound-path audit (fee-vault-check.ts):
#     - no withdraw/transfer-style function in the ABI; raw drain calls
#       revert; lockAccrued with nothing accrued reverts; escrow
#       addFeeTranche from a non-vault reverts; releaseFee from a
#       non-oracle reverts
#   fee-lock loop (deploy-fee.ts: supply 1000 PTK over 4 pushes,
#   milestone every 2; fee tranches vest over 2 pushes):
#     - 40 WETH claimable on the mock claim source; keeper claim+lock
#       -> 40 WETH in FeeStreamEscrow, 0 in vault, 0 to recipient
#       (zero pushes -> nothing released)
#     - push 1 -> +20 WETH to recipient (half the tranche), PTK still 0
#       (fee schedule independent of supply milestones)
#     - push 2 (PR #42) -> +20 WETH (tranche complete), +500 PTK
#       (supply milestone 1), author +10 RWD (merge reward unaffected)
#     - replay of push 2 -> nothing changes (no double fee release)
#     - second fee round: +30 WETH accrued -> keeper locks tranche 2
#       (baseline = 1 counted push, locked after push 1)
#     - push 2 -> tranche 1 completes (+20) and tranche 2 half-vests
#       (+15); push 3 -> tranche 2 completes (+15). 3 counted pushes
#       total — the verifier's daily cap (3/day) is real and the
#       timeline is built inside it.
#   round-3:
#     - registerFeeGrant from a non-owner reverts (registrar-only)
#     - blocker 3 exact case: push 7 counted in the backend, its fee
#       report pending (on-chain counter still 6) -> keeper DEFERS
#       before moving any funds -> sweep lands the report -> keeper
#       locks tranche 4 with backendCountAtLock = 7 -> push 8
#       half-vests it (+10 WETH)
#     - blocker 1 lock-event match: a lock event for a different
#       repo / recipient / token leaves the grant UNSTAMPED with
#       LAUNCH_LOCK_{REPO,RECIPIENT,TOKEN}_MISMATCH
# No external calls, no real keys.
set -u
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
LOG="$ROOT/tests/e2e/fee-lock-output.log"
: > "$LOG"
exec > >(tee -a "$LOG") 2>&1

FAILURES=0
check() { # name, haystack, needle
  if printf '%s' "$2" | grep -qF "$3"; then
    echo "PASS: $1"
  else
    echo "FAIL: $1 (missing: $3)"
    FAILURES=$((FAILURES + 1))
  fi
}
check_absent_fee() { if printf '%s' "$2" | grep -qF "$3"; then echo "FAIL: $1 (unexpectedly present: $3)"; FAILURES=$((FAILURES + 1)); else echo "PASS: $1"; fi; }

PIDS=()
kill_port() {
  local pids
  pids="$(ss -ltnp 2>/dev/null | grep ":$1 " | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u)"
  for p in $pids; do kill "$p" 2>/dev/null || true; done
}
cleanup() {
  for pid in "${PIDS[@]:-}"; do [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null || true; done
  kill_port 8545; kill_port 6399; kill_port 3210; kill_port 8977
}
trap cleanup EXIT

if [ ! -f /tmp/e2e_github_app_key.pem ]; then
  openssl genrsa -out /tmp/e2e_github_app_key.pem 2048 2>/dev/null
fi
APP_KEY_ESCAPED="$(python3 -c "print(open('/tmp/e2e_github_app_key.pem').read().replace('\n','\\\\n'), end='')")"
export ORACLE_PRIVATE_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
KEEPER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

set_test_env() {
  export PORT=3210 HOST=127.0.0.1 NODE_ENV=development
  export GITHUB_APP_ID=123456
  export GITHUB_APP_PRIVATE_KEY="$APP_KEY_ESCAPED"
  export GITHUB_WEBHOOK_SECRET="test-webhook-secret"
  export GITHUB_CLIENT_ID="test-client-id"
  export GITHUB_CLIENT_SECRET="test-client-secret"
  export REDIS_URL="redis://127.0.0.1:6399"
  export SESSION_SECRET="test-session-secret"
  export BASE_RPC_URL="http://127.0.0.1:8545"
  export ROBINHOOD_RPC_URL="http://127.0.0.1:8545"
  export FRONTEND_URL="http://localhost:5173"
  export SERVER_URL="http://127.0.0.1:3210"
  export GITHUB_API_BASE_URL="http://127.0.0.1:8977"
}

wait_http() {
  for i in $(seq 1 "$2"); do
    if curl -s -o /dev/null "$1"; then return 0; fi
    sleep 1
  done
  echo "TIMEOUT waiting for $1"; return 1
}
wait_rpc() {
  for i in $(seq 1 30); do
    if curl -s -X POST -H 'content-type: application/json' \
      --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
      http://127.0.0.1:8545 | grep -q "0x2105"; then return 0; fi
    sleep 1
  done
  echo "TIMEOUT waiting for hardhat node (chainId 0x2105=8453)"; return 1
}

API="http://127.0.0.1:3210"
REPO="testowner/testrepo"

echo "=== 1. fake redis ==="
node tests/e2e/fake-redis.js &
PIDS+=($!)
sleep 1

echo "=== 2. hardhat node (chainId 8453) ==="
npx hardhat node --config hardhat.local.config.ts --port 8545 &
PIDS+=($!)
wait_rpc || exit 1
echo "node up"

echo "=== 3. deploy fee-lock stack ==="
npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/deploy-fee.ts || exit 1
J() { python3 -c "import json,sys;print(json.load(open('tests/e2e/state-fee.json'))[sys.argv[1]])" "$1"; }
export GIT_ESCROW_ADDRESS="$(J gitEscrow)"
export SHIP_REWARDS_ADDRESS="$(J shipRewards)"
export FEE_STREAM_ESCROW_ADDRESS="$(J feeStreamEscrow)"
export SHIP_REWARD_PER_MERGE="10000000000000000000"
RECIPIENT="$(J recipient)"; AUTHOR="$(J author)"; DEPLOYER="$(J deployer)"
VAULT="$(J feeLockVault)"; SOURCE="$(J feeClaimSource)"
# The deployer stands in as the designated treasury for the prep test
# (plumbing proof only — no real treasury is designated yet).
export PLATFORM_REWARD_TREASURY_WALLET="$DEPLOYER"
echo "recipient=$RECIPIENT vault=$VAULT treasury=$DEPLOYER"

echo "=== 3b. deploy recognition fixtures (round-2: mock Bankr record + per-repo vaults) ==="
npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/deploy-recognition.ts || exit 1
JR() { python3 -c "import json,sys;print(json.load(open('tests/e2e/state-recognition.json'))[sys.argv[1]])" "$1"; }
# The mock record plays both Bankr roles for the backend's launch-use
# reads; exported BEFORE the server starts (env is read at boot).
export BANKR_FACTORY_ADDRESS="$(JR record)"
export BANKR_FEE_LEDGER_ADDRESS="$(JR record)"
# Round-4 prepare-launch binding config: the chain's WETH and the
# Bankr CLAIM ledger (the fee suite's claim source — the launch-
# record ledger above is a different mock of the same production
# contract).
export WETH_ADDRESS="$(J weth)"
export BANKR_CLAIM_LEDGER_ADDRESS="$(J feeClaimSource)"
echo "bankr record double: $BANKR_FACTORY_ADDRESS"

echo "=== 4. fixture GitHub API ==="
node tests/e2e/github-fixture.js &
PIDS+=($!)
sleep 1

echo "=== 5. vesting server ==="
set_test_env
npx tsx src/index.ts &
PIDS+=($!)
wait_http "$API/health" 30 || exit 1
echo "server up"

echo "=== 6. seed grant + links ==="
npx tsx tests/e2e/seed-fee.ts || exit 1

echo "=== 7. prepare-launch: NO token -> refused ==="
OUT="$(curl -s -X POST "$API/api/launch/prepare-launch" -H 'content-type: application/json' \
  -H "x-wallet-address: $RECIPIENT" \
  -d "{\"repo\":\"$REPO\",\"feeLockVault\":\"$VAULT\",\"launch\":{\"name\":\"Fee Probe\",\"symbol\":\"FPX\"}}")"; echo "$OUT"
check "no-token prepare-launch refused" "$OUT" '"code":"LAUNCH_VERIFICATION_REQUIRED"'

echo "=== 8. verify-github: happy -> token ==="
OUT="$(curl -s -X POST "$API/api/launch/verify-github" -H 'content-type: application/json' \
  -d "{\"githubLogin\":\"testowner\",\"repo\":\"$REPO\",\"wallet\":\"$RECIPIENT\",\"chain\":\"base\"}")"; echo "$OUT"
check "happy verify ok" "$OUT" '"verified":true'
TOKEN="$(printf '%s' "$OUT" | python3 -c "import sys,json;print(json.load(sys.stdin)['verificationToken'])")"

echo "=== 9. prepare-launch: valid token -> production split with vault ==="
OUT="$(curl -s -X POST "$API/api/launch/prepare-launch" -H 'content-type: application/json' \
  -H "x-wallet-address: $RECIPIENT" \
  -d "{\"repo\":\"$REPO\",\"verificationToken\":\"$TOKEN\",\"feeLockVault\":\"$VAULT\",\"launch\":{\"name\":\"Fee Probe\",\"symbol\":\"FPX\"}}")"; echo "$OUT"
check "prepare-launch ok" "$OUT" '"prepared":true'
check "treasury gets 2500" "$OUT" "\"recipient\":\"$(printf '%s' "$DEPLOYER" | tr 'A-F' 'a-f')\",\"shareBps\":2500"
check "vault gets 7500 (not the raw wallet)" "$OUT" "\"recipient\":\"$(printf '%s' "$VAULT" | tr 'A-F' 'a-f')\",\"shareBps\":7500"
check "vesting explicitly bps 0" "$OUT" '"bps":0'

echo "=== 10. prepare-launch: no feeLockVault -> refused ==="
OUT="$(curl -s -X POST "$API/api/launch/prepare-launch" -H 'content-type: application/json' \
  -H "x-wallet-address: $RECIPIENT" \
  -d "{\"repo\":\"$REPO\",\"verificationToken\":\"$TOKEN\",\"launch\":{\"name\":\"Fee Probe\",\"symbol\":\"FPX\"}}")"; echo "$OUT"
check "no-vault prepare-launch refused" "$OUT" '"code":"LAUNCH_FEE_VAULT_REQUIRED"'

echo "=== 11. vault outbound-path audit ==="
OUT="$(npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/fee-vault-check.ts)"; echo "$OUT"
check "vault state-changing surface is claim+lock only" "$OUT" "VAULT_CHECK state-changing: claimFees,lockAccrued"
check "vault has no banned functions" "$OUT" "VAULT_CHECK banned functions: NONE"
check "raw withdraw call reverts" "$OUT" "VAULT_CHECK raw withdraw(address,uint256): REVERTED"
check "raw transfer call reverts" "$OUT" "VAULT_CHECK raw transfer(address,uint256): REVERTED"
check "lockAccrued with nothing accrued reverts" "$OUT" "VAULT_CHECK lockAccrued with nothing accrued: REVERTED"
check "addFeeTranche from non-vault reverts" "$OUT" "VAULT_CHECK addFeeTranche from non-vault: REVERTED"
check "releaseFee from non-oracle reverts" "$OUT" "VAULT_CHECK releaseFee from non-oracle: REVERTED"
check "registerFeeGrant from non-owner reverts (registrar-only, round-3)" "$OUT" "VAULT_CHECK registerFeeGrant from non-owner (registrar-only, round-3): REVERTED"

echo "=== 12. balances before keeper: nothing claimed, nothing released ==="
OUT="$(npx tsx tests/e2e/balances-fee.ts before)"; echo "$OUT"
check "vault holds 0 before claim" "$OUT" "vault WETH=0"
check "recipient WETH 0 before any push" "$OUT" "recipient PTK=0 WETH=0"

echo "=== 13. keeper cycle 1: claim 40 WETH -> lock tranche 1 ==="
OUT="$(KEEPER_PRIVATE_KEY="$KEEPER_KEY" FEE_CLAIM_SOURCE="$SOURCE" npx tsx scripts/fee-lock-keeper.ts "$VAULT")"; echo "$OUT"
check "keeper locked 40 WETH" "$OUT" '"lockedAmount":"40000000000000000000"'
check "keeper tranche 1 baseline = 0 counted pushes (provenance)" "$OUT" '"expectedBaseline":"0"'
check "keeper tranche 1 attestedCountAtLock = 0 (round-4 oracle attestation)" "$OUT" '"attestedCountAtLock":"0"'
OUT="$(npx tsx tests/e2e/balances-fee.ts after-lock1)"; echo "$OUT"
check "fee escrow holds the locked 40" "$OUT" "feeEscrow WETH=40"
check "vault drained after lock" "$OUT" "vault WETH=0"
check "recipient still 0 with zero pushes" "$OUT" "recipient PTK=0 WETH=0"

echo "=== 14. webhook push 1 (plain): fee tranche half-vests, no supply milestone ==="
node tests/e2e/send-webhook.mjs plain
OUT="$(npx tsx tests/e2e/balances-fee.ts after-push1)"; echo "$OUT"
check "push 1 released 20 WETH of fees" "$OUT" "recipient PTK=0 WETH=20"

echo "=== 15. second fee round: +30 WETH accrued -> keeper locks tranche 2 (baseline = 1 counted push) ==="
AMOUNT=30 npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/fee-topup.ts || exit 1
OUT="$(KEEPER_PRIVATE_KEY="$KEEPER_KEY" FEE_CLAIM_SOURCE="$SOURCE" npx tsx scripts/fee-lock-keeper.ts "$VAULT")"; echo "$OUT"
check "keeper locked 30 WETH (tranche 2)" "$OUT" '"lockedAmount":"30000000000000000000"'
check "keeper tranche 2 baseline = 1 counted push (provenance)" "$OUT" '"expectedBaseline":"1"'
check "keeper tranche 2 attestedCountAtLock = 1 (round-4)" "$OUT" '"attestedCountAtLock":"1"'
OUT="$(npx tsx tests/e2e/balances-fee.ts after-lock2)"; echo "$OUT"
check "fee escrow holds 20 unreleased tranche-1 + 30 tranche-2" "$OUT" "feeEscrow WETH=50"
check "tranche 2 not released before its pushes" "$OUT" "recipient PTK=0 WETH=20"

echo "=== 16. webhook push 2 (PR #42): tranche 1 completes, tranche 2 half-vests, supply milestone, author reward ==="
node tests/e2e/send-webhook.mjs prhuman
OUT="$(npx tsx tests/e2e/balances-fee.ts after-push2)"; echo "$OUT"
check "push 2: fees at 55 WETH (40 tranche-1 + 15 tranche-2)" "$OUT" "WETH=55"
check "push 2 paid supply milestone 1 (500 PTK)" "$OUT" "recipient PTK=500"
check "author merge reward unaffected (+10 RWD)" "$OUT" "author RWD=10"

echo "=== 17. replay push 2: no double fee release, no double anything ==="
node tests/e2e/send-webhook.mjs prhuman
OUT="$(npx tsx tests/e2e/balances-fee.ts after-replay)"; echo "$OUT"
check "replay: recipient unchanged" "$OUT" "recipient PTK=500 WETH=55"
check "replay: author unchanged" "$OUT" "author RWD=10"

echo "=== 18. webhook push 3 (plain2): tranche 2 completes, no supply milestone ==="
node tests/e2e/send-webhook.mjs plain2
OUT="$(npx tsx tests/e2e/balances-fee.ts after-push3)"; echo "$OUT"
check "push 3 completed tranche 2 (70 WETH total)" "$OUT" "WETH=70"
check "push 3 paid no supply milestone (still 500 PTK)" "$OUT" "recipient PTK=500"

# ─── Round-2: launch RECOGNITION (prepared input must be provably used) ───
PTK_FEE="$(J ptk)"
VAULT1="$(JR vault1)"; VAULT2="$(JR vault2)"; VAULT3="$(JR vault3)"; VAULT4="$(JR vault4)"; VAULT5="$(JR vault5)"
IMPOSTOR="$(JR impostor2)"; ESCROW_B="$(JR escrowB)"; RECORD="$(JR record)"
DEPLOYER_LC="$(printf '%s' "$DEPLOYER" | tr 'A-F' 'a-f')"
RECIPIENT_LC="$(printf '%s' "$RECIPIENT" | tr 'A-F' 'a-f')"

verify_for() { # repo -> echoes token
  curl -s -X POST "$API/api/launch/verify-github" -H 'content-type: application/json' \
    -d "{\"githubLogin\":\"testowner\",\"repo\":\"$1\",\"wallet\":\"$RECIPIENT\",\"chain\":\"base\"}" \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['verificationToken'])"
}
prepare_for() { # repo token vault
  curl -s -X POST "$API/api/launch/prepare-launch" -H 'content-type: application/json' \
    -H "x-wallet-address: $RECIPIENT" \
    -d "{\"repo\":\"$1\",\"verificationToken\":\"$2\",\"feeLockVault\":\"$3\",\"launch\":{\"name\":\"Recog\",\"symbol\":\"RCG\"}}"
}
register_for() { # repo token vault locktx
  curl -s -X POST "$API/api/vesting/register" -H 'content-type: application/json' \
    -d "{\"repoFullName\":\"$1\",\"platform\":\"github\",\"recipient\":\"$RECIPIENT\",\"token\":\"$PTK_FEE\",\"chain\":\"base\",\"totalLocked\":\"10000000000000000000\",\"totalPushesRequired\":2,\"pushesPerMilestone\":1,\"tokensPerMilestone\":\"5000000000000000000\",\"onChainTxHash\":\"$4\",\"installationId\":777,\"streaming\":false,\"launchVerificationToken\":\"$2\",\"feeLockVault\":\"$3\"}"
}
set_record() { # recipients-json
  RECORD="$RECORD" RECIPIENTS_JSON="$1" npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/set-launch-record.ts > /dev/null
}
lock_for() { # repo [escrow]
  if [ -n "${2:-}" ]; then
    LOCK_REPO="$1" LOCK_AMOUNT=10 LOCK_ESCROW="$2" npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/lock-for-repo-fee.ts
  else
    LOCK_REPO="$1" LOCK_AMOUNT=10 npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/lock-for-repo-fee.ts
  fi
}

echo "=== 19. recognition happy path: prepared vault + matching launch record -> STAMPED ==="
T="$(verify_for testowner/feeproj)"
OUT="$(prepare_for testowner/feeproj "$T" "$VAULT1")"; echo "$OUT"
check "feeproj prepare ok" "$OUT" '"prepared":true'
LTX="$(lock_for testowner/feeproj | grep -o 'LOCK_TX=0x[0-9a-f]*' | cut -d= -f2)"
OUT="$(register_for testowner/feeproj "$T" "$VAULT1" "$LTX")"; echo "$OUT"
check "feeproj grant stamped launchVerified" "$OUT" '"launchVerified":true'
check "feeproj launcher enrolled" "$OUT" '"launcherRewardEnrolled":true'

echo "=== 20. recognition: substituted contract (wrong codehash) -> UNSTAMPED ==="
set_record "[[\"$DEPLOYER\",2500],[\"$VAULT2\",7500]]"
T="$(verify_for testowner/feeproj2)"
OUT="$(prepare_for testowner/feeproj2 "$T" "$VAULT2")"; echo "$OUT"
check "feeproj2 prepare ok (real vault)" "$OUT" '"prepared":true'
LTX="$(lock_for testowner/feeproj2 | grep -o 'LOCK_TX=0x[0-9a-f]*' | cut -d= -f2)"
OUT="$(register_for testowner/feeproj2 "$T" "$IMPOSTOR" "$LTX")"; echo "$OUT"
check "feeproj2 unstamped" "$OUT" '"stamped":false'
check "feeproj2 codehash mismatch code" "$OUT" '"code":"LAUNCH_VAULT_CODEHASH_MISMATCH"'

echo "=== 21. round-4: vault bound to another repo -> refused at PREPARE (was: unstamped at registration) ==="
# Round 3 caught this binding only at registration — after the user
# may already have launched. Round 4 validates bindings at prepare:
# no launch input is ever returned for a wrongly-bound vault. The
# registration-side check remains as the second line of defence;
# with no prepared record, registration withholds the stamp as
# LAUNCH_NO_PREPARED_RECORD.
set_record "[[\"$DEPLOYER\",2500],[\"$VAULT3\",7500]]"
T="$(verify_for testowner/feeproj3)"
OUT="$(prepare_for testowner/feeproj3 "$T" "$VAULT3")"; echo "$OUT"
check "feeproj3 prepare REFUSED (vault bound to another repo)" "$OUT" '"code":"LAUNCH_VAULT_REPO_MISMATCH"'
check_absent_fee "feeproj3 prepare returned no input" "$OUT" '"prepared":true'
LTX="$(lock_for testowner/feeproj3 | grep -o 'LOCK_TX=0x[0-9a-f]*' | cut -d= -f2)"
OUT="$(register_for testowner/feeproj3 "$T" "$VAULT3" "$LTX")"; echo "$OUT"
check "feeproj3 unstamped" "$OUT" '"stamped":false'
check "feeproj3 no-prepared-record code at registration" "$OUT" '"code":"LAUNCH_NO_PREPARED_RECORD"'

echo "=== 22. recognition: actual launch recipients != prepared -> UNSTAMPED ==="
set_record "[[\"$DEPLOYER\",2500],[\"$RECIPIENT\",7500]]"
T="$(verify_for testowner/feeproj4)"
OUT="$(prepare_for testowner/feeproj4 "$T" "$VAULT4")"; echo "$OUT"
check "feeproj4 prepare ok" "$OUT" '"prepared":true'
LTX="$(lock_for testowner/feeproj4 | grep -o 'LOCK_TX=0x[0-9a-f]*' | cut -d= -f2)"
OUT="$(register_for testowner/feeproj4 "$T" "$VAULT4" "$LTX")"; echo "$OUT"
check "feeproj4 unstamped" "$OUT" '"stamped":false'
check "feeproj4 fee-config mismatch code" "$OUT" '"code":"LAUNCH_FEE_CONFIG_MISMATCH"'

echo "=== 23. recognition: lock lives in a DIFFERENT escrow -> UNSTAMPED ==="
set_record "[[\"$DEPLOYER\",2500],[\"$VAULT5\",7500]]"
T="$(verify_for testowner/feeproj5)"
OUT="$(prepare_for testowner/feeproj5 "$T" "$VAULT5")"; echo "$OUT"
check "feeproj5 prepare ok" "$OUT" '"prepared":true'
LTX="$(lock_for testowner/feeproj5 "$ESCROW_B" | grep -o 'LOCK_TX=0x[0-9a-f]*' | cut -d= -f2)"
OUT="$(register_for testowner/feeproj5 "$T" "$VAULT5" "$LTX")"; echo "$OUT"
check "feeproj5 unstamped" "$OUT" '"stamped":false'
check "feeproj5 wrong-escrow code" "$OUT" '"code":"LAUNCH_LOCK_NOT_IN_CONFIGURED_ESCROW"'

echo "=== 24. prepare-launch: launcher position can never be a raw wallet ==="
T="$(verify_for "$REPO")"
OUT="$(prepare_for "$REPO" "$T" "$RECIPIENT")"; echo "$OUT"
check "vault == launcher wallet refused" "$OUT" '"code":"LAUNCH_FEE_VAULT_IS_LAUNCHER_WALLET"'
AUTHOR_ADDR="$(J author)"
OUT="$(prepare_for "$REPO" "$T" "$AUTHOR_ADDR")"; echo "$OUT"
check "vault == other EOA refused (no code)" "$OUT" '"code":"LAUNCH_FEE_VAULT_NOT_A_CONTRACT"'

# ─── Round-2: fee-release RETRY (supply succeeds, fee fails, then recovers) ───
GIT_ESCROW_ADDR="$(J gitEscrow)"

echo "=== 25. tranche 3: +20 WETH accrued -> keeper locks (baseline = 3 counted pushes) ==="
AMOUNT=20 npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/fee-topup.ts || exit 1
OUT="$(KEEPER_PRIVATE_KEY="$KEEPER_KEY" FEE_CLAIM_SOURCE="$SOURCE" npx tsx scripts/fee-lock-keeper.ts "$VAULT")"; echo "$OUT"
check "keeper locked 20 WETH (tranche 3)" "$OUT" '"lockedAmount":"20000000000000000000"'
check "keeper tranche 3 baseline = 3 counted pushes" "$OUT" '"expectedBaseline":"3"'
check "keeper tranche 3 attestedCountAtLock = 3 (round-4)" "$OUT" '"attestedCountAtLock":"3"'

echo "=== 26. push 4 with a BROKEN fee leg: supply milestone pays, fee release fails -> pending ==="
OUT="$(FEE_STREAM_ESCROW_ADDRESS="$GIT_ESCROW_ADDR" npx tsx tests/e2e/fee-retry.ts push fee4000000000000000000000000000000000001)"; echo "$OUT"
check "push 4 counted" "$OUT" '"accepted":true'
check "push 4 fee release failed" "$OUT" 'Fee release tx failed'
check "pending fee release recorded (basis = push 4)" "$OUT" '"pending":{"repoId"'
check "pending basis is push count 4" "$OUT" '"pushCount":4'
OUT="$(npx tsx tests/e2e/balances-fee.ts after-push4-broken-fee)"; echo "$OUT"
check "supply milestone 2 PAID despite the fee failure (1000 PTK)" "$OUT" "recipient PTK=1000"
check "fees NOT paid while the fee leg is broken (still 70 WETH)" "$OUT" "WETH=70"

echo "=== 27. keeper sweep retries the pending fee release -> paid exactly once ==="
OUT="$(npx tsx scripts/fee-release-sweep.ts)"; echo "$OUT"
check "sweep retried one pending release" "$OUT" '"swept":1'
OUT="$(npx tsx tests/e2e/fee-retry.ts pending)"; echo "$OUT"
check "pending cleared after the sweep" "$OUT" '"pending":null'
OUT="$(npx tsx tests/e2e/balances-fee.ts after-sweep)"; echo "$OUT"
check "sweep paid tranche 3 half-vest (80 WETH)" "$OUT" "WETH=80"
check "supply NOT re-released by the sweep (still 1000 PTK)" "$OUT" "recipient PTK=1000"

echo "=== 28. push 5 broken again -> pending; push 6 (healthy) retries on the push path ==="
OUT="$(FEE_STREAM_ESCROW_ADDRESS="$GIT_ESCROW_ADDR" npx tsx tests/e2e/fee-retry.ts push fee5000000000000000000000000000000000002)"; echo "$OUT"
check "push 5 fee release failed again" "$OUT" 'Fee release tx failed'
check "pending recorded again (basis = push 5)" "$OUT" '"pushCount":5'
OUT="$(npx tsx tests/e2e/fee-retry.ts push fee6000000000000000000000000000000000003)"; echo "$OUT"
check "push 6 counted and its fee release succeeded" "$OUT" '"accepted":true'
check "pending cleared by the next counted push" "$OUT" '"pending":null'
OUT="$(npx tsx tests/e2e/balances-fee.ts after-push6)"; echo "$OUT"
check "tranche 3 completed via the push-path retry (90 WETH)" "$OUT" "WETH=90"
check "supply unchanged through the retry cycle (1000 PTK)" "$OUT" "recipient PTK=1000"

# ─── Round-3, blocker 3: the reviewer's exact gap ───
# Backend counts push 7; its fee report FAILS (pending retry), so
# the on-chain counter stays at 6. A keeper lock attempted in that
# gap must DEFER; after the sweep lands the report, the keeper
# locks with backendCountAtLock = 7 and the tranche vests only
# against push 8+.

echo "=== 29. round-3: +20 WETH accrued; push 7 counts in the backend, fee report FAILS -> pending, on-chain stays 6 ==="
AMOUNT=20 npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/fee-topup.ts || exit 1
OUT="$(FEE_STREAM_ESCROW_ADDRESS="$GIT_ESCROW_ADDR" npx tsx tests/e2e/fee-retry.ts push fee7000000000000000000000000000000000004)"; echo "$OUT"
check "push 7 counted in the backend" "$OUT" '"accepted":true'
check "push 7 fee release failed" "$OUT" 'Fee release tx failed'
check "pending recorded (basis = push 7)" "$OUT" '"pushCount":7'
OUT="$(npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/fee-state.ts)"; echo "$OUT"
check "on-chain counter still 6 while the report is pending" "$OUT" "knownPushCount=6"
check "still 3 tranches on-chain" "$OUT" "tranches=3"

echo "=== 30. round-3: keeper attempts to lock in the gap -> DEFERRED, no funds move ==="
OUT="$(KEEPER_PRIVATE_KEY="$KEEPER_KEY" FEE_CLAIM_SOURCE="$SOURCE" npx tsx scripts/fee-lock-keeper.ts "$VAULT")"; echo "$OUT"
check "keeper deferred on the pending report" "$OUT" '"lockDeferred"'
check "keeper deferral names the pending total 7" "$OUT" "pending fee release for total 7"
check_absent_fee "keeper did NOT lock while deferred" "$OUT" '"lockedAmount"'
OUT="$(npx tsx tests/e2e/balances-fee.ts after-deferred-keeper)"; echo "$OUT"
check "vault still holds 0 (deferral precedes the claim leg)" "$OUT" "vault WETH=0"
check "recipient unchanged during the gap (90 WETH)" "$OUT" "WETH=90"
OUT="$(npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/fee-state.ts)"; echo "$OUT"
check "no tranche was created in the gap" "$OUT" "tranches=3"

echo "=== 31. round-3: sweep lands the pending report -> on-chain counter 7, nothing new vests ==="
OUT="$(npx tsx scripts/fee-release-sweep.ts)"; echo "$OUT"
check "sweep retried the pending release" "$OUT" '"swept":1'
OUT="$(npx tsx tests/e2e/fee-retry.ts pending)"; echo "$OUT"
check "pending cleared after the sweep" "$OUT" '"pending":null'
OUT="$(npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/fee-state.ts)"; echo "$OUT"
check "on-chain counter now 7" "$OUT" "knownPushCount=7"
OUT="$(npx tsx tests/e2e/balances-fee.ts after-gap-sweep)"; echo "$OUT"
check "the landed report vested nothing new (all tranches already full, 90 WETH)" "$OUT" "WETH=90"

echo "=== 32. round-3 scenario, round-4 path: keeper locks tranche 4 with attested count 7 ==="
OUT="$(KEEPER_PRIVATE_KEY="$KEEPER_KEY" FEE_CLAIM_SOURCE="$SOURCE" npx tsx scripts/fee-lock-keeper.ts "$VAULT")"; echo "$OUT"
check "keeper locked 20 WETH (tranche 4)" "$OUT" '"lockedAmount":"20000000000000000000"'
check "keeper tranche 4 on-chain baseline = 7" "$OUT" '"expectedBaseline":"7"'
check "keeper tranche 4 attestedCountAtLock = 7" "$OUT" '"attestedCountAtLock":"7"'
OUT="$(npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/fee-state.ts)"; echo "$OUT"
check "tranche 4 stamped baseline 7 with backendCountAtLock 7" "$OUT" "tranche3 amount=20000000000000000000 baseline=7 backend=7 released=0"

echo "=== 33. round-3: push 8 (healthy) -> tranche 4 half-vests (+10 WETH) ==="
OUT="$(npx tsx tests/e2e/fee-retry.ts push fee8000000000000000000000000000000000005)"; echo "$OUT"
check "push 8 counted and its fee release succeeded" "$OUT" '"accepted":true'
OUT="$(npx tsx tests/e2e/balances-fee.ts after-push8)"; echo "$OUT"
check "tranche 4 half-vested (100 WETH total)" "$OUT" "WETH=100"
check "supply unchanged (1000 PTK)" "$OUT" "recipient PTK=1000"

# ─── Round-3, blocker 1: the lock EVENT must match the registration ───
VAULT6="$(JR vault6)"; VAULT7="$(JR vault7)"; VAULT8="$(JR vault8)"
WETH_FEE="$(J weth)"

echo "=== 34. round-3: lock event for a DIFFERENT repo -> UNSTAMPED (LAUNCH_LOCK_REPO_MISMATCH) ==="
set_record "[[\"$DEPLOYER\",2500],[\"$VAULT6\",7500]]"
T="$(verify_for testowner/feeproj6)"
OUT="$(prepare_for testowner/feeproj6 "$T" "$VAULT6")"; echo "$OUT"
check "feeproj6 prepare ok" "$OUT" '"prepared":true'
LTX="$(LOCK_REPO="testowner/feeproj6-other" LOCK_AMOUNT=10 npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/lock-for-repo-fee.ts | grep -o 'LOCK_TX=0x[0-9a-f]*' | cut -d= -f2)"
OUT="$(register_for testowner/feeproj6 "$T" "$VAULT6" "$LTX")"; echo "$OUT"
check "feeproj6 unstamped" "$OUT" '"stamped":false'
check "feeproj6 lock-repo mismatch code" "$OUT" '"code":"LAUNCH_LOCK_REPO_MISMATCH"'
check_absent_fee "feeproj6 grant NOT launchVerified" "$OUT" '"launchVerified":true'

echo "=== 35. round-3: lock event naming a DIFFERENT recipient -> UNSTAMPED (LAUNCH_LOCK_RECIPIENT_MISMATCH) ==="
set_record "[[\"$DEPLOYER\",2500],[\"$VAULT7\",7500]]"
T="$(verify_for testowner/feeproj7)"
OUT="$(prepare_for testowner/feeproj7 "$T" "$VAULT7")"; echo "$OUT"
check "feeproj7 prepare ok" "$OUT" '"prepared":true'
LTX="$(LOCK_REPO="testowner/feeproj7" LOCK_AMOUNT=10 LOCK_SIGNER_INDEX=3 npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/lock-for-repo-fee.ts | grep -o 'LOCK_TX=0x[0-9a-f]*' | cut -d= -f2)"
OUT="$(register_for testowner/feeproj7 "$T" "$VAULT7" "$LTX")"; echo "$OUT"
check "feeproj7 unstamped" "$OUT" '"stamped":false'
check "feeproj7 lock-recipient mismatch code" "$OUT" '"code":"LAUNCH_LOCK_RECIPIENT_MISMATCH"'
check_absent_fee "feeproj7 grant NOT launchVerified" "$OUT" '"launchVerified":true'

echo "=== 36. round-3: lock event locking a DIFFERENT token -> UNSTAMPED (LAUNCH_LOCK_TOKEN_MISMATCH) ==="
set_record "[[\"$DEPLOYER\",2500],[\"$VAULT8\",7500]]"
T="$(verify_for testowner/feeproj8)"
OUT="$(prepare_for testowner/feeproj8 "$T" "$VAULT8")"; echo "$OUT"
check "feeproj8 prepare ok" "$OUT" '"prepared":true'
LTX="$(LOCK_REPO="testowner/feeproj8" LOCK_AMOUNT=10 LOCK_TOKEN="$WETH_FEE" npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/lock-for-repo-fee.ts | grep -o 'LOCK_TX=0x[0-9a-f]*' | cut -d= -f2)"
OUT="$(register_for testowner/feeproj8 "$T" "$VAULT8" "$LTX")"; echo "$OUT"
check "feeproj8 unstamped" "$OUT" '"stamped":false'
check "feeproj8 lock-token mismatch code" "$OUT" '"code":"LAUNCH_LOCK_TOKEN_MISMATCH"'
check_absent_fee "feeproj8 grant NOT launchVerified" "$OUT" '"launchVerified":true'

# ─── Round-4, blocker 2: capped release stays QUEUED until settled ───
# A separate grant (testowner/caprepo) holds 40 tranches of 1 WETH
# all vesting at counted total 1 — one releaseFee call settles only
# MAX_TRANCHES_PER_RELEASE (16). The backend must keep the release
# queued after the successful capped tx and the sweep must drain
# the rest with NO new pushes, to the exact wei.

echo "=== 37. round-4: 40 tranches vest at one count -> capped release stays queued -> sweep drains ==="
OUT="$(npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/deploy-cap.ts)" || exit 1; echo "$OUT"
CAP_ESCROW="$(python3 -c "import json;print(json.load(open('tests/e2e/state-cap.json'))['feeStreamEscrow'])")"
OUT="$OUT
$(FEE_STREAM_ESCROW_ADDRESS="$CAP_ESCROW" npx tsx tests/e2e/fee-cap.ts)"; echo "$OUT"
check "cap: 40 tranches deployed at baseline 0" "$OUT" "CAP_DEPLOY tranches=40"
check "cap: first release pays exactly the capped subset (16 WETH)" "$OUT" '"payout":"16000000000000000000"'
check "cap: first release reports the remainder still due (24 WETH)" "$OUT" '"remainingDue":"24000000000000000000"'
check "cap: recipient holds exactly 16 WETH after the capped release" "$OUT" "CAP_CHECK recipient after first release: 16 WETH"
check "cap: pending entry SURVIVES the successful capped tx" "$OUT" '"pushCount":1'
check "cap: pending entry names the partial settlement" "$OUT" "release partially settled at count 1"
check "cap: sweep drains the remainder (final call pays 8 WETH)" "$OUT" '"payout":"8000000000000000000"'
check "cap: pending cleared only at zero due" "$OUT" "CAP_CHECK pending after sweep: null"
check "cap: recipient lifetime total exact (40 WETH)" "$OUT" "CAP_CHECK recipient after sweep: 40 WETH"
check "cap: second sweep finds nothing queued" "$OUT" "CAP_CHECK second sweep entries: 0"
check "cap: second sweep pays nothing extra (still 40 WETH)" "$OUT" "CAP_CHECK recipient after second sweep: 40 WETH"

echo "=== FEE-LOCK DRIVER DONE — failures: $FAILURES ==="
[ "$FAILURES" -eq 0 ] || exit 1
