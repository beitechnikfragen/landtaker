import type {
  RankedLeaderboardEntry,
  RankedLeaderboardResponse,
  TribeLeaderboardResponse,
} from "@game/ApiSchemas.ts";
import { RankedType } from "@game/game/Game.ts";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { leaderboardEntries, users } from "../db/schema.ts";
import { resolveDisplayUsername } from "./users.ts";

/**
 * Public leaderboards. Both boards are read-only projections: nothing here
 * writes, so a board can never corrupt ranking state.
 *
 * The ranked board reads `leaderboard_entries`, which carries one row per
 * (user, mode) and is indexed on (mode, elo) — exactly the ordering below, so
 * a page is an index scan rather than a sort of the whole ladder.
 */

/**
 * Page size. Mirrors `playerPageSize` in the client's
 * LeaderboardPlayerList: it stops paging when a page comes back short, so a
 * smaller number here would truncate the board and a larger one would make it
 * ask for pages that do not exist.
 */
export const RANKED_PAGE_SIZE = 50;

/**
 * Upper bound on pages, matching the upstream API the client was written
 * against. Beyond it the client expects a 400 whose message it pattern-matches
 * (`isPageBoundsMessage` in src/client/Api.ts) to mean "stop", so the cap is
 * part of the contract rather than a local safety valve.
 */
export const RANKED_MAX_PAGE = 20;

/** The ladders served, in the order the response lists them. */
const RANKED_MODES = [RankedType.OneVOne, RankedType.TwoVTwo] as const;

/**
 * Message for a page outside the bounds. The client matches it against
 * /^Page must be between \d+ and \d+$/ — reword it and paging silently turns
 * into a generic failure.
 */
export function pageBoundsMessage(): string {
  return `Page must be between 1 and ${RANKED_MAX_PAGE}`;
}

export function isValidRankedPage(page: number): boolean {
  return Number.isInteger(page) && page >= 1 && page <= RANKED_MAX_PAGE;
}

/**
 * One page of one ladder. `rank` is absolute across pages, so page 2 of a
 * 50-entry board starts at 51 — the client renders it verbatim.
 *
 * Ordering is elo descending with `userId` as a tiebreak: without a total
 * order, two rows with equal elo could swap between pages and be shown twice
 * or not at all.
 */
async function fetchLadderPage(
  mode: string,
  page: number,
): Promise<RankedLeaderboardEntry[]> {
  const offset = (page - 1) * RANKED_PAGE_SIZE;

  const rows = await db
    .select({
      elo: leaderboardEntries.elo,
      wins: leaderboardEntries.wins,
      losses: leaderboardEntries.losses,
      publicId: users.publicId,
      usernameBase: users.usernameBase,
      usernameDiscriminator: users.usernameDiscriminator,
      usernameStatus: users.usernameStatus,
    })
    .from(leaderboardEntries)
    .innerJoin(users, eq(users.id, leaderboardEntries.userId))
    .where(eq(leaderboardEntries.mode, mode))
    .orderBy(desc(leaderboardEntries.elo), leaderboardEntries.userId)
    .limit(RANKED_PAGE_SIZE)
    .offset(offset);

  return rows.map((row, index) => ({
    rank: offset + index + 1,
    elo: row.elo,
    // Peak elo is not tracked yet; null is the schema's "unknown", which the
    // client renders as absent rather than as a peak equal to the current elo.
    peakElo: null,
    wins: row.wins,
    losses: row.losses,
    total: row.wins + row.losses,
    public_id: row.publicId,
    // Resolved server-side, never assembled here: the presence of a dot is
    // what the game derives the verified badge from.
    accountUsername: resolveDisplayUsername(row),
  }));
}

/**
 * One page across every ladder. A page carries a slice of each ranked type;
 * the client folds them all in at once and tracks "has more" per ladder, so
 * the ladders are allowed to run out at different pages.
 *
 * An empty table yields empty arrays, not an error — a fresh install must
 * render an empty board.
 */
export async function fetchRankedLeaderboard(
  page: number,
): Promise<RankedLeaderboardResponse> {
  const ladders = await Promise.all(
    RANKED_MODES.map((mode) => fetchLadderPage(mode, page)),
  );

  return {
    [RankedType.OneVOne]: ladders[0]!,
    [RankedType.TwoVTwo]: ladders[1]!,
  };
}

/**
 * Rolling window the tribe board would rank by. Declared here so the
 * placeholder reports the same window length the real implementation will.
 */
const TRIBE_WINDOW_DAYS = 30;

/** YYYY-MM-DD in UTC, the format the board's bounds use. */
function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * PLACEHOLDER. Custom tribe names do not exist in this backend yet: there is
 * no table of purchased names and no per-game appearance tracking to rank them
 * by, so there is nothing to return.
 *
 * It answers with a schema-valid empty page rather than a 404, because the
 * client treats a non-200 as a failed board and shows an error, while an empty
 * `tribes` array renders as "no entries" — the honest state. The window bounds
 * are real dates so the caption the client draws from them is not nonsense.
 *
 * Deliberately NOT fabricating rows: a made-up board is indistinguishable from
 * a real one to the player.
 *
 * When tribe names land, replace the body with a real aggregate over the
 * window and keep the response shape.
 */
export function fetchTribeLeaderboard(
  now: Date = new Date(),
): TribeLeaderboardResponse {
  const start = new Date(now.getTime());
  // Inclusive bounds: a 30-day window ending today starts 29 days back.
  start.setUTCDate(start.getUTCDate() - (TRIBE_WINDOW_DAYS - 1));

  return {
    windowDays: TRIBE_WINDOW_DAYS,
    start: toDateString(start),
    end: toDateString(now),
    tribes: [],
  };
}
