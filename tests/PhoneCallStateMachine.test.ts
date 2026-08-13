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

  // Regression tests for robustness fixes
  it("returns a defensive copy of peers so external mutation does not affect state", () => {
    m.receive({ kind: "callState", callId: "c1", peers: [B] });
    const peers1 = m.peers;
    peers1.push("HACKED");
    // Verify the machine's internal state is unchanged
    expect(m.peers).toEqual([B]);
    // Verify subsequent calls also return uncorrupted state
    const peers2 = m.peers;
    expect(peers2).toEqual([B]);
  });

  it("returns a defensive copy of missed so external mutation does not affect state", () => {
    m.receive({ kind: "missed", from: A, fromUsername: "Alice" });
    const missed1 = m.missed;
    missed1.push({ from: B, username: "Bob" });
    // Verify the machine's internal state is unchanged
    expect(m.missed).toEqual([{ from: A, username: "Alice" }]);
    // Verify subsequent calls also return uncorrupted state
    const missed2 = m.missed;
    expect(missed2).toEqual([{ from: A, username: "Alice" }]);
  });

  it("does not let a throwing listener silence other listeners", () => {
    const events: string[] = [];
    const throwingListener = vi.fn(() => {
      throw new Error("Listener error");
    });
    const goodListener = vi.fn(() => {
      events.push("listener2");
    });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    m.onChange(throwingListener);
    m.onChange(goodListener);
    m.receive({ kind: "dialing", callId: "c1" });

    // Both listeners should have been called
    expect(throwingListener).toHaveBeenCalled();
    expect(goodListener).toHaveBeenCalled();
    // The good listener should have run despite the throwing one
    expect(events).toEqual(["listener2"]);
    // The error should have been logged
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "CallStateMachine: listener threw",
      expect.any(Error),
    );

    consoleErrorSpy.mockRestore();
  });

  it("second busy arriving while one is pending replaces the timer cleanly", () => {
    m.receive({ kind: "dialing", callId: "c1" });
    m.receive({ kind: "busy" });
    expect(m.state).toBe("busy");

    // Advance partway through the first busy timeout
    vi.advanceTimersByTime(1000);
    expect(m.state).toBe("busy");

    // A second busy arrives and replaces the timer
    m.receive({ kind: "busy" });
    expect(m.state).toBe("busy");

    // Advance 2000 more (total 3000) — the original timer would have fired at 3000
    vi.advanceTimersByTime(2000);
    // Should still be busy because the new timer started fresh
    expect(m.state).toBe("busy");

    // Advance 1000 more (total 3000 from the new timer start)
    vi.advanceTimersByTime(1000);
    // Now should be idle
    expect(m.state).toBe("idle");
  });

  it("dialing/ringing/callState arriving while busy timer is pending cancels it", () => {
    m.receive({ kind: "dialing", callId: "c1" });
    m.receive({ kind: "busy" });
    expect(m.state).toBe("busy");

    // Advance partway through the busy timeout
    vi.advanceTimersByTime(1500);
    expect(m.state).toBe("busy");

    // A dialing arrives and should cancel the busy timer
    m.receive({ kind: "dialing", callId: "c2" });
    expect(m.state).toBe("dialing");

    // Advance past where the original busy timer would have fired
    vi.advanceTimersByTime(2000);
    // Should still be dialing, not kicked back to idle by the stale busy timer
    expect(m.state).toBe("dialing");
  });

  it("ringing arriving while busy timer pending cancels it", () => {
    m.receive({ kind: "dialing", callId: "c1" });
    m.receive({ kind: "busy" });
    expect(m.state).toBe("busy");

    vi.advanceTimersByTime(1500);
    m.receive({
      kind: "ringing",
      callId: "c2",
      from: A,
      fromUsername: "Alice",
    });
    expect(m.state).toBe("ringing");

    vi.advanceTimersByTime(2000);
    expect(m.state).toBe("ringing");
  });

  it("callState arriving while busy timer pending cancels it", () => {
    m.receive({ kind: "dialing", callId: "c1" });
    m.receive({ kind: "busy" });
    expect(m.state).toBe("busy");

    vi.advanceTimersByTime(1500);
    m.receive({ kind: "callState", callId: "c2", peers: [A] });
    expect(m.state).toBe("in-call");

    vi.advanceTimersByTime(2000);
    expect(m.state).toBe("in-call");
  });

  describe("staying connected while a new ring is pending", () => {
    it("stays in-call when a dial goes out from inside a conference", () => {
      // The bug: `dialing` used to clobber `in-call`, so the user looked
      // idle-ish to the view and the hang-up button vanished — while they
      // were still very much connected to someone.
      m.receive({ kind: "callState", callId: "c1", peers: [A] });
      m.receive({ kind: "dialing", callId: "c1" });
      expect(m.state).toBe("in-call");
      expect(m.peers).toEqual([A]);
    });

    it("still goes to dialing for a first call from idle", () => {
      m.receive({ kind: "dialing", callId: "c1" });
      expect(m.state).toBe("dialing");
    });

    it("exposes who is still ringing separately from who is connected", () => {
      m.receive({
        kind: "callState",
        callId: "c1",
        peers: [A],
        ringing: [B],
      });
      expect(m.peers).toEqual([A]);
      expect(m.pending).toEqual([B]);
    });

    it("treats a callState with no ringing field as nobody pending", () => {
      m.receive({ kind: "callState", callId: "c1", peers: [A] });
      expect(m.pending).toEqual([]);
    });

    it("drops the pending entry once that party connects", () => {
      m.receive({
        kind: "callState",
        callId: "c1",
        peers: [A],
        ringing: [B],
      });
      m.receive({
        kind: "callState",
        callId: "c1",
        peers: [A, B],
        ringing: [],
      });
      expect(m.peers).toEqual([A, B]);
      expect(m.pending).toEqual([]);
    });

    it("returns a defensive copy of pending", () => {
      m.receive({
        kind: "callState",
        callId: "c1",
        peers: [A],
        ringing: [B],
      });
      m.pending.push("HACKED");
      expect(m.pending).toEqual([B]);
    });

    it("clears pending when the call ends", () => {
      m.receive({
        kind: "callState",
        callId: "c1",
        peers: [A],
        ringing: [B],
      });
      m.receive({ kind: "callEnded", callId: "c1" });
      expect(m.pending).toEqual([]);
      expect(m.state).toBe("idle");
    });

    it("does not let a busy for the refused third party tear down the live call", () => {
      // A conference is up and a pulled-in party refuses. `busy` must not
      // reset a call the user is still connected to — that is precisely how
      // the user got stranded with no hang-up button.
      m.receive({
        kind: "callState",
        callId: "c1",
        peers: [A],
        ringing: [B],
      });
      m.receive({ kind: "busy" });
      expect(m.state).toBe("in-call");
      expect(m.peers).toEqual([A]);
    });

    it("still shows busy when a first call from idle is refused", () => {
      m.receive({ kind: "dialing", callId: "c1" });
      m.receive({ kind: "busy" });
      expect(m.state).toBe("busy");
    });

    // The invariant the whole fix exists to guarantee.
    it("reports connected whenever the user has any live peer", () => {
      expect(m.connected).toBe(false);
      m.receive({ kind: "dialing", callId: "c1" });
      expect(m.connected).toBe(false);
      m.receive({ kind: "callState", callId: "c1", peers: [A] });
      expect(m.connected).toBe(true);
      // ...and it survives a fresh outgoing ring, which is the bug case.
      m.receive({ kind: "dialing", callId: "c1" });
      expect(m.connected).toBe(true);
      m.receive({ kind: "callEnded", callId: "c1" });
      expect(m.connected).toBe(false);
    });
  });
});
