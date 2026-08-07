#!/usr/bin/env bash
# End-to-end check of POST /custom_tribes against a running backend.
#
# The game server calls this once per public game with bots, at prestart, with
# a 1.5s timeout inside a 2s prestart->start window (src/server/CustomTribes.ts).
# What matters is not merely that it answers 200, but that its body survives
# the game's OWN CustomTribesResponseSchema — a response the game cannot parse
# is worse than a 404, because both cost the game its tribe pool while only one
# of them looks like it worked.
#
# Section 5 therefore does not eyeball the JSON: it runs the game's real parser
# over the real HTTP response.
#
# Usage: bash scripts/smoke-custom-tribes.sh [base-url]
#
# Requires the backend to be up. No database rows are created or destroyed —
# this endpoint is read-only (and, today, does not touch the database at all).
set -uo pipefail

BASE="${1:-http://localhost:8787}"
API_KEY="${API_KEY:-WARNING_DEV_API_KEY_DO_NOT_USE_IN_PRODUCTION}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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

# tribes <body> [extra curl args...] -> "<body>\n<status>"
tribes() {
    local body="$1"
    shift
    curl -s -m 8 -w '\n%{http_code}' -X POST "$BASE/custom_tribes" \
        -H 'Content-Type: application/json' "$@" -d "$body"
}

status_of() { printf '%s' "$1" | tail -n1; }
body_of() { printf '%s' "$1" | sed '$d'; }

PLAYERS='{"players":[{"clientId":"client-1","publicId":"public-1"},{"clientId":"client-2","publicId":"public-2"}]}'

if [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$BASE/health")" != "200" ]; then
    echo "backend is not answering on $BASE — start it first"
    exit 1
fi

echo "1. the happy path: a normal prestart call"
R=$(tribes "$PLAYERS" -H "x-api-key: $API_KEY")
check "returns 200" "200" "$(status_of "$R")"
contains "carries a tribes array" '"tribes"' "$(body_of "$R")"
# Empty is the honest answer today: no tribe names have been purchased,
# because there is no purchase flow. See services/customTribes.ts.
contains "the pool is empty (nothing has been purchased)" '"tribes":[]' "$(body_of "$R")"

echo
echo "2. the api key is required"
R=$(tribes "$PLAYERS")
check "missing key is rejected" "401" "$(status_of "$R")"
R=$(tribes "$PLAYERS" -H "x-api-key: wrong-key")
check "wrong key is rejected" "401" "$(status_of "$R")"
# A 401 must not leak a parseable-looking body — the game would still fail,
# but a caller reading the body should see an error, not an empty pool.
contains "says unauthorized rather than serving a pool" 'Unauthorized' "$(body_of "$R")"

echo
echo "3. ordinary lobbies that are not the happy path"
R=$(tribes '{"players":[]}' -H "x-api-key: $API_KEY")
check "an all-guest lobby (empty players) is fine" "200" "$(status_of "$R")"
R=$(tribes '{}' -H "x-api-key: $API_KEY")
check "a body with no players key is fine" "200" "$(status_of "$R")"
R=$(tribes '{"players":null}' -H "x-api-key: $API_KEY")
check "a null players list is fine" "200" "$(status_of "$R")"
# The game sends {clientId, publicId}; extra fields must not be a 400, so a
# future game-side addition cannot break the pool for an older backend.
R=$(tribes '{"players":[{"clientId":"c","publicId":"p","futureField":1}]}' \
    -H "x-api-key: $API_KEY")
check "unknown per-player fields pass through" "200" "$(status_of "$R")"

echo
echo "4. a malformed body never 500s"
R=$(tribes '{"players":' -H "x-api-key: $API_KEY")
check "unparseable JSON" "400" "$(status_of "$R")"
R=$(tribes '{"players":"nope"}' -H "x-api-key: $API_KEY")
check "players of the wrong type" "400" "$(status_of "$R")"
R=$(tribes '{"players":[{"clientId":1,"publicId":2}]}' -H "x-api-key: $API_KEY")
check "player fields of the wrong type" "400" "$(status_of "$R")"
R=$(tribes '[1,2,3]' -H "x-api-key: $API_KEY")
check "JSON array instead of an object" "400" "$(status_of "$R")"
# The game slices to 500 before sending, so more than that is not the game.
R=$(node -e '
  const players = Array.from({length: 501}, (_, i) => ({clientId:"c"+i, publicId:"p"+i}));
  process.stdout.write(JSON.stringify({players}));
' | curl -s -m 8 -o /dev/null -w '%{http_code}' -X POST "$BASE/custom_tribes" \
    -H 'Content-Type: application/json' -H "x-api-key: $API_KEY" -d @-)
check "more players than the game would ever send" "400" "$R"

echo
echo "5. the game server's OWN parser accepts what we return"
# This is the point of the whole script. Rather than pattern-matching the JSON,
# run the real CustomTribesResponseSchema from src/server/CustomTribes.ts over
# the real response. It is not exported, so it is rebuilt here from the game's
# exported TribeSchema — the same one line the game uses.
PARSE_OUT=$(cd "$REPO_ROOT" && BASE="$BASE" API_KEY="$API_KEY" npx tsx -e '
import { z } from "zod";
import { TribeSchema } from "../src/core/Schemas.ts";

// Identical to CustomTribesResponseSchema in src/server/CustomTribes.ts.
const CustomTribesResponseSchema = z.object({
  tribes: TribeSchema.array().max(100),
});

// Wrapped in an async IIFE: `tsx -e` compiles to CJS, which rejects
// top-level await outright.
void (async () => {
  const res = await fetch(`${process.env.BASE}/custom_tribes`, {
    method: "POST",
    signal: AbortSignal.timeout(1500), // the games own budget
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.API_KEY!,
    },
    body: JSON.stringify({
      players: [{ clientId: "client-1", publicId: "public-1" }],
    }),
  });
  if (!res.ok) {
    console.log(`PARSE_FAIL non-200: ${res.status}`);
    return;
  }
  const parsed = CustomTribesResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    console.log(`PARSE_FAIL malformed: ${parsed.error.message}`);
    return;
  }
  console.log(`PARSE_OK tribes=${parsed.data.tribes.length}`);
})();
' 2>&1 | tail -n1)
contains "the game parses the response without throwing" "PARSE_OK" "$PARSE_OUT"

echo
echo "6. it answers inside the prestart budget"
# The game aborts at 1.5s and must still have time to start the game.
ELAPSED=$(curl -s -m 8 -o /dev/null -w '%{time_total}' -X POST "$BASE/custom_tribes" \
    -H 'Content-Type: application/json' -H "x-api-key: $API_KEY" -d "$PLAYERS")
if awk "BEGIN{exit !($ELAPSED < 1.5)}"; then
    echo "  ok   answers within the game's 1.5s timeout (${ELAPSED}s)"
    pass=$((pass + 1))
else
    echo "  FAIL took ${ELAPSED}s — the game would have aborted"
    fail=$((fail + 1))
fi

echo
echo "-------------------------------------"
echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ] || exit 1
