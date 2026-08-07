import type {
  Party,
  PartyErrorCode,
  PartyMember,
} from "@game/PartyApiSchemas.ts";
import { eq } from "drizzle-orm";
import { randomInt } from "node:crypto";
import { db } from "../db/index.ts";
import { parties, partyMembers, users } from "../db/schema.ts";

/**
 * Parties let a group enter a match together. Membership is persisted so a
 * party survives a backend restart; who is currently connected is ephemeral
 * and belongs in Redis, not here.
 *
 * A player is in at most one party at a time — enforced by a unique index on
 * party_members.user_id, so a double-join fails at the database rather than
 * relying on a check-then-insert race.
 */

export const MAX_PARTY_SIZE = 8;
const DEFAULT_PARTY_SIZE = 4;

/**
 * Invite codes are read aloud and typed by hand, so the alphabet omits
 * characters that are easily confused: 0/O, 1/I/L, 5/S, 8/B.
 */
const CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXY2346799";
const CODE_LENGTH = 6;

function generateInviteCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Shapes come from the shared schema in core/, so the client and this service
 * cannot drift: a field renamed there fails the build here.
 */
export type PartyMemberView = PartyMember;
export type PartyView = Party;
export type PartyError = PartyErrorCode;

export type PartyResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: PartyError };

/**
 * Reads a party with its members. `viewerId` is echoed back as `viewerId` so
 * the client knows which member is itself without having to infer it.
 */
export async function getParty(
  partyId: string,
  viewerId?: string,
): Promise<PartyView | null> {
  const party = await db.query.parties.findFirst({
    where: eq(parties.id, partyId),
  });
  if (!party) return null;

  const rows = await db
    .select({
      userId: partyMembers.userId,
      joinedAt: partyMembers.joinedAt,
      publicId: users.publicId,
      usernameBase: users.usernameBase,
      usernameDiscriminator: users.usernameDiscriminator,
      usernameStatus: users.usernameStatus,
    })
    .from(partyMembers)
    .innerJoin(users, eq(users.id, partyMembers.userId))
    .where(eq(partyMembers.partyId, partyId));

  return {
    id: party.id,
    inviteCode: party.inviteCode,
    isOpen: party.isOpen,
    maxMembers: party.maxMembers,
    leaderId: party.leaderId,
    ...(viewerId ? { viewerId } : {}),
    members: rows.map((row) => ({
      userId: row.userId,
      publicId: row.publicId,
      // Mirrors resolveDisplayUsername: only entitled statuses render bare.
      username: row.usernameBase
        ? ["premium", "indefinite"].includes(row.usernameStatus ?? "")
          ? row.usernameBase
          : `${row.usernameBase}.${row.usernameDiscriminator ?? ""}`
        : null,
      isLeader: row.userId === party.leaderId,
      joinedAt: row.joinedAt.toISOString(),
    })),
  };
}

/** The party a player currently belongs to, or null. */
export async function getPartyForUser(
  userId: string,
): Promise<PartyView | null> {
  const membership = await db.query.partyMembers.findFirst({
    where: eq(partyMembers.userId, userId),
  });
  if (!membership) return null;
  return getParty(membership.partyId, userId);
}

export async function createParty(
  leaderId: string,
  options: { isOpen?: boolean; maxMembers?: number } = {},
): Promise<PartyResult<PartyView>> {
  const existing = await db.query.partyMembers.findFirst({
    where: eq(partyMembers.userId, leaderId),
  });
  if (existing) return { ok: false, error: "already_in_party" };

  const maxMembers = Math.min(
    Math.max(options.maxMembers ?? DEFAULT_PARTY_SIZE, 2),
    MAX_PARTY_SIZE,
  );

  // Retry on the (unlikely) invite-code collision rather than pre-checking:
  // the unique index is the real guarantee, a SELECT first would still race.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const partyId = await db.transaction(async (tx) => {
        const [party] = await tx
          .insert(parties)
          .values({
            leaderId,
            inviteCode: generateInviteCode(),
            isOpen: options.isOpen ?? false,
            maxMembers,
          })
          .returning();
        if (!party) throw new Error("party insert returned no row");
        await tx
          .insert(partyMembers)
          .values({ partyId: party.id, userId: leaderId });
        return party.id;
      });
      const view = await getParty(partyId, leaderId);
      if (!view) throw new Error("party vanished after creation");
      return { ok: true, value: view };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("failed to create party");
}

