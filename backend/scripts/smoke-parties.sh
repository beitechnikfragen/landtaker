#!/usr/bin/env bash
# End-to-end check of the party routes against a running backend.
# Usage: bash scripts/smoke-parties.sh [base-url]
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
    curl -s -m 8 -X POST "$BASE/auth/dev-login" \
        -H 'Content-Type: application/json' \
        -d "{\"username\":\"$1\"}" \
        | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'
}

status() { # status <method> <path> <token> [body]
    curl -s -m 8 -o /dev/null -w '%{http_code}' -X "$1" "$BASE$2" \
        -H "Authorization: Bearer $3" -H 'Content-Type: application/json' \
        -d "${4:-{\}}"
}

A=$(login Alpha)
B=$(login Bravo)
C=$(login Charlie)
[ -n "$A" ] && [ -n "$B" ] && [ -n "$C" ] || {
    echo "could not obtain dev tokens — is the backend running on $BASE?"
    exit 1
}

echo "1. create a 2-seat party"
PARTY=$(curl -s -m 8 -X POST "$BASE/parties" -H "Authorization: Bearer $A" \
    -H 'Content-Type: application/json' -d '{"maxMembers":2}')
CODE=$(echo "$PARTY" | sed -n 's/.*"inviteCode":"\([^"]*\)".*/\1/p')
MEMBERS=$(echo "$PARTY" | grep -o '"userId"' | wc -l | tr -d ' ')
check "invite code issued" "6" "${#CODE}"
check "creator is a member" "1" "$MEMBERS"

echo "2. second player joins"
JOINED=$(curl -s -m 8 -X POST "$BASE/parties/join" -H "Authorization: Bearer $B" \
    -H 'Content-Type: application/json' -d "{\"inviteCode\":\"$CODE\"}")
check "party has two members" "2" "$(echo "$JOINED" | grep -o '"userId"' | wc -l | tr -d ' ')"

echo "3. third player hits the cap"
check "full party rejected" "409" \
    "$(status POST /parties/join "$C" "{\"inviteCode\":\"$CODE\"}")"

echo "4. unknown invite code"
check "unknown code rejected" "404" \
    "$(status POST /parties/join "$C" '{"inviteCode":"ZZZZZZ"}')"

echo "5. re-joining the party you are already in is a no-op, not an error"
check "idempotent re-join" "200" \
    "$(status POST /parties/join "$A" "{\"inviteCode\":\"$CODE\"}")"

echo "6. joining a DIFFERENT party while already in one"
OTHER=$(curl -s -m 8 -X POST "$BASE/parties" -H "Authorization: Bearer $C" \
    -H 'Content-Type: application/json' -d '{}')
OTHER_CODE=$(echo "$OTHER" | sed -n 's/.*"inviteCode":"\([^"]*\)".*/\1/p')
check "second party rejected" "409" \
    "$(status POST /parties/join "$A" "{\"inviteCode\":\"$OTHER_CODE\"}")"
# Leave again so C does not linger in a party for the steps below.
curl -s -m 8 -o /dev/null -X POST "$BASE/parties/leave" -H "Authorization: Bearer $C"

echo "7. non-leader tries to kick"
LEADER_ID=$(echo "$PARTY" | sed -n 's/.*"leaderId":"\([^"]*\)".*/\1/p')
check "non-leader kick rejected" "403" \
    "$(status POST /parties/kick "$B" "{\"userId\":\"$LEADER_ID\"}")"

echo "7b. bodyless POST — the shape a browser client sends"
# Regression guard: Fastify 400s on an EMPTY body when content-type says
# application/json. PartyApi used to set that header on every request, so
# /parties/leave broke in the browser while passing here. Note there is no
# -d flag below — that is the whole point of the case.
curl -s -m 8 -o /dev/null -X POST "$BASE/parties" -H "Authorization: Bearer $C" \
    -H 'Content-Type: application/json' -d '{}'
check "leave works with no body at all" "200" \
    "$(curl -s -m 8 -o /dev/null -w '%{http_code}' -X POST "$BASE/parties/leave" \
        -H "Authorization: Bearer $C")"

echo "8. leader leaves — leadership must transfer"
curl -s -m 8 -o /dev/null -X POST "$BASE/parties/leave" -H "Authorization: Bearer $A"
AFTER=$(curl -s -m 8 "$BASE/parties/@me" -H "Authorization: Bearer $B")
NEW_LEADER=$(echo "$AFTER" | sed -n 's/.*"leaderId":"\([^"]*\)".*/\1/p')
check "leadership moved off the leaver" "yes" \
    "$([ -n "$NEW_LEADER" ] && [ "$NEW_LEADER" != "$LEADER_ID" ] && echo yes || echo no)"

echo "9. last member leaves — party is deleted"
curl -s -m 8 -o /dev/null -X POST "$BASE/parties/leave" -H "Authorization: Bearer $B"
EMPTY=$(curl -s -m 8 "$BASE/parties/@me" -H "Authorization: Bearer $B")
check "no party remains" "yes" \
    "$(echo "$EMPTY" | grep -q '"party":null' && echo yes || echo no)"

echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
