#!/usr/bin/env bash
# Checks GET /parties/@me/fit — can this party be seated together in a lobby
# of the given shape? Usage: bash scripts/smoke-party-fit.sh [base-url]
set -uo pipefail

BASE="${1:-http://localhost:8787}"
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

login() {
    curl -s -m 8 -X POST "$BASE/auth/dev-login" -H 'Content-Type: application/json' \
        -d "{\"username\":\"$1\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'
}

fits() { # fits <token> <teamCount>
    curl -s -m 8 "$BASE/parties/@me/fit?teamCount=$2" -H "Authorization: Bearer $1" \
        | sed -n 's/.*"fits":\([a-z]*\).*/\1/p'
}

A=$(login FitAlpha)
B=$(login FitBravo)
C=$(login FitCharlie)
D=$(login FitDelta)
[ -n "$A" ] || {
    echo "no dev token — is the backend running on $BASE?"
    exit 1
}

echo "0. a player with no party fits anywhere"
check "solo player fits Trios" "true" "$(fits "$A" Trios)"

echo "1. build a 4-player party"
PARTY=$(curl -s -m 8 -X POST "$BASE/parties" -H "Authorization: Bearer $A" \
    -H 'Content-Type: application/json' -d '{"maxMembers":4}')
CODE=$(echo "$PARTY" | sed -n 's/.*"inviteCode":"\([^"]*\)".*/\1/p')
for T in "$B" "$C" "$D"; do
    curl -s -m 8 -o /dev/null -X POST "$BASE/parties/join" -H "Authorization: Bearer $T" \
        -H 'Content-Type: application/json' -d "{\"inviteCode\":\"$CODE\"}"
done
SIZE=$(curl -s -m 8 "$BASE/parties/@me" -H "Authorization: Bearer $A" | grep -o '"userId"' | wc -l | tr -d ' ')
check "party has four members" "4" "$SIZE"

echo "2. fixed-size lobbies — the whole point of the check"
check "4-party blocked from Duos" "false" "$(fits "$A" Duos)"
check "4-party blocked from Trios" "false" "$(fits "$A" Trios)"
check "4-party allowed into Quads" "true" "$(fits "$A" Quads)"

echo "3. variable-size lobbies cannot promise seats, so they never block"
check "4-party allowed into a 2-team lobby" "true" "$(fits "$A" 2)"
check "4-party allowed into Humans Vs Nations" "true" \
    "$(fits "$A" "Humans%20Vs%20Nations")"

echo "4. shrinking the party re-opens the smaller lobbies"
curl -s -m 8 -o /dev/null -X POST "$BASE/parties/leave" -H "Authorization: Bearer $D"
check "3-party now fits Trios" "true" "$(fits "$A" Trios)"
check "3-party still blocked from Duos" "false" "$(fits "$A" Duos)"

# Leave so repeated runs start clean.
for T in "$A" "$B" "$C"; do
    curl -s -m 8 -o /dev/null -X POST "$BASE/parties/leave" -H "Authorization: Bearer $T"
done

echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
