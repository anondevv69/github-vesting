#!/usr/bin/env bash
# TEST-ONLY driver for the REVIEWER SWARM (Gregory, 2026-11-25).
# Same local stack as run-rewards.sh (fake redis + Hardhat node chainId
# 8453 + fixture GitHub API + vesting server). The grant on
# testowner/testrepo is seeded with swarmReviewRequired: true.
# Reviewer reward is left UNSET in env, proving the labelled default:
# 10% of the 10 RWD base per-merge reward = 1 RWD per PASS reviewer.
# Proves:
#   - enrolment refuses a wallet not linked to the login
#   - push with swarm ON, no reviews -> NOT counted (swarm reason logged)
#   - the push appears in an independent reviewer's queue
#   - the AUTHOR reviewing their own push -> SWARM_REVIEW_NOT_INDEPENDENT
#   - 1 PASS (below quorum of 2) -> still NOT counted
#   - 2nd independent PASS -> webhook counts it: milestone release
#     (500 PTK) + author reward (10 RWD) + BOTH reviewers paid 1 RWD
#   - webhook replay -> rejected (duplicate SHA), nobody double-paid
#   - duplicate diff: PR #48's fingerprint exactly equals PR #47's
#     counted fingerprint -> auto-flagged; a FAIL citing duplicate +
#     one PASS -> webhook does NOT count it (duplicate/veto rule)
# No external calls, no real keys (Hardhat test accounts + throwaway RSA).
set -u
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
LOG="$ROOT/tests/e2e/swarm-output.log"
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
  echo "TIMEOUT waiting for hardhat node"; return 1
}

API="http://127.0.0.1:3210"
REPO="testowner/testrepo"
SHA47="$(python3 -c 'print("47"*20)')"
SHA48="$(python3 -c 'print("48"*20)')"

report_post() { # sha pr author repo
  curl -s -X POST "$API/api/agent/report-ship" -H 'content-type: application/json' \
    -d "{\"repo\":\"$4\",\"headSha\":\"$1\",\"prNumber\":$2,\"authorLogin\":\"$3\"}"
}

echo "=== 1. fake redis ==="
node tests/e2e/fake-redis.js &
PIDS+=($!)
sleep 1

echo "=== 2. hardhat node (chainId 8453) ==="
npx hardhat node --config hardhat.local.config.ts --port 8545 &
PIDS+=($!)
wait_rpc || exit 1
echo "node up"

echo "=== 3. deploy + lock + fund ==="
npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/deploy.ts || exit 1
GIT_ESCROW_ADDRESS="$(python3 -c "import json;print(json.load(open('tests/e2e/state.json'))['gitEscrow'])")"
SHIP_REWARDS_ADDRESS="$(python3 -c "import json;print(json.load(open('tests/e2e/state.json'))['shipRewards'])")"
export GIT_ESCROW_ADDRESS SHIP_REWARDS_ADDRESS
export SHIP_REWARD_PER_MERGE="10000000000000000000" # 10 RWD
# SHIP_REVIEWER_REWARD_PER_MERGE deliberately UNSET -> default 10% = 1 RWD.
export -n SHIP_REVIEWER_REWARD_PER_MERGE 2>/dev/null || unset SHIP_REVIEWER_REWARD_PER_MERGE

