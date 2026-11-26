#!/usr/bin/env bash
# TEST-ONLY local E2E driver. Everything runs on localhost against a local
# Hardhat node (chainId 8453) and a minimal in-memory Redis-protocol stub.
# No external deploys, no real keys: oracle = Hardhat well-known account #1,
# GitHub App key = a throwaway RSA key generated into /tmp.
set -u
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
LOG="$ROOT/tests/e2e/e2e-output.log"
: > "$LOG"
exec > >(tee -a "$LOG") 2>&1

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT

# ── throwaway GitHub App RSA key (test only, lives in /tmp) ──────────────────
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
  # Swarm window pinned to 0 (mandatory-window rule, 2026-11-26): this suite
  # predates the swarm and exercises pushes synchronously — a 0-length
  # window settles by immediate verifier fallback. Swarm paths are
  # covered by run-swarm.sh and run-swarm-window.sh.
  export SWARM_REVIEW_WINDOW_SECONDS=0
}

wait_http() { # url, tries
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

echo "=== 4. vesting server ==="
set_test_env
npx tsx src/index.ts &
PIDS+=($!)
wait_http "http://127.0.0.1:3210/health" 30 || exit 1
echo "server up"

echo "=== 5. seed grant + linked wallet ==="
npx tsx tests/e2e/seed.ts || exit 1

echo "=== 6. balances before ==="
npx tsx tests/e2e/balances.ts before

echo "=== 7a. webhook: plain meaningful push ==="
node tests/e2e/send-webhook.mjs plain
npx tsx tests/e2e/balances.ts after-plain

echo "=== 7b. webhook: docs-only push (expect reject) ==="
node tests/e2e/send-webhook.mjs docs
npx tsx tests/e2e/balances.ts after-docs

echo "=== 7c. webhook: squash-merge style push (#42, GitHub API unreachable/fake -> fallback) ==="
timeout 180 node tests/e2e/send-webhook.mjs squash
npx tsx tests/e2e/balances.ts after-squash

echo "=== 8. payRewardForMerge direct (twice, same merge) ==="
npx tsx tests/e2e/reward-test.ts

echo "=== 9. ShipRewards.pay direct (twice, same hash -> 2nd reverts) ==="
npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/direct-pay.ts

echo "=== E2E DRIVER DONE ==="
