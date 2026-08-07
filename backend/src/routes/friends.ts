import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth } from "../plugins/auth.ts";
import {
  acceptFriendRequest,
  deleteFriendRequest,
  type FriendError,
  listFriendRequests,
  listFriends,
  normalizePaging,
  removeFriend,
  sendFriendRequest,
} from "../services/friends.ts";

/**
 * Maps a domain error to a status code. The client (src/client/FriendsApi.ts)
 * branches on the STATUS CODE, not the body, and only distinguishes three:
 *
 *   404 → "not_found"    the person does not exist / there is nothing to act on
 *   409 → "conflict"     the action is redundant (already friends, already sent)
 *   400 → "bad_request"  the action is nonsensical (friending yourself)
 *
 * The `error` string in the body is still emitted so logs and the smoke script
 * can tell apart two conditions that share a code.
 */
const STATUS: Record<FriendError, number> = {
  not_found: 404,
  self: 400,
  already_friends: 409,
  already_requested: 409,
  no_request: 404,
};

function sendError(reply: FastifyReply, error: FriendError) {
  return reply.code(STATUS[error]).send({ error });
}

/**
 * The `:publicId` segment is whatever the player typed into the add-friend
 * box — a publicId, a `name.1234` display name, or junk. Length is bounded
 * here so a multi-kilobyte path never reaches a query; resolution itself is an
 * exact match in the service.
 */
const MAX_IDENTIFIER_LENGTH = 128;

function identifier(params: unknown): string | null {
  const value = (params as { publicId?: unknown }).publicId;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_IDENTIFIER_LENGTH) {
    return null;
  }
  return trimmed;
}

export async function registerFriendRoutes(
  app: FastifyInstance,
): Promise<void> {
  /**
   * Incoming and outgoing pending requests. Registered before "/friends/:publicId"
   * would matter for DELETE only, but keeping the literal routes first also
   * keeps the file readable.
   */
  app.get(
    "/friends/requests",
    { preHandler: requireAuth },
    async (request, reply) =>
      reply.send(await listFriendRequests(request.userId!)),
  );

  /**
   * GET /friends?page=1&limit=20
   *
   * Paging is clamped rather than rejected: the client always sends sane
   * values, and a 400 here would blank the whole list over a detail the player
   * never chose. Out-of-range pages return an empty `results` with the real
   * `total`, which is what the client's stitching logic expects.
   */
  app.get("/friends", { preHandler: requireAuth }, async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const { page, limit } = normalizePaging(query.page, query.limit);
    return reply.send(await listFriends(request.userId!, page, limit));
  });

  /** Sends a request, or accepts a mutual one — see sendFriendRequest. */
  app.post(
    "/friends/requests/:publicId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const target = identifier(request.params);
      if (!target) return reply.code(400).send({ error: "invalid_identifier" });
      const result = await sendFriendRequest(request.userId!, target);
      return result.ok
        ? reply.send(result.value)
        : sendError(reply, result.error);
    },
  );

  /** Accepts the request `:publicId` sent to the caller. */
  app.post(
    "/friends/requests/:publicId/accept",
    { preHandler: requireAuth },
    async (request, reply) => {
      const target = identifier(request.params);
      if (!target) return reply.code(400).send({ error: "invalid_identifier" });
      const result = await acceptFriendRequest(request.userId!, target);
      return result.ok
        ? reply.send(result.value)
        : sendError(reply, result.error);
    },
  );

  /** Denies an incoming request or withdraws an outgoing one. */
  app.delete(
    "/friends/requests/:publicId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const target = identifier(request.params);
      if (!target) return reply.code(400).send({ error: "invalid_identifier" });
      const result = await deleteFriendRequest(request.userId!, target);
      return result.ok
        ? reply.send(result.value)
        : sendError(reply, result.error);
    },
  );

  /** Removes an existing friend. */
  app.delete(
    "/friends/:publicId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const target = identifier(request.params);
      if (!target) return reply.code(400).send({ error: "invalid_identifier" });
      const result = await removeFriend(request.userId!, target);
      return result.ok
        ? reply.send(result.value)
        : sendError(reply, result.error);
    },
  );
}
