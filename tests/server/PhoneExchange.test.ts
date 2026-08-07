import { beforeEach, describe, expect, it } from "vitest";
import {
  PhoneExchange,
  type PhoneOutbox,
  type PhoneParticipant,
} from "../../src/server/phone/PhoneExchange";

const A = "aaaa1111";
const B = "bbbb2222";
const C = "cccc3333";

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
});
