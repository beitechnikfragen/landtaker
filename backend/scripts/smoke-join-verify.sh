#!/usr/bin/env bash
# End-to-end check of POST /join_verify against a running backend.
#
# This endpoint is called by the game server for EVERY player joining a match
# (src/server/JoinVerify.ts). What matters is not just that it answers, but
# that it answers in the exact shape the game's JoinVerifyVerdictSchema can
# parse — a body the game cannot read is worse than a 404, because the game
# treats both as a hard failure at the moment someone is trying to play.
#
# Usage: bash scripts/smoke-join-verify.sh [base-url]
#
# Requires the backend, Postgres and Redis to be up (docker compose up -d).
# Creates a throwaway account per run, bans it via a direct INSERT into the
# `bans` table, and cleans it up at the end.
set -uo pipefail

BASE="${1:-http://localhost:8787}"
API_KEY="${API_KEY:-WARNING_DEV_API_KEY_DO_NOT_USE_IN_PRODUCTION}"
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

contains() { # contains <label> <needle> <haystack>
    case "$3" in
        *"$2"*)
            echo "  ok   $1"
            pass=$((pass + 1))
            ;;
        *)
            echo "  FAIL $1 — '$2' not found in: $3"
            fail=$((fail + 1))
            ;;
    esac
}

not_contains() { # not_contains <label> <needle> <haystack>
    case "$3" in
        *"$2"*)
            echo "  FAIL $1 — unexpected '$2' in: $3"
            fail=$((fail + 1))
            ;;
        *)
            echo "  ok   $1"
            pass=$((pass + 1))
            ;;
    esac
}

psql_run() { # psql_run <sql>
    docker compose exec -T postgres psql -U openfront -d openfront -tAc "$1"
}

# verify <body> [api-key-header-args...] -> "<status>\n<body>"
verify() {
    local body="$1"
    shift
    curl -s -m 8 -w '\n%{http_code}' -X POST "$BASE/join_verify" \
        -H 'Content-Type: application/json' "$@" -d "$body"
}

status_of() { printf '%s' "$1" | tail -n1; }
body_of() { printf '%s' "$1" | sed '$d'; }

RUN=$$
CLEAN_NAME="Clean$RUN"
BANNED_NAME="Banned$RUN"

