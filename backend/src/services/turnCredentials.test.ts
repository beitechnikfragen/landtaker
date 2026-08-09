import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * mintTurnCredential must produce exactly what coturn's REST API scheme
 * expects: username "<expiry>:<id>", credential = base64(HMAC-SHA1(username,
 * secret)). A drift here is invisible until a real call fails ICE — coturn
 * rejects a bad credential silently from the client's point of view (ICE just
 * never gets a relay candidate), so this is pinned exactly.
 */
const mockConfig = {
  TURN_STATIC_AUTH_SECRET: undefined as string | undefined,
  TURN_URLS: "",
  TURN_CREDENTIAL_TTL_SECONDS: 6 * 3600,
};

vi.mock("../config.ts", () => ({
  get config() {
    return mockConfig;
  },
  isProduction: false,
}));

const { mintTurnCredential } = await import("./turnCredentials.ts");

beforeEach(() => {
  mockConfig.TURN_STATIC_AUTH_SECRET = "test-static-secret";
  mockConfig.TURN_URLS = "turn:turn.example.com:3478";
  mockConfig.TURN_CREDENTIAL_TTL_SECONDS = 6 * 3600;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mintTurnCredential", () => {
  it("returns null when no static secret is configured", () => {
    mockConfig.TURN_STATIC_AUTH_SECRET = undefined;
    expect(mintTurnCredential("client-1")).toBeNull();
  });

  it("returns null when no TURN URLs are configured", () => {
    mockConfig.TURN_URLS = "";
    expect(mintTurnCredential("client-1")).toBeNull();
  });

  it("username is '<unix-expiry>:<identifier>'", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const result = mintTurnCredential("client-1")!;

    const [expiryPart, idPart] = result.username.split(":");
    expect(idPart).toBe("client-1");
    // 1_700_000_000_000 ms + 6h (21600s) TTL.
    expect(Number(expiryPart)).toBe(1_700_000_000 + 6 * 3600);
  });

  it("expiry is in the future", () => {
    const before = Math.floor(Date.now() / 1000);
    const result = mintTurnCredential("client-1")!;
    const expiry = Number(result.username.split(":")[0]);
    expect(expiry).toBeGreaterThan(before);
  });

  it("credential is base64(HMAC-SHA1(username, secret))", () => {
    const result = mintTurnCredential("client-1")!;
    const expected = createHmac("sha1", "test-static-secret")
      .update(result.username)
      .digest("base64");
    expect(result.credential).toBe(expected);
  });

  it("a different secret produces a different credential for the same username", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const a = mintTurnCredential("client-1")!;

    mockConfig.TURN_STATIC_AUTH_SECRET = "a-different-secret";
    const b = mintTurnCredential("client-1")!;

    expect(a.username).toBe(b.username);
    expect(a.credential).not.toBe(b.credential);
  });

  it("parses comma-separated TURN_URLS, trimming whitespace", () => {
    mockConfig.TURN_URLS = "turn:a.example.com:3478, turns:a.example.com:5349";
    const result = mintTurnCredential("client-1")!;
    expect(result.urls).toEqual([
      "turn:a.example.com:3478",
      "turns:a.example.com:5349",
    ]);
  });

  it("strips ':' from the identifier so the username stays two-part", () => {
    const result = mintTurnCredential("weird:client:id")!;
    const parts = result.username.split(":");
    // expiry + sanitized identifier, no extra ':' introduced by the identifier.
    expect(parts.length).toBe(2);
    expect(parts[1]).toBe("weird_client_id");
  });

  it("bounds an oversized identifier", () => {
    const result = mintTurnCredential("x".repeat(500))!;
    const idPart = result.username.split(":")[1]!;
    expect(idPart.length).toBeLessThanOrEqual(128);
  });
});