export async function joinPartyByCode(
  userId: string,
  inviteCode: string,
): Promise<PartyResult<PartyView>> {
  const party = await db.query.parties.findFirst({
    where: eq(parties.inviteCode, inviteCode.toUpperCase()),
  });
  if (!party) return { ok: false, error: "not_found" };

  const existing = await db.query.partyMembers.findFirst({
    where: eq(partyMembers.userId, userId),
  });
  if (existing) {
    // Re-joining the party you are already in is a no-op, not an error.
    if (existing.partyId === party.id) {
      const view = await getParty(party.id, userId);
      return view
        ? { ok: true, value: view }
        : { ok: false, error: "not_found" };
    }
    return { ok: false, error: "already_in_party" };
  }

  const current = await db
    .select({ userId: partyMembers.userId })
    .from(partyMembers)
    .where(eq(partyMembers.partyId, party.id));
  if (current.length >= party.maxMembers) {
    return { ok: false, error: "party_full" };
  }

  try {
    await db.insert(partyMembers).values({ partyId: party.id, userId });
  } catch {
    // Lost a race against a concurrent join elsewhere.
    return { ok: false, error: "already_in_party" };
  }

  const view = await getParty(party.id, userId);
  return view ? { ok: true, value: view } : { ok: false, error: "not_found" };
}

/**
 * Removes a member. When the leader leaves, leadership passes to the
 * longest-standing remaining member; the party is deleted once empty, so no
 * abandoned rows accumulate.
 */
export async function leaveParty(
  userId: string,
): Promise<PartyResult<{ partyId: string; deleted: boolean }>> {
  const membership = await db.query.partyMembers.findFirst({
    where: eq(partyMembers.userId, userId),
  });
  if (!membership) return { ok: false, error: "not_a_member" };

  const partyId = membership.partyId;

  const deleted = await db.transaction(async (tx) => {
    await tx.delete(partyMembers).where(eq(partyMembers.userId, userId));

    const remaining = await tx
      .select({
        userId: partyMembers.userId,
        joinedAt: partyMembers.joinedAt,
      })
      .from(partyMembers)
      .where(eq(partyMembers.partyId, partyId));

    if (remaining.length === 0) {
      await tx.delete(parties).where(eq(parties.id, partyId));
      return true;
    }

    const party = await tx.query.parties.findFirst({
      where: eq(parties.id, partyId),
    });
    if (party?.leaderId === userId) {
      const next = [...remaining].sort(
        (a, b) => a.joinedAt.getTime() - b.joinedAt.getTime(),
      )[0];
      if (next) {
        await tx
          .update(parties)
          .set({ leaderId: next.userId })
          .where(eq(parties.id, partyId));
      }
    }
    return false;
  });

  return { ok: true, value: { partyId, deleted } };
}

/** Leader-only: removes another member. */
export async function kickFromParty(
  leaderId: string,
  targetUserId: string,
): Promise<PartyResult<PartyView>> {
  const membership = await db.query.partyMembers.findFirst({
    where: eq(partyMembers.userId, leaderId),
  });
  if (!membership) return { ok: false, error: "not_a_member" };

  const party = await db.query.parties.findFirst({
    where: eq(parties.id, membership.partyId),
  });
  if (!party) return { ok: false, error: "not_found" };
  if (party.leaderId !== leaderId) return { ok: false, error: "not_leader" };
  if (targetUserId === leaderId) return { ok: false, error: "not_leader" };

  const target = await db.query.partyMembers.findFirst({
    where: eq(partyMembers.userId, targetUserId),
  });
  if (!target || target.partyId !== party.id) {
    return { ok: false, error: "not_a_member" };
  }

  await db.delete(partyMembers).where(eq(partyMembers.userId, targetUserId));

  const view = await getParty(party.id, leaderId);
  return view ? { ok: true, value: view } : { ok: false, error: "not_found" };
}
