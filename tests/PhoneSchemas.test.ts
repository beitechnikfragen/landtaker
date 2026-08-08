import { describe, expect, it } from "vitest";
import { ClientMessageSchema, ServerMessageSchema } from "../src/core/Schemas";

describe("phone schemas", () => {
  it("accepts a dial message", () => {
    const result = ClientMessageSchema.safeParse({
      type: "phone",
      payload: { kind: "dial", target: "abcd1234" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a mode change", () => {
    const result = ClientMessageSchema.safeParse({
      type: "phone",
      payload: { kind: "setMode", mode: "dnd" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown mode", () => {
    const result = ClientMessageSchema.safeParse({
      type: "phone",
      payload: { kind: "setMode", mode: "invisible" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts an SDP signal with a bounded payload", () => {
    const result = ClientMessageSchema.safeParse({
      type: "phone",
      payload: {
        kind: "signal",
        to: "abcd1234",
        data: JSON.stringify({ type: "offer", sdp: "v=0" }),
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an oversized signal payload", () => {
    const result = ClientMessageSchema.safeParse({
      type: "phone",
      payload: { kind: "signal", to: "abcd1234", data: "x".repeat(20001) },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a server ringing message", () => {
    const result = ServerMessageSchema.safeParse({
      type: "phone",
      payload: {
        kind: "ringing",
        callId: "call-1",
        from: "abcd1234",
        fromUsername: "Alice",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a server busy message", () => {
    const result = ServerMessageSchema.safeParse({
      type: "phone",
      payload: { kind: "busy" },
    });
    expect(result.success).toBe(true);
  });
});
