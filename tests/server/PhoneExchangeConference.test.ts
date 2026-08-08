import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_CALL_PARTICIPANTS,
  PhoneExchange,
  type PhoneOutbox,
  type PhoneParticipant,
} from "../../src/server/phone/PhoneExchange";

const NAMES = ["A", "B", "C", "D", "E", "F", "G"];
const ids = NAMES.map((n) => n.repeat(8));
const [A, B, C, D, E, F, G] = ids;

let clock = 0;
const now = () => clock;
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

describe("PhoneExchange conferences", () => {
  let ex: PhoneExchange;

  beforeEach(() => {
    clock = 0;
    allies = new Set();
    ex = new PhoneExchange(now);
    ids.forEach((id, i) => ex.addPlayer(player(id, NAMES[i])));
  });

  // Bringt A und B in ein verbundenes Gespräch.
  function connectAB() {
    ex.handle(A, { kind: "dial", target: B });
    ex.handle(B, { kind: "answer" });
  }

  it("lets a participant pull in a third player", () => {
    connectAB();
    const out = ex.handle(A, { kind: "dial", target: C });
    expect(kinds(out, C)).toContain("ringing");
  });

  it("gives everyone the full peer list once the third answers", () => {
    connectAB();
    ex.handle(A, { kind: "dial", target: C });
    const out = ex.handle(C, { kind: "answer" });
    const peersOf = (who: string) =>
      (to(out, who).find((p) => p.kind === "callState") as any).peers.sort();
    expect(peersOf(A)).toEqual([B, C].sort());
    expect(peersOf(B)).toEqual([A, C].sort());
    expect(peersOf(C)).toEqual([A, B].sort());
  });

  it("lets a non-initiator pull someone in too (no host)", () => {
    connectAB();
    const out = ex.handle(B, { kind: "dial", target: C });
    expect(kinds(out, C)).toContain("ringing");
  });

  it("refuses to pull in someone who blocked another participant", () => {
    connectAB();
    ex.handle(C, { kind: "block", target: B });
    const out = ex.handle(A, { kind: "dial", target: C });
    expect(kinds(out, A)).toEqual(["busy"]);
    expect(kinds(out, C)).toEqual([]);
  });

  it("refuses to pull in someone a participant has blocked", () => {
    connectAB();
    ex.handle(B, { kind: "block", target: C });
    const out = ex.handle(A, { kind: "dial", target: C });
    expect(kinds(out, A)).toEqual(["busy"]);
  });

  it("applies allies-only only against the dialer, not the whole room", () => {
    allies.add(allyKey(A, C));
    connectAB();
    ex.handle(C, { kind: "setAlliesOnly", value: true });
    // A ist mit C verbündet, B nicht — A darf C trotzdem dazuholen.
    const out = ex.handle(A, { kind: "dial", target: C });
    expect(kinds(out, C)).toContain("ringing");
  });

  it("caps the call at MAX_CALL_PARTICIPANTS", () => {
    connectAB();
    for (const who of [C, D, E, F]) {
      ex.handle(A, { kind: "dial", target: who });
      ex.handle(who, { kind: "answer" });
    }
    // A,B,C,D,E,F = 6 -> voll.
    const out = ex.handle(A, { kind: "dial", target: G });
    expect(kinds(out, A)).toEqual(["busy"]);
    expect(MAX_CALL_PARTICIPANTS).toBe(6);
  });

  it("counts pending rings against the cap", () => {
    connectAB();
    for (const who of [C, D, E]) {
      ex.handle(A, { kind: "dial", target: who });
      ex.handle(who, { kind: "answer" });
    }
    // A,B,C,D,E = 5 verbunden. Ein Ruf an F macht 6 -> erlaubt, aber blockiert G.
    ex.handle(A, { kind: "dial", target: F });
    const out = ex.handle(B, { kind: "dial", target: G });
    expect(kinds(out, G)).toEqual([]);
    expect(kinds(out, B)).toEqual(["busy"]);
  });

  it("keeps the ring alive when the dialer hangs up mid-ring", () => {
    connectAB();
    ex.handle(A, { kind: "dial", target: C });
    const out = ex.handle(A, { kind: "hangup" });
    // B telefoniert weiter, bei C klingelt es unverändert.
    expect(kinds(out, C)).not.toContain("missed");
    const answered = ex.handle(C, { kind: "answer" });
    const bState = to(answered, B).find((p) => p.kind === "callState") as any;
    expect(bState.peers).toEqual([C]);
  });

  it("cancels a pending ring as missed when the call collapses", () => {
    connectAB();
    ex.handle(A, { kind: "dial", target: C });
    ex.handle(A, { kind: "hangup" });
    const out = ex.handle(B, { kind: "hangup" });
    const missed = to(out, C).find((p) => p.kind === "missed") as any;
    expect(missed.from).toBe(A);
  });

  it("keeps the call running when one of three drops out", () => {
    connectAB();
    ex.handle(A, { kind: "dial", target: C });
    ex.handle(C, { kind: "answer" });
    const out = ex.handle(C, { kind: "hangup" });
    const aState = to(out, A).find((p) => p.kind === "callState") as any;
    expect(aState.peers).toEqual([B]);
    expect(kinds(out, A)).not.toContain("callEnded");
  });

  it("ends the call for the last person standing", () => {
    connectAB();
    const out = ex.handle(B, { kind: "hangup" });
    expect(kinds(out, A)).toContain("callEnded");
  });

  it("routes signaling between any two peers in a conference", () => {
    connectAB();
    ex.handle(A, { kind: "dial", target: C });
    ex.handle(C, { kind: "answer" });
    const out = ex.handle(B, { kind: "signal", to: C, data: "ice" });
    const sig = to(out, C).find((p) => p.kind === "signal") as any;
    expect(sig.from).toBe(B);
    expect(to(out, A)).toEqual([]);
  });

  it("removes a disconnected participant but keeps the rest talking", () => {
    connectAB();
    ex.handle(A, { kind: "dial", target: C });
    ex.handle(C, { kind: "answer" });
    const out = ex.removePlayer(B);
    const aState = to(out, A).find((p) => p.kind === "callState") as any;
    expect(aState.peers).toEqual([C]);
  });

  it("refuses to pull in someone blocked by a participant who is still ringing (not yet connected)", () => {
    connectAB();
    // D blocks C.
    ex.handle(D, { kind: "block", target: C });
    // A dials D — D is now in call.ringing, not call.participants.
    ex.handle(A, { kind: "dial", target: D });
    // A tries to pull in C — D, still ringing, has blocked C.
    const out = ex.handle(A, { kind: "dial", target: C });
    expect(kinds(out, C)).toEqual([]);
    expect(kinds(out, A)).toEqual(["busy"]);
  });

  it("refuses to pull in a new target who blocked a participant who is still ringing (not yet connected)", () => {
    connectAB();
    // C blocks D.
    ex.handle(C, { kind: "block", target: D });
    // A dials C — C is now in call.ringing, not call.participants.
    ex.handle(A, { kind: "dial", target: C });
    // A tries to pull in D — the still-ringing C has blocked D.
    const out = ex.handle(A, { kind: "dial", target: D });
    expect(kinds(out, D)).toEqual([]);
    expect(kinds(out, A)).toEqual(["busy"]);
  });

  it("removes a disconnected participant from a 3-way conference and keeps the other two connected", () => {
    connectAB();
    ex.handle(A, { kind: "dial", target: C });
    ex.handle(C, { kind: "answer" });
    // A, B, C are all connected. Remove A.
    const out = ex.removePlayer(A);
    const bState = to(out, B).find((p) => p.kind === "callState") as any;
    const cState = to(out, C).find((p) => p.kind === "callState") as any;
    expect(bState.peers).toEqual([C]);
    expect(cState.peers).toEqual([B]);
    expect(kinds(out, B)).not.toContain("callEnded");
    expect(kinds(out, C)).not.toContain("callEnded");
  });

  it("does not let a merely-ringing target's dial pull an uninvolved caller into a call (consent defect repro)", () => {
    // A dials B -> B is ringing, A is dialing. B has NOT answered.
    ex.handle(A, { kind: "dial", target: B });
    // B, only ringing (not a participant), dials C.
    const bDialOut = ex.handle(B, { kind: "dial", target: C });
    // B's dial must be rejected as busy — B cannot start a second call while
    // still an unanswered ring target of A's call.
    expect(kinds(bDialOut, B)).toEqual(["busy"]);
    expect(kinds(bDialOut, C)).toEqual([]);
    // C answering (nothing to answer, C was never rung) should not connect
    // A to C.
    const answerOut = ex.handle(C, { kind: "answer" });
    expect(answerOut).toEqual([]);
    // A must still only be ringing B, never connected to C.
    const aState = to(answerOut, A).find((p) => p.kind === "callState");
    expect(aState).toBeUndefined();
  });

  it("rejects a second dial from a caller whose own outgoing call is still ringing, without disturbing the original ring", () => {
    // A dials B -> A is dialing, B is ringing.
    ex.handle(A, { kind: "dial", target: B });
    // A tries to dial C while B has not yet answered.
    const out = ex.handle(A, { kind: "dial", target: C });
    expect(kinds(out, A)).toEqual(["busy"]);
    expect(kinds(out, C)).toEqual([]);
    // B's original ring is unaffected — B can still answer and connect to A.
    const answered = ex.handle(B, { kind: "answer" });
    const aState = to(answered, A).find((p) => p.kind === "callState") as any;
    const bState = to(answered, B).find((p) => p.kind === "callState") as any;
    expect(aState.peers).toEqual([B]);
    expect(bState.peers).toEqual([A]);
  });

  it("still allows a genuine connected participant to pull in a third party (legitimate conference path)", () => {
    connectAB();
    const dialOut = ex.handle(A, { kind: "dial", target: C });
    expect(kinds(dialOut, C)).toContain("ringing");
    const out = ex.handle(C, { kind: "answer" });
    const peersOf = (who: string) =>
      (to(out, who).find((p) => p.kind === "callState") as any).peers.sort();
    expect(peersOf(A)).toEqual([B, C].sort());
    expect(peersOf(B)).toEqual([A, C].sort());
    expect(peersOf(C)).toEqual([A, B].sort());
  });

  it("does not eject anyone when a block is added after both parties are already connected", () => {
    connectAB();
    // A and B are connected. B blocks A after the fact.
    const out = ex.handle(B, { kind: "block", target: A });
    expect(out).toEqual([]);
    // Neither side got kicked — no callEnded, no busy.
    expect(kinds(out, A)).toEqual([]);
    expect(kinds(out, B)).toEqual([]);
    // The block only gates future dials: A pulling in a new target still
    // works fine (the block doesn't retroactively unravel the existing call).
    const signal = ex.handle(A, {
      kind: "signal",
      to: B,
      data: "still-connected",
    });
    const sig = to(signal, B).find((p) => p.kind === "signal") as any;
    expect(sig.from).toBe(A);
  });
});
