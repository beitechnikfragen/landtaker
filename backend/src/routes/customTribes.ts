import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireApiKey } from "../plugins/auth.ts";
import { buildTribePool, MAX_TRIBES } from "../services/customTribes.ts";

/**
 * The body the game server sends (src/server/CustomTribes.ts,
 * `fetchCustomTribes`): `JSON.stringify({ players: players.slice(0, 500) })`,
 * where each player is `{ clientId, publicId }` — logged-in humans only, since
 * guests cannot own tribe names.
 *
 * Everything is permissive on purpose. We do not currently key any lookup on
 * these values (see services/customTribes.ts for why the pool is empty), and
 * even once we do, a lobby containing one odd player must not cost the whole
 * game its tribe pool. Unknown per-player fields are allowed through rather
 * than stripped, mirroring the loose TribeSchema on the game's side.
 *
 * The 500 bound matches the game's own slice, and the string bounds are guards
 * against junk reaching a future query — not a name policy.
 */
const TribePoolPlayerSchema = z
  .object({
    clientId: z.string().max(256),
    publicId: z.string().max(256),
  })
  .loose();

const CustomTribesBodySchema = z.object({
  // Absent or null is treated as "no logged-in players", which is a perfectly
  // ordinary lobby (all guests) and must not be a 400.
  players: z.array(TribePoolPlayerSchema).max(500).nullish(),
});

export async function registerCustomTribeRoutes(
  app: FastifyInstance,
): Promise<void> {
  /**
   * POST /custom_tribes
   *
   * Called once per public game with bots, at prestart, with a 1.5s client
   * timeout that has to fit inside the game's 2s prestart->start window.
   *
   * The game maps ANY non-200 — and any 200 whose body its
   * CustomTribesResponseSchema cannot parse — to a thrown error, logs a
   * warning, and starts the game with organic bot names. So the only useful
   * answers are:
   *
   *   200 + {tribes:[...]}  parseable; the only thing that changes anything
   *   401                   wrong/missing api key; not the game server
   *   400                   body we cannot read at all (never a 500)
   *
   * Note that `{tribes: []}` is a SUCCESS, not a soft failure: the game keeps
   * its organic names when the pool is empty, which is the correct outcome
   * while no tribe names have been purchased. Returning an error to say
   * "nothing to give" would make the game log an outage that is not happening.
   *
   * This is intentionally cheap and synchronous — no database access at all
   * today — so it cannot contribute to the prestart budget.
   */
  app.post(
    "/custom_tribes",
    { preHandler: requireApiKey },
    async (request, reply) => {
      const parsed = CustomTribesBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        // 400 rather than an unhandled throw: a garbage request must never
        // become a 500 in the prestart path. The game treats both the same,
        // but only one of them is honest about whose fault it is.
        request.log.warn(
          { issues: parsed.error.issues },
          "custom_tribes: unreadable body",
        );
        return reply.code(400).send({ error: "invalid_body" });
      }

      const tribes = buildTribePool(parsed.data.players ?? []);

      // Belt and braces. The game rejects the whole response when the array
      // exceeds 100 (CustomTribesResponseSchema `.max(100)`), and a rejected
      // response costs the game its tribes entirely — so clamp here rather
      // than trust a future query to have got its LIMIT right.
      return reply.send({ tribes: tribes.slice(0, MAX_TRIBES) });
    },
  );
}
