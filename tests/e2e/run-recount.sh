#!/usr/bin/env bash
# TEST-ONLY driver for the EQUIVALENT RECOUNT (Codex finding 4 closure).
# Same local stack (fake redis + Hardhat node 8453 + fixture GitHub API
# + vesting server), GitEscrowV2 supply grant: 900 PTK, 3 pushes,
# milestone every push (300 PTK each).
#
# History driven through REAL webhooks:
#   plain   -> counted #1, milestone 1 pays 300 (oracle #1 alive)
#   small   -> rejected (cooldown: 5 lines, minutes after #1)
#   prbot   -> rejected (bot-authored PR #43)
#   plain   -> rejected (duplicate SHA)
#   docs    -> rejected (docs-only)
#   prhuman -> counted #2, milestone 2 pays 300 (oracle #1 alive)
#   [owner rotates oracle on-chain to backup acct #4 — "GitHub death":
#    the backend's oracle key #1 can no longer release]
#   plain2  -> counted #3 by the verifier, but the release FAILS
#              (dead oracle) — recipient stays at 600
#   plain3  -> rejected (daily cap of 3 already reached)
# Then the backup verifier runs scripts/recount-and-release.ts:
#   - recounts from the recorded push log by replaying the REAL
#     verifier rules (src/lib/recount.ts) — not a git-log count;
#   - recounted total must EQUAL the recorded counter (3);
#   - releases against the recount with the backup key: exactly the
#     one unpaid milestone (300) pays out — recipient ends at 900,
#     the full grant, with no double payment of milestones 1–2.
set -u
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
LOG="$ROOT/tests/e2e/recount-output.log"
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
# Hardhat well-known account #4 (backup oracle) — public, test-only.
BACKUP_KEY="0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"

