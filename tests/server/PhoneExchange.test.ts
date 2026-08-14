import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_CALL_MS,
  PhoneExchange,
  type PhoneOutbox,
  type PhoneParticipant,
  REDIAL_COOLDOWN_MS,
} from "../../src/server/phone/PhoneExchange";

const A = "aaaa1111";
const B = "bbbb2222";
const C = "cccc3333";
const D = "dddd4444";

let clock = 0;
const now = () => clock;

// Standard: niemand ist mit niemandem verbündet. Einzelne Tests überschreiben das.
let allies: Set<string> = new Set();
const allyKey = (x: string, y: string) => [x, y].sort().join("|");

function player(clientID: string, username: string): PhoneParticipant {
  return {
    clientID,
    username,
    isAllyOf: (other: string) => allies.has(allyKey(clientID, other)),
  };
}

function to(out: PhoneOutbox[], target: string) {
  return out.filter((o) => o.to === target).map((o) => o.payload);
}

function kinds(out: PhoneOutbox[], target: string) {
  return to(out, target).map((p) => p.kind);
}

describe("PhoneExchange", () => {
  let ex: PhoneExchange;

  beforeEach(() => {
    clock = 0;
    allies = new Set();
    ex = new PhoneExchange(now);
    ex.addPlayer(player(A, "Alice"));
    ex.addPlayer(player(B, "Bob"));
    ex.addPlayer(player(C, "Carol"));
    ex.addPlayer(player(D, "Dave"));
  });

  it("rings the target and tells the caller it is dialing", () => {
    const out = ex.handle(A, { kind: "dial", target: B });
    expect(kinds(out, B)).toContain("ringing");
    expect(kinds(out, A)).toContain("dialing");
  });

  it("connects both sides when the target answers", () => {
    ex.handle(A, { kind: "dial", target: B });
    const out = ex.handle(B, { kind: "answer" });
    const aState = to(out, A).find((p) => p.kind === "callState") as any;
    const bState = to(out, B).find((p) => p.kind === "callState") as any;
    expect(aState.peers).toEqual([B]);
    expect(bState.peers).toEqual([A]);
  });

  it("gives busy when the target has DND on", () => {
    ex.handle(B, { kind: "setMode", mode: "dnd" });
    const out = ex.handle(A, { kind: "dial", target: B });
    expect(kinds(out, A)).toEqual(["busy"]);
    expect(kinds(out, B)).toEqual([]);
  });

  it("still rings on silent mode (the caller cannot tell)", () => {
    ex.handle(B, { kind: "setMode", mode: "silent" });
    const out = ex.handle(A, { kind: "dial", target: B });
    expect(kinds(out, B)).toContain("ringing");
    expect(kinds(out, A)).toContain("dialing");
  });

  it("gives busy when the caller is blocked", () => {
    ex.handle(B, { kind: "block", target: A });
    const out = ex.handle(A, { kind: "dial", target: B });
    expect(kinds(out, A)).toEqual(["busy"]);
  });

  it("gives busy when allies-only is on and the caller is no ally", () => {
    ex.handle(B, { kind: "setAlliesOnly", value: true });
    const out = ex.handle(A, { kind: "dial", target: B });
    expect(kinds(out, A)).toEqual(["busy"]);
  });

  it("connects when allies-only is on and the caller is an ally", () => {
    allies.add(allyKey(A, B));
    ex.handle(B, { kind: "setAlliesOnly", value: true });
    const out = ex.handle(A, { kind: "dial", target: B });
    expect(kinds(out, B)).toContain("ringing");
  });

  it("gives busy when the target is already in a call", () => {
    ex.handle(A, { kind: "dial", target: B });
    ex.handle(B, { kind: "answer" });
    const out = ex.handle(C, { kind: "dial", target: B });
    expect(kinds(out, C)).toEqual(["busy"]);
  });

  it("gives busy when dialing an unknown player", () => {
    const out = ex.handle(A, { kind: "dial", target: "zzzz9999" });
    expect(kinds(out, A)).toEqual(["busy"]);
  });

  it("gives busy when dialing yourself", () => {
    const out = ex.handle(A, { kind: "dial", target: A });
    expect(kinds(out, A)).toEqual(["busy"]);
  });

  it("reports a missed call after the ring timeout", () => {
    ex.handle(A, { kind: "dial", target: B });
    clock = 11999;
    expect(ex.tick()).toEqual([]);
    clock = 12000;
    const out = ex.tick();
    const missed = to(out, B).find((p) => p.kind === "missed") as any;
    expect(missed.from).toBe(A);
    expect(missed.fromUsername).toBe("Alice");
    expect(kinds(out, A)).toContain("callEnded");
  });

  it("gives the caller busy when the target rejects", () => {
    ex.handle(A, { kind: "dial", target: B });
    const out = ex.handle(B, { kind: "hangup" });
    expect(kinds(out, A)).toContain("busy");
    const missed = to(out, B).find((p) => p.kind === "missed");
    expect(missed).toBeUndefined();
  });

  it("records a missed call when the caller gives up first", () => {
    ex.handle(A, { kind: "dial", target: B });
    const out = ex.handle(A, { kind: "hangup" });
    const missed = to(out, B).find((p) => p.kind === "missed") as any;
    expect(missed.from).toBe(A);
  });

  it("ends the call for the other side on hangup", () => {
    ex.handle(A, { kind: "dial", target: B });
    ex.handle(B, { kind: "answer" });
    const out = ex.handle(A, { kind: "hangup" });
    expect(kinds(out, B)).toContain("callEnded");
  });

  it("forwards signaling only to the named peer inside the call", () => {
    ex.handle(A, { kind: "dial", target: B });
    ex.handle(B, { kind: "answer" });
    const out = ex.handle(A, { kind: "signal", to: B, data: "sdp" });
    const sig = to(out, B).find((p) => p.kind === "signal") as any;
    expect(sig.from).toBe(A);
    expect(sig.data).toBe("sdp");
    expect(to(out, C)).toEqual([]);
  });

  it("drops signaling to someone outside the call", () => {
    ex.handle(A, { kind: "dial", target: B });
    ex.handle(B, { kind: "answer" });
    const out = ex.handle(A, { kind: "signal", to: C, data: "sdp" });
    expect(out).toEqual([]);
  });

  it("clears the call when a participant disconnects", () => {
    ex.handle(A, { kind: "dial", target: B });
    ex.handle(B, { kind: "answer" });
    const out = ex.removePlayer(A);
    expect(kinds(out, B)).toContain("callEnded");
  });

  it("leaves the caller reachable again after destroyCall runs on a fresh, uncleaned call", () => {
    // Regression: destroyCall() must remove its own callOf entries, not rely
    // on the caller (e.g. collapseIfEmpty) to have done it already. Today the
    // only two call sites that invoke destroyCall() on a freshly-created call
    // (capacity-exceeded, block-loop) are unreachable through the public API
    // — Task 4 reworks that arithmetic and makes them reachable. Exercise
    // destroyCall() directly here so a regression is caught now rather than
    // discovered later as callers becoming permanently "busy" forever.
    ex.handle(A, { kind: "dial", target: B });
    const call = (ex as any).calls.get((ex as any).callOf.get(A));
    expect(call).toBeDefined();

    (ex as any).destroyCall(call);

    expect((ex as any).callOf.has(A)).toBe(false);
    expect((ex as any).callOf.has(B)).toBe(false);

    // With the callOf entries gone, both former participants must be
    // dialable again as targets — a stale entry would make
    // `this.callOf.has(target)` wrongly return true forever and every
    // future dial() at them would come back "busy". Use separate,
    // uninvolved dialers (C, D) for each probe so that neither probe's own
    // consent state (dialing/ringing) interferes with the other.
    const out = ex.handle(C, { kind: "dial", target: A });
    expect(kinds(out, A)).toContain("ringing");
    expect(kinds(out, C)).toContain("dialing");

    const out2 = ex.handle(D, { kind: "dial", target: B });
    expect(kinds(out2, B)).toContain("ringing");
  });

  it("keeps DND set across a disconnect/reconnect cycle", () => {
    ex.handle(B, { kind: "setMode", mode: "dnd" });
    // Simulates GameServer: handleClientDisconnect always calls
    // removePlayer, even for a brief drop; rejoinClient then re-registers
    // via addPlayer. Prefs must not reset in between.
    ex.removePlayer(B);
    ex.addPlayer(player(B, "Bob"));

    const out = ex.handle(A, { kind: "dial", target: B });
    expect(kinds(out, A)).toEqual(["busy"]);
    expect(kinds(out, B)).toEqual([]);
  });

  it("keeps a block set across a disconnect/reconnect cycle", () => {
    ex.handle(B, { kind: "block", target: A });
    ex.removePlayer(B);
    ex.addPlayer(player(B, "Bob"));

    const out = ex.handle(A, { kind: "dial", target: B });
    expect(kinds(out, A)).toEqual(["busy"]);
  });

  describe("reject", () => {
    it("gives the caller the plain busy signal and stops the ring", () => {
      ex.handle(A, { kind: "dial", target: B });
      const out = ex.handle(B, { kind: "reject" });
      expect(kinds(out, A)).toContain("busy");
      // Rejecting is an active refusal: the rejecter does not log it as a
      // call they missed.
      expect(to(out, B).find((p) => p.kind === "missed")).toBeUndefined();
    });

    it("is indistinguishable from DND, a block, and being busy", () => {
      // The whole point: a caller must not be able to tell WHY they were
      // refused, or blocking becomes probeable.
      const rejected = (() => {
        ex.handle(A, { kind: "dial", target: B });
        return to(ex.handle(B, { kind: "reject" }), A).filter(
          (p) => p.kind !== "callEnded",
        );
      })();

      const viaDnd = (() => {
        ex.handle(C, { kind: "setMode", mode: "dnd" });
        return to(ex.handle(A, { kind: "dial", target: C }), A);
      })();

      const viaBlock = (() => {
        ex.handle(D, { kind: "block", target: A });
        return to(ex.handle(A, { kind: "dial", target: D }), A);
      })();

      expect(rejected).toEqual([{ kind: "busy" }]);
      expect(viaDnd).toEqual([{ kind: "busy" }]);
      expect(viaBlock).toEqual([{ kind: "busy" }]);
    });

    it("frees the rejecter to be called again", () => {
      ex.handle(A, { kind: "dial", target: B });
      ex.handle(B, { kind: "reject" });
      const out = ex.handle(C, { kind: "dial", target: B });
      expect(kinds(out, B)).toContain("ringing");
    });

    it("does nothing when there is no incoming call", () => {
      expect(ex.handle(B, { kind: "reject" })).toEqual([]);
    });

    it("does not let a connected participant reject their way out silently", () => {
      // reject is for an unanswered ring. Someone already connected who
      // sends it must simply leave, exactly like hangup — never eject
      // anyone else.
      ex.handle(A, { kind: "dial", target: B });
      ex.handle(B, { kind: "answer" });
      const out = ex.handle(B, { kind: "reject" });
      expect(kinds(out, A)).toContain("callEnded");
      expect(kinds(out, B)).toContain("callEnded");
    });
  });

  describe("death", () => {
    it("ends a dead player's live call for both sides", () => {
      ex.handle(A, { kind: "dial", target: B });
      ex.handle(B, { kind: "answer" });
      const out = ex.handle(A, { kind: "died" });
      expect(kinds(out, B)).toContain("callEnded");
      expect(kinds(out, A)).toContain("callEnded");
    });

    it("stops a ring that is already going out to the player who died", () => {
      ex.handle(A, { kind: "dial", target: B });
      // B dies while their phone is ringing. The ring must stop, and A must
      // not be left listening to a dial tone forever.
      const out = ex.handle(B, { kind: "died" });
      expect(kinds(out, A)).toContain("busy");
      const stillRinging = ex.handle(C, { kind: "dial", target: B });
      expect(kinds(stillRinging, B)).toEqual([]);
    });

    it("makes a dead player uncallable, with the same busy signal as any other refusal", () => {
      ex.handle(B, { kind: "died" });
      const out = ex.handle(A, { kind: "dial", target: B });
      expect(kinds(out, A)).toEqual(["busy"]);
      expect(kinds(out, B)).toEqual([]);
    });

    it("stops a dead player from dialing anyone", () => {
      ex.handle(A, { kind: "died" });
      const out = ex.handle(A, { kind: "dial", target: B });
      expect(kinds(out, A)).toEqual(["busy"]);
      expect(kinds(out, B)).toEqual([]);
    });

    it("is permanent for the match: a reconnect does not resurrect the phone", () => {
      // Unlike removePlayer (a socket blip that a reconnect undoes), death is
      // final in the simulation. addPlayer must not make a dead player
      // callable again.
      ex.handle(B, { kind: "died" });
      ex.removePlayer(B);
      ex.addPlayer(player(B, "Bob"));
      const out = ex.handle(A, { kind: "dial", target: B });
      expect(kinds(out, A)).toEqual(["busy"]);
    });

    it("keeps prefs intact, exactly as a disconnect does", () => {
      // Death must not regress the fix that keeps DND/blocks alive across a
      // drop — prefs still belong to the client, not to their liveness.
      ex.handle(B, { kind: "block", target: A });
      ex.handle(B, { kind: "setMode", mode: "dnd" });
      ex.handle(B, { kind: "died" });
      expect((ex as any).prefsOf(B).blocked.has(A)).toBe(true);
      expect((ex as any).prefsOf(B).mode).toBe("dnd");
    });

    // SECURITY. Liveness lives in the client-side simulation, so the server
    // can never verify it. It therefore must only ever accept a death report
    // about the REPORTING client itself, keyed off the connection's own
    // clientID. If a payload could name a victim, a modified client could
    // hang up on arbitrary players or eject rivals from a conference.
    it("does not let a client end another player's call by reporting a death", () => {
      // B and C are talking. A — an outsider — reports a death.
      ex.handle(B, { kind: "dial", target: C });
      ex.handle(C, { kind: "answer" });

      const out = ex.handle(A, { kind: "died" } as any);

      // B and C's call is untouched: no one was ejected.
      expect(kinds(out, B)).toEqual([]);
      expect(kinds(out, C)).toEqual([]);
      // And they are still connected to each other.
      const sig = ex.handle(B, { kind: "signal", to: C, data: "still-here" });
      expect(to(sig, C).find((p) => p.kind === "signal")).toBeDefined();
    });

    it("ignores any victim smuggled into the death payload", () => {
      // Even if a modified client adds a `target`/`clientID` field, the
      // server must key the death to the sender and nothing else.
      ex.handle(B, { kind: "dial", target: C });
      ex.handle(C, { kind: "answer" });

      const out = ex.handle(A, {
        kind: "died",
        target: B,
        clientID: C,
      } as any);

      expect(kinds(out, B)).toEqual([]);
      expect(kinds(out, C)).toEqual([]);
      // B is still in their call, so a fresh dial at B comes back busy —
      // proof the call survived rather than having been torn down.
      expect(kinds(ex.handle(D, { kind: "dial", target: B }), D)).toEqual([
        "busy",
      ]);
    });

    it("is idempotent when the report is retried", () => {
      // The client re-announces its death for a few ticks, because a single
      // phone message can be dropped by the rate limiter. Repeats must be
      // silent no-ops, not a second teardown.
      ex.handle(A, { kind: "dial", target: B });
      ex.handle(B, { kind: "answer" });
      const first = ex.handle(A, { kind: "died" });
      expect(kinds(first, B)).toContain("callEnded");
      expect(ex.handle(A, { kind: "died" })).toEqual([]);
      expect(ex.handle(A, { kind: "died" })).toEqual([]);
    });

    it("does not eject a dead player's conference partners from each other", () => {
      // A, B, C in a conference; A dies. B and C keep talking.
      ex.handle(A, { kind: "dial", target: B });
      ex.handle(B, { kind: "answer" });
      ex.handle(A, { kind: "dial", target: C });
      ex.handle(C, { kind: "answer" });

      const out = ex.handle(A, { kind: "died" });
      const bState = to(out, B).find((p) => p.kind === "callState") as any;
      expect(bState.peers).toEqual([C]);
      expect(kinds(out, B)).not.toContain("callEnded");
    });
  });

  // A call is capped at two minutes of TALK time, swept by the same tick()
  // that already expires rings. The clock has to live here, on the server: a
  // countdown owned by the client is turned off by editing the client.
  describe("call time limit", () => {
    it("caps talk time at two minutes", () => {
      expect(MAX_CALL_MS).toBe(120000);
    });

    it("ends the call for both sides once the limit is reached", () => {
      ex.handle(A, { kind: "dial", target: B });
      ex.handle(B, { kind: "answer" });

      clock = MAX_CALL_MS - 1;
      expect(ex.tick()).toEqual([]);

      clock = MAX_CALL_MS;
      const out = ex.tick();
      expect(kinds(out, A)).toContain("callEnded");
      expect(kinds(out, B)).toContain("callEnded");
    });

    // The budget starts when the call CONNECTS, not when it is created.
    // Otherwise a target who lets it ring for the full 12s ring timeout
    // silently spends a tenth of the talk time before saying hello, and a
    // caller could shrink a callee's talk time just by dialing early.
    it("starts the budget at the first answer, not at dial time", () => {
      ex.handle(A, { kind: "dial", target: B });
      clock = 11000; // rang almost to the ring timeout
      ex.handle(B, { kind: "answer" });

      // Two minutes after the DIAL the call must still be alive...
      clock = MAX_CALL_MS;
      expect(ex.tick()).toEqual([]);

      // ...and it ends two minutes after the ANSWER.
      clock = 11000 + MAX_CALL_MS;
      const out = ex.tick();
      expect(kinds(out, A)).toContain("callEnded");
      expect(kinds(out, B)).toContain("callEnded");
    });

    it("does not expire a call that is only ringing", () => {
      // A dial that is never answered is governed by the ring timeout alone.
      // Reaching MAX_CALL_MS must not produce a second, different teardown.
      ex.handle(A, { kind: "dial", target: B });
      clock = 12000;
      ex.tick(); // ring timeout fires, call collapses
      clock = MAX_CALL_MS + 12000;
      expect(ex.tick()).toEqual([]);
    });

    it("reports the remaining time in every callState", () => {
      ex.handle(A, { kind: "dial", target: B });
      const answered = ex.handle(B, { kind: "answer" });
      const first = to(answered, A).find((p) => p.kind === "callState") as any;
      expect(first.remainingMs).toBe(MAX_CALL_MS);

      // 30s in, C is pulled into the call: the fresh state carries the
      // shrunken budget, so nobody's countdown drifts or restarts.
      clock = 30000;
      ex.handle(A, { kind: "dial", target: C });
      const joined = ex.handle(C, { kind: "answer" });
      const later = to(joined, C).find((p) => p.kind === "callState") as any;
      expect(later.remainingMs).toBe(MAX_CALL_MS - 30000);
    });

    it("never reports a negative remaining time", () => {
      ex.handle(A, { kind: "dial", target: B });
      ex.handle(B, { kind: "answer" });
      clock = MAX_CALL_MS + 5000;
      const out = ex.tick();
      const states = out
        .map((o) => o.payload)
        .filter((p) => p.kind === "callState") as any[];
      for (const s of states) expect(s.remainingMs).toBeGreaterThanOrEqual(0);
    });
  });

  // After a call dies on the clock, the same PAIR cannot immediately redial.
  // Pairwise is the whole point: a global "this player's phone is locked"
  // would let anyone silence a rival by calling them and letting it run out.
  describe("redial cooldown", () => {
    function timeOutAB() {
      ex.handle(A, { kind: "dial", target: B });
      ex.handle(B, { kind: "answer" });
      clock = MAX_CALL_MS;
      ex.tick();
    }

    it("refuses a redial between the same pair, in both directions", () => {
      timeOutAB();
      expect(kinds(ex.handle(A, { kind: "dial", target: B }), A)).toEqual([
        "busy",
      ]);
      expect(kinds(ex.handle(B, { kind: "dial", target: A }), B)).toEqual([
        "busy",
      ]);
    });

    it("is indistinguishable from any other refusal", () => {
      // Exactly the bare busy of DND/block/reject — no extra field, no
      // second message, nothing to probe a reason from.
      timeOutAB();
      expect(to(ex.handle(A, { kind: "dial", target: B }), A)).toEqual([
        { kind: "busy" },
      ]);
      expect(to(ex.handle(A, { kind: "dial", target: B }), B)).toEqual([]);
    });

    it("expires after thirty seconds", () => {
      expect(REDIAL_COOLDOWN_MS).toBe(30000);
      timeOutAB();
      clock = MAX_CALL_MS + REDIAL_COOLDOWN_MS - 1;
      expect(kinds(ex.handle(A, { kind: "dial", target: B }), A)).toEqual([
        "busy",
      ]);
      clock = MAX_CALL_MS + REDIAL_COOLDOWN_MS;
      const out = ex.handle(A, { kind: "dial", target: B });
      expect(kinds(out, B)).toContain("ringing");
      expect(kinds(out, A)).toContain("dialing");
    });

    // THE point of pairwise. If the cooldown were a per-player lock, C could
    // not reach either of them — and A could weaponise the timer to take B's
    // phone away from everyone for 30 seconds.
    it("leaves both participants reachable by a third party", () => {
      timeOutAB();
      const toB = ex.handle(C, { kind: "dial", target: B });
      expect(kinds(toB, B)).toContain("ringing");
      ex.handle(C, { kind: "hangup" });

      const toA = ex.handle(D, { kind: "dial", target: A });
      expect(kinds(toA, A)).toContain("ringing");
    });

    it("leaves both participants free to dial out to a third party", () => {
      timeOutAB();
      expect(kinds(ex.handle(A, { kind: "dial", target: C }), C)).toContain(
        "ringing",
      );
      expect(kinds(ex.handle(B, { kind: "dial", target: D }), D)).toContain(
        "ringing",
      );
    });

    // The user asked for a cooldown in the context of the time LIMIT. A
    // cooldown after every ordinary hang-up would punish normal use (say
    // one sentence, hang up, call back) and was never requested.
    it("does not apply after a normal hang-up", () => {
      ex.handle(A, { kind: "dial", target: B });
      ex.handle(B, { kind: "answer" });
      ex.handle(A, { kind: "hangup" });
      const out = ex.handle(A, { kind: "dial", target: B });
      expect(kinds(out, B)).toContain("ringing");
    });

    it("does not apply after an unanswered call rings out", () => {
      ex.handle(A, { kind: "dial", target: B });
      clock = 12000;
      ex.tick();
      const out = ex.handle(A, { kind: "dial", target: B });
      expect(kinds(out, B)).toContain("ringing");
    });

    it("does not apply after a rejection", () => {
      ex.handle(A, { kind: "dial", target: B });
      ex.handle(B, { kind: "reject" });
      const out = ex.handle(A, { kind: "dial", target: B });
      expect(kinds(out, B)).toContain("ringing");
    });

    it("survives a disconnect, like the other prefs", () => {
      // A cooldown a player can clear by bouncing their socket is no cap
      // at all.
      timeOutAB();
      ex.removePlayer(B);
      ex.addPlayer(player(B, "Bob"));
      expect(kinds(ex.handle(A, { kind: "dial", target: B }), A)).toEqual([
        "busy",
      ]);
    });
  });
});
