import type { FriendMessage } from "@game/ApiSchemas.ts";
import { and, desc, eq, lt, or } from "drizzle-orm";
import type { Redis } from "ioredis";
import { db } from "../db/index.ts";
import { friendMessages, friendships, users } from "../db/schema.ts";
import { redis } from "../redis.ts";

/**
 * Direct messages and presence for the friends panel.
 *
 * Delivery follows the party-events pattern (services/partyEvents.ts): Redis
 * pub/sub fans events out across backend instances, one shared subscriber
 * connection per process demultiplexes to local SSE streams. The routing key
 * here is the RECIPIENT's user id — every event is addressed to exactly one
 * account, and a message is published twice (recipient + sender) so the
 * sender's other open tabs stay in sync too.
 *
 * Presence is a Redis key with a TTL, refreshed by the SSE heartbeat. Liveness
 * therefore IS the stream: when the tab closes, the key expires on its own
 * even if the teardown never ran. Redis being down degrades to "everyone
 * offline, no live delivery" — REST send/history keep working.
 */

const CHANNEL = "friend:events";
const MESSAGE_MAX_LENGTH = 500;
export const MESSAGES_PAGE_LIMIT = 50;

/** Presence TTL; refreshed every SSE heartbeat (25s), so 60s rides out two. */
const PRESENCE_TTL_SECONDS = 60;

export type ChatError = "not_found" | "not_friends" | "empty" | "too_long";
export type ChatResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ChatError };

/** An event addressed to one user, as carried on the Redis channel. */
export type FriendEvent =
  | { type: "message"; message: FriendMessage }
  | { type: "presence"; publicId: string; online: boolean };

type AddressedEvent = { to: string; event: FriendEvent };

// ---------------------------------------------------------------------------
// Pub/sub plumbing (one subscriber connection per process, local demux)
// ---------------------------------------------------------------------------

export type FriendEventListener = (event: FriendEvent) => void;

const listeners = new Map<string, Set<FriendEventListener>>();

let subscriber: Redis | null = null;
let subscribing: Promise<void> | null = null;

function handleMessage(channel: string, raw: string): void {
  if (channel !== CHANNEL) return;
  let parsed: AddressedEvent;
  try {
    parsed = JSON.parse(raw) as AddressedEvent;
  } catch {
    return;
  }
  const targets = listeners.get(parsed.to);
  if (!targets) return;
  for (const listener of [...targets]) {
    try {
      listener(parsed.event);
    } catch (err) {
      console.error("friend event listener failed:", (err as Error).message);
    }
  }
}

async function ensureSubscribed(): Promise<void> {
  if (subscriber) return;
  if (subscribing) return subscribing;

  subscribing = (async () => {
    const client = redis.duplicate({ lazyConnect: true });
    client.on("error", (err: Error) => {
      console.error("friend events subscriber error:", err.message);
    });
    client.on("message", handleMessage);
    try {
      await client.connect();
      await client.subscribe(CHANNEL);
      subscriber = client;
    } catch (err) {
      console.error(
        "friend events: subscribe failed, live updates are off:",
        (err as Error).message,
      );
      client.removeListener("message", handleMessage);
      client.disconnect();
    } finally {
      subscribing = null;
    }
  })();

  return subscribing;
}

/** Registers one user's SSE stream. Callers MUST invoke the returned release. */
export async function subscribeToUser(
  userId: string,
  listener: FriendEventListener,
): Promise<() => void> {
  let set = listeners.get(userId);
  if (!set) {
    set = new Set();
    listeners.set(userId, set);
  }
  set.add(listener);

  await ensureSubscribed();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = listeners.get(userId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(userId);
  };
}

/** Fire-and-forget: chat must not fail because Redis is down. */
async function publishToUser(
  userId: string,
  event: FriendEvent,
): Promise<void> {
  try {
    await redis.publish(CHANNEL, JSON.stringify({ to: userId, event }));
  } catch (err) {
    console.error("friend events: publish failed:", (err as Error).message);
  }
}

