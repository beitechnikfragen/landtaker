import type { PublicPlayerGame } from "@game/ApiSchemas.ts";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { gameParticipants, games, users } from "../db/schema.ts";

/**
 * A player's match history, as shown on their public profile.
 *
 * Reads the promoted columns on `games` and `game_participants` only — the
 * archived `record` blob exists for replays and must never be scanned to
 * render a list.
 *
 * Anonymous games are excluded by construction: rows are matched on
 * `user_id`, so only matches played while signed in appear.
 */

export const PLAYER_GAMES_PAGE_LIMIT = 20;
const PLAYER_GAMES_PAGE_LIMIT_MAX = 50;

export function normalizeLimit(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return PLAYER_GAMES_PAGE_LIMIT;
  return Math.min(Math.floor(value), PLAYER_GAMES_PAGE_LIMIT_MAX);
}

/**
 * Cursor paging keyed on `ended_at`, not OFFSET: new games land at the top
 * between requests, and an offset page would then repeat or skip rows. The
 * token is the ISO timestamp of the last row served — opaque to the client,
 * which round-trips it verbatim.
 */
function decodeCursor(raw: unknown): Date | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export interface PlayerGamesPage {
  results: PublicPlayerGame[];
  nextCursor: string | null;
}

/** Resolves a publicId to a user id. Null when no such account exists. */
export async function findUserIdByPublicId(
  publicId: string,
): Promise<string | null> {
  const row = await db.query.users.findFirst({
    where: eq(users.publicId, publicId),
  });
  return row?.id ?? null;
}

export async function listPlayerGames(
  userId: string,
  limit: number,
  cursor: unknown,
): Promise<PlayerGamesPage> {
  const before = decodeCursor(cursor);

  const finished = sql`${games.endedAt} is not null`;
  const rows = await db
    .select({
      gameId: games.id,
      startedAt: games.startedAt,
      endedAt: games.endedAt,
      durationSeconds: games.durationSeconds,
      map: games.map,
      mode: games.mode,
      rankedType: games.rankedType,
      won: gameParticipants.won,
      playerName: gameParticipants.playerName,
      clanTag: gameParticipants.clanTag,
      // One extra query per row would be a classic N+1; count in the same
      // statement instead.
      totalPlayers: sql<number>`(
        select count(*)::int from ${gameParticipants} p
        where p.game_id = ${games.id}
      )`,
    })
    .from(gameParticipants)
    .innerJoin(games, eq(games.id, gameParticipants.gameId))
    .where(
      before
        ? and(
            eq(gameParticipants.userId, userId),
            finished,
            lt(games.endedAt, before),
          )
        : and(eq(gameParticipants.userId, userId), finished),
    )
    .orderBy(desc(games.endedAt))
    // One extra row answers "is there another page?" without a second query.
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page.at(-1);

  return {
    results: page.map((row) => ({
      gameId: row.gameId,
      // The schema demands a datetime; fall back to endedAt (never null here,
      // the query filters on it) when a record carried no start.
      start: (row.startedAt ?? row.endedAt!).toISOString(),
      durationSeconds: Math.max(0, row.durationSeconds ?? 0),
      map: row.map ?? "",
      mode: row.mode ?? "",
      // We do not record whether a lobby was public or private, and guessing
      // would put a wrong label on every row.
      type: "public",
      playerTeams: null,
      rankedType: row.rankedType ?? "none",
      result:
        row.won === true
          ? "victory"
          : row.won === false
            ? "defeat"
            : "incomplete",
      totalPlayers: row.totalPlayers,
      username: row.playerName ?? "",
      clanTag: row.clanTag,
    })),
    nextCursor:
      rows.length > limit && last?.endedAt ? last.endedAt.toISOString() : null,
  };
}
