import type {
  AdminAuditEntry,
  AdminUserDetail,
  AdminUserPatch,
  AdminUserQuery,
  AdminUserSummary,
} from "@game/AdminApiSchemas.ts";
import {
  and,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  or,
} from "drizzle-orm";
import { db } from "../db/index.ts";
import { adminAuditLog, bans, identities, users } from "../db/schema.ts";
import { resolveDisplayUsername } from "./users.ts";

// ---------------------------------------------------------------------------
// Pure helpers
//
// Kept free of database access so they can be tested directly. The backend's
// test suite has no Postgres (see vitest.config.ts — node environment, no
// container), so anything that matters has to be decidable from its inputs.
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Whether `actorRole` may set a target's role to `nextRole`.
 *
 * Only root touches admin. An admin who could promote another admin could
 * promote a second account they control and use it to undo any demotion, so
 * the privilege ladder has to be one-directional: admins moderate players,
 * root manages admins.
 *
 * Demoting an existing admin is likewise root-only, which is enforced
 * separately in `roleChangeRefusal` because it depends on the *current* role
 * rather than the requested one.
 */
export function mayAssignRole(
  actorRole: string | null | undefined,
  nextRole: string | null,
): boolean {
  // Checked before the root shortcut below: "root" is never assignable through
  // the API by anyone, root included. Bootstrapping a second root is a
  // deliberate database operation, not something a session can do.
  if (nextRole === "root") return false;
  if (actorRole === "root") return true;
  return nextRole !== "admin";
}

/**
 * Explains why a role change must be refused, or null if it is allowed.
 * Returned as a message so the route can answer 403 with something actionable.
 */
export function roleChangeRefusal(args: {
  actorId: string;
  actorRole: string | null | undefined;
  targetId: string;
  targetCurrentRole: string | null;
  nextRole: string | null;
}): string | null {
  const { actorId, actorRole, targetId, targetCurrentRole, nextRole } = args;

  if (actorId === targetId) {
    // Locking yourself out of the panel is never the intent, and recovering
    // needs a database write. Refuse rather than let it happen.
    if (nextRole !== actorRole) {
      return "You cannot change your own role";
    }
    // Resending your own current role changes nothing. Returning early rather
    // than falling through matters: an admin re-sending "admin" would
    // otherwise be caught by the admin-cannot-grant-admin rule below and see a
    // confusing refusal for a no-op.
    return null;
  }
  if (targetCurrentRole === "root" && actorRole !== "root") {
    return "Only root may modify a root account";
  }
  if (targetCurrentRole === "admin" && actorRole !== "root") {
    return "Only root may demote an admin";
  }
  if (!mayAssignRole(actorRole, nextRole)) {
    return nextRole === "root"
      ? "The root role cannot be assigned through the panel"
      : "Only root may grant the admin role";
  }
  return null;
}

/**
 * Ban expiry from a duration, resolved against a caller-supplied `now` so the
 * result is testable and so a single request cannot straddle two clock reads.
 * Null (permanent) and undefined (unspecified) both mean no expiry.
 */
export function banExpiresAt(
  durationHours: number | null | undefined,
  now: Date,
): Date | null {
  if (durationHours === null || durationHours === undefined) return null;
  return new Date(now.getTime() + durationHours * 60 * 60 * 1000);
}

/**
 * Clamps a credit delta so the resulting balance stays within [0, max].
 *
 * Returns the balance to write rather than the delta: the caller needs the
 * absolute value, and computing it here keeps the "cannot go negative" rule in
 * one place. A grant that would overflow is clamped rather than rejected —
 * refusing a +1000 because the account is near the ceiling is more surprising
 * than capping it.
 */
export function clampCredits(
  current: number,
  delta: number,
  max = 1_000_000_000,
): number {
  const next = current + delta;
  if (next < 0) return 0;
  if (next > max) return max;
  return next;
}

/**
 * Normalises a flare list: trims, drops empties, de-duplicates, preserves
 * first-seen order. Flares are entitlement strings (`pattern:x`, `flag:y`) and
 * duplicates in the column would make ownership checks ambiguous.
 */
export function normalizeFlares(flares: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of flares) {
    const flare = raw.trim();
    if (flare === "" || seen.has(flare)) continue;
    seen.add(flare);
    out.push(flare);
  }
  return out;
}

/**
 * Turns a validated patch into the column updates to apply, dropping keys the
 * caller did not send. Separated from the write so the mapping is testable.
 *
 * Note `role` is passed through when explicitly null — that is the "clear the
 * role" operation, distinct from omitting the key.
 */
