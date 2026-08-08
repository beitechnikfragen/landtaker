import type { FriendEntry } from "@game/ApiSchemas.ts";
import { and, count, desc, eq, or, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { friendRequests, friendships, users } from "../db/schema.ts";
import { resolveDisplayUsername } from "./users.ts";

/**
 * The social graph behind /friends. Two tables back it:
 *
 *   friend_requests — a directed, pending invitation (from → to).
 *   friendships     — an undirected, accepted edge, stored ONCE with
 *                     userIdA < userIdB (a check constraint enforces it).
 *
 * Storing the friendship once means every read has to look both ways, and
 * every write has to sort the pair first. Both are funnelled through
 * `orderedPair` / `friendshipWhere` below so the ordering rule lives in exactly
 * one place — a caller that inserts an unordered pair would hit the check
 * constraint at runtime, which is a bug we would rather not ship.
 *
 * Identities on the wire are always `publicId`. The internal uuid is never
 * serialised: it is the JWT subject, so leaking it would let anyone address
 * another account directly.
 */

export type FriendError =
  | "not_found"
  | "self"
  | "already_friends"
  | "already_requested"
  | "no_request";

export type FriendResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: FriendError };

/** What POST /friends/requests/:publicId reports back. */
export type SendOutcome = { status: "requested" | "accepted" };

export const FRIENDS_PAGE_LIMIT_MAX = 100;
const FRIENDS_PAGE_LIMIT_DEFAULT = 20;

/**
 * The user columns needed to build a FriendEntry. Selected explicitly rather
 * than with `select()` so a new column on `users` never silently widens what
 * we expose.
 */
const entryColumns = {
  id: users.id,
  publicId: users.publicId,
  usernameBase: users.usernameBase,
  usernameDiscriminator: users.usernameDiscriminator,
  usernameStatus: users.usernameStatus,
};

type EntryRow = {
  publicId: string;
  usernameBase: string | null;
  usernameDiscriminator: string | null;
  usernameStatus: string | null;
};

/**
 * Renders the wire form of another player.
 *
 * The username MUST come from resolveDisplayUsername: the game derives the
 * verified badge purely from the name containing no dot, so assembling the
 * string anywhere else would hand out or withhold badges by accident.
 */
export function toFriendEntry(row: EntryRow, createdAt: Date): FriendEntry {
  return {
    publicId: row.publicId,
    username: resolveDisplayUsername(row),
    createdAt: createdAt.toISOString(),
  };
}

/** Sorts a pair to satisfy the userIdA < userIdB storage rule. */
function orderedPair(x: string, y: string): { a: string; b: string } {
  return x < y ? { a: x, b: y } : { a: y, b: x };
}

/** Matches the single stored row for a pair, whichever way round it was given. */
function friendshipWhere(x: string, y: string) {
  const { a, b } = orderedPair(x, y);
  return and(eq(friendships.userIdA, a), eq(friendships.userIdB, b));
}

async function areFriends(x: string, y: string): Promise<boolean> {
  const row = await db.query.friendships.findFirst({
    where: friendshipWhere(x, y),
  });
  return row !== undefined;
}

/**
 * Resolves the `:publicId` path segment to an account.
 *
 * Deliberately publicId ONLY. Name lookup was removed: bare names are only
 * unique by accident, `name.1234` leaks the discriminator scheme, and both
 * together made the add-friend box an account enumeration oracle. The id is
 * shown in the account modal and is what players share.
 */
async function findTarget(identifier: string) {
  const byPublicId = await db
    .select(entryColumns)
    .from(users)
    .where(eq(users.publicId, identifier))
    .limit(1);
  return byPublicId[0] ?? null;
}

/**
 * GET /friends/requests — both directions in one call.
 *
 * The client renders incoming with accept/deny buttons and outgoing with a
 * withdraw button, and asks for both on every open, so splitting this into two
 * endpoints would only cost a round trip.
 */
export async function listFriendRequests(userId: string): Promise<{
  incoming: FriendEntry[];
  outgoing: FriendEntry[];
}> {
  const [incomingRows, outgoingRows] = await Promise.all([
    db
      .select({ ...entryColumns, createdAt: friendRequests.createdAt })
      .from(friendRequests)
      .innerJoin(users, eq(users.id, friendRequests.fromUserId))
      .where(eq(friendRequests.toUserId, userId))
      .orderBy(desc(friendRequests.createdAt)),
    db
      .select({ ...entryColumns, createdAt: friendRequests.createdAt })
      .from(friendRequests)
      .innerJoin(users, eq(users.id, friendRequests.toUserId))
      .where(eq(friendRequests.fromUserId, userId))
      .orderBy(desc(friendRequests.createdAt)),
  ]);

  return {
    incoming: incomingRows.map((row) => toFriendEntry(row, row.createdAt)),
    outgoing: outgoingRows.map((row) => toFriendEntry(row, row.createdAt)),
  };
}

