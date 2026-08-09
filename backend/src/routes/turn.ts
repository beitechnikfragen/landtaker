import type { TurnCredentialsResponse } from "@game/ApiSchemas.ts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { optionalAuth } from "../plugins/auth.ts";
import { checkRateLimit, type RateLimitTier } from "../services/rateLimit.ts";
import { mintTurnCredential } from "../services/turnCredentials.ts";

/**
 * GET /phone/turn-credentials — mints short-lived TURN credentials for the
 * in-game phone (see src/client/phone/PhoneTransport.ts and
 * services/turnCredentials.ts for the scheme).
 *
 * Reachable by guests, same reasoning as /feedback: the phone works without
 * an account, so gating this behind requireAuth would leave every guest
 * caller STUN-only. That openness is exactly what the rate limit guards
 * against — this endpoint does no DB/network work per call (it's a local
 * HMAC), so the limit exists purely to stop it being scraped for free relay
 * access rather than to protect an expensive resource.
 */

const ClientIdQuerySchema = z.object({
  // Whatever PhoneTransport passes as `myId` (src/core/Schemas.ts ClientID is
  // an unconstrained string in practice). Bounded so a hostile value can't
  // bloat the rate-limit key or the minted username.
  clientId: z.string().min(1).max(128),
});

/**
 * One shared limit regardless of account status: unlike /feedback there is no
 * meaningful "member vs guest" distinction here, since the credential itself
 * doesn't identify an account. A phone call mints at most one credential (the
 * client caches it for its lifetime — see PhoneTransport), so double-digit
 * requests per window is already generous headroom for reconnects.
 */
const TIERS: RateLimitTier[] = [
  { limit: 10, windowSeconds: 60 },
  { limit: 60, windowSeconds: 3600 },
];

/** STUN-only shape: same schema, empty/blank fields. */
const NO_TURN_RESPONSE: TurnCredentialsResponse = {
  urls: [],
  username: "",
  credential: "",
};

export async function registerTurnRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/phone/turn-credentials",
    { preHandler: optionalAuth },
    async (request, reply) => {
      const parsed = ClientIdQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_client_id" });
      }

      // Prefer the account when we have one (exact, unspoofable); fall back
      // to IP for guests. Mirrors /feedback's limitKey reasoning.
      const limitKey = request.userId ?? request.ip ?? "unknown";
      const limit = await checkRateLimit(
        "phone-turn-credentials",
        limitKey,
        TIERS,
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

      const minted = mintTurnCredential(parsed.data.clientId);
      return reply.send(minted ?? NO_TURN_RESPONSE);
    },
  );
}
