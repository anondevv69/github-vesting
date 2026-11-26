#!/usr/bin/env bash
# TEST-ONLY driver for UNSTAMPED-GRANT EXCLUSIONS (Codex review
# finding 1/2, 2026-11-25): a grant registered WITHOUT a verification
# token (the ordinary web-wizard vesting path) must be excluded from
# launch recognition —
#   (a) it never appears on the verified-launch listing
#       (GET /api/launch/projects) and carries launchVerified:false
#       on the general listing (GET /api/vesting/explore);
#   (b) it has NO ShipRewards launcher enrolment, before or after a
#       counted push (counted pushes on it remain ORDINARY vesting
#       counting — the lock is real — but create no launch
#       recognition and no launcher eligibility);
# while a verified launch (token + prepare-launch + post-verification
# lock — round-3: the prepared record is REQUIRED for the stamp) IS
# listed and enrolled. Same local stack as run-launch-gate.sh.
set -u
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
LOG="$ROOT/tests/e2e/launch-exclusions-output.log"
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
check_absent() { # name, haystack, needle-that-must-not-appear
  if printf '%s' "$2" | grep -qF "$3"; then
    echo "FAIL: $1 (unexpectedly present: $3)"
    FAILURES=$((FAILURES + 1))
  else
    echo "PASS: $1"
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
  export ROBINHOOD_RPC_URL="http://127.0.0.1:8545"
  export FRONTEND_URL="http://localhost:5173"
  export SERVER_URL="http://127.0.0.1:3210"
  export GITHUB_API_BASE_URL="http://127.0.0.1:8977"
  # Treasury for prepare-launch (the deployer stands in as the
  # designated reward treasury, as in run-launch-gate.sh).
  export PLATFORM_REWARD_TREASURY_WALLET="${DEPLOYER:-}"
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
LAUNCH_REPO="testauthor/launchrepo"
OTHER_REPO="testauthor/otherrepo"

verify() { # login repo wallet
  curl -s -X POST "$API/api/launch/verify-github" -H 'content-type: application/json' \
    -d "{\"githubLogin\":\"$1\",\"repo\":\"$2\",\"wallet\":\"$3\",\"chain\":\"base\"}"
}
prepare() { # wallet repo token-or-empty
  local body="{\"repo\":\"$2\",\"token\":\"$PTK\",\"amount\":\"10\",\"chain\":\"base\""
  if [ -n "$3" ]; then body="$body,\"verificationToken\":\"$3\""; fi
  body="$body}"
  curl -s -X POST "$API/api/agent/prepare-lock" -H 'content-type: application/json' \
    -H "x-wallet-address: $1" -d "$body"
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
RECIPIENT="$(python3 -c "import json;print(json.load(open('tests/e2e/state.json'))['recipient'])")"
AUTHOR="$(python3 -c "import json;print(json.load(open('tests/e2e/state.json'))['author'])")"
DEPLOYER="$(python3 -c "import json;print(json.load(open('tests/e2e/state.json'))['deployer'])")"
PTK="$(python3 -c "import json;print(json.load(open('tests/e2e/state.json'))['ptk'])")"
LOCK_TX="$(python3 -c "import json;print(json.load(open('tests/e2e/state.json'))['lockTx'])")"
MINT_TX="$(python3 -c "import json;print(json.load(open('tests/e2e/state.json'))['deployTxs']['ptk'])")"
echo "recipient=$RECIPIENT author=$AUTHOR ptk=$PTK"

echo "=== 3b. PRE-verification lock for testauthor/orderrepo (ordering fixture) ==="
# Locked BEFORE any verification token for orderrepo exists — the
# ordering test in step 23 registers it with a later-issued token and
# must NOT be stamped. NOTE: this lock runs as early as possible in
# the driver because Hardhat block timestamps drift ahead of wall
# clock under instant mining (+1s per block minimum); the ordering
# check compares the lock's block time with the token's wall-clock
# iat, so the fixture needs real seconds between lock and verify.
LOCK_OUT="$(LOCK_REPO="testauthor/orderrepo" LOCK_AMOUNT=10 npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/lock-for-repo.ts)" || exit 1
echo "$LOCK_OUT"
PRE_LOCK_TX="$(printf '%s' "$LOCK_OUT" | grep -o 'LOCK_TX=0x[0-9a-f]*' | cut -d= -f2)"
echo "pre-verification lock tx: $PRE_LOCK_TX"

echo "=== 3c. recognition fixture (round-3: prepared record REQUIRED for the stamp) ==="
npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/deploy-gate-recognition.ts || exit 1
FEE_STREAM_ESCROW_ADDRESS="$(python3 -c "import json;print(json.load(open('tests/e2e/state-gate.json'))['feeStreamEscrow'])")"
BANKR_RECORD_ADDRESS="$(python3 -c "import json;print(json.load(open('tests/e2e/state-gate.json'))['bankrRecord'])")"
export FEE_STREAM_ESCROW_ADDRESS
export BANKR_FACTORY_ADDRESS="$BANKR_RECORD_ADDRESS"
export BANKR_FEE_LEDGER_ADDRESS="$BANKR_RECORD_ADDRESS"
VAULT_LAUNCH="$(python3 -c "import json;print(json.load(open('tests/e2e/state-gate.json'))['vaultLaunch'])")"
echo "feeStreamEscrow=$FEE_STREAM_ESCROW_ADDRESS vaultLaunch=$VAULT_LAUNCH"


echo "=== 4. fixture GitHub API ==="
node tests/e2e/github-fixture.js &
PIDS+=($!)
sleep 1

echo "=== 5. vesting server (GITHUB_API_BASE_URL -> fixture) ==="
set_test_env
npx tsx src/index.ts &
PIDS+=($!)
wait_http "$API/health" 30 || exit 1
echo "server up"

echo "=== 6. seed: grant + @testauthor links (author, recipient) + PTK mint ==="
npx tsx tests/e2e/seed.ts || exit 1
npx tsx tests/e2e/seed-gate.ts || exit 1


echo "=== 7. verified launch: verify -> post-verification lock -> prepare-launch -> register with token ==="
OUT="$(verify testauthor "$LAUNCH_REPO" "$RECIPIENT")"; echo "$OUT"
check "verified launch: token issued" "$OUT" '"verified":true'
TOKEN="$(printf '%s' "$OUT" | python3 -c "import sys,json;print(json.load(sys.stdin)['verificationToken'])")"
LOCK_OUT="$(LOCK_REPO="$LAUNCH_REPO" LOCK_AMOUNT=10 npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/lock-for-repo.ts)" || exit 1
echo "$LOCK_OUT"
V_LOCK_TX="$(printf '%s' "$LOCK_OUT" | grep -o 'LOCK_TX=0x[0-9a-f]*' | cut -d= -f2)"
OUT="$(curl -s -X POST "$API/api/launch/prepare-launch" -H 'content-type: application/json' \
  -H "x-wallet-address: $RECIPIENT" \
  -d "{\"repo\":\"$LAUNCH_REPO\",\"verificationToken\":\"$TOKEN\",\"feeLockVault\":\"$VAULT_LAUNCH\",\"launch\":{\"name\":\"Launch Token\",\"symbol\":\"LTK\"}}")"; echo "$OUT"
check "verified launch: prepare-launch ok" "$OUT" '"prepared":true'
REG_V="{\"repoFullName\":\"$LAUNCH_REPO\",\"platform\":\"github\",\"recipient\":\"$RECIPIENT\",\"token\":\"$PTK\",\"chain\":\"base\",\"totalLocked\":\"10000000000000000000\",\"totalPushesRequired\":2,\"pushesPerMilestone\":1,\"tokensPerMilestone\":\"5000000000000000000\",\"onChainTxHash\":\"$V_LOCK_TX\",\"installationId\":777,\"streaming\":false,\"launchVerificationToken\":\"$TOKEN\"}"
OUT="$(curl -s -X POST "$API/api/vesting/register" -H 'content-type: application/json' -d "$REG_V")"; echo "$OUT"
check "verified launch registered stamped" "$OUT" '"launchVerified":true'

echo "=== 8. unverified grant: register otherrepo with NO token (ordinary vesting path) ==="
REG_U="{\"repoFullName\":\"$OTHER_REPO\",\"platform\":\"github\",\"recipient\":\"$RECIPIENT\",\"token\":\"$PTK\",\"chain\":\"base\",\"totalLocked\":\"10000000000000000000\",\"totalPushesRequired\":2,\"pushesPerMilestone\":1,\"tokensPerMilestone\":\"5000000000000000000\",\"onChainTxHash\":\"$MINT_TX\",\"installationId\":777,\"streaming\":false}"
OUT="$(curl -s -X POST "$API/api/vesting/register" -H 'content-type: application/json' -d "$REG_U")"; echo "$OUT"
check "unverified grant registers (ordinary lock is real)" "$OUT" '"ok":true'
check_absent "unverified grant NOT stamped" "$OUT" '"launchVerified":true'

echo "=== 9. (a) verified-launch listing: verified IN, unverified OUT ==="
PROJ="$(curl -s "$API/api/launch/projects")"; echo "$PROJ"
check "launched-projects includes the verified launch" "$PROJ" "\"repoFullName\":\"$LAUNCH_REPO\""
check_absent "launched-projects EXCLUDES the unverified grant" "$PROJ" "$OTHER_REPO"

echo "=== 10. (a2) general listing flags: verified true, unverified false ==="
EXPL="$(curl -s "$API/api/vesting/explore")"
FLAGS="$(printf '%s' "$EXPL" | python3 -c "
import sys, json
for g in json.load(sys.stdin)['grants']:
    print(g['repoFullName'], 'launchVerified=' + str(g.get('launchVerified')))
")"; echo "$FLAGS"
check "explore flags verified launch true" "$FLAGS" "$LAUNCH_REPO launchVerified=True"
check "explore flags unverified grant false" "$FLAGS" "$OTHER_REPO launchVerified=False"

echo "=== 11. (b) enrolment: verified enrolled, unverified NOT ==="
ENR="$(curl -s "$API/api/launch/enrollment?repo=$LAUNCH_REPO&wallet=$RECIPIENT")"; echo "$ENR"
check "verified launcher enrolled" "$ENR" '"enrolled":true'
ENR="$(curl -s "$API/api/launch/enrollment?repo=$OTHER_REPO&wallet=$RECIPIENT")"; echo "$ENR"
check "unverified grant NOT enrolled" "$ENR" '"enrolled":false'

echo "=== 12. counted push on the UNVERIFIED grant: ordinary counting, still no recognition ==="
WH="$(REPO="$OTHER_REPO" timeout 180 node tests/e2e/send-webhook.mjs plain)"; echo "$WH"
STATUS="$(curl -s "$API/api/vesting/status?repo=$OTHER_REPO")"; echo "$STATUS"
check "unverified grant push counted as ordinary vesting" "$STATUS" '"verifiedPushCount":1'
PROJ="$(curl -s "$API/api/launch/projects")"
check_absent "after counted push: STILL excluded from launched projects" "$PROJ" "$OTHER_REPO"
ENR="$(curl -s "$API/api/launch/enrollment?repo=$OTHER_REPO&wallet=$RECIPIENT")"; echo "$ENR"
check "after counted push: STILL no launcher enrolment" "$ENR" '"enrolled":false'

echo "=== LAUNCH-EXCLUSIONS DRIVER DONE — failures: $FAILURES ==="
[ "$FAILURES" -eq 0 ] || exit 1
