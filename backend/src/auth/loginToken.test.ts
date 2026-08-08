import { describe, expect, it } from "vitest";
import { generateLoginToken, hashRefreshToken } from "./tokens.ts";

describe("generateLoginToken", () => {
  it("returns the hash of the plaintext, never the plaintext itself", () => {
    const { token, tokenHash } = generateLoginToken(15);
    // What lands in the database must not be replayable as a login.
    expect(tokenHash).toBe(hashRefreshToken(token));
    expect(tokenHash).not.toBe(token);
  });

  it("issues unguessable tokens", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateLoginToken(15).token);
    expect(seen.size).toBe(200);
    // 32 random bytes, base64url — 43 chars, no padding.
    expect([...seen][0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("expires after the requested window", () => {
    const before = Date.now();
    const { expiresAt } = generateLoginToken(15);
    const minutes = (expiresAt.getTime() - before) / 60_000;
    expect(minutes).toBeGreaterThan(14.9);
    expect(minutes).toBeLessThanOrEqual(15.1);
  });

  it("honours a short ttl", () => {
    const { expiresAt } = generateLoginToken(1);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60_500);
  });
});
