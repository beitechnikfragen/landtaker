import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * These tests own the mapping from Cloudflare's answer to our verdict. The
 * distinction that matters throughout is "failed" (Cloudflare rejected the
 * token) versus "unavailable" (we never got an answer) — callers respond to
 * those in opposite ways, so collapsing them into a boolean would be a bug.
 */
const mockConfig = { TURNSTILE_SECRET_KEY: undefined as string | undefined };

vi.mock("../config.ts", () => ({
  get config() {
    return mockConfig;
  },
  isProduction: false,
}));

const { verifyTurnstileToken, isTurnstileConfigured } =
  await import("./turnstile.ts");

beforeEach(() => {
  mockConfig.TURNSTILE_SECRET_KEY = "test-secret";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("isTurnstileConfigured", () => {
  it("is false without a secret", () => {
    mockConfig.TURNSTILE_SECRET_KEY = undefined;
    expect(isTurnstileConfigured()).toBe(false);
  });

  it("is true with a secret", () => {
    expect(isTurnstileConfigured()).toBe(true);
  });
});

describe("verifyTurnstileToken", () => {
  it("returns unavailable when no secret is configured", async () => {
    mockConfig.TURNSTILE_SECRET_KEY = undefined;

    // Not "failed": we have no basis to reject a token we cannot check.
    expect(await verifyTurnstileToken("some-token", null)).toBe("unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns failed for a null token when configured", async () => {
    // A configured deployment that receives no token has been given nothing
    // to verify — that is a rejection, not an outage.
    expect(await verifyTurnstileToken(null, null)).toBe("failed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns passed when Cloudflare accepts the token", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);

    expect(await verifyTurnstileToken("good-token", "203.0.113.5")).toBe(
      "passed",
    );
  });

  it("sends the secret, token and remote IP to siteverify", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);

    await verifyTurnstileToken("good-token", "203.0.113.5");

    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toContain("challenges.cloudflare.com");
    const body = init!.body as URLSearchParams;
    expect(body.get("secret")).toBe("test-secret");
    expect(body.get("response")).toBe("good-token");
    expect(body.get("remoteip")).toBe("203.0.113.5");
  });

  it("returns failed when Cloudflare rejects the token", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: false,
        "error-codes": ["invalid-input-response"],
      }),
    } as Response);

    expect(await verifyTurnstileToken("bad-token", null)).toBe("failed");
  });

  it("returns unavailable when siteverify is unreachable", async () => {
    // Cloudflare being down is our problem, not the player's.
    vi.mocked(fetch).mockRejectedValue(new Error("ENOTFOUND"));

    expect(await verifyTurnstileToken("good-token", null)).toBe("unavailable");
  });

  it("returns unavailable on a non-200 from siteverify", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({}),
    } as Response);

    expect(await verifyTurnstileToken("good-token", null)).toBe("unavailable");
  });

  it("returns unavailable when siteverify times out", async () => {
    // AbortController surfaces as an AbortError from fetch; it must map to
    // unavailable rather than failed, or a slow network would look like fraud.
    vi.mocked(fetch).mockRejectedValue(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    );

    expect(await verifyTurnstileToken("good-token", null)).toBe("unavailable");
  });
});
