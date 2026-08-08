# Phone audio race fix — 2026-08-08

## Environment discrepancy (read first)

The task prompt stated the working directory was the MAIN repo on branch
`claude/telefonsystem-spieler-anrufe-414d07` with a **clean** tree. The
actual working directory was on branch `admin-gift`, with pre-existing
**uncommitted, unrelated** changes to `src/client/hud/layers/AdminCheatMenu.ts`,
`src/core/Schemas.ts`, `src/core/execution/AdminCheatExecution.ts`, and
`resources/lang/en.json` (an in-progress "admin gift" feature — not
something this session created). `npx tsc --noEmit` shows pre-existing
errors in `AdminCheatExecution.ts`/`AdminCheatMenu.ts` from that unrelated
work; none in the phone files.

To stay safe, only `src/client/phone/PhoneTransport.ts` and
`tests/PhoneTransport.test.ts` were staged (`git add <path>` by name, never
`-A`) and committed. The unrelated dirty files were left untouched and
unstaged. `git status --short` after the commit shows only those four
pre-existing unrelated modifications remaining.

## Root cause A — mic arrives after the peer connection is built

Confirmed: `addTrack` was called exactly once, inside `createPeer()`, from
a snapshot of `localStream` at connection-build time. No
`onnegotiationneeded`, `replaceTrack`, or later top-up existed. Worse than
originally scoped: `handleSignal()` and `syncPeers()` both `await
ensureMic()` **before** creating the peer / answering signals, so the
entire handshake — not just the audio — was delayed by the permission
prompt. Fixed by:

- `attachMicToExistingPeers()`: once `ensureMic()` resolves, walks
  `this.peers`, uses `pc.getSenders()` to find connections with no audio
  sender, and calls `addTrack` on them.
- `createPeer()` now wires `pc.onnegotiationneeded`, gated by the existing
  "smaller client id offers" rule (`this.myId < id`) and
  `signalingState === "stable"` to avoid glare. The higher-id side never
  re-offers; instead, when it answers the lower side's renegotiation offer
  via the existing `handleSignal()` path, `createAnswer()` naturally
  reflects its own current senders — so a single one-directional re-offer
  carries audio for both directions once answered.
- `handleSignal()`/`syncPeers()` no longer `await ensureMic()` before
  creating peers/offers/answers — mic acquisition now runs in the
  background (`void this.ensureMic()`), so signaling is never delayed by
  the permission prompt, and `attachMicToExistingPeers()` +
  `onnegotiationneeded` deliver the track whenever it arrives.

## Root cause B — `ensureMic()` had no in-flight guard

Confirmed: no `micPromise`/pending field existed; concurrent callers each
started their own `getUserMedia()`. Fixed by caching the in-flight promise
in `this.micPromise` and having all callers await it. Denial behavior
(`_micDenied` latches, never throws) is unchanged.

## Regression test verified to fail pre-fix

`tests/PhoneTransport.test.ts` was run against the original
`PhoneTransport.ts` (via `git stash` of only that file) before applying the
fix:

- "attaches an outgoing audio track to a peer created before the mic
  resolved (regression)" — **failed** (peer connection wasn't even created
  yet at the assertion point, because the old `handleSignal` blocked on
  `ensureMic()` first — an even more direct manifestation of the bug).
- "concurrent ensureMic callers trigger getUserMedia exactly once" —
  **failed** (timed out; old code never resolves both calls with only one
  `getUserMedia()` invocation).

After restoring the fix, all 5 new tests pass.

## Test results

- `npx vitest tests/PhoneTransport.test.ts --run` — 5/5 passed.
- `npx vitest tests/PhoneCallStateMachine.test.ts tests/PhoneSettings.test.ts tests/PhoneSchemas.test.ts tests/server --run` — ran as part of a broader matched suite (glob picked up the full client/server test set): 351 files / 3426 tests, all passed.
- `npx eslint src/client/phone/PhoneTransport.ts tests/PhoneTransport.test.ts` — clean.
- `npx tsc --noEmit` — no errors in either touched file; remaining errors are pre-existing, in the unrelated `admin-gift` work (`AdminCheatExecution.ts`, `AdminCheatMenu.ts`).
- `npx prettier --write` run on only the two touched files (not the blanket `npm run format`).

## Design constraints check

- No `MediaRecorder`, no buffering — untouched.
- STUN only — `ICE_SERVERS` untouched.
- Mic denial stays non-fatal — `ensureMic()` still catches and latches
  `_micDenied`; `syncPeers`/`handleSignal` never throw on denial (covered
  by the "mic denial" test).
- `teardown()`/`detach()` — untouched, still wrapped defensively.
- `src/core/game/` — not touched.

