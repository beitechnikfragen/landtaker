import type { FastifyInstance } from "fastify";
import { getSigningKeys } from "../auth/keys.ts";

/**
 * JWKS endpoint. Both the game server and the client fetch this to verify our
 * tokens (ServerEnv.jwkPublicKey / ClientEnv). Note the game takes `keys[0]`
 * rather than matching on `kid` — during a key rotation the NEW signing key
 * must therefore be first in the array.
 */
export async function registerWellKnownRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get("/.well-known/jwks.json", async (_request, reply) => {
    const { publicJwk } = await getSigningKeys();
    // Cacheable, but briefly: a rotation should propagate in minutes.
    return reply
      .header("cache-control", "public, max-age=300")
      .send({ keys: [publicJwk] });
  });
}
