#!/usr/bin/env bash
# TEST-ONLY driver for the MANDATORY reviewer swarm with a 6h review
# window and verifier fallback (Gregory's adopted rule, 2026-11-26:
# "Adopt it, 6 hour review window"). Same local stack as run-swarm.sh
# (fake redis + Hardhat node chainId 8453 + fixture GitHub API +
# vesting server), with two test knobs:
#   SWARM_REVIEW_WINDOW_SECONDS=20  (production default: 6h)
#   SWARM_SETTLE_INTERVAL_MS=500   (production default: 60s)
# The grant is seeded with NO swarm configuration at all (the legacy
# shape of production grants like anondevv69/pod-live-test) — the
# gate must apply anyway. Reviewer reward left UNSET in env (default
# 10% of the 10 RWD per-merge reward = 1 RWD per PASS reviewer).
# Proves:
#   - a verifier-REJECTED push (docs-only) opens NO window
#   - enrolment refuses a wallet not linked to the login
#   - the review queue works for a grant with no swarm config
#   - the AUTHOR reviewing their own push -> SWARM_REVIEW_NOT_INDEPENDENT
#   - push #47, zero reviews: pending in its window, then counts at
#     EXPIRY via the verifier fallback (countPath stamped), author
#     rewarded, milestone released, NO reviewer paid
#   - push #49: 2 independent PASS inside the window -> counts EARLY
#     via the swarm path (countPath "swarm"), both reviewers paid
#   - push #50: 1 PASS + 1 FAIL -> FAIL vetoes, push never counts
#   - push #51: 1 PASS only -> counts at expiry via fallback, and the
#     lone PASS reviewer is NOT paid (fallback pays no reviewers)
#   - a LATE FAIL on the already-counted #51 changes nothing, and a
#     webhook redelivery is a duplicate-SHA rejection
# No external calls, no real keys (Hardhat test accounts + throwaway RSA).
set -u
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
LOG="$ROOT/tests/e2e/swarm-window-output.log"
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
  # The window rule, compressed for tests (production: 6h / 60s).
  export SWARM_REVIEW_WINDOW_SECONDS=20
  export SWARM_SETTLE_INTERVAL_MS=500
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
# Poll the status endpoint until the needle appears (settlement is async).
wait_status() { # needle, tries
  local needle="$1" tries="${2:-40}"
  for i in $(seq 1 "$tries"); do
    OUT="$(curl -s "$API/api/vesting/status?repo=$REPO")"
    if printf '%s' "$OUT" | grep -qF "$needle"; then return 0; fi
    sleep 1
  done
  echo "TIMEOUT waiting for status needle: $needle"
  return 1
}
# Print the recorded swarm countPath for one push (by sha prefix), or "none".
push_path() { # sha-prefix
  python3 - "$1" <<'EOF'
import json, sys, urllib.request
data = json.load(urllib.request.urlopen("http://127.0.0.1:3210/api/vesting/status?repo=testowner/testrepo"))
for e in data.get("recentPushes", []):
    if isinstance(e, dict) and str(e.get("sha", "")).startswith(sys.argv[1]):
        print((e.get("swarm") or {}).get("countPath") or "none")
        sys.exit(0)
print("missing")
EOF
}
wait_push_path() { # sha-prefix, expected-path, tries
  local prefix="$1" want="$2" tries="${3:-40}"
  for i in $(seq 1 "$tries"); do
    if [ "$(push_path "$prefix")" = "$want" ]; then return 0; fi
    sleep 1
  done
  echo "TIMEOUT waiting for push $prefix countPath=$want (got: $(push_path "$prefix"))"
  return 1
}

API="http://127.0.0.1:3210"
REPO="testowner/testrepo"
SHA47="$(python3 -c 'print("47"*20)')"
SHA49="$(python3 -c 'print("49"*20)')"
SHA50="$(python3 -c 'print("50"*20)')"
SHA51="$(python3 -c 'print("51"*20)')"
DOCS_SHA="d0c5000000000000000000000000000000000000"

