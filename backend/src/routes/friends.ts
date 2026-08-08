import { inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import { requireAuth } from "../plugins/auth.ts";
import {
  arePresent,
  broadcastPresence,
  type ChatError,
  clearPresence,
  listMessages,
  sendMessage,
  subscribeToUser,
  touchPresence,
} from "../services/friendChat.ts";
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
   *
   * Each entry carries `online`, resolved from the presence keys the event
   * stream maintains — the list is the snapshot, the stream is the delta.
   */
  app.get("/friends", { preHandler: requireAuth }, async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const { page, limit } = normalizePaging(query.page, query.limit);
    const list = await listFriends(request.userId!, page, limit);

    const publicIds = list.results.map((entry) => entry.publicId);
    if (publicIds.length > 0) {
      const rows = await db
        .select({ id: users.id, publicId: users.publicId })
        .from(users)
        .where(inArray(users.publicId, publicIds));
      const idByPublicId = new Map(rows.map((r) => [r.publicId, r.id]));
      const ids = list.results.map((e) => idByPublicId.get(e.publicId) ?? "");
      const online = await arePresent(ids);
      list.results = list.results.map((entry, i) => ({
        ...entry,
        online: online[i] ?? false,
      }));
    }
    return reply.send(list);
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

  /**
   * GET /friends/chat/:publicId?before=<ISO> — the conversation with one
   * friend, oldest first. `not_friends` maps to 404 like an unknown account:
   * whether a thread exists must not be probeable by strangers.
   */
  app.get(
    "/friends/chat/:publicId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const target = identifier(request.params);
      if (!target) return reply.code(400).send({ error: "invalid_identifier" });
      const query = (request.query ?? {}) as Record<string, unknown>;
      const before =
        typeof query.before === "string" ? query.before : undefined;
      const result = await listMessages(request.userId!, target, before);
      return result.ok
        ? reply.send({ results: result.value })
        : sendChatError(reply, result.error);
    },
  );

  /** POST /friends/chat/:publicId — sends one message to a friend. */
  app.post(
    "/friends/chat/:publicId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const target = identifier(request.params);
      if (!target) return reply.code(400).send({ error: "invalid_identifier" });
      const body = (request.body ?? {}) as { body?: unknown };
      if (typeof body.body !== "string") {
        return reply.code(400).send({ error: "empty" });
      }
      const result = await sendMessage(request.userId!, target, body.body);
      return result.ok
        ? reply.send(result.value)
        : sendChatError(reply, result.error);
    },
  );

  /**
   * GET /friends/events — live messages and friend presence over SSE.
   *
   * Same transport decision as /parties/@me/events (see routes/partyEvents.ts):
   * one-directional traffic, fetch+ReadableStream on the client because
   * requireAuth only reads the Authorization header.
   *
   * The stream doubles as presence: connecting marks the user online (Redis
   * key with a TTL), each heartbeat refreshes the mark, and closing the last
   * stream of this process clears it. The TTL rides out crashed processes.
   */
  app.get(
    "/friends/events",
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.userId!;

      reply.hijack();
      sseHeaders(reply);

      let closed = false;
      const send = (event: string, data: unknown): void => {
        if (closed || reply.raw.writableEnded) return;
        try {
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          // Peer vanished mid-write; teardown runs via 'close'.
        }
      };

      const streams = openStreams.get(userId) ?? 0;
      openStreams.set(userId, streams + 1);
      const flipped = await touchPresence(userId);
      if (flipped) void broadcastPresence(userId, true);

      // Prime the client: current presence of every friend, as one event per
      // friend, so the panel needs no second request to light the dots.
      try {
        const list = await listFriends(userId, 1, 100);
        const publicIds = list.results.map((e) => e.publicId);
        if (publicIds.length > 0) {
          const rows = await db
            .select({ id: users.id, publicId: users.publicId })
            .from(users)
            .where(inArray(users.publicId, publicIds));
          const idByPublicId = new Map(rows.map((r) => [r.publicId, r.id]));
          const online = await arePresent(
            publicIds.map((p) => idByPublicId.get(p) ?? ""),
          );
          publicIds.forEach((publicId, i) => {
            send("friend", {
              type: "presence",
              publicId,
              online: online[i] ?? false,
            });
          });
        }
      } catch (err) {
        request.log.error({ err }, "friend events: presence snapshot failed");
      }

      const heartbeat = setInterval(() => {
        if (closed || reply.raw.writableEnded) return;
        try {
          reply.raw.write(": keepalive\n\n");
        } catch {
          // Same as above.
        }
        // Refresh the presence TTL; a flip here means Redis lost the key
        // (restart), so friends are told again.
        void touchPresence(userId).then((flippedAgain) => {
          if (flippedAgain) void broadcastPresence(userId, true);
        });
      }, SSE_HEARTBEAT_MS);
      heartbeat.unref?.();

      const unsubscribe = await subscribeToUser(userId, (event) => {
        send("friend", event);
      });

      const teardown = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        const remaining = (openStreams.get(userId) ?? 1) - 1;
        if (remaining <= 0) {
          openStreams.delete(userId);
          void clearPresence(userId).then(() =>
            broadcastPresence(userId, false),
          );
        } else {
          openStreams.set(userId, remaining);
        }
        if (!reply.raw.writableEnded) reply.raw.end();
      };

      request.raw.on("close", teardown);
      request.raw.on("error", teardown);
      reply.raw.on("close", teardown);
      reply.raw.on("error", teardown);
    },
  );
}

const CHAT_STATUS: Record<ChatError, number> = {
  not_found: 404,
  not_friends: 404,
  empty: 400,
  too_long: 400,
};

function sendChatError(reply: FastifyReply, error: ChatError) {
  return reply.code(CHAT_STATUS[error]).send({ error });
}

/** Open SSE streams per user ON THIS PROCESS, for the presence lifecycle. */
const openStreams = new Map<string, number>();

const SSE_HEARTBEAT_MS = 25_000;

/**
 * Raw-socket SSE headers with CORS re-applied — writeHead bypasses
 * @fastify/cors. Mirrors sseHeaders in routes/partyEvents.ts; see there for
 * the full reasoning.
 */
function sseHeaders(reply: FastifyReply): void {
  const origin = reply.request.headers.origin;
  const allowed = config.CORS_ORIGIN.split(",").map((o) => o.trim());
  const corsHeaders =
    origin && allowed.includes(origin)
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Credentials": "true",
          Vary: "Origin",
        }
      : {};

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...corsHeaders,
  });
  reply.raw.flushHeaders?.();
}