/** Clamps client-supplied paging into a range we are willing to serve. */
export function normalizePaging(
  page: unknown,
  limit: unknown,
): { page: number; limit: number } {
  const rawPage = Number(page);
  const rawLimit = Number(limit);
  return {
    page: Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1,
    limit:
      Number.isFinite(rawLimit) && rawLimit >= 1
        ? Math.min(Math.floor(rawLimit), FRIENDS_PAGE_LIMIT_MAX)
        : FRIENDS_PAGE_LIMIT_DEFAULT,
  };
}

/**
 * GET /friends?page&limit — the accepted friends of `userId`.
 *
 * A friendship is one row that may name the caller as either side, so the
 * "other" id is picked per row with a CASE rather than by unioning two queries.
 * That keeps ordering, LIMIT and OFFSET meaningful across the whole set — a
 * two-query version would paginate each half separately and interleave wrongly.
 *
 * Ordering is newest-first with publicId as a tiebreaker. The tiebreaker is not
 * cosmetic: offset paging over a non-deterministic order can repeat or skip
 * rows between pages, and the client stitches pages together (refreshFriends).
 */
export async function listFriends(
  userId: string,
  page: number,
  limit: number,
): Promise<{
  results: FriendEntry[];
  total: number;
  page: number;
  limit: number;
}> {
  const mine = or(
    eq(friendships.userIdA, userId),
    eq(friendships.userIdB, userId),
  );

  // The friend is whichever column is not the caller.
  const otherId = sql<string>`case when ${friendships.userIdA} = ${userId} then ${friendships.userIdB} else ${friendships.userIdA} end`;

  const [rows, totals] = await Promise.all([
    db
      .select({ ...entryColumns, createdAt: friendships.createdAt })
      .from(friendships)
      .innerJoin(users, eq(users.id, otherId))
      .where(mine)
      .orderBy(desc(friendships.createdAt), users.publicId)
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ value: count() }).from(friendships).where(mine),
  ]);

  return {
    results: rows.map((row) => toFriendEntry(row, row.createdAt)),
    total: totals[0]?.value ?? 0,
    page,
    limit,
  };
}

/**
 * POST /friends/requests/:publicId
 *
 * MUTUAL REQUEST → AUTO-ACCEPT. If B has already requested A and A now
 * requests B, the friendship is created immediately and the reply says
 * "accepted" instead of "requested".
 *
 * Both parties have expressed exactly the consent that accepting requires, so
 * the alternative — parking A's request next to B's and demanding one of them
 * press accept — asks for permission that has already been given twice. It
 * also produces a state the UI cannot render honestly: the pair would sit in
 * A's incoming AND outgoing list at once, and whoever pressed accept would win
 * a race against a row that no longer means anything.
 *
 * The client already handles this: handleSend branches on
 * `result.status === "accepted"` and reloads the whole list. The distinct
 * status exists so it can say "you are now friends" rather than "request
 * sent".
 */
export async function sendFriendRequest(
  userId: string,
  identifier: string,
): Promise<FriendResult<SendOutcome>> {
  const target = await findTarget(identifier);
  if (!target) return { ok: false, error: "not_found" };
  // Checked after the lookup on purpose: an unknown id is "not_found" whether
  // or not it happens to be your own, and self-friending is its own message.
  if (target.id === userId) return { ok: false, error: "self" };

  if (await areFriends(userId, target.id)) {
    return { ok: false, error: "already_friends" };
  }

  // The reverse request turns this into an acceptance.
  const reverse = await db.query.friendRequests.findFirst({
    where: and(
      eq(friendRequests.fromUserId, target.id),
      eq(friendRequests.toUserId, userId),
    ),
  });
  if (reverse) {
    await acceptRequestRows(userId, target.id);
    return { ok: true, value: { status: "accepted" } };
  }

  const existing = await db.query.friendRequests.findFirst({
    where: and(
      eq(friendRequests.fromUserId, userId),
      eq(friendRequests.toUserId, target.id),
    ),
  });
  if (existing) return { ok: false, error: "already_requested" };

  try {
    await db
      .insert(friendRequests)
      .values({ fromUserId: userId, toUserId: target.id });
  } catch {
    // Lost a race against a duplicate send; the unique index is the real
    // guarantee, the check above is only there to give a nicer answer first.
    return { ok: false, error: "already_requested" };
  }
  return { ok: true, value: { status: "requested" } };
}