/** Releases the subscriber connection. For graceful shutdown and tests. */
export async function closeFriendEvents(): Promise<void> {
  listeners.clear();
  const client = subscriber;
  subscriber = null;
  if (!client) return;
  client.removeListener("message", handleMessage);
  try {
    await client.quit();
  } catch {
    // Already gone.
  }
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

function presenceKey(userId: string): string {
  return `presence:${userId}`;
}

/**
 * Marks a user online (or refreshes the mark). Returns whether this flipped
 * them from offline — the caller only broadcasts presence on actual flips, so
 * heartbeats stay silent.
 */
export async function touchPresence(userId: string): Promise<boolean> {
  try {
    const wasOnline = await redis.set(
      presenceKey(userId),
      "1",
      "EX",
      PRESENCE_TTL_SECONDS,
      "GET",
    );
    return wasOnline === null;
  } catch {
    return false;
  }
}

/**
 * Drops the presence mark. Only meaningful when this was the user's LAST open
 * stream; the route counts its local streams before calling.
 */
export async function clearPresence(userId: string): Promise<void> {
  try {
    await redis.del(presenceKey(userId));
  } catch {
    // The TTL cleans up on its own.
  }
}

/** Batch presence lookup, ordered like the input. Redis down = all offline. */
export async function arePresent(userIds: string[]): Promise<boolean[]> {
  if (userIds.length === 0) return [];
  try {
    const pipeline = redis.pipeline();
    for (const id of userIds) pipeline.exists(presenceKey(id));
    const replies = (await pipeline.exec()) ?? [];
    return userIds.map((_, i) => replies[i]?.[1] === 1);
  } catch {
    return userIds.map(() => false);
  }
}

/**
 * Tells every friend of `userId` that their presence flipped. The friend list
 * is read fresh so a brand-new friendship is already covered.
 */
export async function broadcastPresence(
  userId: string,
  online: boolean,
): Promise<void> {
  const self = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!self) return;
  const rows = await db
    .select({ a: friendships.userIdA, b: friendships.userIdB })
    .from(friendships)
    .where(
      or(eq(friendships.userIdA, userId), eq(friendships.userIdB, userId)),
    );
  const event: FriendEvent = {
    type: "presence",
    publicId: self.publicId,
    online,
  };
  await Promise.all(
    rows.map((row) => publishToUser(row.a === userId ? row.b : row.a, event)),
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

async function findFriend(userId: string, publicId: string) {
  const target = await db.query.users.findFirst({
    where: eq(users.publicId, publicId),
  });
  if (!target || target.id === userId) return null;
  const edge = await db.query.friendships.findFirst({
    where:
      userId < target.id
        ? and(
            eq(friendships.userIdA, userId),
            eq(friendships.userIdB, target.id),
          )
        : and(
            eq(friendships.userIdA, target.id),
            eq(friendships.userIdB, userId),
          ),
  });
  return edge ? target : null;
}

function toWire(
  row: typeof friendMessages.$inferSelect,
  senderPublicId: string,
  recipientPublicId: string,
): FriendMessage {
  return {
    id: row.id,
    from: senderPublicId,
    to: recipientPublicId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The conversation between the caller and one friend, oldest first. `before`
 * (an ISO timestamp) pages further back; the newest page comes without it.
 * Friendship is required — an ex-friend can neither read nor extend a thread.
 */
export async function listMessages(
  userId: string,
  otherPublicId: string,
  before?: string,
): Promise<ChatResult<FriendMessage[]>> {
  const target = await findFriend(userId, otherPublicId);
  if (!target) return { ok: false, error: "not_friends" };

  const pair = or(
    and(
      eq(friendMessages.senderId, userId),
      eq(friendMessages.recipientId, target.id),
    ),
    and(
      eq(friendMessages.senderId, target.id),
      eq(friendMessages.recipientId, userId),
    ),
  );
  const cursor = before ? new Date(before) : null;
  const rows = await db
    .select()
    .from(friendMessages)
    .where(
      cursor && !Number.isNaN(cursor.getTime())
        ? and(pair, lt(friendMessages.createdAt, cursor))
        : pair,
    )
    .orderBy(desc(friendMessages.createdAt))
    .limit(MESSAGES_PAGE_LIMIT);

  const self = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const selfPublicId = self?.publicId ?? "";
  return {
    ok: true,
    value: rows
      .reverse()
      .map((row) =>
        row.senderId === userId
          ? toWire(row, selfPublicId, target.publicId)
          : toWire(row, target.publicId, selfPublicId),
      ),
  };
}

/**
 * Sends one message. The insert is the source of truth; delivery is
 * best-effort on top (recipient's stream AND the sender's own, so a second
 * tab of the sender shows it too).
 */
export async function sendMessage(
  userId: string,
  otherPublicId: string,
  body: string,
): Promise<ChatResult<FriendMessage>> {
  const trimmed = body.trim();
  if (trimmed.length === 0) return { ok: false, error: "empty" };
  if (trimmed.length > MESSAGE_MAX_LENGTH)
    return { ok: false, error: "too_long" };

  const target = await findFriend(userId, otherPublicId);
  if (!target) return { ok: false, error: "not_friends" };

  const self = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!self) return { ok: false, error: "not_found" };

  const [row] = await db
    .insert(friendMessages)
    .values({ senderId: userId, recipientId: target.id, body: trimmed })
    .returning();

  const wire = toWire(row!, self.publicId, target.publicId);
  const event: FriendEvent = { type: "message", message: wire };
  await Promise.all([
    publishToUser(target.id, event),
    publishToUser(userId, event),
  ]);
  return { ok: true, value: wire };
}