echo "setup: creating a clean account and a banned account"
CLEAN_TOKEN=$(curl -s -m 8 -X POST "$BASE/auth/dev-login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$CLEAN_NAME\"}" \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
BANNED_TOKEN=$(curl -s -m 8 -X POST "$BASE/auth/dev-login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$BANNED_NAME\"}" \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')

if [ -z "$CLEAN_TOKEN" ] || [ -z "$BANNED_TOKEN" ]; then
    echo "could not obtain dev tokens — is the backend running on $BASE?"
    exit 1
fi

# The game sends the DISPLAY name (base.discriminator), which is what the
# endpoint keys its ban lookup on. Read it back rather than assuming.
display_name() { # display_name <token>
    curl -s -m 8 "$BASE/users/@me" -H "Authorization: Bearer $1" \
        | sed -n 's/.*"username":"\([^"]*\)".*/\1/p'
}
CLEAN_DISPLAY=$(display_name "$CLEAN_TOKEN")
BANNED_DISPLAY=$(display_name "$BANNED_TOKEN")
echo "  clean player:  $CLEAN_DISPLAY"
echo "  banned player: $BANNED_DISPLAY"

BANNED_BASE="${BANNED_DISPLAY%%.*}"
psql_run "INSERT INTO bans (user_id, category, reason)
          SELECT id, 'cheating', 'smoke test ban'
          FROM users WHERE username_base = '$BANNED_BASE';" > /dev/null

cleanup() {
    psql_run "DELETE FROM bans WHERE user_id IN
              (SELECT id FROM users WHERE username_base = '$BANNED_BASE');" > /dev/null 2>&1
}
trap cleanup EXIT

echo
echo "1. a normal player is allowed"
R=$(verify "{\"ip\":\"203.0.113.7\",\"token\":\"dummy-turnstile-token\",\"username\":\"$CLEAN_DISPLAY\",\"clanTag\":\"abc\"}" \
    -H "x-api-key: $API_KEY")
check "returns 200" "200" "$(status_of "$R")"
contains "approves the join" '"status":"approved"' "$(body_of "$R")"
contains "echoes the username back" "\"username\":\"$CLEAN_DISPLAY\"" "$(body_of "$R")"
contains "uppercases the clan tag" '"clanTag":"ABC"' "$(body_of "$R")"

echo
echo "1b. a re-admit (null token) is allowed — its single-use token is spent"
R=$(verify "{\"ip\":\"203.0.113.7\",\"token\":null,\"username\":\"$CLEAN_DISPLAY\",\"clanTag\":null}" \
    -H "x-api-key: $API_KEY")
check "returns 200" "200" "$(status_of "$R")"
contains "approves the join" '"status":"approved"' "$(body_of "$R")"

echo
echo "1c. an unknown (signed-out) name is allowed — not ban-checkable, not refused"
R=$(verify "{\"ip\":\"203.0.113.7\",\"token\":\"t\",\"username\":\"NoSuchPlayer$RUN\",\"clanTag\":null}" \
    -H "x-api-key: $API_KEY")
check "returns 200" "200" "$(status_of "$R")"
contains "approves the join" '"status":"approved"' "$(body_of "$R")"

echo
echo "2. a banned player is refused, in the shape the game expects"
R=$(verify "{\"ip\":\"203.0.113.7\",\"token\":\"dummy-turnstile-token\",\"username\":\"$BANNED_DISPLAY\",\"clanTag\":null}" \
    -H "x-api-key: $API_KEY")
check "returns 200 (a rejection is a verdict, not an HTTP error)" "200" "$(status_of "$R")"
contains "rejects the join" '"status":"rejected"' "$(body_of "$R")"
contains "carries a reason, as the schema requires" '"reason":' "$(body_of "$R")"
contains "names the ban category" 'cheating' "$(body_of "$R")"
not_contains "does not leak the internal user id" '-' "$(body_of "$R" | sed 's/[^"]*"reason":"\([^"]*\)".*/\1/;s/banned: //')"

echo
echo "2b. a lifted ban no longer refuses the player"
psql_run "UPDATE bans SET lifted_at = now() WHERE user_id IN
          (SELECT id FROM users WHERE username_base = '$BANNED_BASE');" > /dev/null
R=$(verify "{\"ip\":\"203.0.113.7\",\"token\":\"t\",\"username\":\"$BANNED_DISPLAY\",\"clanTag\":null}" \
    -H "x-api-key: $API_KEY")
contains "approves after the ban is lifted" '"status":"approved"' "$(body_of "$R")"
psql_run "UPDATE bans SET lifted_at = NULL WHERE user_id IN
          (SELECT id FROM users WHERE username_base = '$BANNED_BASE');" > /dev/null

echo
echo "2c. an expired ban no longer refuses the player"
psql_run "UPDATE bans SET expires_at = now() - interval '1 hour' WHERE user_id IN
          (SELECT id FROM users WHERE username_base = '$BANNED_BASE');" > /dev/null
R=$(verify "{\"ip\":\"203.0.113.7\",\"token\":\"t\",\"username\":\"$BANNED_DISPLAY\",\"clanTag\":null}" \
    -H "x-api-key: $API_KEY")
contains "approves after the ban expires" '"status":"approved"' "$(body_of "$R")"

echo
echo "3. the api key is required"
R=$(verify "{\"ip\":\"203.0.113.7\",\"token\":\"t\",\"username\":\"$CLEAN_DISPLAY\",\"clanTag\":null}")
check "missing key is rejected" "401" "$(status_of "$R")"
R=$(verify "{\"ip\":\"203.0.113.7\",\"token\":\"t\",\"username\":\"$CLEAN_DISPLAY\",\"clanTag\":null}" \
    -H "x-api-key: wrong-key")
check "wrong key is rejected" "401" "$(status_of "$R")"

