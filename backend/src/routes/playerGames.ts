import type { FastifyInstance } from "fastify";
import {
  findUserIdByPublicId,
  listPlayerGames,
  normalizeLimit,
} from "../services/playerGames.ts";

/**
 * Public match history for one account.
 *
 * Public on purpose: the client shows this on any player's profile, and the
 * payload carries nothing the game does not already display in a lobby.
 */
export async function registerPlayerGamesRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get<{
    Params: { publicId: string };
    Querystring: { limit?: string; cursor?: string };
  }>("/public/player/:publicId/games", async (request, reply) => {
    const publicId = request.params.publicId?.trim();
    if (!publicId || publicId.length > 128) {
      return reply.code(400).send({ error: "invalid_public_id" });
    }

    const userId = await findUserIdByPublicId(publicId);
    // An account with no games and a non-existent account both answer with an
    // empty page: 404 here would let anyone probe which ids exist, and the
    // client renders both the same way regardless.
    if (!userId) {
      return reply
        .header("cache-control", "public, max-age=30")
        .send({ results: [], nextCursor: null });
    }

    const page = await listPlayerGames(
      userId,
      normalizeLimit(request.query.limit),
      request.query.cursor,
    );
    return reply.header("cache-control", "public, max-age=30").send(page);
  });
}
