#!/usr/bin/env bash
# MULTI-GRANT suite (Phase 2, design §7): the full multi-lock
# checklist on the local stack (fake redis + Hardhat node 8453 +
# fixture GitHub API + the real vesting server):
#
#   Phase A (driver, window=0): legacy V2 grant + V3 grant A (100/1)
#     + V3 grant B (50/1, baseline 10) on ONE repo / ONE counter,
#     interleaved counted pushes to completion; B's completion is
#     isolated; the one PR-credited push pays the author reward
#     exactly once.
#   Phase B (server, post-cutover config): prepare-lock
#     expectedGrantId == Locked grantId; V3 registrations never 409
#     and never reset the counter; a V2 lock still 409s; status
#     primary + grants[], ?grantId=, /api/vesting/grant/:grantId.
#   Phase C (server, window=1h): grants D + E on the Phase-A repo;
#     a swarm-quorum-counted push settles both.
set -u
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
LOG="$ROOT/tests/e2e/multigrant-output.log"
: > "$LOG"
exec > >(tee -a "$LOG") 2>&1

FAILURES=0
note_fail() { FAILURES=$((FAILURES + 1)); }

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
cleanup
sleep 1

if [ ! -f /tmp/e2e_github_app_key.pem ]; then
  openssl genrsa -out /tmp/e2e_github_app_key.pem 2048 2>/dev/null
fi
APP_KEY_ESCAPED="$(python3 -c "print(open('/tmp/e2e_github_app_key.pem').read().replace('\n','\\\\n'), end='')")"
# Hardhat account #1 — the escrows' oracle and the backend signer.
export ORACLE_PRIVATE_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"

set_common_env() {
  export NODE_ENV=development
  export GITHUB_APP_ID=123456
  export GITHUB_APP_PRIVATE_KEY="$APP_KEY_ESCAPED"
  export GITHUB_WEBHOOK_SECRET="test-webhook-secret"
  export GITHUB_CLIENT_ID="test-client-id"
  export GITHUB_CLIENT_SECRET="test-client-secret"
  export SESSION_SECRET="test-session-secret"
  export REDIS_URL="redis://127.0.0.1:6399"
  export BASE_RPC_URL="http://127.0.0.1:8545"
  export ROBINHOOD_RPC_URL="http://127.0.0.1:8545"
  export FRONTEND_URL="http://localhost:5173"
  export SERVER_URL="http://127.0.0.1:3210"
  export GITHUB_API_BASE_URL="http://127.0.0.1:8977"
  export GIT_ESCROW_ADDRESS="$(python3 -c "import json;print(json.load(open('tests/e2e/state-multigrant.json'))['v3'])")"
  export GIT_ESCROW_V2_ADDRESS="$(python3 -c "import json;print(json.load(open('tests/e2e/state-multigrant.json'))['v2'])")"
  export SHIP_REWARDS_ADDRESS="$(python3 -c "import json;print(json.load(open('tests/e2e/state-multigrant.json'))['shipRewards'])")"
  export SHIP_REWARD_PER_MERGE="10000000000000000000"
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

echo "=== 1. fake redis + hardhat node + fixture GitHub API ==="
node tests/e2e/fake-redis.js &
PIDS+=($!)
sleep 1
npx hardhat node --config hardhat.local.config.ts --port 8545 &
PIDS+=($!)
wait_rpc || exit 1
node tests/e2e/github-fixture.js &
PIDS+=($!)
sleep 1

echo "=== 2. deploy multigrant fixtures ==="
npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/deploy-multigrant.ts || exit 1
set_common_env

echo "=== 3. PHASE A: three grants, one counter, interleaved pushes to completion ==="
SWARM_REVIEW_WINDOW_SECONDS=0 npx tsx tests/e2e/multigrant-drive.ts || note_fail

echo "=== 4. PHASE B: server (post-cutover config) + registration/status driver ==="
export PORT=3210 HOST=127.0.0.1
SWARM_REVIEW_WINDOW_SECONDS=3600 npx tsx src/index.ts &
PIDS+=($!)
wait_http "http://127.0.0.1:3210/health" 30 || exit 1
echo "server up"
npx tsx tests/e2e/multigrant-register.ts || note_fail

echo "=== 5. PHASE C: swarm-quorum push settles all active grants ==="
REVONE="$(python3 -c "import json;print(json.load(open('tests/e2e/state-multigrant.json'))['revone'])")"
REVTWO="$(python3 -c "import json;print(json.load(open('tests/e2e/state-multigrant.json'))['rewtwo'])" 2>/dev/null || python3 -c "import json;print(json.load(open('tests/e2e/state-multigrant.json'))['revtwo'])")"
npx tsx tests/e2e/swarm-review.ts enrol revone "$REVONE"
npx tsx tests/e2e/swarm-review.ts enrol revtwo "$REVTWO"
SHA49="$(python3 -c "print('49'*20)")"
node tests/e2e/send-webhook.mjs swarm49
npx tsx tests/e2e/swarm-review.ts review revone "$SHA49" 49 pass
npx tsx tests/e2e/swarm-review.ts review revtwo "$SHA49" 49 pass
npx tsx tests/e2e/multigrant-final.ts || note_fail

echo "=== MULTIGRANT DRIVER DONE — failures: $FAILURES ==="
[ "$FAILURES" -eq 0 ] || exit 1
