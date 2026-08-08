import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { optionalAuth } from "../plugins/auth.ts";
import {
  createFeedbackReport,
  FEEDBACK_TYPES,
  MAX_MESSAGE_LENGTH,
  MIN_MESSAGE_LENGTH,
  truncateIp,
} from "../services/feedback.ts";
import { checkRateLimit, type RateLimitTier } from "../services/rateLimit.ts";
import {
  isTurnstileConfigured,
  verifyTurnstileToken,
} from "../services/turnstile.ts";

/**
 * POST /feedback — in-game bug reports, ideas and other feedback.
 *
 * Unlike most routes here this one is reachable by guests, because a bug that
 * prevents logging in must still be reportable. That openness is what the
 * Turnstile check and the rate limit pay for.
 *
 * Guard order is deliberate: validate (free) → rate limit (one Redis round
 * trip) → Turnstile (a network call to Cloudflare) → insert. A client flooding
 * us must not be able to make us call Cloudflare once per request.
 */

/**
 * Diagnostics the client collects and shows the user before sending. Loose
 * and fully optional: it is written to a jsonb column that only a human reads,
 * so an unexpected extra field is worth keeping, and a missing one is never
 * worth losing a bug report over.
 */
const FeedbackContextSchema = z
  .object({
    clientVersion: z.string().max(128).optional(),
    userAgent: z.string().max(512).optional(),
    language: z.string().max(32).optional(),
    screen: z.string().max(32).optional(),
    instanceId: z.string().max(64).optional(),
    currentPage: z.string().max(128).optional(),
    // Present only when the report was written during a match. Declared
    // explicitly rather than left to `.loose()` so the nesting is bounded:
    // a loose object would happily accept a megabyte of arbitrary JSON here,
    // and this column is read by a human, not queried.
    match: z
      .object({
        gameID: z.string().max(128).optional(),
        source: z.string().max(32).optional(),
        map: z.string().max(64).optional(),
        gameMode: z.string().max(32).optional(),
        difficulty: z.string().max(32).optional(),
        spectating: z.boolean().optional(),
        humanPlayers: z.number().int().nonnegative().max(1000).optional(),
        elapsedSeconds: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .loose();

const FeedbackBodySchema = z.object({
  type: z.enum(FEEDBACK_TYPES),
  // Trimmed BEFORE the length check, or "          " would pass the floor.
  message: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(MIN_MESSAGE_LENGTH).max(MAX_MESSAGE_LENGTH)),
  // Guests only; dropped for authenticated users below rather than rejected.
  contactEmail: z.email().max(254).nullish(),
  turnstileToken: z.string().max(4096).nullish(),
  context: FeedbackContextSchema.nullish(),
});

/**
 * Guests are tighter than members despite shared-NAT concerns: a guest address
 * sending six reports a day is more likely abuse than a household of genuine
 * reporters, and a real player who hits the wall has an obvious remedy — log
 * in. A member is rate-limited by account, which is exact and unspoofable.
 */
const MEMBER_TIERS: RateLimitTier[] = [
  { limit: 3, windowSeconds: 600 },
  { limit: 20, windowSeconds: 86400 },
];

const GUEST_TIERS: RateLimitTier[] = [
  { limit: 2, windowSeconds: 600 },
  { limit: 5, windowSeconds: 86400 },
];

/**
 * `request.ip` already respects the proxy chain (trustProxy is on in app.ts),
 * so this is the real client address rather than nginx's.
 */
function clientIp(request: FastifyRequest): string | null {
  return request.ip.length > 0 ? request.ip : null;
}

export async function registerFeedbackRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.post(
    "/feedback",
    { preHandler: optionalAuth },
    async (request, reply) => {
      const parsed = FeedbackBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid_body", issues: parsed.error.issues });
      }

      const body = parsed.data;
      const userId = request.userId ?? null;
      const ip = clientIp(request);

      // Account when we have one: it survives an IP change and cannot be shared
      // by an entire school behind one NAT address. IP is the only handle on a
      // guest, and the key is the truncated prefix, not the raw address — a
      // raw IPv6 address would let one client cycle through its /64 (and RFC
      // 4941 privacy addresses rotate it automatically) and evade the limit
      // entirely.
      const limitKey = userId ?? truncateIp(ip) ?? ip ?? "unknown";
      const limit = await checkRateLimit(
        "feedback",
        limitKey,
        userId !== null ? MEMBER_TIERS : GUEST_TIERS,
      );

      if (!limit.allowed) {
        return reply
          .code(429)
          .header("Retry-After", String(limit.retryAfterSeconds))
          .send({
            error: "rate_limited",
            retryAfterSeconds: limit.retryAfterSeconds,
          });
      }

      // Members skip the challenge: they already have a bannable account, so a
      // captcha buys nothing and adds a way for a genuine report to fail.
      if (userId === null && isTurnstileConfigured()) {
        const verdict = await verifyTurnstileToken(
          body.turnstileToken ?? null,
          ip,
        );
        if (verdict === "failed") {
          return reply.code(403).send({ error: "captcha_failed" });
        }
        if (verdict === "unavailable") {
          // Fail open, and say so loudly: a persistent stream of these means
          // the captcha is not actually protecting anything.
          request.log.warn("feedback: turnstile unavailable, accepting anyway");
        }
      }

      try {
        const { id } = await createFeedbackReport({
          userId,
          type: body.type,
          message: body.message,
          // A member's account is already contactable, so an address here adds
          // nothing but another copy of their PII. Dropped rather than 400'd —
          // a stray field is not worth losing the report.
          contactEmail: userId === null ? (body.contactEmail ?? null) : null,
          context: body.context ?? null,
          ip,
        });
        return reply.code(201).send({ id });
      } catch (err) {
        // Unlike join_verify, failing open is not an option: there is nowhere
        // to put the report. Report the failure honestly so the client can tell
        // the user their report was NOT saved.
        request.log.error({ err }, "feedback: insert failed");
        return reply.code(500).send({ error: "internal_error" });
      }
    },
  );
}