/**
 * Promotes a pending request to a friendship. Both directions of the request
 * are deleted, not just the one being accepted: a simultaneous mutual send can
 * leave two rows, and leaving the reverse one behind would show the brand-new
 * friend as still having a pending invitation.
 */
async function acceptRequestRows(
  userId: string,
  otherId: string,
): Promise<void> {
  const { a, b } = orderedPair(userId, otherId);
  await db.transaction(async (tx) => {
    await tx
      .delete(friendRequests)
      .where(
        or(
          and(
            eq(friendRequests.fromUserId, userId),
            eq(friendRequests.toUserId, otherId),
          ),
          and(
            eq(friendRequests.fromUserId, otherId),
            eq(friendRequests.toUserId, userId),
          ),
        ),
      );
    // Ignore a conflict rather than pre-checking: two accepts racing would
    // otherwise both pass the check and one would fail on the primary key.
    await tx
      .insert(friendships)
      .values({ userIdA: a, userIdB: b })
      .onConflictDoNothing();
  });
}

/**
 * POST /friends/requests/:publicId/accept — accepts the request that
 * `:publicId` sent to the caller.
 *
 * Only an INCOMING request can be accepted. Accepting your own outgoing
 * request would let anyone add a stranger unilaterally, so a caller with only
 * an outgoing request gets "no_request", the same answer as having none.
 */
export async function acceptFriendRequest(
  userId: string,
  identifier: string,
): Promise<FriendResult<{ friend: FriendEntry }>> {
  const target = await findTarget(identifier);
  if (!target) return { ok: false, error: "not_found" };
  if (target.id === userId) return { ok: false, error: "self" };

  const incoming = await db.query.friendRequests.findFirst({
    where: and(
      eq(friendRequests.fromUserId, target.id),
      eq(friendRequests.toUserId, userId),
    ),
  });
  if (!incoming) return { ok: false, error: "no_request" };

  await acceptRequestRows(userId, target.id);

  const row = await db.query.friendships.findFirst({
    where: friendshipWhere(userId, target.id),
  });
  return {
    ok: true,
    value: { friend: toFriendEntry(target, row?.createdAt ?? new Date()) },
  };
}

/**
 * DELETE /friends/requests/:publicId — one endpoint for both "deny the request
 * they sent me" and "withdraw the request I sent them".
 *
 * The client calls the same route for both (handleDenyOrWithdraw) and only
 * uses `direction` to pick the toast, so the direction is resolved here from
 * whichever row actually exists rather than being trusted from the request.
 */
export async function deleteFriendRequest(
  userId: string,
  identifier: string,
): Promise<FriendResult<{ deleted: number }>> {
  const target = await findTarget(identifier);
  if (!target) return { ok: false, error: "not_found" };
  if (target.id === userId) return { ok: false, error: "self" };

  const deleted = await db
    .delete(friendRequests)
    .where(
      or(
        and(
          eq(friendRequests.fromUserId, userId),
          eq(friendRequests.toUserId, target.id),
        ),
        and(
          eq(friendRequests.fromUserId, target.id),
          eq(friendRequests.toUserId, userId),
        ),
      ),
    )
    .returning({ id: friendRequests.id });

  if (deleted.length === 0) return { ok: false, error: "no_request" };
  return { ok: true, value: { deleted: deleted.length } };
}

/**
 * DELETE /friends/:publicId — removes the friendship in both directions, which
 * is a single row given the ordered-pair storage.
 *
 * Removal is unilateral and needs no confirmation from the other side.
 */
export async function removeFriend(
  userId: string,
  identifier: string,
): Promise<FriendResult<{ removed: true }>> {
  const target = await findTarget(identifier);
  if (!target) return { ok: false, error: "not_found" };
  if (target.id === userId) return { ok: false, error: "self" };

  const deleted = await db
    .delete(friendships)
    .where(friendshipWhere(userId, target.id))
    .returning({ userIdA: friendships.userIdA });

  if (deleted.length === 0) return { ok: false, error: "not_found" };
  return { ok: true, value: { removed: true } };
}
