import { redis } from "../redis.ts";

/**
 * A generic fixed-window rate limiter over Redis. Deliberately knows nothing
 * about feedback: the same limiter should serve any endpoint that needs one,
 * and an abstraction shaped around its first caller is the harder one to
 * reuse later.
 *
 * Fixed windows rather than a sliding log because the counters are cheap
 * (one INCR) and the failure mode is generous: a user can send up to 2x the
 * limit across a window boundary. For feedback that is entirely acceptable —
 * the limit exists to stop floods, not to be exact.
 */

export interface RateLimitTier {
  limit: number;
  /** Doubles as part of the Redis key, so two tiers never share a counter. */
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** 0 when allowed. Otherwise the longest wait across exhausted tiers. */
  retryAfterSeconds: number;
}

function keyFor(namespace: string, tier: RateLimitTier, key: string): string {
  return `ratelimit:${namespace}:${tier.windowSeconds}:${key}`;
}

/**
 * Checks every tier before incrementing any of them.
 *
 * The two-pass shape matters: incrementing as we go would let a request that
 * is about to be refused by the daily tier still consume burst budget, so a
 * blocked user's retries would keep their burst window permanently full.
 *
 * FAILS OPEN. If Redis is unreachable the request is allowed. This endpoint is
 * a low-value target and losing all feedback during a cache blip is the worse
 * outcome; the alternative is an outage that looks like a product decision.
 */
export async function checkRateLimit(
  namespace: string,
  key: string,
  tiers: RateLimitTier[],
): Promise<RateLimitResult> {
  try {
    let worstRetry = 0;

    for (const tier of tiers) {
      const redisKey = keyFor(namespace, tier, key);
      const raw = await redis.get(redisKey);
      const used = raw === null ? 0 : Number.parseInt(raw, 10);

      // A corrupt value (NaN) is treated as "no usage" rather than as an
      // infinite count, so a bad key cannot permanently lock a user out.
      if (Number.isFinite(used) && used >= tier.limit) {
        const ttl = await redis.ttl(redisKey);
        // Report the LONGEST wait: a shorter one would promise a retry that
        // another exhausted tier is still going to refuse.
        worstRetry = Math.max(worstRetry, ttl > 0 ? ttl : tier.windowSeconds);
      }
    }

    if (worstRetry > 0) {
      return { allowed: false, retryAfterSeconds: worstRetry };
    }

    for (const tier of tiers) {
      const redisKey = keyFor(namespace, tier, key);
      const count = await redis.incr(redisKey);
      // Only the first increment sets the expiry. Doing it every time would
      // slide the window forward on each request, so an active user's window
      // would never end.
      if (count === 1) {
        await redis.expire(redisKey, tier.windowSeconds);
      }
    }

    return { allowed: true, retryAfterSeconds: 0 };
  } catch (err) {
    console.warn(
      `Rate limiter unavailable (${(err as Error).message}) — allowing request`,
    );
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
