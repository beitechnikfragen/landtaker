#!/usr/bin/env bash
# End-to-end check of ranked matchmaking against a running backend + Redis.
#
# Proves the three things that actually matter and that no unit test can:
#   1. two real WebSocket clients in the 1v1 queue both receive the SAME gameID
#   2. a client that disconnects is removed from the queue
#   3. 2v2 forms two teams of two
#
# The WS side is a small inline node script (the `ws` package ships with
# @fastify/websocket, so there is nothing extra to install) driving real
# sockets against the real server — not a mock.
#
# Usage: bash scripts/smoke-matchmaking.sh [base-url]
set -uo pipefail

BASE="${1:-http://localhost:8787}"
WS_BASE="${BASE/http:/ws:}"
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

login() {
    curl -s -m 8 -X POST "$BASE/auth/dev-login" \
        -H 'Content-Type: application/json' \
        -d "{\"username\":\"$1\"}" \
        | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'
}

# The node driver. Takes a mode and a list of tokens, queues one socket per
# token, fires a checkin, and prints a one-line JSON summary.
#
# Timing note: the client waits ~2s after open before sending its join, but
# that delay is the client's own UX choice, not part of the protocol — this
# driver joins immediately, which the server must accept just as well.
run_ws() { # run_ws <mode> <token...>
    MODE="$1"
    shift
    TOKENS="$*" BASE="$BASE" WS_BASE="$WS_BASE" API_KEY="$API_KEY" MODE="$MODE" \
        node --input-type=module -e '
import WebSocket from "ws";

const tokens = process.env.TOKENS.split(" ").filter(Boolean);
const mode = process.env.MODE;
const wsBase = process.env.WS_BASE;

const results = tokens.map(() => ({ queueSizes: [], gameId: null }));

const sockets = tokens.map((token, i) =>
  new Promise((resolve) => {
    const ws = new WebSocket(
      `${wsBase}/matchmaking/join?instance_id=smoke&mode=${mode}`,
    );
    ws.on("open", () => ws.send(JSON.stringify({ type: "join", jwt: token })));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "queue-size") results[i].queueSizes.push(msg.count);
      if (msg.type === "match-assignment") {
        results[i].gameId = msg.gameId;
        ws.close();
        resolve();
      }
    });
    ws.on("close", () => resolve());
    ws.on("error", () => resolve());
    // Give up rather than hang the smoke run.
    setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 25000);
  }),
);

// Let EVERY socket get queued before a worker offers a slot. A checkin that
// arrives while only some players are queued forms no match (or the wrong
// one), so wait for the queue to actually report everyone rather than
// guessing at a delay.
const queued = () =>
  results.filter((r) => r.queueSizes.length > 0).length === tokens.length;
for (let i = 0; i < 60 && !queued(); i++) {
  await new Promise((r) => setTimeout(r, 100));
}
await new Promise((r) => setTimeout(r, 300));

const gameId = `smoke-${mode}-${Date.now()}`;
const checkin = await fetch(`${process.env.BASE}/matchmaking/checkin`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": process.env.API_KEY,
  },
  body: JSON.stringify({
    id: 0,
    gameId,
    ccu: 0,
    instanceId: "smoke",
    mode,
  }),
}).then((r) => r.json());

await Promise.all(sockets);

console.log(JSON.stringify({
  gameId,
  assignment: checkin.assignment ?? null,
  delivered: results.map((r) => r.gameId),
  queueSizes: results.map((r) => r.queueSizes),
}));
'
}

# Fresh accounts per run: dev-login mints a new user each time, so a rerun
# never collides with a queue entry or assignment left by the previous one.
RUN=$$
A=$(login "MmA$RUN")
B=$(login "MmB$RUN")
[ -n "$A" ] && [ -n "$B" ] || {
    echo "could not obtain dev tokens — is the backend running on $BASE?"
    exit 1
}

