#!/usr/bin/env bash
# TEST-ONLY driver for grant-less merge rewards (audit H1) and
# pending-reward accrual + link settlement (audit H2).
# Same local stack as run-pr-credit.sh (fake redis + Hardhat node chainId
# 8453 + fixture GitHub API + vesting server). The grant repo is
# testowner/testrepo (seeded grant); the grant-less repo is
# testowner/nogrant (fixture PRs #44/#45, NO grant seeded). Proves:
#   (a) grant-less counted PR merge (author linked) -> author paid
#       exactly 10 RWD; ship report resolves paid; the push appears in
#       GET /api/vesting/recent-pushes. Docs-only push to the
#       grant-less repo -> rejected, nothing paid, report rejected.
#   (b) grant-less counted PR merge (author UNLINKED) -> no payment, a
#       pending reward is recorded and visible on
#       GET /api/dev/link-wallet/ghostdev; linking a wallet through the
#       real Flow A endpoints settles it (balance +10 RWD, pending list
#       empties, ship report flips to paid); re-link + webhook replay
#       do NOT double-pay.
# No external calls, no real keys (Hardhat test accounts + throwaway RSA).
set -u
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
LOG="$ROOT/tests/e2e/rewards-output.log"
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
kill_port() { # port
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

# Hardhat well-known test account #1 (oracle) — public, test-only.
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
  # Swarm window pinned to 0 (mandatory-window rule, 2026-11-26): this suite
  # predates the swarm and exercises pushes synchronously — a 0-length
  # window settles by immediate verifier fallback. Swarm paths are
  # covered by run-swarm.sh and run-swarm-window.sh.
  export SWARM_REVIEW_WINDOW_SECONDS=0
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

SHA44="$(python3 -c 'print("4"*40)')"
SHA45="$(python3 -c 'print("45"*20)')"
SHADOCS="$(python3 -c 'print("d"*40)')"
NOGRANT="testowner/nogrant"

report_post() { # sha pr author
  curl -s -X POST "http://127.0.0.1:3210/api/agent/report-ship" \
    -H 'content-type: application/json' \
    -d "{\"repo\":\"$NOGRANT\",\"headSha\":\"$1\",\"prNumber\":$2,\"authorLogin\":\"$3\"}"
}
report_get() { # sha
  curl -s "http://127.0.0.1:3210/api/agent/ship-report?repo=$NOGRANT&sha=$1"
}
link_get() { # login
  curl -s "http://127.0.0.1:3210/api/dev/link-wallet/$1"
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
export SHIP_REWARD_PER_MERGE="10000000000000000000" # 10 RWD in wei

echo "=== 4. fixture GitHub API ==="
node tests/e2e/github-fixture.js &
PIDS+=($!)
sleep 1
curl -s http://127.0.0.1:8977/repos/testowner/nogrant/pulls/44 | head -c 300; echo

echo "=== 5. vesting server (GITHUB_API_BASE_URL -> fixture) ==="
set_test_env
npx tsx src/index.ts &
PIDS+=($!)
wait_http "http://127.0.0.1:3210/health" 30 || exit 1
echo "server up"

echo "=== 6. seed grant (testrepo only) + linked wallet (@testauthor) ==="
npx tsx tests/e2e/seed.ts || exit 1

GHOST_WALLET="$(node --input-type=module -e "import { privateKeyToAccount } from 'viem/accounts'; console.log(privateKeyToAccount('0x' + '22'.repeat(32)).address);")"
echo "ghost wallet (unlinked): $GHOST_WALLET"

echo "=== 7. balances before ==="
npx tsx tests/e2e/balances-rewards.ts before "$GHOST_WALLET"

echo "=== 8. (a) grant-less counted merge, linked author -> +10 RWD, report paid ==="
OUT="$(report_post "$SHA44" 44 testauthor)"; echo "$OUT"
check "a: report accepted" "$OUT" '"ok":true'
WH="$(REPO=$NOGRANT timeout 180 node tests/e2e/send-webhook.mjs gl44)"; echo "$WH"
check "a: webhook accepted" "$WH" '"accepted":true'
check "a: webhook marked grantless" "$WH" '"grantless":true'
check "a: reward paid" "$WH" '"paid":true'
BAL="$(npx tsx tests/e2e/balances-rewards.ts after-gl44 "$GHOST_WALLET")"; echo "$BAL"
check "a: author RWD = 10" "$BAL" 'author RWD=10 |'
GET="$(report_get "$SHA44")"; echo "$GET"
check "a: ship report paid" "$GET" '"state":"paid"'
check "a: ship report has reward tx" "$GET" '"rewardTxHash":"0x'
FEED="$(curl -s "http://127.0.0.1:3210/api/vesting/recent-pushes?limit=30")"; echo "$FEED"
check "a: recent-pushes feed includes grant-less push" "$FEED" "\"sha\":\"$SHA44\""
check "a: feed row names the grant-less repo" "$FEED" '"repoFullName":"testowner/nogrant"'

echo "=== 9. (a2) grant-less docs-only push -> rejected, nothing paid ==="
OUT="$(report_post "$SHADOCS" 46 testauthor)"; echo "$OUT"
WH="$(REPO=$NOGRANT timeout 180 node tests/e2e/send-webhook.mjs gldocs)"; echo "$WH"
check "a2: webhook rejected" "$WH" '"accepted":false'
BAL="$(npx tsx tests/e2e/balances-rewards.ts after-gldocs "$GHOST_WALLET")"; echo "$BAL"
check "a2: author RWD still 10" "$BAL" 'author RWD=10 |'
GET="$(report_get "$SHADOCS")"; echo "$GET"
check "a2: ship report rejected" "$GET" '"state":"rejected"'
check "a2: rejection reason stored" "$GET" '"reason":"Only docs/lockfiles changed'

echo "=== 10. (b) grant-less counted merge, UNLINKED author -> pending accrual ==="
OUT="$(report_post "$SHA45" 45 ghostdev)"; echo "$OUT"
WH="$(REPO=$NOGRANT timeout 180 node tests/e2e/send-webhook.mjs gl45)"; echo "$WH"
check "b: webhook accepted" "$WH" '"accepted":true'
check "b: reward accrued (pending)" "$WH" '"pending":true'
BAL="$(npx tsx tests/e2e/balances-rewards.ts after-gl45 "$GHOST_WALLET")"; echo "$BAL"
check "b: ghost RWD still 0 (not paid)" "$BAL" 'extra RWD=0 |'
LG="$(link_get ghostdev)"; echo "$LG"
check "b: pending lists the merge" "$LG" "\"mergeSha\":\"$SHA45\""
check "b: pending amount is 10 RWD in wei" "$LG" '"amount":"10000000000000000000"'
check "b: pending total matches" "$LG" '"pendingRewardsTotal":"10000000000000000000"'
GET="$(report_get "$SHA45")"; echo "$GET"
check "b: ship report still reported (no payment yet)" "$GET" '"state":"reported"'

echo "=== 11. (b2) link wallet via real Flow A endpoints -> settlement pays out ==="
LINK_OUT="$(npx tsx tests/e2e/link-wallet-flow-a.ts)" || { echo "$LINK_OUT"; echo "FAIL: link flow exited non-zero"; FAILURES=$((FAILURES + 1)); }
echo "$LINK_OUT"
check "b2: link confirm ok" "$LINK_OUT" '"ok":true'
BAL="$(npx tsx tests/e2e/balances-rewards.ts after-link "$GHOST_WALLET")"; echo "$BAL"
check "b2: ghost RWD = 10 after link" "$BAL" 'extra RWD=10 |'
LG="$(link_get ghostdev)"; echo "$LG"
check "b2: pending list emptied" "$LG" '"pendingRewards":[]'
check "b2: pending total zero" "$LG" '"pendingRewardsTotal":"0"'
GET="$(report_get "$SHA45")"; echo "$GET"
check "b2: ship report flipped to paid on settlement" "$GET" '"state":"paid"'
check "b2: ship report has reward tx" "$GET" '"rewardTxHash":"0x'

echo "=== 12. (b3) replays do not double-pay ==="
LINK_OUT="$(npx tsx tests/e2e/link-wallet-flow-a.ts)" || { echo "$LINK_OUT"; echo "FAIL: re-link flow exited non-zero"; FAILURES=$((FAILURES + 1)); }
echo "$LINK_OUT"
WH="$(REPO=$NOGRANT timeout 180 node tests/e2e/send-webhook.mjs gl45)"; echo "$WH"
check "b3: webhook replay rejected (duplicate SHA)" "$WH" '"accepted":false'
BAL="$(npx tsx tests/e2e/balances-rewards.ts after-replays "$GHOST_WALLET")"; echo "$BAL"
check "b3: ghost RWD still 10 (no double-pay)" "$BAL" 'extra RWD=10 |'

echo "=== REWARDS DRIVER DONE — failures: $FAILURES ==="
[ "$FAILURES" -eq 0 ] || exit 1