export function buildUserUpdate(
  patch: AdminUserPatch,
): Partial<typeof users.$inferInsert> {
  const update: Partial<typeof users.$inferInsert> = {};
  if ("role" in patch) update.role = patch.role ?? null;
  if (patch.credits !== undefined) update.credits = patch.credits;
  if (patch.adfree !== undefined) update.adfree = patch.adfree;
  if (patch.unlimitedRanked !== undefined) {
    update.unlimitedRanked = patch.unlimitedRanked;
  }
  if (patch.canCreatePublicLobbies !== undefined) {
    update.canCreatePublicLobbies = patch.canCreatePublicLobbies;
  }
  if (patch.flares !== undefined) {
    update.flares = normalizeFlares(patch.flares);
  }
  return update;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

type UserRow = typeof users.$inferSelect;

/**
 * Active = not lifted, and either permanent or not yet expired. Mirrors the
 * private findActiveBan in services/users.ts; kept as an exported predicate
 * builder here because the admin list needs it across many users at once.
 */
function activeBanCondition(now: Date) {
  return and(
    isNull(bans.liftedAt),
    or(isNull(bans.expiresAt), gt(bans.expiresAt, now)),
  );
}

function toSummary(user: UserRow, banned: boolean): AdminUserSummary {
  return {
    id: user.id,
    publicId: user.publicId,
    email: user.email,
    username: resolveDisplayUsername(user),
    role: user.role,
    credits: user.credits,
    adfree: user.adfree,
    unlimitedRanked: user.unlimitedRanked,
    canCreatePublicLobbies: user.canCreatePublicLobbies,
    flareCount: user.flares?.length ?? 0,
    banned,
    createdAt: user.createdAt.toISOString(),
    lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
  };
}

/**
 * Search users for the admin table. An exact UUID looks up by id; anything
 * else is a case-insensitive substring over publicId, email and username base.
 */
export async function listUsers(query: AdminUserQuery): Promise<{
  users: AdminUserSummary[];
  total: number;
}> {
  const filters = [];

  if (query.q) {
    const term = query.q;
    if (isUuid(term)) {
      filters.push(eq(users.id, term));
    } else {
      const like = `%${term}%`;
      filters.push(
        or(
          ilike(users.publicId, like),
          ilike(users.email, like),
          ilike(users.usernameBase, like),
        ),
      );
    }
  }

  if (query.role) {
    // "none" is how the panel asks for accounts with no role at all; a literal
    // role string filters to exactly that role.
    filters.push(
      query.role === "none" ? isNull(users.role) : eq(users.role, query.role),
    );
  }

  const where = filters.length > 0 ? and(...filters) : undefined;

  const [rows, totalRows] = await Promise.all([
    db
      .select()
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ value: count() }).from(users).where(where),
  ]);

  // One query for the ban flags of the whole page rather than one per row.
  const now = new Date();
  const ids = rows.map((r) => r.id);
  const bannedIds = new Set<string>();
  if (ids.length > 0) {
    const activeBans = await db
      .select({ userId: bans.userId })
      .from(bans)
      .where(and(inArray(bans.userId, ids), activeBanCondition(now)));
    for (const row of activeBans) bannedIds.add(row.userId);
  }

  return {
    users: rows.map((row) => toSummary(row, bannedIds.has(row.id))),
    total: totalRows[0]?.value ?? 0,
  };
}

export async function getUserDetail(
  userId: string,
): Promise<AdminUserDetail | null> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return null;

  const [links, banRows] = await Promise.all([
    db.select().from(identities).where(eq(identities.userId, userId)),
    db
      .select()
      .from(bans)
      .where(eq(bans.userId, userId))
      .orderBy(desc(bans.createdAt)),
  ]);

  const now = new Date();
  const hasActiveBan = banRows.some(
    (b) => b.liftedAt === null && (b.expiresAt === null || b.expiresAt > now),
  );

  return {
    ...toSummary(user, hasActiveBan),
    usernameBase: user.usernameBase,
    usernameDiscriminator: user.usernameDiscriminator,
    usernameStatus: user.usernameStatus,
    flares: user.flares ?? [],
    identities: links.map((link) => ({
      provider: link.provider,
      providerUserId: link.providerUserId,
      linkedAt: link.linkedAt.toISOString(),
    })),
    bans: banRows.map((ban) => ({
      id: ban.id,
      category: ban.category,
      reason: ban.reason,
      expiresAt: ban.expiresAt?.toISOString() ?? null,
      createdAt: ban.createdAt.toISOString(),
      liftedAt: ban.liftedAt?.toISOString() ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/**
 * Records an admin action. Never throws into the caller: an audit write that
 * fails must not roll back the action the operator already saw succeed, but it
 * must be loud in the logs.
 */
export async function recordAudit(args: {
  actorId: string;
  actorName: string | null;
  action: string;
  targetId: string | null;
  detail: unknown;
  log?: { warn: (obj: unknown, msg: string) => void };
}): Promise<void> {
  try {
    await db.insert(adminAuditLog).values({
      actorId: args.actorId,
      actorName: args.actorName,
      action: args.action,
      targetId: args.targetId,
      detail: (args.detail ?? {}) as object,
    });
  } catch (err) {
    args.log?.warn({ err, action: args.action }, "failed to write audit entry");
  }
}

export async function listAudit(args: {
  targetId?: string;
  limit: number;
  offset: number;
}): Promise<{ entries: AdminAuditEntry[]; total: number }> {
  const where = args.targetId
    ? eq(adminAuditLog.targetId, args.targetId)
    : undefined;

  const [rows, totalRows] = await Promise.all([
    db
      .select()
      .from(adminAuditLog)
      .where(where)
      .orderBy(desc(adminAuditLog.createdAt))
      .limit(args.limit)
      .offset(args.offset),
    db.select({ value: count() }).from(adminAuditLog).where(where),
  ]);

  return {
    entries: rows.map((row) => ({
      id: row.id,
      actorId: row.actorId,
      actorName: row.actorName,
      action: row.action,
      targetId: row.targetId,
      detail: row.detail,
      createdAt: row.createdAt.toISOString(),
    })),
    total: totalRows[0]?.value ?? 0,
  };
}
