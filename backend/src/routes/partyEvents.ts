import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.ts";
import { requireAuth } from "../plugins/auth.ts";
import { getParty, getPartyForUser } from "../services/parties.ts";
import {
  publishPartyChanged,
  subscribeToParty,
} from "../services/partyEvents.ts";

/**
 * Live party updates over Server-Sent Events.
 *
 * SSE rather than WebSockets: the traffic is one-directional (server tells the
 * client the roster moved), EventSource reconnects on its own, it survives
 * proxies that mangle Upgrade headers, and Fastify needs no extra dependency.
 * Nothing here would benefit from a duplex channel — the client's own actions
 * already go through the REST routes.
 */

/**
 * Proxies commonly reap idle connections around 60s, so send a comment line
 * well inside that. A line starting with ':' is a valid SSE comment and is
 * ignored by EventSource, which makes it a keepalive that costs the client
 * nothing.
 */
const HEARTBEAT_MS = 25_000;

function sseHeaders(reply: FastifyReply): void {
  // writeHead goes straight to the raw socket, which bypasses @fastify/cors —
  // it decorates the Fastify reply, and this route never sends one. Without
  // re-adding these the browser discards the whole stream, since the client
  // (:9000) and this backend (:8787) are different origins. The 401 path is
  // unaffected because that one *does* go through Fastify.
  const origin = reply.request.headers.origin;
  const allowed = config.CORS_ORIGIN.split(",").map((o) => o.trim());
  const corsHeaders =
    origin && allowed.includes(origin)
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Credentials": "true",
          // Same-origin requests send no Origin, so caches must not reuse a
          // response keyed on one origin for another.
          Vary: "Origin",
        }
      : {};

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // nginx buffers proxied responses by default, which holds events back
    // until the buffer fills — the one header that makes SSE work behind it.
    "X-Accel-Buffering": "no",
    ...corsHeaders,
  });
  reply.raw.flushHeaders?.();
}

export async function registerPartyEventRoutes(
  app: FastifyInstance,
): Promise<void> {
  /**
   * GET /parties/@me/events
   *
   * Emits `party` events carrying the full party as the REST routes return it,
   * so the client renders straight from the payload with no follow-up request.
   * A member who is no longer in a party (left, kicked, party deleted) gets a
   * `party` event with `party: null`.
   */
  app.get(
    "/parties/@me/events",
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!;
      const party = await getPartyForUser(userId);

      // Tell Fastify this reply is ours now; without hijack it would try to
      // send its own response after the handler resolves and warn about
      // headers already sent.
      reply.hijack();
      sseHeaders(reply);

      let closed = false;

      const send = (event: string, data: unknown): void => {
        if (closed || reply.raw.writableEnded) return;
        try {
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          // Peer vanished mid-write; teardown runs via the 'close' event.
        }
      };

      // Initial state, so a freshly opened stream is immediately authoritative
      // and the client never has to poll once to prime itself.
      send("party", { party });

      const heartbeat = setInterval(() => {
        if (closed || reply.raw.writableEnded) return;
        try {
          reply.raw.write(": keepalive\n\n");
        } catch {
          // Same as above.
        }
      }, HEARTBEAT_MS);
      // A pending timer must not hold the event loop open on shutdown.
      heartbeat.unref?.();

      /**
       * Re-read on notification rather than trusting a payload published by
       * another process: the reader applies this viewer's own `viewerId` and
       * sees the state as actually committed, which keeps two instances from
       * disagreeing about who leads.
       */
      const onChanged = (changedPartyId: string): void => {
        void (async () => {
          if (closed) return;
          try {
            const next = await getParty(changedPartyId, userId);
            // A member removed from the party still holds this subscription
            // until they disconnect; report null so their UI empties out
            // instead of showing a roster they are no longer part of.
            const stillAMember = next?.members.some((m) => m.userId === userId);
            send("party", { party: stillAMember ? next : null });
          } catch (err) {
            request.log.error(
              { err },
              "party events: failed to load party after change",
            );
          }
        })();
      };

      // No party means nothing to watch. The stream stays open (headers sent,
      // heartbeat running) so the client can hold one EventSource for the life
      // of the modal instead of reopening when a party appears — but it will
      // only learn about a brand-new party from its own create/join response.
      const unsubscribe = party
        ? await subscribeToParty(party.id, onChanged)
        : null;

      const teardown = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        // Releasing the listener is what keeps reconnects from accumulating
        // subscriptions — a client that reconnects every 30s would otherwise
        // leave one dead listener behind each time.
        unsubscribe?.();
        if (!reply.raw.writableEnded) reply.raw.end();
      };

      // 'close' covers the browser closing the tab, the network dropping, and
      // the server ending the response. 'error' covers a broken pipe, which
      // does not always emit 'close' first.
      request.raw.on("close", teardown);
      request.raw.on("error", teardown);
      reply.raw.on("close", teardown);
      reply.raw.on("error", teardown);
    },
  );
}

// Re-exported so parties.ts can publish without importing the service directly.
export { publishPartyChanged };