report_post() { # sha pr author repo
  curl -s -X POST "$API/api/agent/report-ship" -H 'content-type: application/json' \
    -d "{\"repo\":\"$4\",\"headSha\":\"$1\",\"prNumber\":$2,\"authorLogin\":\"$3\"}"
}
status() { curl -s "$API/api/vesting/status?repo=$REPO"; }

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
npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/deploy-swarm-window.ts || exit 1
GIT_ESCROW_ADDRESS="$(python3 -c "import json;print(json.load(open('tests/e2e/state.json'))['gitEscrow'])")"
SHIP_REWARDS_ADDRESS="$(python3 -c "import json;print(json.load(open('tests/e2e/state.json'))['shipRewards'])")"
export GIT_ESCROW_ADDRESS SHIP_REWARDS_ADDRESS
export SHIP_REWARD_PER_MERGE="10000000000000000000" # 10 RWD
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

echo "=== 5. vesting server (20s window, 500ms settler) ==="
set_test_env
npx tsx src/index.ts &
PIDS+=($!)
wait_http "$API/health" 30 || exit 1
echo "server up"
HEALTH="$(curl -s "$API/health")"; echo "$HEALTH"
check "health reports the mandatory swarm" "$HEALTH" '"mandatory":true'

echo "=== 6. seed LEGACY grant (no swarm config) + linked wallets ==="
npx tsx tests/e2e/seed-swarm-window.ts || exit 1

echo "=== 7. enrolment: unlinked wallet refused; revone/revtwo/author enrol ==="
OUT="$(npx tsx tests/e2e/swarm-review.ts enrol revone "$DEPLOYER")"; echo "$OUT"
check "enrol unlinked wallet refused" "$OUT" '"code":"SWARM_WALLET_NOT_LINKED"'
OUT="$(npx tsx tests/e2e/swarm-review.ts enrol revone "$REVONE_WALLET")"; echo "$OUT"
check "revone enrolled" "$OUT" '"enrolled":true'
OUT="$(npx tsx tests/e2e/swarm-review.ts enrol revtwo "$REVTWO_WALLET")"; echo "$OUT"
check "revtwo enrolled" "$OUT" '"enrolled":true'
OUT="$(npx tsx tests/e2e/swarm-review.ts enrol testauthor "$AUTHOR")"; echo "$OUT"
check "author enrolled" "$OUT" '"enrolled":true'

echo "=== 8. rules-fail push (docs only) -> verifier rejection, NO window opens ==="
WH="$(timeout 180 node tests/e2e/send-webhook.mjs docs)"; echo "$WH"
check "docs push rejected by the verifier" "$WH" '"accepted":false'
check "docs rejection is the verifier reason" "$WH" 'Only docs/lockfiles changed'
OUT="$(npx tsx tests/e2e/swarm-review.ts reviews "$REPO" "$DOCS_SHA")"; echo "$OUT"
check "no candidate/window for a rules-fail push" "$OUT" '"state":"none"'
BAL="$(npx tsx tests/e2e/balances-swarm.ts after-docs)"; echo "$BAL"
check "nothing released by the docs push" "$BAL" 'recipient PTK=0'

