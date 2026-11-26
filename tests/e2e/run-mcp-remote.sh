#!/usr/bin/env bash
# TEST-ONLY driver for the remote MCP endpoint (Streamable HTTP at /mcp).
# Boots the same local stack as run-attestation.sh (fake redis + Hardhat
# node chainId 8453 + vesting server + seeded grant) and proves:
#   (a) MCP over HTTP: initialize -> tools/list (13 tools) -> tools/call
#       vesting_status returns the seeded grant (mcp/smoke-http.mjs)
#   (b) unknown tool + malformed JSON-RPC body error cleanly (in smoke-http)
#   (c) stdio MCP server still passes its smoke (mcp/smoke.mjs) — no
#       regression from the shared-tool-module refactor
#   (d) the stdio and HTTP tool lists are IDENTICAL (no transport drift)
#   (e) /mcp mount does not swallow other routes (unknown route -> 404)
# No external calls, no real keys (Hardhat test accounts + throwaway RSA).
set -u
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
LOG="$ROOT/tests/e2e/mcp-remote-output.log"
: > "$LOG"
exec > >(tee -a "$LOG") 2>&1

FAILURES=0
note_fail() { echo "FAIL: $1"; FAILURES=$((FAILURES + 1)); }

PIDS=()
kill_port() {
  local pids
  pids="$(ss -ltnp 2>/dev/null | grep ":$1 " | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u)"
  for p in $pids; do kill "$p" 2>/dev/null || true; done
}
cleanup() {
  for pid in "${PIDS[@]:-}"; do [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null || true; done
  kill_port 8545; kill_port 6399; kill_port 3210
}
trap cleanup EXIT

if [ ! -f /tmp/e2e_github_app_key.pem ]; then
  openssl genrsa -out /tmp/e2e_github_app_key.pem 2048 2>/dev/null
fi
APP_KEY_ESCAPED="$(python3 -c "print(open('/tmp/e2e_github_app_key.pem').read().replace('\n','\\\\n'), end='')")"

export ORACLE_PRIVATE_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
export PORT=3210 HOST=127.0.0.1 NODE_ENV=development
export GITHUB_APP_ID=123456
export GITHUB_APP_PRIVATE_KEY="$APP_KEY_ESCAPED"
export GITHUB_WEBHOOK_SECRET="local_test_only"
export GITHUB_CLIENT_ID="test-client-id"
export GITHUB_CLIENT_SECRET="local_test_only"
export REDIS_URL="redis://127.0.0.1:6399"
export SESSION_SECRET="local_test_only"
export BASE_RPC_URL="http://127.0.0.1:8545"
export FRONTEND_URL="http://localhost:5173"
export SERVER_URL="http://127.0.0.1:3210"

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

echo "=== 3. deploy + lock + fund ==="
npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/deploy.ts || exit 1
GIT_ESCROW_ADDRESS="$(python3 -c "import json;print(json.load(open('tests/e2e/state.json'))['gitEscrow'])")"
SHIP_REWARDS_ADDRESS="$(python3 -c "import json;print(json.load(open('tests/e2e/state.json'))['shipRewards'])")"
export GIT_ESCROW_ADDRESS SHIP_REWARDS_ADDRESS
export SHIP_REWARD_PER_MERGE="10000000000000000000"

echo "=== 4. vesting server (with /mcp mounted) ==="
npx tsx src/index.ts &
PIDS+=($!)
wait_http "http://127.0.0.1:3210/health" 30 || exit 1
echo "server up"

echo "=== 5. seed grant + linked wallet ==="
npx tsx tests/e2e/seed.ts || exit 1

echo "=== 6. MCP over HTTP smoke ==="
MCP_URL="http://127.0.0.1:3210/mcp" node mcp/smoke-http.mjs testowner/testrepo > /tmp/mcp-http-out.txt 2>&1 \
  || note_fail "smoke-http exited non-zero"
cat /tmp/mcp-http-out.txt
grep -q "SMOKE-HTTP: ALL PASS" /tmp/mcp-http-out.txt || note_fail "smoke-http checks failed"

echo "=== 7. stdio MCP smoke (regression) ==="
POD_API_URL="http://127.0.0.1:3210" node mcp/smoke.mjs testowner/testrepo > /tmp/mcp-stdio-out.txt 2>&1 \
  || note_fail "stdio smoke exited non-zero"
cat /tmp/mcp-stdio-out.txt
grep -q "SMOKE PASS" /tmp/mcp-stdio-out.txt || note_fail "stdio smoke failed"

echo "=== 8. tool-list consistency (stdio vs HTTP) ==="
HTTP_TOOLS="$(grep '^TOOLS_JSON:' /tmp/mcp-http-out.txt | sed 's/^TOOLS_JSON://')"
STDIO_TOOLS="$(grep 'tools/list ->' /tmp/mcp-stdio-out.txt | sed 's/.*tools\/list -> //' | python3 -c "import sys,json; print(json.dumps(sorted([s.strip() for s in sys.stdin.read().strip().split(',')]),separators=(',',':')))")"
echo "http:  $HTTP_TOOLS"
echo "stdio: $STDIO_TOOLS"
[ "$HTTP_TOOLS" = "$STDIO_TOOLS" ] || note_fail "tool lists differ between transports"

echo "=== 9. /mcp mount does not swallow other routes ==="
CODE="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3210/definitely-not-a-route)"
echo "unknown route -> HTTP $CODE"
[ "$CODE" = "404" ] || note_fail "unknown route did not 404"

echo "=== RESULT: $FAILURES failure(s) ==="
[ "$FAILURES" = "0" ]
