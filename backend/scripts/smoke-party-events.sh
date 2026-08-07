#!/usr/bin/env bash
# End-to-end check of the party SSE stream against a running backend with real
# Postgres and real Redis.
#
# Proves the thing that matters: a stream opened by user A actually receives an
# event when user B joins A's party from a SEPARATE process. An empty stream is
# not proof, so every check asserts on captured bytes.
#
# Usage: bash scripts/smoke-party-events.sh [base-url]
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

# Counts `event: party` frames in a captured stream.
count_events() { grep -c '^event: party' "$1" 2> /dev/null | tr -d ' '; }

# The nth data line of a captured stream (1-based).
data_line() { grep '^data: ' "$1" | sed -n "$2p" | sed 's/^data: //'; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"; [ -n "${STREAM_PID:-}" ] && kill "$STREAM_PID" 2>/dev/null' EXIT

A=$(login EventAlpha)
B=$(login EventBravo)
[ -n "$A" ] && [ -n "$B" ] || {
    echo "could not obtain dev tokens — is the backend running on $BASE?"
    exit 1
}

# Start from a clean slate: a leftover party from an earlier run would make the
# first assertion pass for the wrong reason.
curl -s -m 8 -o /dev/null -X POST "$BASE/parties/leave" -H "Authorization: Bearer $A"
curl -s -m 8 -o /dev/null -X POST "$BASE/parties/leave" -H "Authorization: Bearer $B"

echo "0. auth is enforced on the stream"
check "anonymous stream rejected" "401" \
    "$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$BASE/parties/@me/events")"

echo "1. A creates a party"
PARTY=$(curl -s -m 8 -X POST "$BASE/parties" -H "Authorization: Bearer $A" \
    -H 'Content-Type: application/json' -d '{"maxMembers":4}')
CODE=$(echo "$PARTY" | sed -n 's/.*"inviteCode":"\([^"]*\)".*/\1/p')
check "invite code issued" "6" "${#CODE}"

echo "2. A opens the SSE stream"
STREAM="$WORK/stream.txt"
# -N disables curl's buffering, so frames land in the file as they arrive.
curl -sN -m 20 "$BASE/parties/@me/events" \
    -H "Authorization: Bearer $A" -H 'Accept: text/event-stream' \
    > "$STREAM" 2> /dev/null &
STREAM_PID=$!

# Wait for the initial snapshot rather than sleeping a fixed amount.
for _ in $(seq 1 40); do
    [ "$(count_events "$STREAM")" -ge 1 ] && break
    sleep 0.25
done
check "stream sent an initial snapshot" "1" "$(count_events "$STREAM")"
check "snapshot carries A's invite code" "yes" \
    "$(data_line "$STREAM" 1 | grep -q "\"inviteCode\":\"$CODE\"" && echo yes || echo no)"
check "snapshot has exactly one member" "1" \
    "$(data_line "$STREAM" 1 | grep -o '"userId"' | wc -l | tr -d ' ')"

echo "3. B joins from a separate process — A's open stream must receive it"
curl -s -m 8 -o /dev/null -X POST "$BASE/parties/join" -H "Authorization: Bearer $B" \
    -H 'Content-Type: application/json' -d "{\"inviteCode\":\"$CODE\"}"

for _ in $(seq 1 40); do
    [ "$(count_events "$STREAM")" -ge 2 ] && break
    sleep 0.25
done
check "join pushed a live event to A" "2" "$(count_events "$STREAM")"
check "the pushed party has two members" "2" \
    "$(data_line "$STREAM" 2 | grep -o '"userId"' | wc -l | tr -d ' ')"
check "payload is the full party, no refetch needed" "yes" \
    "$(data_line "$STREAM" 2 | grep -q '"leaderId"' \
        && data_line "$STREAM" 2 | grep -q '"maxMembers"' \
        && data_line "$STREAM" 2 | grep -q '"viewerId"' && echo yes || echo no)"

echo "4. B leaves — A must see the roster shrink"
curl -s -m 8 -o /dev/null -X POST "$BASE/parties/leave" -H "Authorization: Bearer $B"
for _ in $(seq 1 40); do
    [ "$(count_events "$STREAM")" -ge 3 ] && break
    sleep 0.25
done
check "leave pushed a live event to A" "3" "$(count_events "$STREAM")"
check "roster is back to one member" "1" \
    "$(data_line "$STREAM" 3 | grep -o '"userId"' | wc -l | tr -d ' ')"

