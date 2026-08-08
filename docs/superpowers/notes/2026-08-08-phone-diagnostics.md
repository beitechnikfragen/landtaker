# Phone diagnostics — temporary instrumentation

Status: instrumentation-only, no control-flow changes. `npx tsc --noEmit` and
`npx eslint` clean on all touched files.

## Log points added (all prefixed `[phone]`, `console.log`)

- `src/client/phone/PhoneController.ts`
  - `receive()`: logs every inbound payload kind; `callState` also logs
    `peers.length` and the full peers array; `ringing`/`missed` log `from`.
  - `dial()`, `answer()`, `hangup()`: log the action and its target (dial).
  - `send()` (private helper used by all outbound calls): logs every
    outbound payload kind before handing off to `transport.sendPhone()`.
- `src/client/phone/PhoneTransport.ts`
  - Constructor: logs `myId` once.
  - `syncPeers()`: logs incoming `peers` + current `this.peers` keys on
    entry; logs explicitly when it takes the `peers.length === 0` early
    return (prime suspect — this path stops before any peer connection is
    ever created).
  - `createPeer()`: logs that an `RTCPeerConnection` is being constructed,
    for which id.
  - `makeOffer()`: logs the target id, `myId`, and the `myId < id` result.
  - `handleSignal()`: logs inbound signal `type`, `from`, and payload length
    (never the SDP/ICE body).
  - `ensureMic()`: logs start, success (with `getAudioTracks().length`), and
    denial.
- `src/client/ClientGameRunner.ts`
  - Where `message.type === "phone"` is dispatched: logs `payload.kind` and
    whether a `PhoneController` exists to receive it.
  - Where `PhoneController` is constructed: logs the `clientID`; logs an
    explicit line when construction is skipped because `clientID` is
    `undefined`.
- `src/server/GameServer.ts`
  - `case "phone":` handler: logs inbound `clientID` and `payload.kind`.
  - `deliverPhone()`: logs every outbound item's `to` and `payload.kind`,
    and logs explicitly (with reason) when a target is skipped because it's
    missing from `allClients` or its socket isn't `OPEN` — that skip was
    silent before this change.

No SDP/ICE bodies are logged anywhere, only kinds/types and, where useful,
payload/track lengths.

## Suspicious things noticed (not fixed)

- `deliverPhone()` silently drops a message when the target is missing from
  `allClients` or its socket isn't `WebSocket.OPEN` — no log, no retry, no
  feedback to the sender. If the callee's socket flaps around call setup
  (e.g. a reconnect cycle), the `callState`/`signal` payload that should
  arrive at the client is just gone. This is now logged, not fixed.
- `PhoneTransport.myId` is only ever compared with `<`/`>=` against another
  `ClientID` (`this.myId < id`). If `ClientID` values are ever non-string or
  inconsistently typed/formatted between client and server, that comparison
  could silently pick the wrong offerer on both sides (or neither), which
  would look exactly like "callState arrives but nothing connects." Worth
  checking once real logs come back with actual `myId`/`id` values.

## Reproduction instructions for the user

1. Open the live site in Chrome, open DevTools Console, and clear it.
2. Start (or join) a game with a second player/tab so a call can be placed.
3. Place one phone call, let it ring, answer it, and let the "connect"
   attempt run for a few seconds (long enough to see it fail as before).
4. Hang up.
5. In the DevTools Console, filter by `[phone]` and copy every line, in
   order, from both the caller and the callee browser tab (both sides
   matter — the break may be one-directional). Send us that combined,
   ordered log.
