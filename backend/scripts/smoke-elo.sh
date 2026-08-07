#!/usr/bin/env bash
# End-to-end check of ranked rating against a running backend.
#
# Proves the whole path: POST a real ranked GameRecord to /game/:id, then read
# GET /leaderboard/ranked and show the ratings actually moved, in the right
# direction, by the amount the maths says. Then re-POST the identical record and
# show they did NOT move again — the idempotency guarantee, checked against a
# real database rather than asserted in a unit test.
#
# Usage: bash scripts/smoke-elo.sh [base-url]
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

PSQL="docker compose exec -T postgres psql -qtAX -U openfront -d openfront -c"

# Four accounts with fixed uuids so the script is re-runnable. Their ladder rows
# are deleted below, so every run starts from the unrated default of 1000.
U1="11111111-1111-4111-8111-111111111111"
U2="22222222-2222-4222-8222-222222222222"
U3="33333333-3333-4333-8333-333333333333"
U4="44444444-4444-4444-8444-444444444444"

for pair in "$U1:elo-smoke-1" "$U2:elo-smoke-2" "$U3:elo-smoke-3" "$U4:elo-smoke-4"; do
    uid="${pair%%:*}"
    pid="${pair##*:}"
    $PSQL "insert into users (id, public_id) values ('$uid', '$pid')
           on conflict (id) do nothing" > /dev/null 2>&1
done
# Start from a clean ladder: the assertions below are on absolute ratings.
$PSQL "delete from leaderboard_entries where user_id in ('$U1','$U2','$U3','$U4')" > /dev/null 2>&1

# Builds a ranked record. The fixture is an unranked public FFA, so the ranked
# fields are set here — rankedType is what the guard keys on, and it is the only
# thing that makes the backend rate a match at all.
#
# build_record <game-id> <ranked-type> <mode-json>
#   mode-json: a JSON array of {u,team,won} describing the players.
build_record() {
    npx tsx -e "
import { buildGameRecord } from './src/services/gameRecordFixture.ts';
import { replacer } from '@game/Util.ts';
const gameID = process.argv[1];
const rankedType = process.argv[2];
const spec = JSON.parse(process.argv[3]);
const base = buildGameRecord({ gameID });
const ids = ['aBcD1234','eFgH5678','iJkL9012','mNoP3456'];
const players = spec.map((p, i) => ({
  clientID: ids[i],
  username: 'Elo' + (i + 1),
  clanTag: null,
  persistentID: p.u,
  ...(p.team === null ? {} : { teamIndex: p.team }),
  stats: { attacks: [1n], gold: [100n] },
}));
const winners = spec
  .map((p, i) => (p.won ? ids[i] : null))
  .filter((id) => id !== null);
const record = {
  ...base,
  info: {
    ...base.info,
    config: { ...base.info.config, rankedType: rankedType || undefined },
    players,
    // FFA reports a single winning player; a team game reports the team and
    // every clientID on it. Both shapes are what winningClientIds() reads.
    winner: spec.some((p) => p.team !== null)
      ? ['team', String(spec.find((p) => p.won).team), ...winners]
      : ['player', winners[0]],
  },
  turns: [{ turnNumber: 0, intents: [], hash: 1 }],
};
process.stdout.write(JSON.stringify(record, replacer));
" "$1" "$2" "$3" 2> /dev/null
}

post() { # post <game-id> <body-file>
    curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "$BASE/game/$1" \
        -H 'Content-Type: application/json' -H "x-api-key: $KEY" \
        --data-binary "@$2"
}

# Reads one player's row straight off the public leaderboard response, so the
# assertions are on what a player actually sees rather than on the table.
# board <mode> <public-id> <field>
board() {
    curl -s -m 20 "$BASE/leaderboard/ranked?page=1" | npx tsx -e "
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  const body = JSON.parse(raw);
  const row = (body[process.argv[1]] ?? []).find(
    (e) => e.public_id === process.argv[2],
  );
  process.stdout.write(row ? String(row[process.argv[3]]) : 'absent');
});
" "$1" "$2" "$3" 2> /dev/null
}

BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT

echo "0. the ladder starts empty for these accounts"
check "no 1v1 row yet" "absent" "$(board '1v1' 'elo-smoke-1' elo)"

