import { beforeEach, describe, expect, it, vi } from "vitest";
import { CallStateMachine } from "../src/client/phone/CallStateMachine";

const A = "aaaa1111";
const B = "bbbb2222";

describe("CallStateMachine", () => {
  let m: CallStateMachine;

  beforeEach(() => {
    vi.useFakeTimers();
    m = new CallStateMachine();
  });

  it("starts idle", () => {
    expect(m.state).toBe("idle");
    expect(m.peers).toEqual([]);
  });

  it("goes to dialing", () => {
    m.receive({ kind: "dialing", callId: "c1" });
    expect(m.state).toBe("dialing");
  });

  it("goes to ringing and exposes the caller", () => {
    m.receive({
      kind: "ringing",
      callId: "c1",
      from: A,
      fromUsername: "Alice",
    });
    expect(m.state).toBe("ringing");
    expect(m.incoming).toEqual({ from: A, username: "Alice" });
  });

  it("enters the call and lists peers", () => {
    m.receive({ kind: "dialing", callId: "c1" });
    m.receive({ kind: "callState", callId: "c1", peers: [B] });
    expect(m.state).toBe("in-call");
    expect(m.peers).toEqual([B]);
  });

  it("updates the peer list as a conference grows", () => {
    m.receive({ kind: "callState", callId: "c1", peers: [A] });
    m.receive({ kind: "callState", callId: "c1", peers: [A, B] });
    expect(m.peers).toEqual([A, B]);
  });

  it("returns to idle when the call ends", () => {
    m.receive({ kind: "callState", callId: "c1", peers: [B] });
    m.receive({ kind: "callEnded", callId: "c1" });
    expect(m.state).toBe("idle");
    expect(m.peers).toEqual([]);
  });

  it("shows busy and falls back to idle on its own", () => {
    m.receive({ kind: "dialing", callId: "c1" });
    m.receive({ kind: "busy" });
    expect(m.state).toBe("busy");
    vi.advanceTimersByTime(2999);
    expect(m.state).toBe("busy");
    vi.advanceTimersByTime(1);
    expect(m.state).toBe("idle");
  });

  it("collects missed calls", () => {
    m.receive({ kind: "missed", from: A, fromUsername: "Alice" });
    m.receive({ kind: "missed", from: B, fromUsername: "Bob" });
    expect(m.missed).toEqual([
      { from: A, username: "Alice" },
      { from: B, username: "Bob" },
    ]);
  });

  it("clears missed calls on demand", () => {
    m.receive({ kind: "missed", from: A, fromUsername: "Alice" });
    m.clearMissed();
    expect(m.missed).toEqual([]);
  });

  it("drops the incoming caller once answered", () => {
    m.receive({
      kind: "ringing",
      callId: "c1",
      from: A,
      fromUsername: "Alice",
    });
    m.receive({ kind: "callState", callId: "c1", peers: [A] });
    expect(m.incoming).toBeNull();
  });

  it("notifies listeners on every change", () => {
    const seen: string[] = [];
    m.onChange(() => seen.push(m.state));
    m.receive({ kind: "dialing", callId: "c1" });
    m.receive({ kind: "callState", callId: "c1", peers: [B] });
    expect(seen).toEqual(["dialing", "in-call"]);
  });

  it("stops notifying after unsubscribe", () => {
    let count = 0;
    const off = m.onChange(() => count++);
    m.receive({ kind: "dialing", callId: "c1" });
    off();
    m.receive({ kind: "callEnded", callId: "c1" });
    expect(count).toBe(1);
  });

  it("ignores signal payloads (transport handles those)", () => {
    m.receive({ kind: "signal", from: A, data: "sdp" });
    expect(m.state).toBe("idle");
  });
});