echo "1. two clients in the 1v1 queue both get the same gameID"
OUT=$(run_ws 1v1 "$A" "$B")
echo "     $OUT"
GAMEID=$(echo "$OUT" | sed -n 's/.*"gameId":"\([^"]*\)".*/\1/p')
DELIVERED=$(echo "$OUT" | sed -n 's/.*"delivered":\[\([^]]*\)\].*/\1/p')
check "both clients received the gameID" "\"$GAMEID\",\"$GAMEID\"" "$DELIVERED"
TEAMS=$(echo "$OUT" | grep -o '"teams":\[\[[^]]*\],\[[^]]*\]\]' | head -1)
check "1v1 produced two teams of one" "1" \
    "$(echo "$TEAMS" | grep -cE '"teams":\[\["[^"]+"\],\["[^"]+"\]\]')"

echo "2. a disconnected client is removed from the queue"
# Queue one client, drop the socket, then let a worker check in. With the
# queue empty the checkin must come back with no assignment — a stale entry
# would instead be matched into a game nobody joins.
G=$(login "MmG$RUN")
H=$(login "MmH$RUN")
DISC=$(TOKEN="$G" TOKEN2="$H" BASE="$BASE" WS_BASE="$WS_BASE" API_KEY="$API_KEY" \
    node --input-type=module -e '
import WebSocket from "ws";
const ws = new WebSocket(
  `${process.env.WS_BASE}/matchmaking/join?instance_id=smoke&mode=1v1`,
);
await new Promise((resolve) => {
  ws.on("open", () =>
    ws.send(JSON.stringify({ type: "join", jwt: process.env.TOKEN })));
  ws.on("message", (raw) => {
    if (JSON.parse(raw.toString()).type === "queue-size") resolve();
  });
  ws.on("error", resolve);
});
// Queued. Now disconnect and give the server a moment to clean up.
ws.close();
await new Promise((r) => setTimeout(r, 1000));

// A DIFFERENT player queues. If the disconnected one had been left behind,
// the queue would now report 2 (and they would be matched into a game the
// departed player never joins); it must report 1.
const ws2 = new WebSocket(
  `${process.env.WS_BASE}/matchmaking/join?instance_id=smoke&mode=1v1`,
);
let size = null;
await new Promise((resolve) => {
  ws2.on("open", () =>
    ws2.send(JSON.stringify({ type: "join", jwt: process.env.TOKEN2 })));
  ws2.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "queue-size") { size = m.count; resolve(); }
  });
  ws2.on("error", resolve);
});
ws2.close();
console.log(JSON.stringify({ queueSizeAfterDisconnect: size }));
')
echo "     $DISC"
check "queue holds only the live client" "1" \
    "$(echo "$DISC" | sed -n 's/.*"queueSizeAfterDisconnect":\([0-9]*\).*/\1/p')"

echo "3. 2v2 forms two teams of two"
C=$(login "MmC$RUN")
D=$(login "MmD$RUN")
E=$(login "MmE$RUN")
F=$(login "MmF$RUN")
OUT2=$(run_ws 2v2 "$C" "$D" "$E" "$F")
echo "     $OUT2"
GAMEID2=$(echo "$OUT2" | sed -n 's/.*"gameId":"\([^"]*\)".*/\1/p')
DELIVERED2=$(echo "$OUT2" | sed -n 's/.*"delivered":\[\([^]]*\)\].*/\1/p')
check "all four clients received the gameID" \
    "\"$GAMEID2\",\"$GAMEID2\",\"$GAMEID2\",\"$GAMEID2\"" "$DELIVERED2"
check "2v2 produced two teams of two" "1" \
    "$(echo "$OUT2" | grep -cE '"teams":\[\["[^"]+","[^"]+"\],\["[^"]+","[^"]+"\]\]')"

echo "4. checkin rejects a caller without the api key"
check "unauthenticated checkin refused" "401" \
    "$(curl -s -m 8 -o /dev/null -w '%{http_code}' -X POST "$BASE/matchmaking/checkin" \
        -H 'Content-Type: application/json' \
        -d '{"id":0,"gameId":"x","ccu":0,"mode":"1v1"}')"

echo "5. checkin with an empty queue returns no assignment"
EMPTY=$(curl -s -m 25 -X POST "$BASE/matchmaking/checkin" \
    -H 'Content-Type: application/json' -H "x-api-key: $API_KEY" \
    -d '{"id":0,"gameId":"smoke-empty","ccu":0,"mode":"1v1"}')
check "no assignment offered" "{}" "$EMPTY"

echo
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ] || exit 1
