#!/usr/bin/env bash
# TEST-ONLY driver for the verifier DOUBLE-COUNT RACE fix (Codex
# review, 2026-11-25): the duplicate-SHA check (SISMEMBER) and the
# record step used to be separate Redis operations, so two concurrent
# deliveries of the same webhook could both pass the check and
# double-count vesting progress. recordVerifiedPush now claims the
# SHA atomically (Lua; fake-redis implements the same script).
# This driver fires the SAME prhuman webhook twice IN PARALLEL and
# proves: exactly one delivery counts (push count 1), exactly one
# milestone release (recipient +500 PTK, not 1000), exactly one
# author reward (+10 RWD, not 20).
# Same local stack as run-pr-credit.sh. No external calls.
set -u
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
LOG="$ROOT/tests/e2e/concurrency-output.log"
: > "$LOG"
exec > >(tee -a "$LOG") 2>&1

PIDS=()
kill_port() { # port
  local pids
  pids="$(ss -ltnp 2>/dev/null | grep ":$1 " | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u)"
  for p in $pids; do kill "$p" 2>/dev/null || true; done
}
cleanup() {
  for pid in "${PIDS[@]:-}"; do [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null || true; done
  # npx/tsx wrappers can orphan node children — kill by port too (lesson
  # recorded in the first E2E report, §4 harness issue 2).
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
  # The one production hook under test: point the GitHub App client at the
  # fixture API instead of https://api.github.com.
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
curl -s http://127.0.0.1:8977/repos/testowner/testrepo/pulls/42 | head -c 300; echo

echo "=== 5. vesting server (GITHUB_API_BASE_URL -> fixture) ==="
set_test_env
npx tsx src/index.ts &
PIDS+=($!)
wait_http "http://127.0.0.1:3210/health" 30 || exit 1
echo "server up"

echo "=== 6. seed grant + linked wallet (@testauthor) ==="
npx tsx tests/e2e/seed.ts || exit 1

FAILURES=0
check() { # name, haystack, needle
  if printf '%s' "$2" | grep -qF "$3"; then
    echo "PASS: $1"
  else
    echo "FAIL: $1 (missing: $3)"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "=== 7. balances before ==="
BEFORE="$(npx tsx tests/e2e/balances.ts before)"; echo "$BEFORE"
check "before: author RWD 0" "$BEFORE" "author RWD=0"
check "before: recipient PTK 0" "$BEFORE" "recipient PTK=0"

echo "=== 8. fire the SAME prhuman webhook twice IN PARALLEL ==="
timeout 180 node tests/e2e/send-webhook.mjs prhuman > /tmp/conc-a.log 2>&1 &
PID_A=$!
timeout 180 node tests/e2e/send-webhook.mjs prhuman > /tmp/conc-b.log 2>&1 &
PID_B=$!
wait $PID_A; wait $PID_B
echo "--- delivery A ---"; cat /tmp/conc-a.log
echo "--- delivery B ---"; cat /tmp/conc-b.log

echo "=== 9. balances after: exactly ONE count settled ==="
AFTER="$(npx tsx tests/e2e/balances.ts after-parallel)"; echo "$AFTER"
check "author paid exactly one reward (+10 RWD)" "$AFTER" "author RWD=10"
check "recipient got exactly one milestone (+500 PTK)" "$AFTER" "recipient PTK=500"
check "escrow kept the other half (500 PTK)" "$AFTER" "escrow PTK=500"

echo "=== 10. push counter incremented by exactly 1 ==="
STATUS="$(curl -s "http://127.0.0.1:3210/api/vesting/status?repo=testowner/testrepo")"; echo "$STATUS"
check "verifiedPushCount is 1" "$STATUS" '"verifiedPushCount":1'

echo "=== 11. different SHAs, cooldown race (round-2): two small pushes in parallel on a fresh repo -> exactly one counts ==="
REPO=testowner/nogrant timeout 180 node tests/e2e/send-webhook.mjs small > /tmp/conc-c.log 2>&1 &
PID_C=$!
REPO=testowner/nogrant timeout 180 node tests/e2e/send-webhook.mjs small2 > /tmp/conc-d.log 2>&1 &
PID_D=$!
wait $PID_C; wait $PID_D
cat /tmp/conc-c.log /tmp/conc-d.log
OUT="$(npx tsx tests/e2e/push-state.ts testowner/nogrant)"; echo "$OUT"
check "cooldown race: exactly one of the two different SHAs counted" "$OUT" '"pushCount":1'
python3 - <<'EOF'
import json, subprocess
out = subprocess.run(["npx","tsx","tests/e2e/push-state.ts","testowner/nogrant"], capture_output=True, text=True).stdout
state = json.loads(out.strip().splitlines()[-1])
rejected = [e for e in state["log"] if not e["accepted"]]
ok = len(rejected) == 1 and ("(atomic claim)" in rejected[0]["reason"] or "min since last counted push" in rejected[0]["reason"])
print(("PASS" if ok else "FAIL") + ": cooldown race loser rejected by the cooldown (atomic claim or pre-check)")
raise SystemExit(0 if ok else 1)
EOF
[ $? -eq 0 ] || FAILURES=$((FAILURES + 1))

echo "=== 12. different SHAs, daily-cap race (round-2): one slot left, two big pushes in parallel -> exactly one counts ==="
node tests/e2e/send-webhook.mjs plain
OUT="$(npx tsx tests/e2e/push-state.ts testowner/testrepo)"; echo "$OUT"
check "setup: plain counted (2 total, 2 of 3 daily slots used)" "$OUT" '"pushCount":2'
timeout 180 node tests/e2e/send-webhook.mjs plain2 > /tmp/conc-e.log 2>&1 &
PID_E=$!
timeout 180 node tests/e2e/send-webhook.mjs plain3 > /tmp/conc-f.log 2>&1 &
PID_F=$!
wait $PID_E; wait $PID_F
cat /tmp/conc-e.log /tmp/conc-f.log
OUT="$(npx tsx tests/e2e/push-state.ts testowner/testrepo)"; echo "$OUT"
check "cap race: exactly one racer counted (3 total = the daily cap)" "$OUT" '"pushCount":3'
python3 - <<'EOF'
import json, subprocess
out = subprocess.run(["npx","tsx","tests/e2e/push-state.ts","testowner/testrepo"], capture_output=True, text=True).stdout
state = json.loads(out.strip().splitlines()[-1])
rejected = [e for e in state["log"] if not e["accepted"] and e["sha"] in ("a11ce00","b22ce00","c33ce00")]
ok = len(rejected) == 1 and ("(atomic claim)" in rejected[0]["reason"] or "Daily cap" in rejected[0]["reason"])
print(("PASS" if ok else "FAIL") + ": cap race loser rejected by the daily cap (atomic claim or pre-check)")
raise SystemExit(0 if ok else 1)
EOF
[ $? -eq 0 ] || FAILURES=$((FAILURES + 1))

echo "=== CONCURRENCY DRIVER DONE — failures: $FAILURES ==="
[ "$FAILURES" -eq 0 ] || exit 1
