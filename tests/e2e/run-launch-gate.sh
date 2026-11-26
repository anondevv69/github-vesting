#!/usr/bin/env bash
# TEST-ONLY driver for the LAUNCH GATE (GitHub App verification before
# any launch/deploy — Gregory, 2026-11-25) and verified-launcher
# ShipRewards enrolment (dual reward §8B).
# Same local stack as run-rewards.sh (fake redis + Hardhat node chainId
# 8453 + fixture GitHub API + vesting server). Proves:
#   verify endpoint:
#     - app NOT installed on repo      -> refused, no token issued
#     - login not owner/admin          -> refused
#     - wallet not linked to login     -> refused
#     - happy (installed+owner+linked) -> signed token issued
#   launch prep gate (POST /api/agent/prepare-lock):
#     - no token                       -> 403 LAUNCH_VERIFICATION_REQUIRED
#     - token for repo A used on B     -> 403 LAUNCH_TOKEN_REPO_MISMATCH
#     - token wallet X presented as Y  -> 403 LAUNCH_TOKEN_WALLET_MISMATCH
#     - expired token                  -> 403 LAUNCH_TOKEN_EXPIRED
#     - happy token                    -> prepare succeeds (txs returned)
#   confirm-lock gate: no token        -> 403
#   grant registration (POST /api/vesting/register):
#     - garbage verification token     -> 403, no grant
#     - valid token                    -> grant stamped launchVerified +
#                                        launcherRewardEnrolled, enrolment
#                                        record readable via
#                                        GET /api/launch/enrollment
#     - NO token (legacy path)         -> grant registers, but NO
#                                        enrolment (unverified launch
#                                        gets no launcher rewards)
# No external calls, no real keys (Hardhat test accounts + throwaway RSA).
# ROBINHOOD_RPC_URL is pointed at the local node so register's chain
# detection probe fails fast instead of calling the real RH RPC.
set -u
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
LOG="$ROOT/tests/e2e/launch-gate-output.log"
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
  # Treasury for the prepare-launch tests (round-2 Gregory exception):
  # the deployer stands in as the designated reward treasury.
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

echo "=== 7. verify: app NOT installed -> refused, no token ==="
OUT="$(verify testauthor testauthor/notinstalled "$RECIPIENT")"; echo "$OUT"
check "not-installed refused" "$OUT" '"code":"LAUNCH_APP_NOT_INSTALLED"'
check_absent "not-installed issued no token" "$OUT" '"verificationToken"'

echo "=== 8. verify: login not owner/admin -> refused ==="
OUT="$(verify testauthor otherowner/theirrepo "$RECIPIENT")"; echo "$OUT"
check "not-owner refused" "$OUT" '"code":"LAUNCH_NOT_OWNER_OR_ADMIN"'
check_absent "not-owner issued no token" "$OUT" '"verificationToken"'

echo "=== 9. verify: wallet not linked to login -> refused ==="
OUT="$(verify testauthor "$LAUNCH_REPO" "$DEPLOYER")"; echo "$OUT"
check "unlinked wallet refused" "$OUT" '"code":"LAUNCH_WALLET_NOT_LINKED"'
check_absent "unlinked issued no token" "$OUT" '"verificationToken"'

echo "=== 10. verify: happy path -> token issued ==="
OUT="$(verify testauthor "$LAUNCH_REPO" "$RECIPIENT")"; echo "$OUT"
check "happy verify ok" "$OUT" '"verified":true'
check "happy verify has token" "$OUT" '"verificationToken":"'
TOKEN="$(printf '%s' "$OUT" | python3 -c "import sys,json;print(json.load(sys.stdin)['verificationToken'])")"
echo "token captured (${#TOKEN} chars)"

echo "=== 10b. POST-verification lock for launchrepo (ordering happy fixture) ==="
# Locked AFTER the token was issued, so its block timestamp is >= the
# token's iat and registration in step 18 may legitimately be stamped.
LOCK_OUT="$(LOCK_REPO="$LAUNCH_REPO" LOCK_AMOUNT=10 npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/lock-for-repo.ts)" || exit 1
echo "$LOCK_OUT"
LOCK2_TX="$(printf '%s' "$LOCK_OUT" | grep -o 'LOCK_TX=0x[0-9a-f]*' | cut -d= -f2)"
echo "post-verification lock tx: $LOCK2_TX"