echo
echo "4. a malformed body never 500s"
R=$(verify '{"username":' -H "x-api-key: $API_KEY")
check "unparseable JSON" "400" "$(status_of "$R")"
R=$(verify '{}' -H "x-api-key: $API_KEY")
check "empty object (no username)" "400" "$(status_of "$R")"
R=$(verify '{"username":123}' -H "x-api-key: $API_KEY")
check "username of the wrong type" "400" "$(status_of "$R")"
R=$(verify '{"username":""}' -H "x-api-key: $API_KEY")
check "empty username" "400" "$(status_of "$R")"
R=$(verify "{\"username\":\"$(printf 'x%.0s' $(seq 1 500))\"}" -H "x-api-key: $API_KEY")
check "absurdly long username" "400" "$(status_of "$R")"
R=$(verify '[1,2,3]' -H "x-api-key: $API_KEY")
check "JSON array instead of an object" "400" "$(status_of "$R")"
R=$(verify "{\"username\":\"$CLEAN_DISPLAY\"}" -H "x-api-key: $API_KEY")
check "missing optional fields is fine, not a 400" "200" "$(status_of "$R")"

echo
echo "5. fail-open: a dead database must not stop anyone from playing"
# Tested by booting a SECOND backend pointed at a port nothing listens on,
# rather than by stopping the postgres container.
#
# Two reasons. First, stopping the shared container would break every other
# thing using this database mid-run. Second, and more importantly, it does not
# test what it looks like it tests: `pg.Pool` in src/db/index.ts has no
# 'error' listener, so a Postgres shutdown emits an unhandled 'error' event
# and kills the WHOLE backend process. The request then fails with a
# connection refused, not with our fail-open — the handler cannot run because
# there is no process left to run it. (That is a pre-existing bug in
# src/db/index.ts, not in this endpoint; it needs a `pool.on("error", ...)`
# the way redis.ts already has one.)
#
# An unreachable database exercises the path this endpoint actually owns: the
# query fails or times out, and we approve anyway.
if [ "${SKIP_FAILOPEN:-0}" = "1" ]; then
    echo "  skipped (SKIP_FAILOPEN=1)"
else
    DEAD_PORT=8793
    DATABASE_URL="postgres://openfront:openfront@localhost:5999/openfront" \
        PORT="$DEAD_PORT" setsid nohup npx tsx src/main.ts \
        > /tmp/smoke-join-verify-nodb.log 2>&1 < /dev/null &
    disown 2> /dev/null || true
    for _ in $(seq 1 25); do
        [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' \
            "http://localhost:$DEAD_PORT/health" 2> /dev/null)" = "200" ] && break
        sleep 2
    done

    R=$(curl -s -m 8 -w '\n%{http_code}\n%{time_total}' \
        -X POST "http://localhost:$DEAD_PORT/join_verify" \
        -H 'Content-Type: application/json' -H "x-api-key: $API_KEY" \
        -d "{\"ip\":\"203.0.113.7\",\"token\":\"t\",\"username\":\"$CLEAN_DISPLAY\",\"clanTag\":\"abc\"}")
    ELAPSED=$(printf '%s' "$R" | tail -n1)
    CODE=$(printf '%s' "$R" | tail -n2 | head -n1)
    BODY=$(printf '%s' "$R" | sed '$d' | sed '$d')

    check "still returns 200 with the database unreachable" "200" "$CODE"
    contains "approves rather than locking the player out" '"status":"approved"' "$BODY"
    # The game aborts at 5s. Answering after that is the same as not answering.
    if [ "${ELAPSED%%.*}" -lt 5 ] 2> /dev/null; then
        echo "  ok   answers inside the game's 5s budget (${ELAPSED}s)"
        pass=$((pass + 1))
    else
        echo "  FAIL took ${ELAPSED}s — the game would have timed out first"
        fail=$((fail + 1))
    fi

    fuser -k "$DEAD_PORT/tcp" > /dev/null 2>&1 || true
fi

echo
echo "-------------------------------------"
echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ] || exit 1
