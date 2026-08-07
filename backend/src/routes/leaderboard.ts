import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  fetchRankedLeaderboard,
  fetchTribeLeaderboard,
  isValidRankedPage,
  pageBoundsMessage,
} from "../services/leaderboard.ts";

/**
 * `page` arrives as a query string. Coerced rather than declared a number so
 * "1" parses; a missing page means the first one, which is what a client that
 * omits the parameter expects.
 */
const PageQuerySchema = z.object({
  page: z.coerce.number().int().default(1),
});

export async function registerLeaderboardRoutes(
  app: FastifyInstance,
): Promise<void> {
  /**
   * GET /leaderboard/ranked?page=N
   *
   * Public — the board is shown on the main menu before sign-in. Must satisfy
   * RankedLeaderboardResponseSchema; the client drops a response that fails to
   * parse without telling the player, so the shape is pinned by a test against
   * the game's own schema (leaderboard.test.ts).
   *
   * A page past the end answers 400 with a specific message rather than an
   * empty page. That is not a preference: the client distinguishes "end of
   * board" from "request failed" purely by matching that message
   * (isPageBoundsMessage in src/client/Api.ts), and an empty 200 would instead
   * be read as a real but empty ladder.
   */
  app.get("/leaderboard/ranked", async (request, reply) => {
    const parsed = PageQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success || !isValidRankedPage(parsed.data.page)) {
      return reply.code(400).send({ message: pageBoundsMessage() });
    }

    return reply.send(await fetchRankedLeaderboard(parsed.data.page));
  });

  /**
   * GET /leaderboard/tribes?page=N
   *
   * Public. Custom tribe names are not implemented in this backend, so this
   * serves an empty-but-valid board — see fetchTribeLeaderboard for why an
   * empty 200 beats a 404 here. `page` is accepted and ignored: every page of
   * an empty board is empty, and rejecting the parameter would break the
   * client's two-page walk.
   */
  app.get("/leaderboard/tribes", async (_request, reply) =>
    reply.send(fetchTribeLeaderboard()),
  );
}