echo "=== 11. prepare-lock: NO token -> refused ==="
OUT="$(prepare "$RECIPIENT" "$LAUNCH_REPO" "")"; echo "$OUT"
check "no-token prepare refused" "$OUT" '"code":"LAUNCH_VERIFICATION_REQUIRED"'
check_absent "no-token prepare returned no txs" "$OUT" '"transactions"'

echo "=== 12. prepare-lock: token for repo A used on repo B -> refused ==="
OUT="$(prepare "$RECIPIENT" "$OTHER_REPO" "$TOKEN")"; echo "$OUT"
check "repo mismatch refused" "$OUT" '"code":"LAUNCH_TOKEN_REPO_MISMATCH"'

echo "=== 13. prepare-lock: token wallet X presented as wallet Y -> refused ==="
OUT="$(prepare "$AUTHOR" "$LAUNCH_REPO" "$TOKEN")"; echo "$OUT"
check "wallet mismatch refused" "$OUT" '"code":"LAUNCH_TOKEN_WALLET_MISMATCH"'

echo "=== 14. prepare-lock: expired token -> refused ==="
EXPIRED_TOKEN="$(node -e "
const c = require('crypto');
const now = Math.floor(Date.now()/1000);
const claims = { v:1, githubLogin:'testauthor', repo:'$LAUNCH_REPO'.toLowerCase(), wallet:'$RECIPIENT'.toLowerCase(), chainId:8453, installationId:777, iat:now-3600, exp:now-60, nonce:'expirednonce0001' };
const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
const s = c.createHmac('sha256','test-session-secret').update(p).digest('base64url');
console.log(p + '.' + s);
")"
OUT="$(prepare "$RECIPIENT" "$LAUNCH_REPO" "$EXPIRED_TOKEN")"; echo "$OUT"
check "expired token refused" "$OUT" '"code":"LAUNCH_TOKEN_EXPIRED"'

echo "=== 15. prepare-lock: happy token -> prepare succeeds ==="
OUT="$(prepare "$RECIPIENT" "$LAUNCH_REPO" "$TOKEN")"; echo "$OUT"
check "happy prepare ok" "$OUT" '"ok":true'
check "happy prepare has transactions" "$OUT" '"transactions"'

echo "=== 16. confirm-lock: NO token -> refused ==="
OUT="$(curl -s -X POST "$API/api/agent/confirm-lock" -H 'content-type: application/json' \
  -H "x-wallet-address: $RECIPIENT" \
  -d "{\"repo\":\"$LAUNCH_REPO\",\"lockTxHash\":\"$LOCK_TX\",\"chain\":\"base\"}")"; echo "$OUT"
check "no-token confirm refused" "$OUT" '"code":"LAUNCH_VERIFICATION_REQUIRED"'

echo "=== 17. register: garbage verification token -> refused, no grant ==="
REG_BODY="{\"repoFullName\":\"$LAUNCH_REPO\",\"platform\":\"github\",\"recipient\":\"$RECIPIENT\",\"token\":\"$PTK\",\"chain\":\"base\",\"totalLocked\":\"10000000000000000000\",\"totalPushesRequired\":2,\"pushesPerMilestone\":1,\"tokensPerMilestone\":\"5000000000000000000\",\"onChainTxHash\":\"$LOCK2_TX\",\"installationId\":777,\"streaming\":false"
OUT="$(curl -s -X POST "$API/api/vesting/register" -H 'content-type: application/json' \
  -d "$REG_BODY,\"launchVerificationToken\":\"garbage\"}")"; echo "$OUT"
check "garbage token register refused" "$OUT" '"code":"LAUNCH_TOKEN_MALFORMED"'

echo "=== 18. register: valid token -> grant stamped + launcher enrolled ==="
OUT="$(curl -s -X POST "$API/api/vesting/register" -H 'content-type: application/json' \
  -d "$REG_BODY,\"launchVerificationToken\":\"$TOKEN\"}")"; echo "$OUT"
check "verified register ok" "$OUT" '"ok":true'
check "grant stamped launchVerified" "$OUT" '"launchVerified":true'
check "grant stamped launcherRewardEnrolled" "$OUT" '"launcherRewardEnrolled":true'
ENR="$(curl -s "$API/api/launch/enrollment?repo=$LAUNCH_REPO&wallet=$RECIPIENT")"; echo "$ENR"
check "enrolment record present" "$ENR" '"enrolled":true'
check "enrolment ties the login" "$ENR" '"githubLogin":"testauthor"'
check "enrolment ties the token id (nonce)" "$ENR" '"verificationNonce":"'

