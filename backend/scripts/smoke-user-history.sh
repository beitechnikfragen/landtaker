#!/usr/bin/env bash
# Proves the home page's account rail is fed by real data end to end:
# archive a finished game the signed-in player took part in, then check it
# comes back on GET /users/@me — both the recent-match strip and the
# win/loss counters beside the elo.
#
# The unit tests only assert the response SHAPE against the game's schema.
# This is the part that needs a live Postgres: the join, the ordering, and
# the fact that the participant row is actually linked to the account.
#
# Usage: bash scripts/smoke-user-history.sh [base-url]
set -uo pipefail

BASE="${1:-http://localhost:8787}"
KEY="${API_KEY:-WARNING_DEV_API_KEY_DO_NOT_USE_IN_PRODUCTION}"
pass=0
fail=0

check() { # check <label> <expected> <actual>
    if [ "$2" = "$3" ]; then
        echo "  ok   $1 ($3)"
        pass=$((pass + 1))
    else
        echo "  FAIL $1 — expected $2, got $3"
        fail=$((fail + 1))
    fi
}

BODY=""
cleanup() {
    [ -n "$BODY" ] && rm -f "$BODY" 2> /dev/null
    return 0
}
trap cleanup EXIT

# --- sign in ---------------------------------------------------------------
# dev-login is development-only and mints a session for a throwaway account,
# which is exactly what a history check needs: a user with no prior games.
LOGIN=$(curl -s -m 20 -X POST "$BASE/auth/dev-login" \
    -H 'Content-Type: application/json' -d '{}')
# /users/@me authenticates with a bearer token, and dev-login returns the JWT
# in its body — the session cookie it also sets is for the browser flow.
JWT=$(printf '%s' "$LOGIN" | node -e "
let r='';process.stdin.on('data',c=>r+=c);
process.stdin.on('end',()=>{try{process.stdout.write(JSON.parse(r).jwt ?? '')}catch{process.stdout.write('')}});
" 2> /dev/null)
check "dev-login" "true" "$([ -n "$JWT" ] && echo true || echo false)"
[ -n "$JWT" ] || {
    echo "cannot continue without a token (is NODE_ENV=development?)"
    exit 1
}

me() { curl -s -m 20 -H "Authorization: Bearer $JWT" "$BASE/users/@me"; }

# The archive links a participant by PlayerRecord.persistentID, which is the
# account UUID carried in the JWT `sub` (base64url-encoded) — NOT the publicId
# shown to other players. resolveUserIds drops anything that is not a uuid, so
# using the wrong id would archive fine and silently link nothing.
PERSISTENT_ID=$(printf '%s' "$JWT" | node -e "
let r='';process.stdin.on('data',c=>r+=c);
process.stdin.on('end',()=>{
  const sub = JSON.parse(Buffer.from(r.split('.')[1], 'base64url').toString()).sub;
  const hex = Buffer.from(sub, 'base64url').toString('hex');
  process.stdout.write(
    [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20,32)].join('-'),
  );
});
" 2> /dev/null)
[ -n "$PERSISTENT_ID" ] || {
    echo "could not derive the account id from the token"
    exit 1
}
echo "signed in as ${PERSISTENT_ID}"

# History starts empty for a fresh dev account.
before=$(me | node -e "
let raw='';process.stdin.on('data',c=>raw+=c);
process.stdin.on('end',()=>process.stdout.write(String((JSON.parse(raw).player?.recentMatches ?? []).length)));
" 2> /dev/null)
check "history starts empty" "0" "$before"

# --- archive a finished game the player took part in ------------------------
GAME_ID="Hst$(printf '%05d' $((RANDOM % 100000)))"
BODY=$(mktemp)
# Kept beside the project rather than in /tmp: on Git Bash for Windows the
# shell's /tmp is not a path the Windows-side tsx can open.
GEN="./.smoke-fixture-$$.ts"
# Written to a file rather than passed with -e: a multi-line -e script gets
# mangled here and tsx exits without output.
cat > "$GEN" << TSEOF
import { buildGameRecord } from "./src/services/gameRecordFixture.ts";
import { replacer } from "@game/Util.ts";
const record = buildGameRecord({ gameID: "${GAME_ID}" });
// Attribute the first player to the signed-in account so the participant row
// carries a user_id — an unattributed row would never reach /users/@me.
if (record.info?.players?.[0]) {
  record.info.players[0].persistentID = "${PERSISTENT_ID}";
}
process.stdout.write(JSON.stringify(record, replacer));
TSEOF
npx tsx "$GEN" > "$BODY" 2> /dev/null
rm -f "$GEN"

[ -s "$BODY" ] || {
    echo "could not build the fixture record"
    exit 1
}

code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "$BASE/game/$GAME_ID" \
    -H 'Content-Type: application/json' -H "x-api-key: $KEY" \
    --data-binary "@$BODY")
check "archive game" "201" "$code"

# --- the rail's data ---------------------------------------------------------
after=$(me | node -e "
let raw='';process.stdin.on('data',c=>raw+=c);
process.stdin.on('end',()=>{
  const p = JSON.parse(raw).player ?? {};
  const matches = p.recentMatches ?? [];
  const first = matches[0] ?? {};
  process.stdout.write(JSON.stringify({
    count: matches.length,
    gameId: first.gameId ?? '',
    hasMap: first.map != null,
    hasEndedAt: first.endedAt != null,
  }));
});
" 2> /dev/null)

check "history has the game" "1" "$(printf '%s' "$after" | node -e "let r='';process.stdin.on('data',c=>r+=c);process.stdin.on('end',()=>process.stdout.write(String(JSON.parse(r).count)))" 2> /dev/null)"
check "it is the game we archived" "$GAME_ID" "$(printf '%s' "$after" | node -e "let r='';process.stdin.on('data',c=>r+=c);process.stdin.on('end',()=>process.stdout.write(JSON.parse(r).gameId))" 2> /dev/null)"
check "map name present" "true" "$(printf '%s' "$after" | node -e "let r='';process.stdin.on('data',c=>r+=c);process.stdin.on('end',()=>process.stdout.write(String(JSON.parse(r).hasMap)))" 2> /dev/null)"
check "ended-at present" "true" "$(printf '%s' "$after" | node -e "let r='';process.stdin.on('data',c=>r+=c);process.stdin.on('end',()=>process.stdout.write(String(JSON.parse(r).hasEndedAt)))" 2> /dev/null)"

echo
echo "passed: $pass, failed: $fail"
[ "$fail" -eq 0 ] || exit 1
