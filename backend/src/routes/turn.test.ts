import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level tests: the credential minting and rate limiter are mocked, so
 * what is under test is the HTTP contract — guard order, status codes, and
 * what reaches the service layer. mintTurnCredential's own correctness is
 * covered by turnCredentials.test.ts.
 */
const mockMintTurnCredential = vi.fn();
const mockCheckRateLimit = vi.fn();

vi.mock("../services/turnCredentials.ts", () => ({
  mintTurnCredential: mockMintTurnCredential,
}));

vi.mock("../services/rateLimit.ts", () => ({
  checkRateLimit: mockCheckRateLimit,
}));

// Guests are the default subject here; the authenticated path is covered
// separately below.
vi.mock("../plugins/auth.ts", () => ({
  optionalAuth: vi.fn(async () => {}),
  requireAuth: vi.fn(async () => {}),
  requireApiKey: vi.fn(async () => {}),
}));

const Fastify = (await import("fastify")).default;
const { registerTurnRoutes } = await import("./turn.ts");

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  mockMintTurnCredential.mockReturnValue({
    urls: ["turn:turn.example.com:3478"],
    username: "1700000000:client-1",
    credential: "fake-credential",
  });
  mockCheckRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });

  app = Fastify();
  await registerTurnRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function get(clientId?: string) {
  return app.inject({
    method: "GET",
    url:
      clientId === undefined
        ? "/phone/turn-credentials"
        : `/phone/turn-credentials?clientId=${encodeURIComponent(clientId)}`,
  });
}

describe("GET /phone/turn-credentials", () => {
  it("returns the minted credential for a valid clientId", async () => {
    const response = await get("client-1");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      urls: ["turn:turn.example.com:3478"],
      username: "1700000000:client-1",
      credential: "fake-credential",
    });
  });

  it("rejects a missing clientId", async () => {
    const response = await get(undefined);
    expect(response.statusCode).toBe(400);
    expect(mockMintTurnCredential).not.toHaveBeenCalled();
  });

  it("rejects an empty clientId", async () => {
    const response = await get("");
    expect(response.statusCode).toBe(400);
  });

  it("rejects an oversized clientId", async () => {
    const response = await get("x".repeat(200));
    expect(response.statusCode).toBe(400);
  });

  it("answers a STUN-only shaped response when TURN is not configured", async () => {
    mockMintTurnCredential.mockReturnValue(null);

    const response = await get("client-1");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      urls: [],
      username: "",
      credential: "",
    });
  });

  it("returns 429 with Retry-After when rate limited", async () => {
    mockCheckRateLimit.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 30,
    });

    const response = await get("client-1");

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("30");
    expect(mockMintTurnCredential).not.toHaveBeenCalled();
  });

  it("keys the rate limit on IP for a guest", async () => {
    await get("client-1");

    const [namespace, key] = mockCheckRateLimit.mock.calls[0]!;
    expect(namespace).toBe("phone-turn-credentials");
    expect(typeof key).toBe("string");
  });
});

describe("GET /phone/turn-credentials for a logged-in user", () => {
  beforeEach(async () => {
    await app.close();
    const auth = await import("../plugins/auth.ts");
    vi.mocked(auth.optionalAuth).mockImplementation(async (request: any) => {
      request.userId = "11111111-1111-1111-1111-111111111111";
    });
    app = Fastify();
    await registerTurnRoutes(app);
    await app.ready();
  });

  it("keys the rate limit on the account, not the IP", async () => {
    await get("client-1");

    const [, key] = mockCheckRateLimit.mock.calls[0]!;
    expect(key).toBe("11111111-1111-1111-1111-111111111111");
  });
});
