#!/usr/bin/env bash
# Proof of Dev — Claude Code PostToolUse hook: report a `git push` as a ship.
#
# What this does: after a Bash tool call whose command contains `git push`,
# it POSTs {repo, headSha} to the Proof of Dev ship-report endpoint so the
# developer's Claude can narrate the ship's state (reported → confirmed →
# paid / rejected / expired) in-conversation.
#
# What this does NOT do: move money. A ship report is a signal only —
# settlement happens exclusively via the GitHub push webhook → verifier →
# oracle. A report can be faked by anyone and is therefore worth exactly
# nothing until the webhook confirms it. See SKILL.md "Attestation layer".
#
# Safety contract: this hook must NEVER block, fail, or slow down a push.
# Every failure path exits 0 silently. It uses only bash + curl + git.
#
# Config (environment):
#   POD_API_URL       API base (default https://api.proofofdev.xyz)
#   POD_GITHUB_LOGIN  optional — your GitHub login, included as authorLogin
#                     when set. Never guessed or derived when unset.

# Deliberately no `set -e`: any error below must end in `exit 0`.
set -u

API="${POD_API_URL:-https://api.proofofdev.xyz}"

# ── 1. Read the hook payload and keep only `git push` Bash calls ─────────────
input="$(cat 2>/dev/null)" || exit 0
[ -n "$input" ] || exit 0

# Extract tool_input.command (a JSON string). Crude sed extraction is fine:
# we only need a contains-check, not a faithful parse.
cmd="$(printf '%s' "$input" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' | head -n 1)"
case "$cmd" in
  *"git push"*) ;;
  *) exit 0 ;;
esac

# ── 2. Resolve owner/repo from the origin remote ─────────────────────────────
remote="$(git remote get-url origin 2>/dev/null)" || exit 0
repo=""
case "$remote" in
  git@github.com:*)       repo="${remote#git@github.com:}" ;;
  ssh://git@github.com/*) repo="${remote#ssh://git@github.com/}" ;;
  https://github.com/*)   repo="${remote#https://github.com/}" ;;
  http://github.com/*)    repo="${remote#http://github.com/}" ;;
  *) exit 0 ;; # not a GitHub remote — nothing to report
esac
repo="${repo%.git}"
case "$repo" in
  */*) ;;
  *) exit 0 ;;
esac

# ── 3. Head SHA of the local checkout ────────────────────────────────────────
sha="$(git rev-parse HEAD 2>/dev/null)" || exit 0
[ "${#sha}" -eq 40 ] || exit 0
case "$sha" in
  *[!0-9a-f]*) exit 0 ;;
esac

# ── 4. Report it (short timeout, output discarded, result ignored) ──────────
author="${POD_GITHUB_LOGIN:-}"
if [ -n "$author" ]; then
  body="{\"repo\":\"$repo\",\"headSha\":\"$sha\",\"authorLogin\":\"$author\"}"
else
  body="{\"repo\":\"$repo\",\"headSha\":\"$sha\"}"
fi
curl -s -m 5 -X POST "$API/api/agent/report-ship" \
  -H 'content-type: application/json' \
  -d "$body" >/dev/null 2>&1

exit 0
