#!/usr/bin/env bash
# End-to-end check of the friends routes against a running backend.
# Usage: bash scripts/smoke-friends.sh [base-url]
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

me_public_id() { # me_public_id <token>
    curl -s -m 8 "$BASE/users/@me" -H "Authorization: Bearer $1" \
        | sed -n 's/.*"publicId":"\([^"]*\)".*/\1/p'
}

status() { # status <method> <path> <token>
    curl -s -m 8 -o /dev/null -w '%{http_code}' -X "$1" "$BASE$2" \
        -H "Authorization: Bearer $3" -H 'Content-Type: application/json'
}

body() { # body <method> <path> <token>
    curl -s -m 8 -X "$1" "$BASE$2" \
        -H "Authorization: Bearer $3" -H 'Content-Type: application/json'
}

# Unique names per run so repeated runs never collide on an existing edge.
RUN=$$
A=$(login "Ana$RUN")
B=$(login "Ben$RUN")
C=$(login "Cy$RUN")
[ -n "$A" ] && [ -n "$B" ] && [ -n "$C" ] || {
    echo "could not obtain dev tokens — is the backend running on $BASE?"
    exit 1
}

A_ID=$(me_public_id "$A")
B_ID=$(me_public_id "$B")
C_ID=$(me_public_id "$C")
[ -n "$A_ID" ] && [ -n "$B_ID" ] && [ -n "$C_ID" ] || {
    echo "could not read public ids from /users/@me"
    exit 1
}

echo "0. a fresh account has no friends and no requests"
EMPTY=$(body GET /friends "$A")
check "empty friends list" "yes" \
    "$(echo "$EMPTY" | grep -q '"results":\[\]' && echo yes || echo no)"
check "total is zero" "yes" \
    "$(echo "$EMPTY" | grep -q '"total":0' && echo yes || echo no)"
check "paging echoed back" "yes" \
    "$(echo "$EMPTY" | grep -q '"page":1' && echo yes || echo no)"

echo "1. A sends a request to B"
SENT=$(body POST "/friends/requests/$B_ID" "$A")
check "status is requested" "yes" \
    "$(echo "$SENT" | grep -q '"status":"requested"' && echo yes || echo no)"

echo "2. it appears in B's incoming and A's outgoing"
B_REQ=$(body GET /friends/requests "$B")
A_REQ=$(body GET /friends/requests "$A")
check "B sees A incoming" "yes" \
    "$(echo "$B_REQ" | sed -n 's/.*"incoming":\[\(.*\)\],"outgoing".*/\1/p' \
        | grep -q "$A_ID" && echo yes || echo no)"
check "A sees B outgoing" "yes" \
    "$(echo "$A_REQ" | sed -n 's/.*"outgoing":\[\(.*\)\].*/\1/p' \
        | grep -q "$B_ID" && echo yes || echo no)"
check "request carries a username" "yes" \
    "$(echo "$B_REQ" | grep -q '"username":"Ana' && echo yes || echo no)"
check "internal uuid never leaks" "yes" \
    "$(echo "$B_REQ" | grep -Eqi '"(userId|id)":"[0-9a-f]{8}-' && echo no || echo yes)"

echo "3. not friends yet — only a pending request"
check "A has no friends yet" "yes" \
    "$(body GET /friends "$A" | grep -q '"total":0' && echo yes || echo no)"

echo "4. sending the same request twice"
check "duplicate send rejected" "409" "$(status POST "/friends/requests/$B_ID" "$A")"

echo "5. friending yourself"
check "self-request rejected" "400" "$(status POST "/friends/requests/$A_ID" "$A")"

echo "6. unknown publicId"
check "unknown target rejected" "404" \
    "$(status POST "/friends/requests/ZZZnotarealpublicid" "$A")"

echo "7. accepting a request that was never sent"
check "accept without request rejected" "404" \
    "$(status POST "/friends/requests/$C_ID/accept" "$A")"

echo "7b. you cannot accept your OWN outgoing request"
# Otherwise anyone could add a stranger unilaterally.
check "self-accept of outgoing rejected" "404" \
    "$(status POST "/friends/requests/$B_ID/accept" "$A")"

echo "8. B accepts"
check "accept succeeds" "200" "$(status POST "/friends/requests/$A_ID/accept" "$B")"

echo "9. both sides now see each other"
check "A sees B as a friend" "yes" \
    "$(body GET /friends "$A" | grep -q "$B_ID" && echo yes || echo no)"
check "B sees A as a friend" "yes" \
    "$(body GET /friends "$B" | grep -q "$A_ID" && echo yes || echo no)"
check "A total is 1" "yes" \
    "$(body GET /friends "$A" | grep -q '"total":1' && echo yes || echo no)"
check "B total is 1" "yes" \
    "$(body GET /friends "$B" | grep -q '"total":1' && echo yes || echo no)"