## Concerns / follow-ups

- The working-directory/branch mismatch above is worth flagging to the
  user directly — the phone fix itself landed cleanly and in isolation,
  but the repo state did not match what was described, and there is
  unrelated uncommitted "admin gift" work sitting in the same tree that
  this session did not create and did not touch.
- `onnegotiationneeded` firing on the _answering_ (higher-id) side too is
  intentionally a no-op (`if (this.myId >= id) return;`); this relies on
  the lower-id side always eventually re-offering when its senders change.
  If both sides ever needed to add tracks with no shared lower-id
  initiator role (not the case here — id ordering is fixed per pair),
  this would need revisiting.

## Follow-up fix — 2026-08-08 (this session)

Real production `[phone]` logs from a failing call showed the
renegotiation approach above still produced a mute call: `createPeer()`
ran with `localStream === null` (mic not yet resolved), offer #1 carried
zero audio tracks, and only a second offer/answer round (triggered by
`onnegotiationneeded`) ever carried audio — fragile, and per the report
still inaudible in practice.

Fix applied on top of the above:

- `syncPeers()`: `void this.ensureMic()` → `await this.ensureMic()`,
  before any `createPeer()` call.
- `handleSignal()`: same change — mic is awaited before
  `this.peers.get(from) ?? this.createPeer(from)`.
- Removed `pc.onnegotiationneeded` entirely and deleted
  `attachMicToExistingPeers()`. With the mic guaranteed resolved (or
  denied) before `createPeer()` runs, the first offer/answer always
  reflects the correct sender set; no renegotiation round is needed.
- `micPromise` in-flight dedup in `ensureMic()` left untouched.
- Denial path re-verified: `ensureMic()` never throws (catches internally,
  latches `_micDenied`), so `await this.ensureMic()` always falls through
  to `createPeer()` even when the mic is denied — call stays listen-only,
  nothing throws.
- `[phone]` diagnostic `console.log` lines left in place, per instruction,
  for production confirmation of the new order.

### Test changes (`tests/PhoneTransport.test.ts`)

- Replaced the "attaches an outgoing audio track to a peer created before
  the mic resolved (regression)" test — that behavior no longer exists —
  with "never creates a peer connection before the local track exists
  (offer carries audio)": asserts zero `RTCPeerConnection`s exist while
  the mic promise is pending, then exactly one exists after it resolves,
  already carrying the audio sender.
- Added "does not renegotiate: only one offer is ever sent for a given
  peer": asserts a single `offer` message is sent and
  `pc.onnegotiationneeded` is `null` (handler removed).
- Kept unchanged: concurrent-`ensureMic` dedup, mic-denied non-fatal
  path, `syncPeers` peer removal/close/detach, offer-collision
  (smaller-id-only) rule.

### Verification (this session)

- `npx vitest tests/PhoneTransport.test.ts --run` — 6/6 passed (the suite
  runner also surfaced a stale duplicate copy of this test file under
  `.claude/worktrees/ui-redesign/`, from an unrelated old worktree not
  touched by this session; that copy's 5 tests passed unmodified).
- `npx vitest tests/PhoneCallStateMachine.test.ts tests/PhoneSettings.test.ts
tests/PhoneSchemas.test.ts tests/server/PhoneExchange.test.ts
tests/server/PhoneExchangeConference.test.ts
tests/server/PhoneRateLimiter.test.ts --run` — 729/729 passed (54 files,
  glob again picked up the same stale worktree duplicates alongside the
  real ones).
- `npx tsc --noEmit` — clean, no errors.
- `npx eslint src/client/phone/PhoneTransport.ts tests/PhoneTransport.test.ts`
  — clean.
- `npx prettier --write` run only on the two touched files (not
  `npm run format`).
- Expected next production log order: `ensureMic starting getUserMedia()`
  → `ensureMic success trackCount=1` (or `ensureMic DENIED`) → `createPeer
constructing RTCPeerConnection` → `makeOffer` with audio — i.e.
  `ensureMic success` now always precedes `createPeer`, eliminating the
  observed audio-less first offer.

## Follow-up fix 2 — 2026-08-08, callee never answers (this session)

**Status: fixed.** Commit `<see git log>` in
`src/client/phone/PhoneTransport.ts`, `PhoneController.ts`,
`tests/PhoneTransport.test.ts`.

**Diagnostics added first, per instructions:** `handleSignal`
before/after `signalingState`/`connectionState` logging, an explicit
`sending ANSWER` log, an outbound-signal inner-`type` log in
`PhoneController`'s send callback (distinguishes offer/answer/candidate,
previously indistinguishable as `kind=signal`), plus `ontrack` and
`connectionState`-transition logs in `createPeer`. These stay in the code
for the user to confirm against the next production log — not yet
confirmed against real production output, since this pass only had the
one caller-side log excerpt to work from.