echo "=== 9. push #47, zero reviews -> pending; queue works on a legacy grant ==="
OUT="$(report_post "$SHA47" 47 testauthor "$REPO")"; echo "$OUT"
WH="$(timeout 180 node tests/e2e/send-webhook.mjs swarm47)"; echo "$WH"
check "push #47 not counted yet" "$WH" '"accepted":false'
check "push #47 is pending (window open)" "$WH" '"pending":true'
check "pending reason names the window" "$WH" 'review window open (0/2 PASS)'
BAL="$(npx tsx tests/e2e/balances-swarm.ts during-window47)"; echo "$BAL"
check "nothing released inside the window" "$BAL" 'recipient PTK=0'
check "author not rewarded inside the window" "$BAL" 'author RWD=0 |'
OUT="$(npx tsx tests/e2e/swarm-review.ts queue "$REPO" revone)"; echo "$OUT"
check "queue is live without any swarm config" "$OUT" '"swarmRequired":true'
check "queue lists push #47 with its window" "$OUT" "\"headSha\":\"$SHA47\""
check "queue entry carries the window expiry" "$OUT" '"windowExpiresAt"'
OUT="$(npx tsx tests/e2e/swarm-review.ts reviews "$REPO" "$SHA47")"; echo "$OUT"
check "push-reviews shows the open window" "$OUT" '"state":"open"'

echo "=== 10. window expires -> #47 counts via VERIFIER FALLBACK ==="
if wait_push_path 474747 verifier-fallback 60; then
  echo "PASS: #47 settled via fallback with the marker stamped"
else
  echo "FAIL: #47 never settled via fallback"; FAILURES=$((FAILURES + 1))
fi
BAL="$(npx tsx tests/e2e/balances-swarm.ts after-fallback47)"; echo "$BAL"
check "milestone released at fallback (100 PTK)" "$BAL" 'recipient PTK=100'
check "author rewarded at fallback (10 RWD)" "$BAL" 'author RWD=10 |'
check "no reviewer paid on a fallback count" "$BAL" 'revone RWD=0 |'
OUT="$(npx tsx tests/e2e/swarm-review.ts reviews "$REPO" "$SHA47")"; echo "$OUT"
check "push-reviews shows counted via fallback" "$OUT" '"countPath":"verifier-fallback"'

echo "=== 11. push #49: independence, then 2 PASS inside the window -> SWARM count ==="
WH="$(timeout 180 node tests/e2e/send-webhook.mjs swarm49)"; echo "$WH"
check "push #49 pending" "$WH" '"pending":true'
OUT="$(npx tsx tests/e2e/swarm-review.ts review testauthor "$SHA49" 49 pass)"; echo "$OUT"
check "author self-review refused (independence)" "$OUT" '"code":"SWARM_REVIEW_NOT_INDEPENDENT"'
OUT="$(npx tsx tests/e2e/swarm-review.ts review revone "$SHA49" 49 pass)"; echo "$OUT"
check "revone PASS recorded" "$OUT" '"effectiveVerdict":"pass"'
check "one PASS does not settle early" "$OUT" '"pending":true'
BAL="$(npx tsx tests/e2e/balances-swarm.ts after-onepass49)"; echo "$BAL"
check "still one milestone after a single PASS" "$BAL" 'recipient PTK=100'
OUT="$(npx tsx tests/e2e/swarm-review.ts review revtwo "$SHA49" 49 pass)"; echo "$OUT"
check "revtwo PASS recorded" "$OUT" '"effectiveVerdict":"pass"'
check "quorum met at submission" "$OUT" '"met":true'
check "settlement outcome reports the swarm count" "$OUT" '"countPath":"swarm"'
BAL="$(npx tsx tests/e2e/balances-swarm.ts after-swarm49)"; echo "$BAL"
check "second milestone released (200 PTK)" "$BAL" 'recipient PTK=200'
check "author rewarded again (20 RWD)" "$BAL" 'author RWD=20 |'
check "revone paid for the swarm count (1 RWD)" "$BAL" 'revone RWD=1 |'
check "revtwo paid for the swarm count (1 RWD)" "$BAL" 'revtwo RWD=1 |'
GOT="$(push_path 494949)"; echo "push 49 countPath=$GOT"
check "counted entry is stamped swarm" "$GOT" 'swarm'

