import type { FastifyInstance } from "fastify";
import type { InjectPayload } from "light-my-request";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level tests: the services are mocked, so what is under test is the
 * HTTP contract — status codes, which guard runs first, and what reaches the
 * service layer. The services' own behaviour is covered by their unit tests.
 *
 * Fastify's `app.inject()` exercises the real routing, schema parsing and
 * preHandler chain without opening a socket.
 */
const mockCreateFeedbackReport = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockVerifyTurnstileToken = vi.fn();
const mockIsTurnstileConfigured = vi.fn();

vi.mock("../services/feedback.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/feedback.ts")>();
  return {
    ...actual,
    createFeedbackReport: mockCreateFeedbackReport,
  };
});

vi.mock("../services/rateLimit.ts", () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock("../services/turnstile.ts", () => ({
  verifyTurnstileToken: mockVerifyTurnstileToken,
  isTurnstileConfigured: mockIsTurnstileConfigured,
}));

// Guests are the default subject here; the userId path is covered separately.
vi.mock("../plugins/auth.ts", () => ({
  optionalAuth: vi.fn(async () => {}),
  requireAuth: vi.fn(async () => {}),
  requireApiKey: vi.fn(async () => {}),
}));

const Fastify = (await import("fastify")).default;
const { registerFeedbackRoutes } = await import("./feedback.ts");

let app: FastifyInstance;

const VALID_BODY = {
  type: "bug",
  message: "The map does not load after the third round.",
  turnstileToken: "token-abc",
};

beforeEach(async () => {
  vi.clearAllMocks();
  mockCreateFeedbackReport.mockResolvedValue({ id: "report-1" });
  mockCheckRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  mockVerifyTurnstileToken.mockResolvedValue("passed");
  mockIsTurnstileConfigured.mockReturnValue(true);

  app = Fastify();
  await registerFeedbackRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function post(payload: InjectPayload) {
  return app.inject({ method: "POST", url: "/feedback", payload });
}

describe("POST /feedback validation", () => {
  it("stores a valid guest report and returns 201 with an id", async () => {
    const response = await post(VALID_BODY);

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ id: "report-1" });
  });

  it("rejects a message below the minimum length", async () => {
    const response = await post({ ...VALID_BODY, message: "broken" });

    expect(response.statusCode).toBe(400);
    expect(mockCreateFeedbackReport).not.toHaveBeenCalled();
  });

  it("rejects a message above the maximum length", async () => {
    const response = await post({ ...VALID_BODY, message: "x".repeat(4001) });

    expect(response.statusCode).toBe(400);
  });

  it("rejects an unknown type", async () => {
    const response = await post({ ...VALID_BODY, type: "feature-request" });

    expect(response.statusCode).toBe(400);
  });

  it("accepts idea and other as types", async () => {
    for (const type of ["idea", "other"]) {
      const response = await post({ ...VALID_BODY, type });
      expect(response.statusCode).toBe(201);
    }
  });

  it("trims a message that is only whitespace past the minimum", async () => {
    // "     hi     " is 12 chars but 2 of content. Length is checked after
    // trimming, or padding would defeat the floor entirely.
    const response = await post({ ...VALID_BODY, message: "     hi     " });

    expect(response.statusCode).toBe(400);
  });
});

describe("POST /feedback turnstile", () => {
  it("returns 403 when the token is rejected", async () => {
    mockVerifyTurnstileToken.mockResolvedValue("failed");

    const response = await post(VALID_BODY);

    expect(response.statusCode).toBe(403);
    expect(mockCreateFeedbackReport).not.toHaveBeenCalled();
  });

  it("accepts the report when verification is unavailable", async () => {
    // Fail open: our outage must not close the only feedback channel.
    mockVerifyTurnstileToken.mockResolvedValue("unavailable");

    const response = await post(VALID_BODY);

    expect(response.statusCode).toBe(201);
  });

  it("skips verification entirely when no secret is configured", async () => {
    mockIsTurnstileConfigured.mockReturnValue(false);

    const response = await post({ type: "bug", message: VALID_BODY.message });

    expect(response.statusCode).toBe(201);
    expect(mockVerifyTurnstileToken).not.toHaveBeenCalled();
  });

  it("returns 403 for a guest with no token when configured", async () => {
    mockVerifyTurnstileToken.mockResolvedValue("failed");

    const response = await post({ type: "bug", message: VALID_BODY.message });

    expect(response.statusCode).toBe(403);
  });
});

describe("POST /feedback rate limiting", () => {
  it("returns 429 with Retry-After when limited", async () => {
    mockCheckRateLimit.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 480,
    });

    const response = await post(VALID_BODY);

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("480");
    expect(response.json().retryAfterSeconds).toBe(480);
    expect(mockCreateFeedbackReport).not.toHaveBeenCalled();
  });

  it("applies the guest limits for an unauthenticated caller", async () => {
    await post(VALID_BODY);

    const [namespace, , tiers] = mockCheckRateLimit.mock.calls[0]!;
    expect(namespace).toBe("feedback");
    expect(tiers).toEqual([
      { limit: 2, windowSeconds: 600 },
      { limit: 5, windowSeconds: 86400 },
    ]);
  });

  it("checks the rate limit before verifying Turnstile", async () => {
    // Cheap local check before a paid network round trip: a flooding client
    // must not be able to make us call Cloudflare once per request.
    mockCheckRateLimit.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 60,
    });

    await post(VALID_BODY);

    expect(mockVerifyTurnstileToken).not.toHaveBeenCalled();
  });
});

/**
 * The authenticated path. optionalAuth is mocked to populate request.userId,
 * which is exactly what the real one does when a valid bearer token arrives.
 */
describe("POST /feedback for a logged-in user", () => {
  beforeEach(async () => {
    await app.close();
    const auth = await import("../plugins/auth.ts");
    vi.mocked(auth.optionalAuth).mockImplementation(async (request: any) => {
      request.userId = "11111111-1111-1111-1111-111111111111";
    });
    app = Fastify();
    await registerFeedbackRoutes(app);
    await app.ready();
  });

  it("stores the report against the account", async () => {
    await post(VALID_BODY);

    expect(mockCreateFeedbackReport).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "11111111-1111-1111-1111-111111111111",
      }),
    );
  });

  it("skips Turnstile entirely for a member", async () => {
    // A member already has a bannable account, so the challenge buys nothing
    // and only adds a way for a genuine report to fail.
    await post(VALID_BODY);

    expect(mockVerifyTurnstileToken).not.toHaveBeenCalled();
  });

  it("drops contactEmail rather than rejecting it", async () => {
    // Their account is contactable already, so an address here is just
    // another copy of their PII. A 400 would lose the report over a field
    // the user did not even fill in deliberately.
    const response = await post({
      ...VALID_BODY,
      contactEmail: "someone@example.com",
    });

    expect(response.statusCode).toBe(201);
    expect(mockCreateFeedbackReport).toHaveBeenCalledWith(
      expect.objectContaining({ contactEmail: null }),
    );
  });

  it("applies the member limits, not the guest ones", async () => {
    await post(VALID_BODY);

    const [, key, tiers] = mockCheckRateLimit.mock.calls[0]!;
    // Keyed on the account: exact, and unaffected by an IP change or a
    // shared NAT address.
    expect(key).toBe("11111111-1111-1111-1111-111111111111");
    expect(tiers).toEqual([
      { limit: 3, windowSeconds: 600 },
      { limit: 20, windowSeconds: 86400 },
    ]);
  });
});