# ---------------------------------------------------------------------------
echo
echo "1. a RANKED 1v1 moves both ratings, zero-sum"
# Both players are unrated, so both are at 1000 and the match is even: the
# winner must gain exactly K/2 = 16 and the loser must lose exactly 16.
G1="Elo$(printf '%05d' $((RANDOM % 100000)))"
build_record "$G1" "1v1" "[{\"u\":\"$U1\",\"team\":null,\"won\":true},{\"u\":\"$U2\",\"team\":null,\"won\":false}]" > "$BODY"
[ -s "$BODY" ] || {
    echo "could not build the ranked 1v1 record"
    exit 1
}
check "archived" "201" "$(post "$G1" "$BODY")"

check "winner gained 16 (even match, K=32)" "1016" "$(board '1v1' 'elo-smoke-1' elo)"
check "loser lost 16" "984" "$(board '1v1' 'elo-smoke-2' elo)"
check "winner's win counted" "1" "$(board '1v1' 'elo-smoke-1' wins)"
check "winner has no loss" "0" "$(board '1v1' 'elo-smoke-1' losses)"
check "loser's loss counted" "1" "$(board '1v1' 'elo-smoke-2' losses)"
check "loser has no win" "0" "$(board '1v1' 'elo-smoke-2' wins)"
SUM=$($PSQL "select sum(elo) from leaderboard_entries where mode='1v1' and user_id in ('$U1','$U2')" 2> /dev/null | tr -d ' \r')
check "zero-sum: the pair still totals 2000" "2000" "$SUM"

# ---------------------------------------------------------------------------
echo
echo "2. re-POSTing the SAME match does not move the ratings again"
check "second write accepted (upsert, not a conflict)" "200" "$(post "$G1" "$BODY")"
check "winner unchanged after re-archive" "1016" "$(board '1v1' 'elo-smoke-1' elo)"
check "loser unchanged after re-archive" "984" "$(board '1v1' 'elo-smoke-2' elo)"
check "wins not double-counted" "1" "$(board '1v1' 'elo-smoke-1' wins)"
check "losses not double-counted" "1" "$(board '1v1' 'elo-smoke-2' losses)"

echo "   ...and a third delivery is still a no-op"
post "$G1" "$BODY" > /dev/null
check "still 1016 after three archives" "1016" "$(board '1v1' 'elo-smoke-1' elo)"
check "still exactly one win" "1" "$(board '1v1' 'elo-smoke-1' wins)"

# ---------------------------------------------------------------------------
echo
echo "3. an UNRANKED match moves nothing"
# The identical player set, the identical result — only rankedType is absent.
# Nothing on the ladder may change, counters included.
G2="Elo$(printf '%05d' $((RANDOM % 100000)))"
build_record "$G2" "" "[{\"u\":\"$U1\",\"team\":null,\"won\":true},{\"u\":\"$U2\",\"team\":null,\"won\":false}]" > "$BODY"
check "unranked game archived fine" "201" "$(post "$G2" "$BODY")"
check "winner's rating untouched" "1016" "$(board '1v1' 'elo-smoke-1' elo)"
check "loser's rating untouched" "984" "$(board '1v1' 'elo-smoke-2' elo)"
check "no extra win recorded" "1" "$(board '1v1' 'elo-smoke-1' wins)"
check "no extra loss recorded" "1" "$(board '1v1' 'elo-smoke-2' losses)"
RANKED_NULL=$($PSQL "select ranked_type is null from games where id='$G2'" 2> /dev/null | tr -d ' \r')
check "the archived row really is unranked" "t" "$RANKED_NULL"

# ---------------------------------------------------------------------------
echo
echo "4. a GUEST opponent cannot break the rated player"
# u3 (an account) beats a guest with no account. There is no rateable opponent,
# so nothing may be written — a free win against nobody is not a rating.
G3="Elo$(printf '%05d' $((RANDOM % 100000)))"
build_record "$G3" "1v1" "[{\"u\":\"$U3\",\"team\":null,\"won\":true},{\"u\":null,\"team\":null,\"won\":false}]" > "$BODY"
check "archived" "201" "$(post "$G3" "$BODY")"
check "no ladder row invented for a match with no opponent" "absent" "$(board '1v1' 'elo-smoke-3' elo)"
GUESTROWS=$($PSQL "select count(*) from game_participants where game_id='$G3' and user_id is null" 2> /dev/null | tr -d ' \r')
check "the guest was still archived as a participant" "1" "$GUESTROWS"

