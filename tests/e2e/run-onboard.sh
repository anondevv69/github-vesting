#!/usr/bin/env bash
# TEST-ONLY driver for LAUNCH ONBOARDING (POST /api/launch/onboard —
# built 2026-11-26, closing the gap the web launch wizard found:
# prepare-launch required a platform-deployed fee-lock vault + a
# registrar-registered fee grant, but no endpoint existed to request,
# trigger, or look them up).
#
# Same local stack as run-launch-gate.sh (fake redis + Hardhat node
# chainId 8453 + fixture GitHub API + the real vesting server). The
# fee-lock fixture here (deploy-onboard.ts) deploys FeeStreamEscrow
# FROM the oracle account, modelling production, where the escrow's
# owner/registrar and the backend's oracle signer are one wallet.
#
# Proves (tests/e2e/onboard-cases.mjs):
#   - no token / garbage token        -> 403, fail closed
#   - first authenticated onboard     -> deploys ONE FeeLockVault from
#                                        the approved implementation,
#                                        registers the matching grant,
#                                        returns both + tx hashes
#   - the onboarded vault             -> passes prepare-launch's own
#                                        binding validation + fee-grant
#                                        check (prepared, vault named
#                                        as the 75% fee recipient)
#   - second onboard (same repo+user) -> SAME vault, alreadyOnboarded,
#                                        no duplicate deployment
#   - token bound to another repo     -> 403 LAUNCH_TOKEN_REPO_MISMATCH
#   - partial state (vault deployed,  -> retry registers the grant
#     grant registration "failed")       against the EXISTING vault —
#                                        no second deployment — and the
#                                        resumed vault prepares too
# No external calls, no real keys (Hardhat test accounts + throwaway RSA).
set -u
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
LOG="$ROOT/tests/e2e/onboard-output.log"
: > "$LOG"
exec > >(tee -a "$LOG") 2>&1

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
# Hardhat account #1 — the onboard fixture's escrow owner/registrar/oracle.
export ORACLE_PRIVATE_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"

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

echo "=== 1. fake redis ==="
node tests/e2e/fake-redis.js &
PIDS+=($!)
sleep 1

echo "=== 2. hardhat node (chainId 8453) ==="
npx hardhat node --config hardhat.local.config.ts --port 8545 &
PIDS+=($!)
wait_rpc || exit 1
echo "node up"

echo "=== 3. base fixture (state.json: recipient/token for seed-gate) ==="
npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/deploy.ts || exit 1
DEPLOYER="$(python3 -c "import json;print(json.load(open('tests/e2e/state.json'))['deployer'])")"

echo "=== 4. onboarding fixture (escrow owned by the oracle signer; NO vault, NO grant) ==="
npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/deploy-onboard.ts || exit 1
export FEE_STREAM_ESCROW_ADDRESS="$(python3 -c "import json;print(json.load(open('tests/e2e/state-onboard.json'))['escrow'])")"
export WETH_ADDRESS="$(python3 -c "import json;print(json.load(open('tests/e2e/state-onboard.json'))['weth'])")"
export BANKR_CLAIM_LEDGER_ADDRESS="$(python3 -c "import json;print(json.load(open('tests/e2e/state-onboard.json'))['source'])")"
export BANKR_FEE_LEDGER_ADDRESS="$BANKR_CLAIM_LEDGER_ADDRESS"
echo "feeStreamEscrow=$FEE_STREAM_ESCROW_ADDRESS weth=$WETH_ADDRESS claimLedger=$BANKR_CLAIM_LEDGER_ADDRESS"

echo "=== 5. fixture GitHub API ==="
node tests/e2e/github-fixture.js &
PIDS+=($!)
sleep 1

echo "=== 6. vesting server ==="
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
export PLATFORM_REWARD_TREASURY_WALLET="$DEPLOYER"
npx tsx src/index.ts &
PIDS+=($!)
wait_http "$API/health" 30 || exit 1
echo "server up"

echo "=== 7. seed: @testauthor wallet links ==="
npx tsx tests/e2e/seed-gate.ts || exit 1

echo "=== 8. seed the resumability fixture (vault deployed, grant missing) ==="
REDIS_URL="redis://127.0.0.1:6399" npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/seed-onboard-partial.ts || exit 1

echo "=== 9. onboarding cases ==="
ONBOARD_API="$API" \
ONBOARD_STATE="$ROOT/tests/e2e/state-onboard.json" \
ONBOARD_PARTIAL_STATE="$ROOT/tests/e2e/state-onboard-partial.json" \
  node tests/e2e/onboard-cases.mjs
CASES_RC=$?

echo "=== ONBOARD DRIVER DONE — cases rc: $CASES_RC ==="
exit $CASES_RC