set_test_env() {
  export PORT=3210 HOST=127.0.0.1 NODE_ENV=development
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

echo "=== 3. deploy v2 + lock (900 PTK, 3 pushes, milestone every 1) ==="
npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/deploy-recount.ts || exit 1
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

echo "=== 6. seed grant + linked wallet ==="
npx tsx tests/e2e/seed-recount.ts || exit 1

echo "=== 7. history: counted #1 (plain) ==="
node tests/e2e/send-webhook.mjs plain
OUT="$(npx tsx tests/e2e/balances.ts after-plain)"; echo "$OUT"
check "milestone 1 paid by live oracle (300 PTK)" "$OUT" "recipient PTK=300"

echo "=== 8. history: rejected mix (cooldown / bot / duplicate / docs) ==="
node tests/e2e/send-webhook.mjs small
node tests/e2e/send-webhook.mjs prbot
node tests/e2e/send-webhook.mjs plain
node tests/e2e/send-webhook.mjs docs
OUT="$(npx tsx tests/e2e/balances.ts after-rejects)"; echo "$OUT"
check "rejected mix moved nothing (still 300)" "$OUT" "recipient PTK=300"

echo "=== 9. history: counted #2 (PR #42) ==="
node tests/e2e/send-webhook.mjs prhuman
OUT="$(npx tsx tests/e2e/balances.ts after-prhuman)"; echo "$OUT"
check "milestone 2 paid by live oracle (600 PTK)" "$OUT" "recipient PTK=600"

echo "=== 10. GITHUB DEATH: owner rotates oracle to the backup ==="
OUT="$(npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/rotate-oracle.ts)"; echo "$OUT"
check "oracle rotated to backup" "$OUT" "ROTATED oracle ->"

echo "=== 11. counted #3 (plain2): verifier counts, dead oracle cannot release ==="
node tests/e2e/send-webhook.mjs plain2
OUT="$(npx tsx tests/e2e/balances.ts after-plain2)"; echo "$OUT"
check "counted #3 paid nothing under the dead oracle (still 600)" "$OUT" "recipient PTK=600"

echo "=== 12. over-cap push (plain3): rejected by the daily cap ==="
node tests/e2e/send-webhook.mjs plain3
OUT="$(npx tsx tests/e2e/balances.ts after-plain3)"; echo "$OUT"
check "daily-cap rejection moved nothing (still 600)" "$OUT" "recipient PTK=600"

echo "=== 13. backup verifier: recount from the push log + release ==="
OUT="$(BACKUP_ORACLE_PRIVATE_KEY="$BACKUP_KEY" GIT_ESCROW_ADDRESS="$GIT_ESCROW_ADDRESS" REDIS_URL="redis://127.0.0.1:6399" BASE_RPC_URL="http://127.0.0.1:8545" npx tsx scripts/recount-and-release.ts testowner/testrepo)"; echo "$OUT"
check "recount equals the recorded counter" "$OUT" '"recountedCount":3,"recordedCount":3'
check "recount reports equality" "$OUT" '"equal":true'
check "recount certified the history" "$OUT" "status=certified"
check "backup release landed" "$OUT" '"releaseTx":"0x'
OUT="$(npx tsx tests/e2e/balances.ts after-recount)"; echo "$OUT"
check "recount-backed release paid exactly the unpaid milestone (900 total)" "$OUT" "recipient PTK=900"
check "escrow fully drained by the schedule (0 left)" "$OUT" "escrow PTK=0"

echo "=== 14. swarm-gated history: recount replays swarm decisions (round-2) ==="
# The phase drives the gate directly with production-like window
# semantics (a no-review push must read as PENDING there), so it gets
# a 1h window override — the suite server keeps the 0-length window.
OUT="$(SWARM_REVIEW_WINDOW_SECONDS=3600 npx tsx tests/e2e/recount-swarm-phase.ts)"; echo "$OUT"
check "swarm history: webhook total is 1" "$OUT" '"recordedCount":1'
check "swarm history: recount equals webhook total WITH swarm gating" "$OUT" '"recountedCount":1'
check "swarm history: recount certified" "$OUT" '"status":"certified"'
check "swarm history: FAIL-vetoed push kept out by the recorded swarm verdict" "$OUT" "Swarm review: recorded quorum not met"

echo "=== 15. trimmed log: checkpoint certifies; no checkpoint -> REFUSAL (round-2) ==="
OUT="$(npx tsx tests/e2e/recount-trim-test.ts)"; echo "$OUT"
check "trimmed log + checkpoint: certified at the true total" "$OUT" '"phase":"trimmed-with-checkpoint","recordedCount":5,"recountedCount":5,"status":"certified","checkpointUsed":true'
check "trimmed log, no checkpoint: recount REFUSES (incomplete, no total)" "$OUT" '"phase":"trimmed-without-checkpoint","recordedCount":5,"recountedCount":null,"status":"incomplete"'


echo "=== 16. multi-lock recount: two active V3 grants settled by derivation (Phase 2) ==="
# Grants C (baseline 0) and D (baseline 2) lock 300 PTK each on the
# SAME repo (certified total 3). The recount script must settle
# each by the §2.5 derivation: C is owed all 3 milestones (300),
# D exactly one (100); the completed V2 grant must not double-pay.
OUT="$(npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/deploy-v3-recount.ts)"; echo "$OUT"
check "V3 grant D stamped baseline 2 on-chain" "$OUT" "startPushCount=2"
GRANT_C="$(python3 -c "import json;print(json.load(open('tests/e2e/state-recount-v3.json'))['grantC'])")"
GRANT_D="$(python3 -c "import json;print(json.load(open('tests/e2e/state-recount-v3.json'))['grantD'])")"
npx tsx tests/e2e/seed-recount-multigrant.ts || exit 1
OUT="$(BACKUP_ORACLE_PRIVATE_KEY="$BACKUP_KEY" GIT_ESCROW_ADDRESS="$GIT_ESCROW_ADDRESS" REDIS_URL="redis://127.0.0.1:6399" BASE_RPC_URL="http://127.0.0.1:8545" npx tsx scripts/recount-and-release.ts testowner/testrepo)"; echo "$OUT"
check "recount still certifies the shared repo total (3)" "$OUT" '"recountedCount":3,"recordedCount":3'
if printf '%s' "$OUT" | grep -q "\"grantId\":\"$GRANT_C\"[^}]*\"tx\":\"0x"; then echo "PASS: recount settled grant C by derivation (release tx present)"; else echo "FAIL: recount settled grant C by derivation"; FAILURES=$((FAILURES + 1)); fi
if printf '%s' "$OUT" | grep -q "\"grantId\":\"$GRANT_D\"[^}]*\"tx\":\"0x"; then echo "PASS: recount settled grant D by derivation (release tx present)"; else echo "FAIL: recount settled grant D by derivation"; FAILURES=$((FAILURES + 1)); fi
OUT="$(npx tsx tests/e2e/recount-multigrant-check.ts)"; echo "$OUT"
check "derivation payouts exact: recipient 700 PTK (900 - 600 locked + 300 C + 100 D)" "$OUT" "recipient PTK=700"
check "D's unvested remainder stays in the V3 escrow (200 PTK)" "$OUT" "v3escrow PTK=200"

echo "=== RECOUNT DRIVER DONE — failures: $FAILURES ==="
[ "$FAILURES" -eq 0 ] || exit 1
