#!/usr/bin/env bash
# TEST-ONLY driver for the STITCHED END-TO-END run (2026-11-25):
# the complete Proof of Dev platform flow in ONE execution, through
# the CURRENT (round-3) code paths — the legs the earlier suites
# proved separately, stitched on a single repo (testowner/testrepo):
#
#   verify -> fee-grant registration (registrar) -> prepare
#   (round-4 order: the grant must exist before prepare verifies
#   it) -> [launch stand-in] -> lock -> register (stamped) ->
#   counted pushes -> supply milestones + author reward + replay
#   safety -> keeper fee lock -> GITHUB DEATH (oracle rotation) ->
#   recount -> backup-oracle supply release + fee sweep ->
#   negative checks.
#
# Same local stack as the other drivers (fake redis + Hardhat node
# chainId 8453 + fixture GitHub API + the real vesting server).
# No mainnet, no real keys (Hardhat test accounts + throwaway RSA).
#
# TIMELINE CONSTRAINT (named, not hidden): the verifier's daily
# cap is 3 counted pushes per repo per day, and the recount
# replays that cap strictly — so a single-day stitched history
# holds at most 3 counted pushes. The stitch therefore uses:
#   push 1 (webhook, plain)   counted, supply milestone 1
#   push 2 (webhook, PR #42)  counted, milestone 2 + author reward
#   push 3 (webhook, plain2)  counted UNDER THE DEAD ORACLE — its
#                             supply milestone and its fee delta
#                             are the GitHub-death recovery payload,
#                             asserted to land exactly once through
#                             the backup-oracle recount + fee sweep.
# Stage 7's fee tranche (40 WETH, vesting over 2 pushes) locks at
# counted total 2; push 3 is the "one more counted push" whose
# releaseFee delta (20 WETH, half the tranche) stage 7 promises —
# it lands via the stage-8 recovery path because push 3 is the
# death push. Every amount is asserted to the wei either way.
#
# Stage 4's launch leg is a LOCAL STAND-IN: the token's launch fee
# record is set on MockBankrLaunchRecord to exactly the prepared
# production split. The real Bankr SDK launch was proven on Base
# mainnet in round 2 (report §15); this run proves the platform
# flow around it, not a new launch.
set -u
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
LOG="$ROOT/tests/e2e/stitched-e2e-output.log"
: > "$LOG"
exec > >(tee -a "$LOG") 2>&1

