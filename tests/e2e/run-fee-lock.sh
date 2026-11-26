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

echo "=== 12. balances before keeper: nothing claimed, nothing released ==="
OUT="$(npx tsx tests/e2e/balances-fee.ts before)"; echo "$OUT"
check "vault holds 0 before claim" "$OUT" "vault WETH=0"
check "recipient WETH 0 before any push" "$OUT" "recipient PTK=0 WETH=0"

echo "=== 13. keeper cycle 1: claim 40 WETH -> lock tranche 1 ==="
OUT="$(KEEPER_PRIVATE_KEY="$KEEPER_KEY" FEE_CLAIM_SOURCE="$SOURCE" npx tsx scripts/fee-lock-keeper.ts "$VAULT")"; echo "$OUT"
check "keeper locked 40 WETH" "$OUT" '"lockedAmount":"40000000000000000000"'
check "keeper tranche 1 baseline = 0 counted pushes (provenance)" "$OUT" '"expectedBaseline":"0"'
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

echo "=== 21. recognition: vault bound to another repo -> UNSTAMPED ==="
set_record "[[\"$DEPLOYER\",2500],[\"$VAULT3\",7500]]"
T="$(verify_for testowner/feeproj3)"
OUT="$(prepare_for testowner/feeproj3 "$T" "$VAULT3")"; echo "$OUT"
check "feeproj3 prepare ok" "$OUT" '"prepared":true'
LTX="$(lock_for testowner/feeproj3 | grep -o 'LOCK_TX=0x[0-9a-f]*' | cut -d= -f2)"
OUT="$(register_for testowner/feeproj3 "$T" "$VAULT3" "$LTX")"; echo "$OUT"
check "feeproj3 unstamped" "$OUT" '"stamped":false'
check "feeproj3 repo mismatch code" "$OUT" '"code":"LAUNCH_VAULT_REPO_MISMATCH"'

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

echo "=== FEE-LOCK DRIVER DONE — failures: $FAILURES ==="
[ "$FAILURES" -eq 0 ] || exit 1
