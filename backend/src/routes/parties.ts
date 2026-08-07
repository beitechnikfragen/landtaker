import { Duos, HumansVsNations, Quads, Trios } from "@game/game/Game.ts";
import { fixedTeamSize, partyFitsLobby } from "@game/game/TeamAssignment.ts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireApiKey, requireAuth } from "../plugins/auth.ts";
import {
  createParty,
  getPartyForUser,
  joinPartyByCode,
  kickFromParty,
  leaveParty,
  listPartyMemberPublicIds,
  MAX_PARTY_SIZE,
  type PartyError,
} from "../services/parties.ts";
import { publishPartyChanged } from "../services/partyEvents.ts";

const CreateBodySchema = z.object({
  isOpen: z.boolean().default(false),
  maxMembers: z.number().int().min(2).max(MAX_PARTY_SIZE).optional(),
});

const JoinBodySchema = z.object({
  inviteCode: z.string().min(4).max(12),
});

const KickBodySchema = z.object({
  userId: z.uuid(),
});

/**
 * Lobby shape for the fit check. `teamCount` mirrors the game's
 * TeamCountConfig: a number means "that many teams" (seats vary with the
 * player count), while Duos/Trios/Quads pin the seats per team.
 */
const FitQuerySchema = z.object({
  teamCount: z.union([
    z.coerce.number().int().positive(),
    z.enum([Duos, Trios, Quads, HumansVsNations]),
  ]),
});

/**
 * Maps a domain error to a status code. Kept in one place so every route
 * answers the same way for the same condition.
 */
const STATUS: Record<PartyError, number> = {
  already_in_party: 409,
  not_found: 404,
  party_full: 409,
  not_a_member: 404,
  not_leader: 403,
  closed: 403,
};

function sendError(reply: FastifyReply, error: PartyError) {
  return reply.code(STATUS[error]).send({ error });
}

export async function registerPartyRoutes(app: FastifyInstance): Promise<void> {
  /** The caller's current party, or null. */
  app.get("/parties/@me", { preHandler: requireAuth }, async (request, reply) =>
    reply.send({ party: await getPartyForUser(request.userId!) }),
  );

  /**
   * GET /parties/@me/fit?teamCount=...
   *
   * Answers whether the caller's party can be seated together in a lobby of
   * the given shape, so the client can refuse the join up front with a clear
   * reason instead of someone getting kicked or split once the match starts.
   *
   * Callers not in a party always fit — there is nothing to keep together.
   */
  app.get(
    "/parties/@me/fit",
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = FitQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "teamCount is required" });
      }

      const party = await getPartyForUser(request.userId!);
      if (!party) return reply.send({ fits: true, partySize: 0, seats: null });

      const seats = fixedTeamSize(parsed.data.teamCount);
      return reply.send({
        fits: partyFitsLobby(party.members.length, parsed.data.teamCount),
        partySize: party.members.length,
        // null when the lobby's team size depends on the final player count, so
        // the client can word the message as a limit rather than a guess.
        seats,
      });
    },
  );

  /**
   * GET /parties/members?publicId=... — server-to-server.
   *
   * The game server calls this at join time to learn who a player is partied
   * with, so it can bias team assignment (JoinVerify.fetchPartyMembers).
   * Guarded by the api key rather than a bearer token: the caller is our own
   * game server acting for a player it is not authenticated as.
   *
   * Returns publicIds only — the game server never sees internal account ids.
   */
  app.get<{ Querystring: { publicId?: string } }>(
    "/parties/members",
    { preHandler: requireApiKey },
    async (request, reply) => {
      const publicId = request.query.publicId;
      if (!publicId) {
        return reply.code(400).send({ error: "publicId is required" });
      }
      return reply.send({
        publicIds: await listPartyMemberPublicIds(publicId),
      });
    },
  );

  app.post("/parties", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = CreateBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: z.prettifyError(parsed.error) });
    }
    const result = await createParty(request.userId!, parsed.data);
    // Notify after the mutation commits, never before — a subscriber that
    // re-reads on notify would otherwise see the pre-change state.
    // publishPartyChanged swallows its own errors, so a Redis outage costs
    // live updates but never the party action itself.
    if (result.ok) await publishPartyChanged(result.value.id);
    return result.ok
      ? reply.code(201).send({ party: result.value })
      : sendError(reply, result.error);
  });

  app.post(
    "/parties/join",
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = JoinBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "inviteCode is required" });
      }
      const result = await joinPartyByCode(
        request.userId!,
        parsed.data.inviteCode,
      );
      if (result.ok) await publishPartyChanged(result.value.id);
      return result.ok
        ? reply.send({ party: result.value })
        : sendError(reply, result.error);
    },
  );

  app.post(
    "/parties/leave",
    { preHandler: requireAuth },
    async (request, reply) => {
      const result = await leaveParty(request.userId!);
      // leaveParty returns { partyId, deleted }, not a party. Leadership
      // transfer and deletion both happen inside it, so this one notify
      // covers every outcome — remaining members re-read and see whichever
      // it was.
      if (result.ok) await publishPartyChanged(result.value.partyId);
      return result.ok
        ? reply.send(result.value)
        : sendError(reply, result.error);
    },
  );

  app.post(
    "/parties/kick",
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = KickBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "userId is required" });
      }
      const result = await kickFromParty(request.userId!, parsed.data.userId);
      if (result.ok) await publishPartyChanged(result.value.id);
      return result.ok
        ? reply.send({ party: result.value })
        : sendError(reply, result.error);
    },
  );
}
