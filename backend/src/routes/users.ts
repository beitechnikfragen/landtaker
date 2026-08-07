import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import { requireAuth } from "../plugins/auth.ts";
import {
  buildUserMeResponse,
  resolveDisplayUsername,
} from "../services/users.ts";

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /player/:publicId
   *
   * Public profile shown when clicking a player. Must satisfy
   * PlayerProfileSchema. `stats` is an empty object for now — every branch of
   * PlayerStatsTree is optional, and match stats are not recorded yet (see the
   * game-archive item in the roadmap), so an empty tree is honest rather than
   * fabricated.
   */
  app.get<{ Params: { publicId: string } }>(
    "/player/:publicId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = await db.query.users.findFirst({
        where: eq(users.publicId, request.params.publicId),
      });
      if (!user) return reply.code(404).send({ error: "Player not found" });

      return reply.send({
        createdAt: user.createdAt.toISOString(),
        username: resolveDisplayUsername(user),
        stats: {},
      });
    },
  );

  /**
   * GET /users/@me
   *
   * Called by the client directly and by the game server on join
   * (src/server/jwt.ts getUserMe), which forwards the player's bearer token
   * alongside its own x-api-key. Authorization is by bearer token in both
   * cases, so the api key is not required here.
   */
  app.get("/users/@me", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.userId!;
    const response = await buildUserMeResponse(userId);
    if (!response) {
      return reply.code(404).send({ error: "User not found" });
    }

    // Best-effort liveness marker; never block the response on it.
    void db
      .update(users)
      .set({ lastSeenAt: new Date() })
      .where(eq(users.id, userId))
      .catch((err: unknown) => {
        request.log.warn({ err }, "failed to update last_seen_at");
      });

    return reply.send(response);
  });
}
