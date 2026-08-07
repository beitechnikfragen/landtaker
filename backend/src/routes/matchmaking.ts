import websocket from "@fastify/websocket";
import { base64urlToUuid } from "@game/Base64.ts";
import type { FastifyInstance } from "fastify";
import { jwtVerify } from "jose";
import type { WebSocket } from "ws";
import { z } from "zod";
import { getSigningKeys, JWT_ALGORITHM } from "../auth/keys.ts";
import { config } from "../config.ts";
import { requireApiKey } from "../plugins/auth.ts";
import {
  dequeue,
  enqueue,
  heartbeat,
  isMatchmakingMode,
  type MatchmakingMode,
  publicIdFor,
  queueSize,
  ratingFor,
  takeAssignment,
  tryFormMatch,
} from "../services/matchmaking.ts";

/**
 * Ranked matchmaking endpoints.
 *
 * Both halves of the protocol are defined by callers this backend does not
 * own — see the module comment in services/matchmaking.ts. The rules that
 * matter here:
 *
 *   - the client sends exactly one `{type:"join", jwt}`, roughly 2s after the
 *     socket opens. Until then it is connected but NOT queued.
 *   - it treats 15s of server silence as a dead connection, so a queued socket
 *     must be written to well inside that.
 *   - close code 1000 specifically means "a newer connection replaced you",
 *     and the client will NOT retry. Every other close is retried with
 *     backoff, so an ordinary failure is self-healing.
 *   - the worker's checkin aborts at 20s, so our long-poll must return before
 *     that or every poll looks like a failure.
 */

/** How often a queued socket is told the queue size. */
const QUEUE_PUSH_INTERVAL_MS = 3000;

/**
 * Long-poll ceiling for the worker checkin. Comfortably under the worker's own
 * 20s AbortController: returning at 15s makes an empty queue look like a
 * normal empty answer rather than a timeout in the worker's logs.
 */
const CHECKIN_MAX_WAIT_MS = 15_000;

/** How often a waiting checkin re-examines the queue. */
const CHECKIN_POLL_INTERVAL_MS = 500;

const JoinMessageSchema = z.object({
  type: z.literal("join"),
  jwt: z.string().min(1),
  // Accepted and ignored: clan-restricted 2v2 queueing is not implemented, and
  // the client only sends this when the player picked a clan tag. Rejecting an
  // unknown field would break those players for a feature we do not have.
  clanTag: z.string().max(64).optional(),
});

/**
 * The worker's checkin body (src/server/Worker.ts). Only `gameId` and `mode`
 * actually drive behaviour; the rest is telemetry the upstream API took, kept
 * permissive so a worker version skew is never a 400 in the matchmaking path.
 */
const CheckinBodySchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  gameId: z.string().min(1).max(128),
  ccu: z.number().optional(),
  instanceId: z.string().max(128).nullish(),
  mode: z.string().min(1).max(16),
});

/**
 * Verify the client's play token. This is the same check as `requireAuth`, but
 * it cannot reuse it: that helper writes a reply, and here the credential
 * arrives in a WebSocket frame long after the HTTP handshake is over.
 *
 * An anonymous player sends their raw persistentID rather than a JWT (see
 * getPlayToken in src/client/Auth.ts). That is not a valid token and is
 * rejected — ranked requires an account, which the client already enforces by
 * refusing to open the modal for a player with no linked account.
 */
async function userIdFromToken(token: string): Promise<string | null> {
  try {
    const { publicKey } = await getSigningKeys();
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: [JWT_ALGORITHM],
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    });
    const sub = payload.sub;
    if (!sub) return null;
    return base64urlToUuid(sub) ?? null;
  } catch {
    return null;
  }
}

/**
 * Live sockets on THIS instance, keyed by `${mode}:${userId}`.
 *
 * One slot per account per mode. A second tab joining the same queue replaces
 * the first, and the replaced socket is closed with 1000 — the code the client
 * reads as "you were replaced, do not reconnect". Without this, a player who
 * reloads mid-queue would hold two entries and could be matched into a game
 * only one of their tabs is listening for.
 */
