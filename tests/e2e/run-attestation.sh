#!/usr/bin/env bash
# TEST-ONLY driver for the Claude attestation layer (ship reports).
# Same local stack as run-pr-credit.sh (fake redis + Hardhat node chainId
# 8453 + fixture GitHub API + vesting server). Proves:
#   (a) POST report for the PR #42 merge sha -> GET shows "reported"
#       with settlement="github-webhook" + reportMovesMoney=false
#   (e) malformed report bodies -> 400
#   (b) counted PR-merge webhook for that sha -> GET shows "paid" with
#       release + reward tx hashes; balances move (500 PTK, 10 RWD)
#   (c) report for a docs-only push + its webhook -> GET shows "rejected"
#       with the verifier's reason
#   (d) report with no webhook -> stays "reported"; a report seeded 25h
#       old -> GET shows "expired" (lazy expiry)
#   (+) MCP smoke: initialize + tools/list + vesting_status tools/call
# No external calls, no real keys (Hardhat test accounts + throwaway RSA).
set -u
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
LOG="$ROOT/tests/e2e/attestation-output.log"
: > "$LOG"
exec > >(tee -a "$LOG") 2>&1

FAILURES=0
check() { # name, haystack, needle
  if printf '%s' "$2" | grep -q "$3"; then
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
export SHIP_REWARD_PER_MERGE="10000000000000000000"

echo "=== 4. fixture GitHub API ==="
node tests/e2e/github-fixture.js &
PIDS+=($!)
sleep 1

echo "=== 5. vesting server ==="
set_test_env
npx tsx src/index.ts &
PIDS+=($!)
wait_http "http://127.0.0.1:3210/health" 30 || exit 1
echo "server up"

echo "=== 6. seed grant + linked wallet (@testauthor) ==="
npx tsx tests/e2e/seed.ts || exit 1

echo "=== 6b. MCP smoke (initialize + tools/list + vesting_status) ==="
if [ -d mcp/node_modules/@modelcontextprotocol/sdk ]; then
  POD_API_URL="http://127.0.0.1:3210" timeout 120 node mcp/smoke.mjs testowner/testrepo || FAILURES=$((FAILURES + 1))
else
  echo "SKIP: mcp/node_modules missing (run npm install in mcp/ first)"
  FAILURES=$((FAILURES + 1))
fi

echo "=== 7a. (a) report the PR #42 merge BEFORE its webhook ==="
OUT="$(node tests/e2e/ship-report.mjs post prhuman)"; echo "$OUT"
check "a: post accepted" "$OUT" '"ok":true'
GET="$(node tests/e2e/ship-report.mjs get prhuman)"; echo "$GET"
check "a: state reported" "$GET" '"state":"reported"'
check "a: settlement field" "$GET" '"settlement":"github-webhook"'
check "a: reportMovesMoney false" "$GET" '"reportMovesMoney":false'
LIST="$(node tests/e2e/ship-report.mjs list)"; echo "$LIST"
check "a: list contains report" "$LIST" '"count":1'

echo "=== 7b. (e) malformed reports -> 400 ==="
BAD1="$(node tests/e2e/ship-report.mjs post-raw '{"repo":"testowner/testrepo"}')"; echo "$BAD1"
check "e: missing headSha -> 400" "$BAD1" "HTTP 400"
BAD2="$(node tests/e2e/ship-report.mjs post-raw '{"repo":"noslash","headSha":"c0ffee0000000000000000000000000000000042"}')"; echo "$BAD2"
check "e: bad repo -> 400" "$BAD2" "HTTP 400"
BAD3="$(node tests/e2e/ship-report.mjs post-raw '{"repo":"testowner/testrepo","headSha":"xyz"}')"; echo "$BAD3"
check "e: bad sha -> 400" "$BAD3" "HTTP 400"

echo "=== 8. (b) fire the counted PR-merge webhook -> report resolves paid ==="
timeout 180 node tests/e2e/send-webhook.mjs prhuman
GET="$(node tests/e2e/ship-report.mjs get prhuman)"; echo "$GET"
check "b: state paid" "$GET" '"state":"paid"'
check "b: releaseTxHash recorded" "$GET" '"releaseTxHash":"0x'
check "b: rewardTxHash recorded" "$GET" '"rewardTxHash":"0x'
npx tsx tests/e2e/balances.ts after-prhuman

echo "=== 9. (c) docs-only push: report + webhook -> rejected with reason ==="
OUT="$(node tests/e2e/ship-report.mjs post docs)"; echo "$OUT"
timeout 180 node tests/e2e/send-webhook.mjs docs
GET="$(node tests/e2e/ship-report.mjs get docs)"; echo "$GET"
check "c: state rejected" "$GET" '"state":"rejected"'
check "c: rejection reason stored" "$GET" '"reason":"Only docs/lockfiles changed'

echo "=== 10. (d) orphan report stays reported; 25h-old report reads expired ==="
OUT="$(node tests/e2e/ship-report.mjs post orphan)"; echo "$OUT"
GET="$(node tests/e2e/ship-report.mjs get orphan)"; echo "$GET"
check "d: orphan still reported" "$GET" '"state":"reported"'
npx tsx tests/e2e/seed-old-report.ts || exit 1
GET="$(node tests/e2e/ship-report.mjs get old)"; echo "$GET"
check "d: stale report expired" "$GET" '"state":"expired"'

echo "=== ATTESTATION DRIVER DONE — failures: $FAILURES ==="
[ "$FAILURES" -eq 0 ] || exit 1