echo "=== 19. register: NO token (unverified launch) -> registers, NO enrolment ==="
REG_BODY_OTHER="$(printf '%s' "$REG_BODY" | sed "s|$LAUNCH_REPO|$OTHER_REPO|" | sed "s|$LOCK2_TX|$MINT_TX|")}"
OUT="$(curl -s -X POST "$API/api/vesting/register" -H 'content-type: application/json' \
  -d "$REG_BODY_OTHER")"; echo "$OUT"
check "unverified register ok (legacy path)" "$OUT" '"ok":true'
check_absent "unverified grant NOT stamped enrolled" "$OUT" '"launcherRewardEnrolled":true'
ENR="$(curl -s "$API/api/launch/enrollment?repo=$OTHER_REPO&wallet=$RECIPIENT")"; echo "$ENR"
check "unverified launch has no enrolment" "$ENR" '"enrolled":false'

echo "=== 20. prepare-lock: token for Base presented for Robinhood Chain -> refused (wrong chain) ==="
OUT="$(curl -s -X POST "$API/api/agent/prepare-lock" -H 'content-type: application/json' \
  -H "x-wallet-address: $RECIPIENT" \
  -d "{\"repo\":\"$LAUNCH_REPO\",\"token\":\"$PTK\",\"amount\":\"10\",\"chain\":\"robinhood\",\"verificationToken\":\"$TOKEN\"}")"; echo "$OUT"
check "wrong-chain token refused" "$OUT" '"code":"LAUNCH_TOKEN_CHAIN_MISMATCH"'

echo "=== 21. prepare-lock: correctly-signed token with NO issuance record -> refused ==="
GHOST_TOKEN="$(node -e "
const c = require('crypto');
const now = Math.floor(Date.now()/1000);
const claims = { v:1, githubLogin:'testauthor', repo:'$LAUNCH_REPO'.toLowerCase(), wallet:'$RECIPIENT'.toLowerCase(), chainId:8453, installationId:777, iat:now, exp:now+900, nonce:'neverissuednonce1' };
const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
const s = c.createHmac('sha256','test-session-secret').update(p).digest('base64url');
console.log(p + '.' + s);
")"
OUT="$(prepare "$RECIPIENT" "$LAUNCH_REPO" "$GHOST_TOKEN")"; echo "$OUT"
check "no-issuance-record token refused" "$OUT" '"code":"LAUNCH_TOKEN_UNKNOWN_NONCE"'

echo "=== 22. token reuse within TTL is INTENTIONAL: same token prepares again -> succeeds ==="
OUT="$(prepare "$RECIPIENT" "$LAUNCH_REPO" "$TOKEN")"; echo "$OUT"
check "token reuse across calls within TTL ok" "$OUT" '"ok":true'

echo "=== 23. ordering: lock tx PREDATES the verification token -> registers UNSTAMPED, no enrolment ==="
sleep 3 # widen the wall-clock gap over the step-3b lock (see the note there)
OUT="$(verify testauthor testauthor/orderrepo "$RECIPIENT")"; echo "$OUT"
check "orderrepo verify ok" "$OUT" '"verified":true'
ORDER_TOKEN="$(printf '%s' "$OUT" | python3 -c "import sys,json;print(json.load(sys.stdin)['verificationToken'])")"
REG_ORDER="{\"repoFullName\":\"testauthor/orderrepo\",\"platform\":\"github\",\"recipient\":\"$RECIPIENT\",\"token\":\"$PTK\",\"chain\":\"base\",\"totalLocked\":\"10000000000000000000\",\"totalPushesRequired\":2,\"pushesPerMilestone\":1,\"tokensPerMilestone\":\"5000000000000000000\",\"onChainTxHash\":\"$PRE_LOCK_TX\",\"installationId\":777,\"streaming\":false,\"launchVerificationToken\":\"$ORDER_TOKEN\"}"
OUT="$(curl -s -X POST "$API/api/vesting/register" -H 'content-type: application/json' -d "$REG_ORDER")"; echo "$OUT"
check "predated-lock register ok (ordinary grant)" "$OUT" '"ok":true'
check "predated-lock register reports unstamped" "$OUT" '"stamped":false'
check_absent "predated-lock grant NOT launchVerified" "$OUT" '"launchVerified":true'
check_absent "predated-lock grant NOT enrolled" "$OUT" '"launcherRewardEnrolled":true'
ENR="$(curl -s "$API/api/launch/enrollment?repo=testauthor/orderrepo&wallet=$RECIPIENT")"; echo "$ENR"
check "predated-lock launch has no enrolment" "$ENR" '"enrolled":false'

