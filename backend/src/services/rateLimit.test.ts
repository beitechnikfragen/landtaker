import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The limiter is a thin wrapper over Redis, so these tests mock ioredis
 * rather than requiring a live server. What is worth testing is the policy:
 * when we refuse, what we report as the retry delay, and — most importantly —
 * that a Redis outage does not silently close the endpoint.
 */
const mockRedis = {
  get: vi.fn(),
  incr: vi.fn(),
  expire: vi.fn(),
  ttl: vi.fn(),
};

vi.mock("../redis.ts", () => ({ redis: mockRedis }));

const { checkRateLimit } = await import("./rateLimit.ts");

const BURST = { limit: 3, windowSeconds: 600 };
const DAILY = { limit: 20, windowSeconds: 86400 };

beforeEach(() => {
  vi.clearAllMocks();
  mockRedis.get.mockResolvedValue(null);
  mockRedis.incr.mockResolvedValue(1);
  mockRedis.expire.mockResolvedValue(1);
  mockRedis.ttl.mockResolvedValue(600);
});

describe("checkRateLimit", () => {
  it("allows a first request and starts the window", async () => {
    const result = await checkRateLimit("feedback", "user-1", [BURST]);

    expect(result.allowed).toBe(true);
    expect(mockRedis.incr).toHaveBeenCalledWith(
      "ratelimit:feedback:600:user-1",
    );
    // EXPIRE only on the first increment, or the window would slide forever.
    expect(mockRedis.expire).toHaveBeenCalledWith(
      "ratelimit:feedback:600:user-1",
      600,
    );
  });

  it("does not reset the window on later requests", async () => {
    mockRedis.get.mockResolvedValue("1");
    mockRedis.incr.mockResolvedValue(2);

    const result = await checkRateLimit("feedback", "user-1", [BURST]);

    expect(result.allowed).toBe(true);
    expect(mockRedis.expire).not.toHaveBeenCalled();
  });

  it("refuses once the limit is reached and reports the TTL", async () => {
    mockRedis.get.mockResolvedValue("3");
    mockRedis.ttl.mockResolvedValue(412);

    const result = await checkRateLimit("feedback", "user-1", [BURST]);

    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(412);
    // A refused request must not consume budget, or the window would extend
    // itself every time an already-blocked user retried.
    expect(mockRedis.incr).not.toHaveBeenCalled();
  });

  it("reports the longer TTL when both tiers are exhausted", async () => {
    // Burst full (10 min left) and daily full (6 h left). Advertising the
    // burst TTL would promise a retry that the daily tier still refuses.
    mockRedis.get.mockImplementation(async (key: string) =>
      key.endsWith(":600:user-1") ? "3" : "20",
    );
    mockRedis.ttl.mockImplementation(async (key: string) =>
      key.endsWith(":600:user-1") ? 600 : 21600,
    );

    const result = await checkRateLimit("feedback", "user-1", [BURST, DAILY]);

    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(21600);
  });

  it("fails OPEN when Redis is unavailable", async () => {
    // Deliberate policy, not an oversight: a Redis blip must not block all
    // feedback. See the spec's "Redis unavailable" decision.
    mockRedis.get.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await checkRateLimit("feedback", "user-1", [BURST]);

    expect(result.allowed).toBe(true);
    expect(result.retryAfterSeconds).toBe(0);
  });

  it("keys tiers separately so windows cannot collide", async () => {
    await checkRateLimit("feedback", "user-1", [BURST, DAILY]);

    expect(mockRedis.incr).toHaveBeenCalledWith(
      "ratelimit:feedback:600:user-1",
    );
    expect(mockRedis.incr).toHaveBeenCalledWith(
      "ratelimit:feedback:86400:user-1",
    );
  });
});
