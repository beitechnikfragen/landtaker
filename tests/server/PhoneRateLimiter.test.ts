import { describe, expect, it } from "vitest";
import { ClientMsgRateLimiter } from "../../src/server/ClientMsgRateLimiter";

const CLIENT_A = "clientA" as any;
const CLIENT_B = "clientB" as any;
const SMALL = 100;

describe("ClientMsgRateLimiter phone messages", () => {
  it("allows phone messages within limits", () => {
    const limiter = new ClientMsgRateLimiter();
    expect(limiter.check(CLIENT_A, "phone", SMALL)).toBe("ok");
  });

  it("allows a burst of signaling (ICE candidates arrive in clusters)", () => {
    const limiter = new ClientMsgRateLimiter();
    for (let i = 0; i < 30; i++) {
      expect(limiter.check(CLIENT_A, "phone", SMALL)).toBe("ok");
    }
  });

  it("limits sustained phone flooding", () => {
    const limiter = new ClientMsgRateLimiter();
    for (let i = 0; i < 30; i++) {
      limiter.check(CLIENT_A, "phone", SMALL);
    }
    expect(limiter.check(CLIENT_A, "phone", SMALL)).toBe("limit");
  });

  it("kicks oversized phone messages", () => {
    const limiter = new ClientMsgRateLimiter();
    expect(limiter.check(CLIENT_A, "phone", 30001)).toBe("kick");
  });

  it("phone limits are per client", () => {
    const limiter = new ClientMsgRateLimiter();
    for (let i = 0; i < 30; i++) {
      limiter.check(CLIENT_A, "phone", SMALL);
    }
    expect(limiter.check(CLIENT_B, "phone", SMALL)).toBe("ok");
  });

  it("phone traffic does not consume the intent budget", () => {
    const limiter = new ClientMsgRateLimiter();
    for (let i = 0; i < 30; i++) {
      limiter.check(CLIENT_A, "phone", SMALL);
    }
    expect(limiter.check(CLIENT_A, "intent", SMALL)).toBe("ok");
  });
});