FAILURES=0
CHECKS=0
check() { # name, haystack, needle
  CHECKS=$((CHECKS + 1))
  if printf '%s' "$2" | grep -qF "$3"; then
    echo "PASS: $1"
  else
    echo "FAIL: $1 (missing: $3)"
    FAILURES=$((FAILURES + 1))
  fi
}
check_absent() { # name, haystack, needle-that-must-not-appear
  CHECKS=$((CHECKS + 1))
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
KEEPER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
# Hardhat well-known account #4 (backup oracle) — public, test-only.
BACKUP_KEY="0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"

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
  # Swarm window pinned to 0 (mandatory-window rule, 2026-11-26): this suite
  # predates the swarm and exercises pushes synchronously — a 0-length
  # window settles by immediate verifier fallback. Swarm paths are
  # covered by run-swarm.sh and run-swarm-window.sh.
  export SWARM_REVIEW_WINDOW_SECONDS=0
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
REPO="testowner/testrepo"
J() { python3 -c "import json,sys;print(json.load(open('tests/e2e/state-stitched.json'))[sys.argv[1]])" "$1"; }

echo "=== STAGE 1. SETUP: fake redis + local chain + deploys + server ==="
node tests/e2e/fake-redis.js &
PIDS+=($!)
sleep 1
npx hardhat node --config hardhat.local.config.ts --port 8545 &
PIDS+=($!)
wait_rpc || exit 1
echo "node up"
DEPLOY_OUT="$(npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/deploy-stitched.ts)" || exit 1
echo "$DEPLOY_OUT"
DEPLOYER="$(J deployer)"; RECIPIENT="$(J recipient)"; AUTHOR="$(J author)"
VAULT="$(J feeLockVault)"; SOURCE="$(J feeClaimSource)"
PTK="$(J ptk)"; WETH="$(J weth)"
export GIT_ESCROW_ADDRESS="$(J gitEscrow)"
export SHIP_REWARDS_ADDRESS="$(J shipRewards)"
export FEE_STREAM_ESCROW_ADDRESS="$(J feeStreamEscrow)"
export BANKR_FACTORY_ADDRESS="$(J bankrRecord)"
export BANKR_FEE_LEDGER_ADDRESS="$(J bankrRecord)"
export WETH_ADDRESS="$(J weth)"
export BANKR_CLAIM_LEDGER_ADDRESS="$(J feeClaimSource)"
export SHIP_REWARD_PER_MERGE="10000000000000000000"
echo "recipient=$RECIPIENT vault=$VAULT treasury(stand-in)=$DEPLOYER"
check "stage 1: vault deployed from the approved implementation (address present)" "$VAULT" "0x"
node tests/e2e/github-fixture.js &
PIDS+=($!)
sleep 1
set_test_env
npx tsx src/index.ts &
SERVER_PID=$!
PIDS+=($SERVER_PID)
wait_http "$API/health" 30 || exit 1
echo "server up"
npx tsx tests/e2e/seed-stitched.ts || exit 1

echo "=== STAGE 2. VERIFY: GitHub App verification -> gate token ==="
OUT="$(curl -s -X POST "$API/api/launch/verify-github" -H 'content-type: application/json' \
  -d "{\"githubLogin\":\"testowner\",\"repo\":\"$REPO\",\"wallet\":\"$RECIPIENT\",\"chain\":\"base\"}")"; echo "$OUT"
check "stage 2: verify ok" "$OUT" '"verified":true'
check "stage 2: gate token issued (issuance record written)" "$OUT" '"verificationToken":"'
TOKEN="$(printf '%s' "$OUT" | python3 -c "import sys,json;print(json.load(sys.stdin)['verificationToken'])")"

echo "=== STAGE 3. PREPARE: registrar fee grant FIRST, then prepare-launch -> production template ==="
# Round-4 order: platform deploys the vault -> registrar registers
# the fee grant -> prepare verifies bindings + grant -> input.
OUT="$(npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/register-fee-grant-stitched.ts)"; echo "$OUT"
check "stage 3: fee grant registered via the registrar path (before prepare)" "$OUT" "FEE_GRANT_REGISTERED"
check "stage 3: fee grant fields exact (recipient/token/vault/ppt)" "$OUT" "FEE_GRANT recipient=$RECIPIENT token=$WETH vault=$VAULT pushesPerTranche=2 registered=true"
OUT="$(curl -s -X POST "$API/api/launch/prepare-launch" -H 'content-type: application/json' \
  -H "x-wallet-address: $RECIPIENT" \
  -d "{\"repo\":\"$REPO\",\"verificationToken\":\"$TOKEN\",\"feeLockVault\":\"$VAULT\",\"launch\":{\"name\":\"Stitched Token\",\"symbol\":\"STK\"}}")"; echo "$OUT"
check "stage 3: prepare-launch ok (vault passed the canonical codehash check AND every binding + grant check)" "$OUT" '"prepared":true'
check "stage 3: treasury (stand-in) gets exactly 2500" "$OUT" "\"recipient\":\"$(printf '%s' "$DEPLOYER" | tr 'A-F' 'a-f')\",\"shareBps\":2500"
check "stage 3: vault gets exactly 7500 (never the raw wallet)" "$OUT" "\"recipient\":\"$(printf '%s' "$VAULT" | tr 'A-F' 'a-f')\",\"shareBps\":7500"
check "stage 3: vesting explicitly {bps:0}" "$OUT" '"bps":0'
OUT="$(npx hardhat run tests/vault-impl-test.ts 2>&1 | tail -3)"; echo "$OUT"
check "stage 3: canonical vault implementation guard (artifact == pinned template)" "$OUT" "vault-impl: ALL PASS"

echo "=== STAGE 4. LAUNCH (LOCAL STAND-IN for the SDK launch proven on mainnet in round 2) ==="
echo "STAND-IN: token launch record set locally to exactly the prepared split — no SDK launch is executed in this run."
check "stage 4: launch record carries the prepared recipients exactly" "$DEPLOY_OUT" "RECORD_SET token=$PTK recipients=[[\"$DEPLOYER\",2500],[\"$VAULT\",7500]]"

echo "=== STAGE 5. LOCK + REGISTER: v2 lock, stamped registration (fee grant registered in stage 3) ==="
LOCK_OUT="$(npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/lock-stitched.ts)" || exit 1
echo "$LOCK_OUT"
LOCK_TX="$(printf '%s' "$LOCK_OUT" | grep -o 'LOCK_TX=0x[0-9a-f]*' | cut -d= -f2)"
REG_BODY="{\"repoFullName\":\"$REPO\",\"platform\":\"github\",\"recipient\":\"$RECIPIENT\",\"token\":\"$PTK\",\"chain\":\"base\",\"totalLocked\":\"900000000000000000000\",\"totalPushesRequired\":3,\"pushesPerMilestone\":1,\"tokensPerMilestone\":\"300000000000000000000\",\"onChainTxHash\":\"$LOCK_TX\",\"installationId\":777,\"streaming\":false,\"feeLockVault\":\"$VAULT\",\"feePushesPerTranche\":2,\"launchVerificationToken\":\"$TOKEN\"}"
OUT="$(curl -s -X POST "$API/api/vesting/register" -H 'content-type: application/json' -d "$REG_BODY")"; echo "$OUT"
check "stage 5: register ok" "$OUT" '"ok":true'
check "stage 5: grant stamped launchVerified" "$OUT" '"launchVerified":true'
check "stage 5: launcher enrolled" "$OUT" '"launcherRewardEnrolled":true'
ENR="$(curl -s "$API/api/launch/enrollment?repo=$REPO&wallet=$RECIPIENT")"; echo "$ENR"
check "stage 5: enrolment record present" "$ENR" '"enrolled":true'
PROJ="$(curl -s "$API/api/launch/projects")"; echo "$PROJ"
check "stage 5: verified launch listed" "$PROJ" "\"repoFullName\":\"$REPO\""

echo "=== STAGE 6. PUSHES + RELEASES: milestones, author reward, replay safety ==="
node tests/e2e/send-webhook.mjs plain
OUT="$(npx tsx tests/e2e/balances.ts after-push1)"; echo "$OUT"
check "stage 6: push 1 paid supply milestone 1 (100 free + 300 released = 400 PTK)" "$OUT" "recipient PTK=400"
node tests/e2e/send-webhook.mjs prhuman
OUT="$(npx tsx tests/e2e/balances.ts after-push2)"; echo "$OUT"
check "stage 6: push 2 (PR #42) paid supply milestone 2 (100 free + 600 released = 700 PTK)" "$OUT" "recipient PTK=700"
check "stage 6: author reward paid the merge author exactly once (10 RWD)" "$OUT" "author RWD=10"
node tests/e2e/send-webhook.mjs prhuman
OUT="$(npx tsx tests/e2e/balances.ts after-replay)"; echo "$OUT"
check "stage 6: replayed webhook changed nothing (PTK)" "$OUT" "recipient PTK=700"
check "stage 6: replayed webhook changed nothing (RWD)" "$OUT" "author RWD=10"
OUT="$(REDIS_URL="redis://127.0.0.1:6399" npx tsx tests/e2e/push-state.ts "$REPO")"; echo "$OUT"
check "stage 6: backend counted exactly 2 pushes" "$OUT" '"pushCount":2'

echo "=== STAGE 7. FEE STREAM: keeper claim+lock at the current counts ==="
OUT="$(KEEPER_PRIVATE_KEY="$KEEPER_KEY" FEE_CLAIM_SOURCE="$SOURCE" npx tsx scripts/fee-lock-keeper.ts "$VAULT")"; echo "$OUT"
check "stage 7: keeper claimed + locked 40 WETH" "$OUT" '"lockedAmount":"40000000000000000000"'
check "stage 7: tranche 1 on-chain baseline == 2" "$OUT" '"expectedBaseline":"2"'
check "stage 7: tranche 1 attestedCountAtLock == 2 (baseline == attested == on-chain)" "$OUT" '"attestedCountAtLock":"2"'
OUT="$(npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/fee-state.ts)"; echo "$OUT"
check "stage 7: on-chain counter is 2" "$OUT" "knownPushCount=2"
check "stage 7: tranche 0 stamped baseline=2 backend=2, nothing released" "$OUT" "tranche0 amount=40000000000000000000 baseline=2 backend=2 released=0"
OUT="$(npx tsx tests/e2e/balances-fee.ts after-lock)"; echo "$OUT"
check "stage 7: fee escrow holds the locked 40 WETH" "$OUT" "feeEscrow WETH=40"
check "stage 7: vault drained after lock" "$OUT" "vault WETH=0"
check "stage 7: recipient WETH still 0 (no push since the lock)" "$OUT" "recipient PTK=700 WETH=0"
echo "NOTE: the 'one more counted push' for this tranche is push 3 — the stage-8 death push. Its 20 WETH delta is asserted in stage 8 after the backup-oracle recovery."

echo "=== STAGE 8. GITHUB-DEATH: rotation, unreported push, recount, exact recovery ==="
OUT="$(npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/rotate-stitched.ts)"; echo "$OUT"
check "stage 8: supply oracle rotated to the backup" "$OUT" "ROTATED supply oracle ->"
check "stage 8: fee oracle rotated to the backup" "$OUT" "ROTATED fee oracle ->"
node tests/e2e/send-webhook.mjs plain2
OUT="$(REDIS_URL="redis://127.0.0.1:6399" npx tsx tests/e2e/push-state.ts "$REPO")"; echo "$OUT"
check "stage 8: backend counted push 3 (backend ahead of chain)" "$OUT" '"pushCount":3'
OUT="$(npx tsx tests/e2e/balances.ts after-death-push)"; echo "$OUT"
check "stage 8: dead oracle paid no supply milestone (still 700 PTK incl. the 100 free)" "$OUT" "recipient PTK=700"
OUT="$(npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/fee-state.ts)"; echo "$OUT"
check "stage 8: on-chain fee counter still 2 while the report is unlanded" "$OUT" "knownPushCount=2"
OUT="$(REDIS_URL="redis://127.0.0.1:6399" npx tsx tests/e2e/fee-retry.ts pending)"; echo "$OUT"
check "stage 8: pending fee release recorded at push count 3" "$OUT" '"pushCount":3'
echo "--- spot-check 9(c) runs HERE, at the only point a genuine pending entry exists ---"
AMOUNT=20 npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/fee-topup.ts || exit 1
OUT="$(KEEPER_PRIVATE_KEY="$KEEPER_KEY" FEE_CLAIM_SOURCE="$SOURCE" npx tsx scripts/fee-lock-keeper.ts "$VAULT")"; echo "$OUT"
check "stage 8/9c: keeper DEFERRED while a fee release is pending" "$OUT" '"lockDeferred"'
check_absent "stage 8/9c: deferred keeper locked nothing" "$OUT" '"lockedAmount"'
OUT="$(npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/fee-state.ts)"; echo "$OUT"
check "stage 8/9c: no tranche was created during the deferral" "$OUT" "tranches=1"
OUT="$(npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/dead-oracle-stitched.ts)"; echo "$OUT"
check "stage 8: dead oracle key can no longer release supply" "$OUT" "DEAD_ORACLE_SUPPLY_RELEASE: REVERTED"
check "stage 8: dead oracle key can no longer release fees" "$OUT" "DEAD_ORACLE_FEE_RELEASE: REVERTED"
OUT="$(BACKUP_ORACLE_PRIVATE_KEY="$BACKUP_KEY" GIT_ESCROW_ADDRESS="$GIT_ESCROW_ADDRESS" REDIS_URL="redis://127.0.0.1:6399" BASE_RPC_URL="http://127.0.0.1:8545" npx tsx scripts/recount-and-release.ts "$REPO")"; echo "$OUT"
check "stage 8: recount equals the backend total (3 = 3)" "$OUT" '"recountedCount":3,"recordedCount":3'
check "stage 8: recount certified the history" "$OUT" "status=certified"
check "stage 8: backup-oracle supply release landed" "$OUT" '"releaseTx":"0x'
OUT="$(npx tsx tests/e2e/balances.ts after-recount)"; echo "$OUT"
check "stage 8: missed supply milestone paid exactly (100 free + 900 released = 1000 PTK)" "$OUT" "recipient PTK=1000"
check "stage 8: supply escrow fully drained, no double-pay" "$OUT" "escrow PTK=0"
OUT="$(ORACLE_PRIVATE_KEY="$BACKUP_KEY" npx tsx scripts/fee-release-sweep.ts)"; echo "$OUT"
check "stage 8: fee sweep retried the pending release once" "$OUT" '"swept":1'
OUT="$(npx tsx tests/e2e/balances-fee.ts after-sweep)"; echo "$OUT"
check "stage 7+8: releaseFee paid the vested delta exactly (20 WETH = half the tranche)" "$OUT" "recipient PTK=1000 WETH=20"
check "stage 7+8: unvested half stays locked in the fee escrow (20 WETH)" "$OUT" "feeEscrow WETH=20"
OUT="$(REDIS_URL="redis://127.0.0.1:6399" npx tsx tests/e2e/fee-retry.ts pending)"; echo "$OUT"
check "stage 8: pending entry cleared after the sweep" "$OUT" '"pending":null'
OUT="$(npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/fee-state.ts)"; echo "$OUT"
check "stage 8: on-chain fee counter caught up to 3" "$OUT" "knownPushCount=3"
OUT="$(ORACLE_PRIVATE_KEY="$BACKUP_KEY" npx tsx scripts/fee-release-sweep.ts)"; echo "$OUT"
check "stage 8: second sweep is a no-op (exactly-once)" "$OUT" '"swept":0'
OUT="$(npx tsx tests/e2e/balances-fee.ts after-second-sweep)"; echo "$OUT"
check "stage 8: balances unchanged after the second sweep" "$OUT" "recipient PTK=1000 WETH=20"

echo "=== STAGE 9. NEGATIVE SPOT-CHECKS ==="
echo "--- (a) no prepared record / no token -> unstamped, unlisted; duplicate active grant refused ---"
LOCK_OUT="$(LOCK_REPO="testowner/stitched-plain" LOCK_AMOUNT=10 npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/lock-for-repo-fee.ts)" || exit 1
PLAIN_LOCK_TX="$(printf '%s' "$LOCK_OUT" | grep -o 'LOCK_TX=0x[0-9a-f]*' | cut -d= -f2)"
REG_PLAIN="{\"repoFullName\":\"testowner/stitched-plain\",\"platform\":\"github\",\"recipient\":\"$RECIPIENT\",\"token\":\"$PTK\",\"chain\":\"base\",\"totalLocked\":\"10000000000000000000\",\"totalPushesRequired\":2,\"pushesPerMilestone\":1,\"tokensPerMilestone\":\"5000000000000000000\",\"onChainTxHash\":\"$PLAIN_LOCK_TX\",\"installationId\":777,\"streaming\":false}"
OUT="$(curl -s -X POST "$API/api/vesting/register" -H 'content-type: application/json' -d "$REG_PLAIN")"; echo "$OUT"
check "stage 9a: tokenless registration still registers an ordinary grant" "$OUT" '"ok":true'
check_absent "stage 9a: ordinary grant is NOT stamped" "$OUT" '"launchVerified":true'
PROJ="$(curl -s "$API/api/launch/projects")"; echo "$PROJ"
check_absent "stage 9a: ordinary grant is NOT in the verified-launch listing" "$PROJ" "stitched-plain"
check "stage 9a: the stamped launch is STILL listed" "$PROJ" "\"repoFullName\":\"$REPO\""
ENR="$(curl -s "$API/api/launch/enrollment?repo=testowner/stitched-plain&wallet=$RECIPIENT")"; echo "$ENR"
check "stage 9a: ordinary grant has no launcher enrolment" "$ENR" '"enrolled":false'
OUT="$(curl -s -X POST "$API/api/vesting/register" -H 'content-type: application/json' -d "$REG_BODY")"; echo "$OUT"
check "stage 9a: second registration of the SAME repo is refused (active grant stands)" "$OUT" "Active vesting grant already exists for this repo"
echo "--- (b) recipient cancel attempt on v2 ---"
OUT="$(npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/cancel-attempt-stitched.ts)"; echo "$OUT"
check "stage 9b: recipient cancel attempt on v2 reverts (no-cancel)" "$OUT" "CANCEL_ATTEMPT: REVERTED"
echo "--- (c) keeper gate cleared once the pending entry is gone (deferral itself asserted in stage 8) ---"
# Round-4 wrinkle the death stage now exercises: the count
# attestation is signed by the escrow's CURRENT oracle — the same
# trust role that signs release counts. Stage 8 rotated that role
# to the backup, so attestation issuance moves with it: the
# backup operator's backend (same code, backup oracle key) takes
# over the API for the keeper's attestation fetch.
kill "$SERVER_PID" 2>/dev/null; pkill -f "tsx src/index.ts" 2>/dev/null; sleep 1
ORACLE_PRIVATE_KEY="$BACKUP_KEY" npx tsx src/index.ts &
SERVER_PID=$!
PIDS+=($SERVER_PID)
wait_http "$API/health" 30 || exit 1
echo "backend restarted under the backup oracle key (attestation issuer == current oracle)"
OUT="$(KEEPER_PRIVATE_KEY="$KEEPER_KEY" FEE_CLAIM_SOURCE="$SOURCE" npx tsx scripts/fee-lock-keeper.ts "$VAULT")"; echo "$OUT"
check_absent "stage 9c: keeper no longer deferred" "$OUT" '"lockDeferred"'
check "stage 9c: keeper locked the 20 WETH accrued during the death window (tranche 2)" "$OUT" '"lockedAmount":"20000000000000000000"'
check "stage 9c: tranche 2 attestedCountAtLock == 3" "$OUT" '"attestedCountAtLock":"3"'
OUT="$(npx hardhat run --config hardhat.local.config.ts --network localhost tests/e2e/fee-state.ts)"; echo "$OUT"
check "stage 9c: tranche 1 stamped baseline=3 backend=3" "$OUT" "tranche1 amount=20000000000000000000 baseline=3 backend=3 released=0"

echo "=== STITCHED E2E DRIVER DONE — $((CHECKS - FAILURES)) PASS / $FAILURES FAIL (of $CHECKS checks) ==="
[ "$FAILURES" -eq 0 ] || exit 1