const sockets = new Map<string, WebSocket>();

function socketKey(mode: MatchmakingMode, userId: string): string {
  return `${mode}:${userId}`;
}

export async function registerMatchmakingRoutes(
  app: FastifyInstance,
): Promise<void> {
  await app.register(websocket);

  /**
   * WS /matchmaking/join?instance_id=<id>&mode=1v1|2v2
   *
   * The socket's lifetime IS the player's queue entry: it is created on the
   * join message and destroyed when the socket closes, for any reason. That
   * coupling is the whole defence against stale entries — a queue entry with
   * no live socket behind it produces a game nobody joins.
   */
  app.get(
    "/matchmaking/join",
    { websocket: true },
    (socket: WebSocket, request) => {
      const query = request.query as Record<string, string | undefined>;
      const rawMode = query.mode ?? "1v1";
      const instanceId = query.instance_id ?? "";

      if (!isMatchmakingMode(rawMode)) {
        socket.close(1008, "invalid_mode");
        return;
      }
      const mode: MatchmakingMode = rawMode;

      let userId: string | null = null;
      let timer: ReturnType<typeof setInterval> | null = null;
      let closed = false;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
        if (userId !== null) {
          const key = socketKey(mode, userId);
          // Only drop the queue entry if THIS socket still owns the slot. A
          // replaced socket closing later must not evict its replacement.
          if (sockets.get(key) === socket) {
            sockets.delete(key);
            void dequeue(mode, userId);
          }
        }
      };

      const send = (payload: unknown): void => {
        try {
          socket.send(JSON.stringify(payload));
        } catch {
          // A send on a socket that died between our check and this call is
          // not an error worth logging per-tick; the close handler cleans up.
        }
      };

      /**
       * The periodic tick. Doubles as the client's liveness signal (it expects
       * traffic inside 15s), the queue-entry heartbeat, and the delivery point
       * for an assignment written by whichever instance formed the match.
       */
      const tick = async (): Promise<void> => {
        if (closed || userId === null) return;
        try {
          const gameId = await takeAssignment(userId);
          if (gameId !== null) {
            send({ type: "match-assignment", gameId });
            // The client closes on its own after this; drop the entry now so a
            // slow close cannot leave a matched player queued.
            const key = socketKey(mode, userId);
            if (sockets.get(key) === socket) sockets.delete(key);
            void dequeue(mode, userId);
            if (timer !== null) {
              clearInterval(timer);
              timer = null;
            }
            return;
          }
          await heartbeat(mode, userId);
          send({ type: "queue-size", count: await queueSize(mode) });
        } catch (err) {
          request.log.error({ err }, "matchmaking tick failed");
        }
      };

      socket.on("message", (raw: Buffer) => {
        void (async () => {
          if (closed) return;
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(raw.toString());
          } catch {
            socket.close(1008, "malformed_message");
            return;
          }
          const parsed = JoinMessageSchema.safeParse(parsedJson);
          if (!parsed.success) {
            socket.close(1008, "malformed_message");
            return;
          }
          // A second join on an already-queued socket is a no-op rather than a
          // re-queue: honouring it would reset nothing useful and could reset
          // the wait that widens the rating window.
          if (userId !== null) return;

          const resolved = await userIdFromToken(parsed.data.jwt);
          if (resolved === null) {
            // The client refreshes its token and reconnects on 1008, so an
            // expired token self-heals.
            socket.close(1008, "invalid_session");
            return;
          }
          if (closed) return;

          const publicId = await publicIdFor(resolved);
          if (publicId === null) {
            socket.close(1008, "invalid_session");
            return;
          }
          if (closed) return;

          const rating = await ratingFor(resolved, mode);

          // Evict an older socket for this account before claiming the slot.
          const key = socketKey(mode, resolved);
          const previous = sockets.get(key);
          if (previous !== undefined && previous !== socket) {
            sockets.set(key, socket);
            try {
              previous.close(1000, "replaced");
            } catch {
              // Already gone; nothing to do.
            }
          } else {
            sockets.set(key, socket);
          }

          const queued = await enqueue(
            mode,
            { userId: resolved, publicId, rating },
            instanceId,
          );
          if (!queued) {
            // Redis is down. Matchmaking is unavailable; say so with a code the
            // client retries, rather than holding a socket that will never
            // produce a match.
            sockets.delete(key);
            socket.close(1011, "queue_unavailable");
            return;
          }

          userId = resolved;
          // Push immediately so the client sees a queue size without waiting a
          // full interval, then keep the connection warm.
          void tick();
          timer = setInterval(() => void tick(), QUEUE_PUSH_INTERVAL_MS);
        })();
      });

      socket.on("close", cleanup);
      socket.on("error", cleanup);
    },
  );

  /**
   * POST /matchmaking/checkin
   *
   * A game worker offering one pre-allocated game slot for one mode. It long-
   * polls: we hold the request until a match forms or the ceiling is reached,
   * so a match starts within a poll interval instead of waiting for the next
   * poll to come round.
   *
   * The worker only creates a game when the response carries an `assignment`,
   * so returning `{}` is the normal, frequent answer and must stay cheap.
   */
  app.post(
    "/matchmaking/checkin",
    { preHandler: requireApiKey },
    async (request, reply) => {
      const parsed = CheckinBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid checkin body" });
      }
      const { gameId, mode } = parsed.data;
      if (!isMatchmakingMode(mode)) {
        return reply.code(400).send({ error: "Unknown mode" });
      }

      // The worker aborts at 20s and its socket dies with it. Stop looping when
      // that happens: continuing would keep forming matches against a gameId
      // nobody is going to create, silently consuming queued players.
      let aborted = false;
      request.raw.on("close", () => {
        aborted = true;
      });

      const deadline = Date.now() + CHECKIN_MAX_WAIT_MS;

      /**
       * The ceiling has to bound the WHOLE handler, not just the gaps between
       * attempts. When Redis is unreachable each attempt still takes as long
       * as ioredis needs to exhaust its retries, so checking the clock only
       * between iterations let the response overrun the worker's 20s abort —
       * every poll during an outage then looked like a failure instead of a
       * normal empty answer. Racing each attempt against the remaining budget
       * keeps the response inside the worker's timeout no matter how slow the
       * backing store is.
       *
       * Losing the race abandons an in-flight `tryFormMatch`, which could in
       * principle still form a match for a gameId we just declined to report.
       * Those players would then hold an assignment for a game no worker
       * creates. That is survivable and self-correcting rather than silent:
       * the assignment key expires after 60s, and the client's own `checkGame`
       * poll never sees the game appear, so it re-queues. The alternative —
       * letting the response overrun — strands the WORKER on every poll during
       * an outage, which is strictly worse.
       */
      const overran = Symbol("overran");
      for (;;) {
        if (aborted) return reply.send({});

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          // No match. The worker logs this and polls again with the same
          // pre-allocated gameId; nothing was consumed.
          return reply.send({});
        }

        let timer: ReturnType<typeof setTimeout> | undefined;
        const budget = new Promise<typeof overran>((resolve) => {
          timer = setTimeout(() => resolve(overran), remaining);
        });
        let result: Awaited<ReturnType<typeof tryFormMatch>> | typeof overran;
        try {
          result = await Promise.race([tryFormMatch(mode, gameId), budget]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }

        if (result === overran) return reply.send({});
        if (result !== null) return reply.send({ assignment: result });

        await new Promise((resolve) =>
          setTimeout(resolve, CHECKIN_POLL_INTERVAL_MS),
        );
      }
    },
  );
}