echo "5. B rejoins, then A kicks B — the kicked member's own stream sees it"
curl -s -m 8 -o /dev/null -X POST "$BASE/parties/join" -H "Authorization: Bearer $B" \
    -H 'Content-Type: application/json' -d "{\"inviteCode\":\"$CODE\"}"
B_STREAM="$WORK/stream-b.txt"
curl -sN -m 15 "$BASE/parties/@me/events" \
    -H "Authorization: Bearer $B" -H 'Accept: text/event-stream' \
    > "$B_STREAM" 2> /dev/null &
B_PID=$!
for _ in $(seq 1 40); do
    [ "$(count_events "$B_STREAM")" -ge 1 ] && break
    sleep 0.25
done
check "B's stream opened with a snapshot" "1" "$(count_events "$B_STREAM")"

B_ID=$(data_line "$B_STREAM" 1 | sed -n 's/.*"viewerId":"\([^"]*\)".*/\1/p')
curl -s -m 8 -o /dev/null -X POST "$BASE/parties/kick" -H "Authorization: Bearer $A" \
    -H 'Content-Type: application/json' -d "{\"userId\":\"$B_ID\"}"
for _ in $(seq 1 40); do
    [ "$(count_events "$B_STREAM")" -ge 2 ] && break
    sleep 0.25
done
check "kick pushed a live event to B" "2" "$(count_events "$B_STREAM")"
check "B is told the party is null" "yes" \
    "$(data_line "$B_STREAM" 2 | grep -q '"party":null' && echo yes || echo no)"
kill "$B_PID" 2> /dev/null

echo "6. teardown — the server must not leak listeners per connection"
# Open and immediately abandon a batch of streams. If teardown leaked, the
# process would keep the listeners and the run below would degrade; the real
# assertion is that the server still serves a fresh stream correctly after.
for _ in $(seq 1 10); do
    curl -sN -m 1 "$BASE/parties/@me/events" -H "Authorization: Bearer $A" \
        > /dev/null 2>&1 &
done
wait_pids=$(jobs -p)
sleep 2
for p in $wait_pids; do kill "$p" 2> /dev/null; done

AFTER="$WORK/after.txt"
curl -sN -m 6 "$BASE/parties/@me/events" -H "Authorization: Bearer $A" \
    > "$AFTER" 2> /dev/null &
AFTER_PID=$!
for _ in $(seq 1 40); do
    [ "$(count_events "$AFTER")" -ge 1 ] && break
    sleep 0.25
done
check "stream still works after 10 abandoned connections" "1" "$(count_events "$AFTER")"

# One publish must reach this stream exactly once — a leaked listener from the
# abandoned connections would show up as duplicate frames.
curl -s -m 8 -o /dev/null -X POST "$BASE/parties/join" -H "Authorization: Bearer $B" \
    -H 'Content-Type: application/json' -d "{\"inviteCode\":\"$CODE\"}"
for _ in $(seq 1 40); do
    [ "$(count_events "$AFTER")" -ge 2 ] && break
    sleep 0.25
done
check "one join produced exactly one event, not duplicates" "2" "$(count_events "$AFTER")"
kill "$AFTER_PID" 2> /dev/null

echo "7. an idle stream stays open rather than being closed by the server"
# The heartbeat interval is 25s, longer than this script should run, so waiting
# for a ': keepalive' line would only pad the runtime. What is checked instead
# is the property the heartbeat exists to preserve: after sitting idle the
# stream is still connected and still delivering, and the server never sent a
# terminating frame.
IDLE="$WORK/idle.txt"
curl -sN -m 12 "$BASE/parties/@me/events" -H "Authorization: Bearer $A" \
    > "$IDLE" 2> /dev/null &
IDLE_PID=$!
for _ in $(seq 1 40); do
    [ "$(count_events "$IDLE")" -ge 1 ] && break
    sleep 0.25
done
sleep 3
check "idle stream is still connected after 3s" "yes" \
    "$(kill -0 "$IDLE_PID" 2> /dev/null && echo yes || echo no)"
curl -s -m 8 -o /dev/null -X POST "$BASE/parties/leave" -H "Authorization: Bearer $B"
for _ in $(seq 1 40); do
    [ "$(count_events "$IDLE")" -ge 2 ] && break
    sleep 0.25
done
check "idle stream still delivers after sitting quiet" "2" "$(count_events "$IDLE")"
kill "$IDLE_PID" 2> /dev/null

# Leave the users clean for the next run.
curl -s -m 8 -o /dev/null -X POST "$BASE/parties/leave" -H "Authorization: Bearer $B"
curl -s -m 8 -o /dev/null -X POST "$BASE/parties/leave" -H "Authorization: Bearer $A"

echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
