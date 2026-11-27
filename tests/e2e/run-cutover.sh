#!/usr/bin/env bash
# v1→v2 CUTOVER test: after the chain config is repointed at
# GitEscrowV2, a pre-cutover grant (no stored escrow) must still
# release from the legacy v1 escrow, and a post-cutover grant
# (stored escrow = v2) must release from v2. Local stack only:
# fake redis + Hardhat node (chainId 8453) + the real backend
# release module. No external calls, Hardhat test keys only.
set -u
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
LOG="$ROOT/tests/e2e/cutover-output.log"
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
  kill_port 8545; kill_port 6399
}
trap cleanup EXIT
cleanup
sleep 1

echo "=== 1. fake redis ==="
node tests/e2e/fake-redis.js &
PIDS+=($!)
sleep 1

echo "=== 2. hardhat node (chainId 8453) ==="
npx hardhat node --config hardhat.local.config.ts --port 8545 &
PIDS+=($!)
for i in $(seq 1 30); do
  curl -s http://127.0.0.1:8545 -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' | grep -q "0x210d" && break
  sleep 1
done

echo "=== 3. deploy cutover fixtures (v1 legacy + v2 current) ==="
npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/deploy-cutover.ts || exit 1

V1="$(python3 -c "import json;print(json.load(open('tests/e2e/state-cutover.json'))['v1'])")"
V2="$(python3 -c "import json;print(json.load(open('tests/e2e/state-cutover.json'))['v2'])")"
V3="$(python3 -c "import json;print(json.load(open('tests/e2e/state-cutover.json'))['v3'])")"
echo "legacy (v1): $V1"
echo "current (v2): $V2"
echo "multi-lock (v3): $V3"

echo "=== 4. backend release path under the repointed config ==="
# Hardhat account #0 — the escrows' oracle and the backend signer.
export ORACLE_PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
export BASE_RPC_URL="http://127.0.0.1:8545"
export ROBINHOOD_RPC_URL="http://127.0.0.1:8545"
# Phase-2 repoint: configured escrow is now V3; V2 joins the
# historical list via GIT_ESCROW_V2_ADDRESS. Existing grants keep
# releasing from their own escrows (stored / legacy resolution).
export GIT_ESCROW_ADDRESS="$V3"
export GIT_ESCROW_V2_ADDRESS="$V2"
export GIT_ESCROW_LEGACY_ADDRESS="$V1"
export REDIS_URL="redis://127.0.0.1:6399"
npx tsx tests/e2e/cutover-release.ts
DRIVER_EXIT=$?

echo "=== CUTOVER DRIVER DONE — exit: $DRIVER_EXIT ==="
exit $DRIVER_EXIT