echo "10. the pending request is gone from both lists"
check "B incoming cleared" "yes" \
    "$(body GET /friends/requests "$B" | grep -q '"incoming":\[\]' && echo yes || echo no)"
check "A outgoing cleared" "yes" \
    "$(body GET /friends/requests "$A" | grep -q '"outgoing":\[\]' && echo yes || echo no)"

echo "11. befriending someone you are already friends with"
check "already-friends rejected" "409" "$(status POST "/friends/requests/$B_ID" "$A")"

echo "12. MUTUAL REQUEST auto-accepts"
# C requests A, then A requests C. The second send must come back "accepted"
# rather than parking a second row: both parties have already consented.
body POST "/friends/requests/$A_ID" "$C" > /dev/null
MUTUAL=$(body POST "/friends/requests/$C_ID" "$A")
check "mutual send auto-accepts" "yes" \
    "$(echo "$MUTUAL" | grep -q '"status":"accepted"' && echo yes || echo no)"
check "A and C are now friends" "yes" \
    "$(body GET /friends "$A" | grep -q "$C_ID" && echo yes || echo no)"
check "no stale request left behind" "yes" \
    "$(body GET /friends/requests "$A" | grep -q '"incoming":\[\],"outgoing":\[\]' \
        && echo yes || echo no)"
check "A now has two friends" "yes" \
    "$(body GET /friends "$A" | grep -q '"total":2' && echo yes || echo no)"

echo "13. paging"
PAGE1=$(curl -s -m 8 "$BASE/friends?page=1&limit=1" -H "Authorization: Bearer $A")
PAGE2=$(curl -s -m 8 "$BASE/friends?page=2&limit=1" -H "Authorization: Bearer $A")
check "page 1 returns one row" "1" \
    "$(echo "$PAGE1" | grep -o '"publicId"' | wc -l | tr -d ' ')"
check "page 2 returns the other row" "1" \
    "$(echo "$PAGE2" | grep -o '"publicId"' | wc -l | tr -d ' ')"
check "pages do not repeat a friend" "yes" \
    "$([ "$(echo "$PAGE1" | sed -n 's/.*"publicId":"\([^"]*\)".*/\1/p')" \
        != "$(echo "$PAGE2" | sed -n 's/.*"publicId":"\([^"]*\)".*/\1/p')" ] \
        && echo yes || echo no)"
check "total is stable across pages" "yes" \
    "$(echo "$PAGE2" | grep -q '"total":2' && echo yes || echo no)"
check "past the end is empty, not an error" "yes" \
    "$(curl -s -m 8 "$BASE/friends?page=99&limit=1" -H "Authorization: Bearer $A" \
        | grep -q '"results":\[\]' && echo yes || echo no)"

echo "14. withdrawing an outgoing request"
body POST "/friends/requests/$C_ID" "$B" > /dev/null
check "withdraw succeeds" "200" "$(status DELETE "/friends/requests/$C_ID" "$B")"
check "gone from C's incoming" "yes" \
    "$(body GET /friends/requests "$C" | grep -q '"incoming":\[\]' && echo yes || echo no)"
check "withdrawing twice is a 404" "404" "$(status DELETE "/friends/requests/$C_ID" "$B")"

echo "15. denying an incoming request"
body POST "/friends/requests/$C_ID" "$B" > /dev/null
check "deny succeeds" "200" "$(status DELETE "/friends/requests/$B_ID" "$C")"
check "gone from B's outgoing" "yes" \
    "$(body GET /friends/requests "$B" | grep -q '"outgoing":\[\]' && echo yes || echo no)"

echo "16. removing a friend"
check "remove succeeds" "200" "$(status DELETE "/friends/$B_ID" "$A")"
check "gone from A's list" "yes" \
    "$(body GET /friends "$A" | grep -q "$B_ID" && echo no || echo yes)"
check "gone from B's list too" "yes" \
    "$(body GET /friends "$B" | grep -q "$A_ID" && echo no || echo yes)"
check "B's total back to zero" "yes" \
    "$(body GET /friends "$B" | grep -q '"total":0' && echo yes || echo no)"

echo "17. removing someone who is not a friend"
check "remove non-friend rejected" "404" "$(status DELETE "/friends/$B_ID" "$A")"

echo "18. a removed friend can be re-added"
check "re-request succeeds" "yes" \
    "$(body POST "/friends/requests/$B_ID" "$A" | grep -q '"status":"requested"' \
        && echo yes || echo no)"

echo "19. auth is required"
check "unauthenticated list rejected" "401" \
    "$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$BASE/friends")"
check "unauthenticated send rejected" "401" \
    "$(curl -s -m 8 -o /dev/null -w '%{http_code}' -X POST "$BASE/friends/requests/$B_ID")"

echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
