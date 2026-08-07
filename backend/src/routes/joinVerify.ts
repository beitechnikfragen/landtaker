import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireApiKey } from "../plugins/auth.ts";
import { type JoinVerdict, verifyJoin } from "../services/joinVerify.ts";

/**
 * The body the game server sends (src/server/JoinVerify.ts, `verifyJoin`):
 * `JSON.stringify({ ip, token, username, clanTag })`.
 *
 * Everything except `username` is permissive on purpose. `token` is null for
 * a re-admit, `clanTag` is null when the player has none, and `ip` is
 * whatever the game server resolved behind its proxy chain — none of those
 * are worth a 400, because a 400 here reads to the game as a hard failure at
 * the exact moment a player is trying to join.
 *
 * `username` is required and bounded: it is the only field we key a database
 * lookup on, so an absent or multi-kilobyte value must not reach a query.
 * Note this bound is a guard against junk, not a name policy — the game
 * validates names itself before it ever calls us.
 */
const MAX_USERNAME_LENGTH = 128;
const MAX_CLAN_TAG_INPUT_LENGTH = 64;

const JoinVerifyBodySchema = z.object({
  ip: z.string().max(64).nullish(),
  token: z.string().max(4096).nullish(),
  username: z.string().min(1).max(MAX_USERNAME_LENGTH),
  clanTag: z.string().max(MAX_CLAN_TAG_INPUT_LENGTH).nullish(),
});

export async function registerJoinVerifyRoutes(
  app: FastifyInstance,
): Promise<void> {
  /**
   * POST /join_verify
   *
   * Called for every player joining every match, with a 5s client timeout.
   *
   * Status codes matter more than usual here, because the game maps ANY
   * non-200 — and any 200 whose body it cannot parse — to `status:"error"`,
   * then fails open with its own locally censored name. So:
   *
   *   200 + approved/rejected  the only answers that actually decide anything
   *   401                      wrong/missing api key; not the game server
   *   400                      body we cannot read at all (never a 500)
   *
   * A malformed body returns 400 rather than throwing, so a garbage request
   * can never become an unhandled error and a 500 in the join path.
   */
  app.post(
    "/join_verify",
    { preHandler: requireApiKey },
    async (request, reply) => {
      const parsed = JoinVerifyBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        // Deliberately NOT a 500 and NOT a rejection. The game reads this as
        // "error" and admits the player with its own screened name, which is
        // the right outcome for a request we could not understand.
        request.log.warn(
          { issues: parsed.error.issues },
          "join_verify: unreadable body",
        );
        return reply.code(400).send({ error: "invalid_body" });
      }

      const { ip, token, username, clanTag } = parsed.data;

      let verdict: JoinVerdict;
      try {
        verdict = await verifyJoin({
          ip: ip ?? null,
          token: token ?? null,
          username,
          clanTag: clanTag ?? null,
        });
      } catch (err) {
        // FAIL OPEN. See the long note on verifyJoin in services/joinVerify.ts:
        // this endpoint sits in the join path of every player, and a database
        // hiccup must not become a game-wide outage. We approve with the name
        // we were given and log at error level so the incident is visible —
        // the ban we may have just missed is still in the database and applies
        // again the moment we are healthy.
        //
        // Note that failing closed would not even reject anyone: the game maps
        // a 500 to "error" and admits the player regardless. A 200 here is the
        // same outcome, minus the misleading error on the game's side.
        request.log.error(
          { err, username },
          "join_verify: check failed, approving anyway (fail-open)",
        );
        verdict = { status: "approved", username, clanTag: clanTag ?? null };
      }

      // Shape is fixed by JoinVerifyVerdictSchema in src/server/JoinVerify.ts.
      // The approved arm must carry `username`; `clanTag` is nullable there,
      // and the game normalises undefined to null itself.
      return reply.send(verdict);
    },
  );
}