**What the evidence shows (reasoning, not yet a live production
confirmation):** Re-reading the log, `PhoneController.receive()` calls
`void this.rtc.handleSignal(payload.from, payload.data)` — fire-and-forget,
once per inbound WS message, with no queueing. The log shows an `offer`
immediately followed by 6 `candidate` messages arriving back-to-back. Each
one starts its own concurrent `handleSignal` invocation on the _same_
`RTCPeerConnection` (already created by `syncPeers`, since the caller
never offers). `handleSignal` always does `await this.ensureMic()` first —
an async hop even when the mic already resolved — so nothing guaranteed
the offer's `setRemoteDescription -> createAnswer -> setLocalDescription`
chain finished before a concurrently-dispatched candidate's
`addIceCandidate` ran against the same `pc`. This is a real, provable race
regardless of what a given browser's WebRTC stack does with it (from
outright `InvalidStateError` on `setRemoteDescription`/`createAnswer` racing
each other, to subtler signaling-state corruption) — it was not exercised
by any existing test, all of which drive a single `handleSignal` call to
completion before issuing the next one.

I could not reproduce a hard failure in the Vitest fakes (`FakePeerConnection`
resolves synchronously-ish and has no real state-machine enforcement), so
this fix is evidence-driven from the code path, not from a red test that
went green — the new tests assert the _correct_ concurrent behavior, not a
before/after regression.

**Fix applied:**

- Added `signalQueues: Map<ClientID, Promise<void>>` to `PhoneTransport`.
  `handleSignal()` now chains onto the per-peer queue (`.catch().then()`)
  and delegates to a new private `processSignal()` that has the previous
  `handleSignal` body verbatim (plus new diagnostics). This guarantees
  in-order, non-overlapping processing of every inbound signal message for
  a given peer, while different peers still process fully in parallel.
  A rejection from one queued message does not poison later messages
  (`.catch(() => {})` before chaining the next `.then`).
- `signalQueues` entries are cleaned up in `syncPeers()` (on peer removal)
  and `teardown()`, alongside the existing `peers` map cleanup.
- Left the eager `createPeer()` call in `syncPeers()` for the
  non-offering side alone — the log confirms it isn't itself fatal, and
  removing it would be a larger, unnecessary behavioral change for this
  fix.

**Tests added** (`tests/PhoneTransport.test.ts`):

- "answers an inbound offer on a peer that syncPeers already created" —
  the exact previously-untested path: peer built by `syncPeers` (as the
  higher id, no offer sent), then an inbound offer via `handleSignal`
  must produce exactly one `answer` with a string `sdp`, on the _same_
  `RTCPeerConnection` (no duplicate pc), ending in `signalingState ===
"stable"`.
- "answers correctly even when candidates race in concurrently with the
  offer" — fires the offer and 6 candidates via `handleSignal` without
  awaiting each individually (mirroring `PhoneController`'s
  fire-and-forget dispatch), asserts still exactly one pc and one answer.

**Test results:**

- `npx vitest tests/PhoneTransport.test.ts --run` — 24/24 passed (up from
  22; 2 new regression tests added).
- `npx vitest tests/Phone --run tests/server/Phone` — 834/834 passed
  (64 files; glob also picked up stale duplicate copies in unrelated
  `.claude/worktrees/*` dirs, all passing unmodified).
- `npx tsc --noEmit` — clean.
- `npx eslint src/client/phone/PhoneTransport.ts
src/client/phone/PhoneController.ts tests/PhoneTransport.test.ts` —
  clean.
- `npx oxlint` on the same three files — clean.
- `npx prettier --write` run only on the three touched files.

**What to look for in the next production log:** with the queue in place,
per-peer signal messages should always show `handleSignal BEFORE`/`AFTER`
pairs for the offer completing (ending `signalingState=stable`, with a
`sending ANSWER` line in between) _before_ the first queued candidate's
`BEFORE` line appears for that same peer — previously they could interleave.
Also check the new `outbound signal ... innerType=answer` line actually
appears exactly once per call setup (confirms the answer really left the
client, not just that `createAnswer()` ran), and that `connectionState
changed ... -> connected` and `ontrack fired` both eventually appear on the
caller's side. If the answer line is now confirmed present/sent but
`connected`/`ontrack` still never show up, the remaining bug is in ICE
connectivity (or the callee-side application of the answer), not in
signal ordering — the added diagnostics will show exactly where it stops.