# A guest alongside two real accounts: the accounts rate normally, as though the
# guest were not in the lobby.
G4="Elo$(printf '%05d' $((RANDOM % 100000)))"
build_record "$G4" "2v2" "[{\"u\":\"$U3\",\"team\":0,\"won\":true},{\"u\":null,\"team\":0,\"won\":true},{\"u\":\"$U4\",\"team\":1,\"won\":false},{\"u\":null,\"team\":1,\"won\":false}]" > "$BODY"
check "archived" "201" "$(post "$G4" "$BODY")"
# Both accounts unrated at 1000, one opponent each: a plain even exchange.
check "the account that won gained 16 despite the guests" "1016" "$(board '2v2' 'elo-smoke-3' elo)"
check "the account that lost dropped 16" "984" "$(board '2v2' 'elo-smoke-4' elo)"
SUM2=$($PSQL "select sum(elo) from leaderboard_entries where mode='2v2' and user_id in ('$U3','$U4')" 2> /dev/null | tr -d ' \r')
check "still zero-sum with guests present" "2000" "$SUM2"

# ---------------------------------------------------------------------------
echo
echo "5. the ladders are separate — a 2v2 result stays out of the 1v1 board"
check "u3 has no 1v1 rating" "absent" "$(board '1v1' 'elo-smoke-3' elo)"
check "u1 has no 2v2 rating" "absent" "$(board '2v2' 'elo-smoke-1' elo)"

# ---------------------------------------------------------------------------
echo
echo "6. an upset pays more than the expected result"
# u2 sits at 984 and u1 at 1016 after step 1. u2 (the underdog) beating u1 must
# be worth more than the 16 an even match paid.
G5="Elo$(printf '%05d' $((RANDOM % 100000)))"
build_record "$G5" "1v1" "[{\"u\":\"$U2\",\"team\":null,\"won\":true},{\"u\":\"$U1\",\"team\":null,\"won\":false}]" > "$BODY"
check "archived" "201" "$(post "$G5" "$BODY")"
NEW2=$(board '1v1' 'elo-smoke-2' elo)
GAIN=$((NEW2 - 984))
check "the underdog gained more than the even-match 16" "yes" \
    "$([ "$GAIN" -gt 16 ] && echo yes || echo no)"
echo "     (underdog at 984 beat 1016 and gained $GAIN)"
SUM3=$($PSQL "select sum(elo) from leaderboard_entries where mode='1v1' and user_id in ('$U1','$U2')" 2> /dev/null | tr -d ' \r')
check "still zero-sum after the upset" "2000" "$SUM3"
check "the winner is now ahead on the board" "yes" \
    "$([ "$NEW2" -gt "$(board '1v1' 'elo-smoke-1' elo)" ] && echo yes || echo no)"

# ---------------------------------------------------------------------------
echo
echo "7. SIMULTANEOUS duplicate archives still rate the match exactly once"
# The case sequential re-POSTs do not cover, and the one that actually broke:
# on a first archive there are no participant rows yet, so a SELECT ... FOR
# UPDATE locks nothing and every concurrent archive reads "not yet rated". Six
# racing deliveries rated the match six times (winner on 1077 with six wins)
# until the advisory lock was added. This is the regression test for that.
U5="55555555-5555-4555-8555-555555555555"
U6="66666666-6666-4666-8666-666666666666"
$PSQL "insert into users (id, public_id) values ('$U5','elo-smoke-5'),('$U6','elo-smoke-6')
       on conflict (id) do nothing" > /dev/null 2>&1
$PSQL "delete from leaderboard_entries where user_id in ('$U5','$U6')" > /dev/null 2>&1

G6="Elo$(printf '%05d' $((RANDOM % 100000)))"
build_record "$G6" "1v1" "[{\"u\":\"$U5\",\"team\":null,\"won\":true},{\"u\":\"$U6\",\"team\":null,\"won\":false}]" > "$BODY"
for _ in 1 2 3 4 5 6; do post "$G6" "$BODY" > /dev/null & done
wait 2> /dev/null

check "winner rated once, not six times" "1016" "$(board '1v1' 'elo-smoke-5' elo)"
check "loser rated once, not six times" "984" "$(board '1v1' 'elo-smoke-6' elo)"
check "exactly one win despite six deliveries" "1" "$(board '1v1' 'elo-smoke-5' wins)"
check "exactly one loss despite six deliveries" "1" "$(board '1v1' 'elo-smoke-6' losses)"

echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
