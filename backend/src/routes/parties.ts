import { Duos, HumansVsNations, Quads, Trios } from "@game/game/Game.ts";
import { fixedTeamSize, partyFitsLobby } from "@game/game/TeamAssignment.ts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireAuth } from "../plugins/auth.ts";
import {
  createParty,
  getPartyForUser,
  joinPartyByCode,
  kickFromParty,
  leaveParty,
  MAX_PARTY_SIZE,
  type PartyError,
} from "../services/parties.ts";

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

  app.post("/parties", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = CreateBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: z.prettifyError(parsed.error) });
    }
    const result = await createParty(request.userId!, parsed.data);
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
      return result.ok
        ? reply.send({ party: result.value })
        : sendError(reply, result.error);
    },
  );
}