echo "=== 24. ordering FAIL-CLOSED: valid token + registration tx with NO Locked event -> UNSTAMPED ==="
OUT="$(verify testauthor testauthor/nolockrepo "$RECIPIENT")"; echo "$OUT"
check "nolockrepo verify ok" "$OUT" '"verified":true'
NOLOCK_TOKEN="$(printf '%s' "$OUT" | python3 -c "import sys,json;print(json.load(sys.stdin)['verificationToken'])")"
REG_NOLOCK="{\"repoFullName\":\"testauthor/nolockrepo\",\"platform\":\"github\",\"recipient\":\"$RECIPIENT\",\"token\":\"$PTK\",\"chain\":\"base\",\"totalLocked\":\"10000000000000000000\",\"totalPushesRequired\":2,\"pushesPerMilestone\":1,\"tokensPerMilestone\":\"5000000000000000000\",\"onChainTxHash\":\"$MINT_TX\",\"installationId\":777,\"streaming\":false,\"launchVerificationToken\":\"$NOLOCK_TOKEN\"}"
OUT="$(curl -s -X POST "$API/api/vesting/register" -H 'content-type: application/json' -d "$REG_NOLOCK")"; echo "$OUT"
check "unprovable-ordering register ok (ordinary grant)" "$OUT" '"ok":true'
check "unprovable-ordering reports unstamped" "$OUT" '"stamped":false'
check "unprovable-ordering carries the fail-closed code" "$OUT" '"code":"LAUNCH_ORDERING_UNPROVABLE"'
check_absent "unprovable-ordering grant NOT launchVerified" "$OUT" '"launchVerified":true'
check_absent "unprovable-ordering grant NOT enrolled" "$OUT" '"launcherRewardEnrolled":true'
ENR="$(curl -s "$API/api/launch/enrollment?repo=testauthor/nolockrepo&wallet=$RECIPIENT")"; echo "$ENR"
check "unprovable-ordering launch has no enrolment" "$ENR" '"enrolled":false'

echo "=== 25. Gregory exception (round-2): the platform's OWN launch may omit the vault ==="
GREGORY_WALLET="0x374d91a5674fa7cf86e725093b5848b97e1e13b4"
OUT="$(verify gregory gregory/platformrepo "$GREGORY_WALLET")"; echo "$OUT"
check "gregory verify ok" "$OUT" '"verified":true'
GTOKEN="$(printf '%s' "$OUT" | python3 -c "import sys,json;print(json.load(sys.stdin)['verificationToken'])")"
OUT="$(curl -s -X POST "$API/api/launch/prepare-launch" -H 'content-type: application/json' \
  -H "x-wallet-address: $GREGORY_WALLET" \
  -d "{\"repo\":\"gregory/platformrepo\",\"verificationToken\":\"$GTOKEN\",\"launch\":{\"name\":\"Platform Token\",\"symbol\":\"PLAT\"}}")"; echo "$OUT"
check "gregory prepare-launch without vault succeeds (platform launch)" "$OUT" '"prepared":true'
check "gregory exception is flagged as a platform launch" "$OUT" '"platformLaunch":true'
check "gregory raw wallet appears ONLY in the 7500 platform position" "$OUT" "\"recipient\":\"$GREGORY_WALLET\",\"shareBps\":7500"
check "treasury still gets its 2500 on the platform launch" "$OUT" "\"recipient\":\"$(printf '%s' "$DEPLOYER" | tr 'A-F' 'a-f')\",\"shareBps\":2500"

echo "=== 26. exception scope: a NON-Gregory launcher omitting the vault is still refused ==="
OUT="$(verify testauthor "$LAUNCH_REPO" "$RECIPIENT")"; echo "$OUT"
FRESH_TOKEN="$(printf '%s' "$OUT" | python3 -c "import sys,json;print(json.load(sys.stdin)['verificationToken'])")"
OUT="$(curl -s -X POST "$API/api/launch/prepare-launch" -H 'content-type: application/json' \
  -H "x-wallet-address: $RECIPIENT" \
  -d "{\"repo\":\"$LAUNCH_REPO\",\"verificationToken\":\"$FRESH_TOKEN\",\"launch\":{\"name\":\"Sneaky\",\"symbol\":\"SNK\"}}")"; echo "$OUT"
check "non-gregory no-vault prepare refused" "$OUT" '"code":"LAUNCH_FEE_VAULT_REQUIRED"'

echo "=== LAUNCH-GATE DRIVER DONE — failures: $FAILURES ==="
[ "$FAILURES" -eq 0 ] || exit 1