AUTHOR="$(python3 -c "import json;print(json.load(open('tests/e2e/state.json'))['author'])")"
DEPLOYER="$(python3 -c "import json;print(json.load(open('tests/e2e/state.json'))['deployer'])")"
REVONE_WALLET="$(node --input-type=module -e "import { privateKeyToAccount } from 'viem/accounts'; console.log(privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba').address);")"
REVTWO_WALLET="$(node --input-type=module -e "import { privateKeyToAccount } from 'viem/accounts'; console.log(privateKeyToAccount('0x92db14e403b83dfe3a4f8a9afce377d105145430f2421dbb26466aaa7a9ffc6a').address);")"
echo "author=$AUTHOR revone=$REVONE_WALLET revtwo=$REVTWO_WALLET"

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

echo "=== 6. seed swarm grant + linked wallets (author, revone, revtwo) ==="
npx tsx tests/e2e/seed-swarm.ts || exit 1

echo "=== 7. enrolment: unlinked wallet -> refused ==="
OUT="$(npx tsx tests/e2e/swarm-review.ts enrol revone "$DEPLOYER")"; echo "$OUT"
check "enrol unlinked wallet refused" "$OUT" '"code":"SWARM_WALLET_NOT_LINKED"'

echo "=== 8. enrolment: revone, revtwo, and the author (enrolment != per-push independence) ==="
OUT="$(npx tsx tests/e2e/swarm-review.ts enrol revone "$REVONE_WALLET")"; echo "$OUT"
check "revone enrolled" "$OUT" '"enrolled":true'
OUT="$(npx tsx tests/e2e/swarm-review.ts enrol revtwo "$REVTWO_WALLET")"; echo "$OUT"
check "revtwo enrolled" "$OUT" '"enrolled":true'
OUT="$(npx tsx tests/e2e/swarm-review.ts enrol testauthor "$AUTHOR")"; echo "$OUT"
check "author enrolled (may review others' pushes)" "$OUT" '"enrolled":true'

echo "=== 9. balances before ==="
npx tsx tests/e2e/balances-swarm.ts before

echo "=== 10. push #47 with NO reviews -> NOT counted (swarm gate) ==="
OUT="$(report_post "$SHA47" 47 testauthor "$REPO")"; echo "$OUT"
WH="$(timeout 180 node tests/e2e/send-webhook.mjs swarm47)"; echo "$WH"
check "no-review push rejected" "$WH" '"accepted":false'
check "rejection reason is the swarm gate" "$WH" 'Swarm review: awaiting independent reviews (0/2 PASS)'
BAL="$(npx tsx tests/e2e/balances-swarm.ts after-noreview)"; echo "$BAL"
check "nothing released without quorum" "$BAL" 'recipient PTK=0'
check "author not rewarded without quorum" "$BAL" 'author RWD=0 |'

echo "=== 11. queue: push awaits review for an independent reviewer ==="
OUT="$(npx tsx tests/e2e/swarm-review.ts queue "$REPO" revone)"; echo "$OUT"
check "queue lists push #47 for revone" "$OUT" "\"headSha\":\"$SHA47\""

echo "=== 12. author reviews OWN push -> refused (independence) ==="
OUT="$(npx tsx tests/e2e/swarm-review.ts review testauthor "$SHA47" 47 pass)"; echo "$OUT"
check "self-review refused" "$OUT" '"code":"SWARM_REVIEW_NOT_INDEPENDENT"'

echo "=== 13. first independent PASS -> still below quorum ==="
OUT="$(npx tsx tests/e2e/swarm-review.ts review revone "$SHA47" 47 pass)"; echo "$OUT"
check "revone PASS recorded" "$OUT" '"effectiveVerdict":"pass"'
check "quorum not yet met (1/2)" "$OUT" '"passCount":1'
WH="$(timeout 180 node tests/e2e/send-webhook.mjs swarm47)"; echo "$WH"
check "1-PASS push still not counted" "$WH" '"accepted":false'
check "reason shows 1/2 progress" "$WH" 'Swarm review: awaiting independent reviews (1/2 PASS)'

echo "=== 14. second independent PASS -> quorum; webhook counts + settles ==="
OUT="$(npx tsx tests/e2e/swarm-review.ts review revtwo "$SHA47" 47 pass)"; echo "$OUT"
check "revtwo PASS recorded" "$OUT" '"effectiveVerdict":"pass"'
check "quorum met at submission" "$OUT" '"met":true'
WH="$(timeout 180 node tests/e2e/send-webhook.mjs swarm47)"; echo "$WH"
check "quorum push accepted" "$WH" '"accepted":true'
check "milestone release triggered" "$WH" '"triggered":true'
check "author reward paid" "$WH" '"paid":true'
check "swarm block present in response" "$WH" '"reviewerRewards"'
BAL="$(npx tsx tests/e2e/balances-swarm.ts after-counted)"; echo "$BAL"
check "author RWD = 10" "$BAL" 'author RWD=10 |'
check "revone RWD = 1 (10% reviewer share)" "$BAL" 'revone RWD=1 |'
check "revtwo RWD = 1 (10% reviewer share)" "$BAL" 'revtwo RWD=1 |'
check "recipient PTK = 500 (milestone release)" "$BAL" 'recipient PTK=500'

echo "=== 15. webhook replay -> duplicate SHA, no double-pay ==="
WH="$(timeout 180 node tests/e2e/send-webhook.mjs swarm47)"; echo "$WH"
check "replay rejected" "$WH" '"accepted":false'
check "replay reason is duplicate SHA" "$WH" 'already counted'
BAL="$(npx tsx tests/e2e/balances-swarm.ts after-replay)"; echo "$BAL"
check "author still 10 after replay" "$BAL" 'author RWD=10 |'
check "revone still 1 after replay" "$BAL" 'revone RWD=1 |'
check "revtwo still 1 after replay" "$BAL" 'revtwo RWD=1 |'

echo "=== 16. duplicate diff (PR #48 == PR #47 code) + FAIL citing duplicate -> NOT counted ==="
OUT="$(report_post "$SHA48" 48 testauthor "$REPO")"; echo "$OUT"
OUT="$(npx tsx tests/e2e/swarm-review.ts review revone "$SHA48" 48 pass)"; echo "$OUT"
check "revone PASS on #48 recorded (pre-flag)" "$OUT" '"ok":true'
OUT="$(npx tsx tests/e2e/swarm-review.ts review revtwo "$SHA48" 48 fail-dupe)"; echo "$OUT"
check "revtwo FAIL on #48 recorded" "$OUT" '"effectiveVerdict":"fail"'
WH="$(timeout 180 node tests/e2e/send-webhook.mjs swarm48)"; echo "$WH"
check "duplicate push not counted" "$WH" '"accepted":false'
check "reason flags the duplicate diff" "$WH" 'exactly duplicates a previously counted diff'
OUT="$(npx tsx tests/e2e/swarm-review.ts reviews "$REPO" "$SHA48")"; echo "$OUT"
check "candidate carries duplicate flag" "$OUT" '"duplicateFlagged":true'
BAL="$(npx tsx tests/e2e/balances-swarm.ts after-dupe)"; echo "$BAL"
check "author still 10 after duplicate attempt" "$BAL" 'author RWD=10 |'
check "recipient still 500 after duplicate attempt" "$BAL" 'recipient PTK=500'

echo "=== SWARM DRIVER DONE — failures: $FAILURES ==="
[ "$FAILURES" -eq 0 ] || exit 1
