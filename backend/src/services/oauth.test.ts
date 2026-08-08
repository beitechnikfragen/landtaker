import { describe, expect, it, vi } from "vitest";
import { isAllowedRedirect, signState, verifyState } from "./oauth.ts";

const ORIGIN = "http://localhost:9000";

describe("signState / verifyState", () => {
  it("round-trips the redirect uri", () => {
    const target = `${ORIGIN}/#modal=account`;
    expect(verifyState(signState(target))).toBe(target);
  });

  it("rejects a tampered payload", () => {
    const state = signState(`${ORIGIN}/`);
    const [body, mac] = state.split(".");
    const forged = Buffer.from(
      JSON.stringify({ r: "https://evil.test/", n: "x", e: Date.now() + 1000 }),
    ).toString("base64url");
    // The attacker swaps the payload but cannot recompute the MAC.
    expect(verifyState(`${forged}.${mac}`)).toBeNull();
    expect(body).not.toBe(forged);
  });

  it("rejects a missing or malformed state", () => {
    expect(verifyState(undefined)).toBeNull();
    expect(verifyState("")).toBeNull();
    expect(verifyState("nodot")).toBeNull();
    expect(verifyState(".onlymac")).toBeNull();
  });

  it("rejects an expired state", () => {
    const state = signState(`${ORIGIN}/`);
    // 10 minute TTL; jump past it.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60 * 1000);
    try {
      expect(verifyState(state)).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("isAllowedRedirect", () => {
  it("accepts an allowlisted origin regardless of path", () => {
    expect(isAllowedRedirect(ORIGIN)).toBe(true);
    expect(isAllowedRedirect(`${ORIGIN}/#modal=account`)).toBe(true);
  });

  it("rejects other origins", () => {
    expect(isAllowedRedirect("https://evil.test/")).toBe(false);
    // Same host, different port and scheme are different origins.
    expect(isAllowedRedirect("http://localhost:9001/")).toBe(false);
    expect(isAllowedRedirect("https://localhost:9000/")).toBe(false);
  });

  it("rejects values that are not absolute urls", () => {
    expect(isAllowedRedirect("/relative")).toBe(false);
    expect(isAllowedRedirect("javascript:alert(1)")).toBe(false);
    expect(isAllowedRedirect("")).toBe(false);
  });
});
