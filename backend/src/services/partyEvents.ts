import type { Redis } from "ioredis";
import { redis } from "../redis.ts";

/**
 * Fan-out for live party updates.
 *
 * Parties change from whichever backend instance happened to serve the request
 * (a join hits instance A while the member watching the roster is streaming
 * from instance B), so the bus has to cross processes. Redis pub/sub does that;
 * an in-process EventEmitter would look correct on one instance and silently
 * stop delivering the moment a second one exists.
 *
 * Redis is allowed to be down. Publishing then drops the notification and the
 * stream stays open but quiet — the client still has its periodic refetch, and
 * the game is playable without live party updates. Nothing here may throw into
 * a request handler or an unhandled rejection.
 */

/** One channel for every party; the party id is the routing key. */
const CHANNEL = "party:changed";

export type PartyChangedListener = (partyId: string) => void;

/**
 * Local listeners keyed by party id. Redis pub/sub is per-connection, not
 * per-request, so all SSE clients on this process share ONE subscriber
 * connection and are demultiplexed here. Opening a Redis connection per SSE
 * client would exhaust the connection limit long before the process ran out of
 * sockets.
 */
const listeners = new Map<string, Set<PartyChangedListener>>();

/**
 * The subscriber connection, created on first use. ioredis puts a connection
 * into subscriber mode permanently, so this cannot be the shared `redis`
 * client — that one still has to serve normal commands.
 */
let subscriber: Redis | null = null;
/** In flight subscribe, so N simultaneous first-connections share one attempt. */
let subscribing: Promise<void> | null = null;

function handleMessage(channel: string, message: string): void {
  if (channel !== CHANNEL) return;
  const targets = listeners.get(message);
  if (!targets) return;
  // Copy first: a listener may unsubscribe itself while being notified, and
  // mutating the Set during iteration would skip its neighbour.
  for (const listener of [...targets]) {
    try {
      listener(message);
    } catch (err) {
      console.error("party event listener failed:", (err as Error).message);
    }
  }
}

/**
 * Ensures the process-wide subscriber exists and is listening. Resolves even
 * when Redis is unreachable: a stream without live updates is better than a
 * request that 500s.
 */
async function ensureSubscribed(): Promise<void> {
  if (subscriber) return;
  if (subscribing) return subscribing;

  subscribing = (async () => {
    // duplicate() copies the connection options (URL, retry policy) without
    // reusing the socket, which is exactly what subscriber mode needs.
    const client = redis.duplicate({ lazyConnect: true });
    // Attach the error handler BEFORE connecting: an ioredis client with no
    // 'error' listener turns a failed connect into an unhandled 'error' event,
    // which takes the process down.
    client.on("error", (err: Error) => {
      console.error("party events subscriber error:", err.message);
    });
    client.on("message", handleMessage);

    try {
      await client.connect();
      await client.subscribe(CHANNEL);
      subscriber = client;
      // ioredis resubscribes automatically after a reconnect, so a Redis
      // restart does not need any handling here.
    } catch (err) {
      console.error(
        "party events: subscribe failed, live updates are off:",
        (err as Error).message,
      );
      client.removeListener("message", handleMessage);
      // Drop the half-open client rather than leaking it; the next subscriber
      // retries from scratch.
      client.disconnect();
    } finally {
      subscribing = null;
    }
  })();

  return subscribing;
}

/**
 * Registers interest in one party's changes. Returns the unsubscribe function —
 * callers MUST invoke it when the client disconnects, or listeners accumulate
 * across reconnects until the process runs out of memory.
 */
export async function subscribeToParty(
  partyId: string,
  listener: PartyChangedListener,
): Promise<() => void> {
  let set = listeners.get(partyId);
  if (!set) {
    set = new Set();
    listeners.set(partyId, set);
  }
  set.add(listener);

  await ensureSubscribed();

  let released = false;
  return () => {
    // Idempotent: a disconnect can fire more than once (client abort plus
    // stream close), and the second call must not delete a set that a newly
    // arrived listener has since joined.
    if (released) return;
    released = true;
    const current = listeners.get(partyId);
    if (!current) return;
    current.delete(listener);
    // Drop the empty bucket, otherwise the map grows by one entry per party
    // ever watched and never shrinks.
    if (current.size === 0) listeners.delete(partyId);
  };
}

/**
 * Announces that a party changed. Fire-and-forget by design: a join must not
 * fail because Redis is unavailable, so this never throws and never rejects.
 *
 * Call this AFTER the mutation has committed — a subscriber that reacts by
 * re-reading the party would otherwise observe the state from before the write.
 */
export async function publishPartyChanged(partyId: string): Promise<void> {
  try {
    await redis.publish(CHANNEL, partyId);
  } catch (err) {
    console.error(
      "party events: publish failed, members will not see this change live:",
      (err as Error).message,
    );
  }
}

/** Test/inspection helper: how many local listeners a party currently has. */
export function listenerCount(partyId: string): number {
  return listeners.get(partyId)?.size ?? 0;
}

/** Test/inspection helper: how many parties have at least one listener. */
export function watchedPartyCount(): number {
  return listeners.size;
}

/** Releases the subscriber connection. For graceful shutdown and tests. */
export async function closePartyEvents(): Promise<void> {
  listeners.clear();
  const client = subscriber;
  subscriber = null;
  if (!client) return;
  client.removeListener("message", handleMessage);
  try {
    await client.quit();
  } catch {
    // Already gone; nothing to release.
  }
}
