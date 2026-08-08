import type { RecentMatch, UserMeResponse } from "@game/ApiSchemas.ts";
import { and, desc, eq, gt, isNotNull, isNull, or } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db } from "../db/index.ts";
import {
  bans,
  friendships,
  gameParticipants,
  games,
  identities,
  leaderboardEntries,
  users,
} from "../db/schema.ts";

/**
 * Builds the /users/@me payload. This response is the widest contract we owe
 * the game: it drives ad entitlement, ranked limits, lobby permissions, the
 * username UI and the ban screen. It must satisfy UserMeResponseSchema.
 *
 * Optional fields are deliberately omitted rather than sent empty — the schema
 * treats absence as "feature not present", which degrades cleanly.
 */
export async function buildUserMeResponse(
  userId: string,
): Promise<UserMeResponse | null> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });
  if (!user) return null;

  const [links, activeBan, ranks, friendIds, recentMatches] = await Promise.all(
    [
      db.select().from(identities).where(eq(identities.userId, userId)),
      findActiveBan(userId),
      db
        .select()
        .from(leaderboardEntries)
        .where(eq(leaderboardEntries.userId, userId)),
      listFriendPublicIds(userId),
      listRecentMatches(userId),
    ],
  );

  const userBlock: UserMeResponse["user"] = {};
  for (const link of links) {
    const profile = link.profile as Record<string, unknown>;
    if (link.provider === "discord") {
      userBlock.discord = profile as UserMeResponse["user"]["discord"];
    } else if (link.provider === "google") {
      userBlock.google = profile as UserMeResponse["user"]["google"];
    } else if (link.provider === "steam") {
      userBlock.steam = profile as UserMeResponse["user"]["steam"];
    }
  }
  if (user.email) userBlock.email = user.email;

  const oneVone = ranks.find((r) => r.mode === "1v1");
  const twoVtwo = ranks.find((r) => r.mode === "2v2");

  return {
    user: userBlock,
    ban: activeBan
      ? {
          category: activeBan.category,
          reason: activeBan.reason,
          expiresAt: activeBan.expiresAt?.toISOString() ?? null,
        }
      : null,
    player: {
      publicId: user.publicId,
      adfree: user.adfree,
      credits: user.credits,
      unlimitedRanked: user.unlimitedRanked,
      canCreatePublicLobbies: user.canCreatePublicLobbies,
      username: resolveDisplayUsername(user),
      usernameBase: user.usernameBase,
      usernameDiscriminator: user.usernameDiscriminator,
      ...(user.usernameStatus
        ? {
            usernameStatus:
              user.usernameStatus as UserMeResponse["player"]["usernameStatus"],
          }
        : {}),
      nextUsernameChangeAt: user.nextUsernameChangeAt?.toISOString() ?? null,
      achievements: { singleplayerMap: [] },
      // wins/losses live on the same row as elo, so sending them costs
      // nothing extra and saves the client a second request to show a record.
      leaderboard: {
        ...(oneVone
          ? {
              oneVone: {
                elo: oneVone.elo,
                wins: oneVone.wins,
                losses: oneVone.losses,
              },
            }
          : {}),
        ...(twoVtwo
          ? {
              twoVtwo: {
                elo: twoVtwo.elo,
                wins: twoVtwo.wins,
                losses: twoVtwo.losses,
              },
            }
          : {}),
      },
      recentMatches,
      friends: friendIds,
      subscription: null,
    },
  };
}

/**
 * Statuses that render the bare name. Only these earn the verified check —
 * the game derives the badge purely from the name having no dot
 * (isVerifiedUsername in src/core/ApiSchemas.ts), so this list IS the badge
 * rule. "claimed" deliberately does not qualify: a claim reserves the name,
 * an entitlement displays it.
 */
const BARE_NAME_STATUSES = new Set(["premium", "indefinite"]);

/**
 * The display form the game renders as-is. Entitled holders show the bare
 * base; everyone else gets "base.1234". The game explicitly forbids assembling
 * this client-side, so it is resolved here and here only.
 */
export function resolveDisplayUsername(
  user: Pick<
    typeof users.$inferSelect,
    "usernameBase" | "usernameDiscriminator" | "usernameStatus"
  >,
): string | null {
  if (!user.usernameBase) return null;
  if (BARE_NAME_STATUSES.has(user.usernameStatus ?? "")) {
    return user.usernameBase;
  }
  if (!user.usernameDiscriminator) return user.usernameBase;
  return `${user.usernameBase}.${user.usernameDiscriminator}`;
}

async function findActiveBan(userId: string) {
  const rows = await db
    .select()
    .from(bans)
    .where(
      and(
        eq(bans.userId, userId),
        isNull(bans.liftedAt),
        // Permanent, or not yet expired.
        or(isNull(bans.expiresAt), gt(bans.expiresAt, new Date())),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Friend public IDs. Friendships are stored once with userIdA < userIdB, so
 * both directions have to be collected.
 */
async function listFriendPublicIds(userId: string): Promise<string[]> {
  const [asA, asB] = await Promise.all([
    db
      .select({ publicId: users.publicId })
      .from(friendships)
      .innerJoin(users, eq(users.id, friendships.userIdB))
      .where(eq(friendships.userIdA, userId)),
    db
      .select({ publicId: users.publicId })
      .from(friendships)
      .innerJoin(users, eq(users.id, friendships.userIdA))
      .where(eq(friendships.userIdB, userId)),
  ]);
  return [...asA, ...asB].map((row) => row.publicId);
}

/**
 * How many finished matches /users/@me carries. Small on purpose: this is the
 * "what did I just play" strip on the home page, not a match archive — a full
 * history belongs behind its own paginated endpoint.
 */
export const RECENT_MATCHES_LIMIT = 5;

/**
 * The caller's most recent finished matches, newest first.
 *
 * Reads `game_participants` (indexed on user_id) and joins the parent game for
 * the map and mode, so it never touches the archived `record` JSON — that blob
 * exists for replays and is large.
 *
 * Unfinished games are excluded: a row with no `endedAt` is a match still in
 * progress or one whose result never arrived, and neither is history.
 */
async function listRecentMatches(userId: string): Promise<RecentMatch[]> {
  const rows = await db
    .select({
      gameId: games.id,
      map: games.map,
      mode: games.mode,
      rankedType: games.rankedType,
      endedAt: games.endedAt,
      placement: gameParticipants.placement,
      won: gameParticipants.won,
    })
    .from(gameParticipants)
    .innerJoin(games, eq(games.id, gameParticipants.gameId))
    .where(and(eq(gameParticipants.userId, userId), isNotNull(games.endedAt)))
    .orderBy(desc(games.endedAt))
    .limit(RECENT_MATCHES_LIMIT);

  return rows.map((row) => ({
    gameId: row.gameId,
    map: row.map,
    mode: row.mode,
    rankedType: row.rankedType,
    placement: row.placement,
    won: row.won,
    endedAt: row.endedAt?.toISOString() ?? null,
  }));
}

/**
 * Public IDs are shown to other players and must not be guessable from an
 * account id, so they get their own random value.
 */
export function generatePublicId(): string {
  return randomBytes(12).toString("base64url");
}

/** Creates a bare account. Identity linking happens separately. */
export async function createUser(
  fields: Partial<typeof users.$inferInsert> = {},
): Promise<typeof users.$inferSelect> {
  const [row] = await db
    .insert(users)
    .values({ publicId: generatePublicId(), ...fields })
    .returning();
  if (!row) throw new Error("Failed to create user");
  return row;
}