echo "=== 12. push #50: PASS + FAIL -> the FAIL vetoes, push never counts ==="
WH="$(timeout 180 node tests/e2e/send-webhook.mjs swarm50)"; echo "$WH"
check "push #50 pending" "$WH" '"pending":true'
OUT="$(npx tsx tests/e2e/swarm-review.ts review revone "$SHA50" 50 pass)"; echo "$OUT"
check "revone PASS on #50 recorded" "$OUT" '"effectiveVerdict":"pass"'
OUT="$(npx tsx tests/e2e/swarm-review.ts review revtwo "$SHA50" 50 fail-dupe)"; echo "$OUT"
check "revtwo FAIL on #50 recorded" "$OUT" '"effectiveVerdict":"fail"'
check "settlement outcome reports not counted" "$OUT" '"counted":false'
sleep 2
ST="$(status)"; echo "$ST"
check "veto is logged with the swarm verdict" "$ST" 'a FAIL vetoes the push'
BAL="$(npx tsx tests/e2e/balances-swarm.ts after-veto50)"; echo "$BAL"
check "vetoed push released nothing" "$BAL" 'recipient PTK=200'
check "vetoed push paid no author reward" "$BAL" 'author RWD=20 |'
check "vetoed push paid no reviewer reward" "$BAL" 'revone RWD=1 |'
WH="$(timeout 180 node tests/e2e/send-webhook.mjs swarm50)"; echo "$WH"
check "redelivery of a vetoed push still does not count" "$WH" '"accepted":false'
check "redelivery reason is the FAIL veto" "$WH" 'a FAIL vetoes the push'

echo "=== 13. push #51: exactly 1 PASS -> fallback at expiry, reviewer NOT paid ==="
WH="$(timeout 180 node tests/e2e/send-webhook.mjs swarm51)"; echo "$WH"
check "push #51 pending" "$WH" '"pending":true'
OUT="$(npx tsx tests/e2e/swarm-review.ts review revone "$SHA51" 51 pass)"; echo "$OUT"
check "revone PASS on #51 recorded (1/2)" "$OUT" '"passCount":1'
if wait_push_path 515151 verifier-fallback 60; then
  echo "PASS: #51 settled via fallback with the marker stamped"
else
  echo "FAIL: #51 never settled via fallback"; FAILURES=$((FAILURES + 1))
fi
BAL="$(npx tsx tests/e2e/balances-swarm.ts after-fallback51)"; echo "$BAL"
check "author rewarded for the fallback count (30 RWD)" "$BAL" 'author RWD=30 |'
check "the lone PASS reviewer is NOT paid on fallback" "$BAL" 'revone RWD=1 |'
check "revtwo unchanged after fallback" "$BAL" 'revtwo RWD=1 |'

echo "=== 14. LATE FAIL on counted #51 -> recorded, reverses nothing ==="
OUT="$(npx tsx tests/e2e/swarm-review.ts review revtwo "$SHA51" 51 fail-dupe)"; echo "$OUT"
check "late FAIL is recorded as an attestation" "$OUT" '"effectiveVerdict":"fail"'
sleep 2
BAL="$(npx tsx tests/e2e/balances-swarm.ts after-latefail)"; echo "$BAL"
check "late FAIL does not claw back the author reward" "$BAL" 'author RWD=30 |'
check "late FAIL does not pay its reviewer" "$BAL" 'revtwo RWD=1 |'
ST="$(status)"; echo "$ST"
check "counted entry still stands after the late FAIL" "$ST" '"countPath":"verifier-fallback"'
GOT="$(push_path 515151)"; echo "push 51 countPath=$GOT"
check "push #51 keeps its fallback marker" "$GOT" 'verifier-fallback'
WH="$(timeout 180 node tests/e2e/send-webhook.mjs swarm51)"; echo "$WH"
check "redelivery of counted #51 is a duplicate" "$WH" '"accepted":false'
check "duplicate reason on redelivery" "$WH" 'already counted'

echo "=== SWARM WINDOW DRIVER DONE — failures: $FAILURES ==="
[ "$FAILURES" -eq 0 ] || exit 1
