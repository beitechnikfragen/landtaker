import { RankedType } from "@game/game/Game.ts";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../db/index.ts";
import { gameParticipants, leaderboardEntries } from "../db/schema.ts";

/**
 * Ranked rating. Turns a finished ranked match into moves on
 * `leaderboard_entries`, which the leaderboard reads and which, until now,
 * nothing ever wrote to.
 *
 * The maths is separated from the database on purpose: `rateMatch()` is a pure
 * function over (rating, team, won) triples and is what the tests exercise,
 * while `applyMatchRating()` is the thin transactional shell that loads the
 * current ratings, calls it, and writes the result back. A rating bug is then a
 * bug in a pure function rather than something only reproducible against a live
 * Postgres.
 */

// ---------------------------------------------------------------------------
// Algorithm
// ---------------------------------------------------------------------------

/**
 * Standard Elo, chosen over Glicko/TrueSkill deliberately.
 *
 * Elo is zero-sum, which is the property that keeps a ladder honest: the points
 * one player gains are exactly the points the other loses, so the mean rating of
 * the pool never drifts and "1400" means the same thing next year as it does
 * today. Glicko-2 and TrueSkill are more accurate per-game because they track a
 * confidence interval as well as a mean, but both need extra per-player state
 * (rating deviation, volatility, sigma) and there is nowhere to put it: the
 * schema is owned elsewhere and stores a single integer `elo` per (user, mode).
 * Implementing a rating system whose state does not fit the storage would mean
 * silently discarding the deviation between matches, which is strictly worse
 * than Elo — a Glicko with an amnesiac RD is just Elo with extra steps.
 *
 * So: Elo, correctly, rather than an approximation of something fancier.
 */

/** Every unrated account starts here, matching `leaderboardEntries.elo`'s default. */
export const DEFAULT_ELO = 1000;

/**
 * The logistic scale. 400 means "400 points of advantage implies a 10:1
 * expected score"; it is the constant every published Elo table is drawn
 * against, and changing it would make our numbers incomparable to the intuition
 * players import from chess and every other ladder.
 */
const ELO_SCALE = 400;

/**
 * K-factor: fixed at 32.
 *
 * The alternative — decaying K with games played (K=40 for newcomers, 20 for
 * established players, as FIDE and Chess.com do) — is more accurate in the
 * steady state, because an established rating is a better estimate and should
 * resist being yanked around by one result. It is genuinely the better choice
 * for a mature ladder, and I am not picking fixed K because decay is wrong.
 *
 * I am picking fixed K because of what it costs *here*. A decaying K is a
 * function of games played, so the rating change for a match depends on how many
 * matches came before it — which makes the ladder order-dependent, and this
 * backend cannot guarantee order. Archive delivery is fire-and-forget from the
 * game server (src/server/Archive.ts logs a failure and moves on), so matches
 * arrive late, out of order, and occasionally twice. Under fixed K a match
 * applies the same delta whenever it lands; under decaying K the same set of
 * matches produces a different ladder depending on the order the archive
 * happened to receive them, and a match retried after a worker restart is
 * rated with a *different* K than it would have had originally. That turns a
 * delivery detail into a rating discrepancy nobody can explain to a player.
 *
 * 32 is the usual mid-range value: a maximally surprising result (beating an
 * opponent whose expected score was ~1) moves 32 points, an evenly matched game
 * moves 16. That settles a new account into roughly its true bracket inside
 * 15-25 matches, which is the right pace for a game where a match is ten
 * minutes rather than four hours.
 *
 * If provisional ratings become a priority later, the honest way to add them is
 * a games-played column and a rating pass that is a function of match history
 * rather than of arrival order — not a K that silently depends on delivery.
 */
export const K_FACTOR = 32;

/** A player as the rating maths sees them: current rating, side, and outcome. */
export interface RatedPlayer {
  userId: string;
  /** Current rating; DEFAULT_ELO for an account that has never been rated. */
  elo: number;
  /**
   * Which side the player was on. Any two distinct values work — the maths only
   * asks "same team or not". Null means FFA, where every player is their own
   * side.
   */
  team: string | null;
  won: boolean;
}

/** What a match does to one player's ladder row. */
export interface RatingChange {
  userId: string;
  eloBefore: number;
  eloAfter: number;
  delta: number;
  won: boolean;
}

/**
 * Expected score for `rating` against `opponent` — the logistic curve at the
 * heart of Elo. Equal ratings give 0.5; +400 gives ~0.909.
 */
export function expectedScore(rating: number, opponent: number): number {
  return 1 / (1 + 10 ** ((opponent - rating) / ELO_SCALE));
}

/**
 * Rates one match.
 *
 * TEAM RESULTS (the 2v2 mapping), and why pairwise rather than team-average:
 *
 * Each player is rated against every opponent individually, and the resulting
 * deltas are averaged over the number of opponents faced. The alternative is to
 * collapse each team to its mean rating, compute one Elo exchange between the
 * two means, and hand every member the same delta.
 *
 * Team-average is wrong in the case that actually occurs: the mismatched duo. A
 * 1600 queueing with a 1000 friend against two 1300s has a team mean of exactly
 * 1300, so team-average calls it an even match and moves everyone 16 points on a
 * win. But Elo's curve is not linear in rating, and a 1600 beating a 1300 is
 * genuinely less surprising than a 1000 beating a 1300 — the 1600 should gain
 * meaningfully less than the 1000 does for the very same win. Pairwise says
 * exactly that: it prices each player against the opponents they actually faced,
 * so the strong player on a carried team gains little and the weak player gains
 * a lot. Team-average instead hands the 1600 a full 16 points for beating
 * players they were expected to beat, which is precisely the exploit — queue
 * with a much weaker friend and farm rating off a curve that has been flattened
 * into a straight line.
 *
 * Pairwise keeps the properties that matter:
 *  - it is exactly standard Elo in 1v1, where each player has one opponent, so
 *    there is no second algorithm to reason about for the 1v1 ladder;
 *  - the averaging over opponent count keeps one match worth at most K points to
 *    any player, so a 2v2 result cannot move a rating twice as far as a 1v1 one;
 *  - it stays zero-sum whenever the two sides are the same size, because every
 *    pair's exchange is itself zero-sum and both members of a pair divide by the
 *    same opponent count. (With uneven sides the divisors differ and the sum is
 *    not exactly zero — accepted knowingly: 1v1 and 2v2 are the only ranked
 *    modes, both are even, and distorting the maths to defend against a match
 *    shape the game does not produce is not worth it.)
 *
 * FFA (`team` null for everyone) is handled by the same code: each player is
 * their own side, so a win is priced against the whole rest of the lobby. That
 * is not a well-founded rating for a 40-player free-for-all, which is why only
 * `rankedType` matches are ever passed here — see `applyMatchRating`.
 *
 * Returns one change per player, in input order. Fewer than two distinct sides
 * means there was nothing to rate and the result is empty.
 */
export function rateMatch(players: RatedPlayer[]): RatingChange[] {
  // "Same side" is team identity in a team game, and the player themselves in
  // FFA — a null team is a side of one, never a side shared with other nulls.
  const sideOf = (index: number): string =>
    players[index]!.team === null ? `@${index}` : `t:${players[index]!.team}`;

  const sides = new Set(players.map((_, index) => sideOf(index)));
  // One side (or none) means no opponents: nothing to exchange, nothing to
  // write. A 2v2 whose second team is entirely guests lands here.
  if (sides.size < 2) return [];

  return players.map((player, index) => {
    const mySide = sideOf(index);
    const opponents = players.filter((_, other) => sideOf(other) !== mySide);

    // Guarded by sides.size >= 2 above, but division by zero is worth ruling
    // out structurally rather than by reading the line above it.
    if (opponents.length === 0) {
      return {
        userId: player.userId,
        eloBefore: player.elo,
        eloAfter: player.elo,
        delta: 0,
        won: player.won,
      };
    }

    const score = player.won ? 1 : 0;
    const totalDelta = opponents.reduce(
      (sum, opponent) =>
        sum + K_FACTOR * (score - expectedScore(player.elo, opponent.elo)),
      0,
    );

    // Averaged over opponents faced, so a match is worth at most K regardless
    // of how many players were in it.
    const delta = roundHalfAwayFromZero(totalDelta / opponents.length);

    return {
      userId: player.userId,
      eloBefore: player.elo,
      eloAfter: player.elo + delta,
      delta,
      won: player.won,
    };
  });
}

/**
 * Rounds to an integer, halves away from zero.
 *
 * `elo` is an integer column, so the fractional delta has to be rounded
 * somewhere. Math.round() breaks ties toward +Infinity (Math.round(-0.5) === 0),
 * which would quietly favour the loser of an evenly-matched pair: their -0.5
 * rounds to 0 while the winner's +0.5 rounds to 1, injecting a point into the
 * pool on every such match. Rounding away from zero keeps the two symmetric.
 */
function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

// ---------------------------------------------------------------------------
// Applying a match
// ---------------------------------------------------------------------------

/** The ranked modes that have a ladder, straight from the game's own enum. */
const RANKED_MODES = new Set<string>([RankedType.OneVOne, RankedType.TwoVTwo]);

/**
 * Whether a mode string names a ladder we rate.
 *
 * THE UNRANKED GUARD. `rankedType` is null on the archived row for every public
 * lobby, private game, and singleplayer match — which is the overwhelming
 * majority of traffic. Only a match the game server itself stamped as ranked
 * moves anybody's rating; an unranked game must leave `leaderboard_entries`
 * byte-for-byte untouched, including the wins and losses counters. This is
 * checked here and again at the top of `applyMatchRating`, and it is the first
 * thing either function does.
 *
 * The value is matched against `RankedType` rather than against string literals
 * so a new ranked mode added on the game side cannot be silently ignored here.
 */
export function isRankedMode(mode: string | null | undefined): boolean {
  return typeof mode === "string" && RANKED_MODES.has(mode);
}

/**
 * A participant row as the rating hook needs it.
 *
 * The fields are optional as well as nullable because the caller passes the
 * rows it is about to insert, and drizzle types a nullable column's insert
 * value as `T | null | undefined`. Both absent and null mean the same thing
 * here — unknown — so both are treated as unratable rather than the caller
 * being made to normalise first.
 */
export interface ParticipantForRating {
  userId?: string | null;
  team?: string | null;
  won?: boolean | null;
}

/**
 * Narrows archived participants to the ones that can be rated.
 *
 * GUESTS. `userId` is null for a player with no account, and there is nowhere to
 * record a rating for someone who does not have a row in `users` — the ladder is
 * keyed on user id. Guests are therefore dropped, and dropping them must not
 * corrupt the players who do have accounts: the remaining players are rated
 * against each other exactly as if the guest had not been in the lobby.
 *
 * That is a real approximation and worth naming. Beating a 2000-rated guest is
 * priced as beating nobody. The alternative — imputing DEFAULT_ELO for guests
 * and letting them influence the exchange — is worse, because it invents a
 * rating for a player we have never observed and then moves real accounts based
 * on it. Skipping is at least honest about what is unknown.
 *
 * A null `won` is also dropped: the record carries no winner (an abandoned or
 * drawn match), so there is no result to rate. Rating those as losses for
 * everyone would punish players for a server-side outcome.
 */
export function ratableParticipants(
  participants: ParticipantForRating[],
): RatedPlayer[] {
  return participants
    .filter(
      (p): p is ParticipantForRating & { userId: string; won: boolean } =>
        typeof p.userId === "string" && typeof p.won === "boolean",
    )
    .map((p) => ({
      userId: p.userId,
      elo: DEFAULT_ELO,
      team: p.team ?? null,
      won: p.won,
    }));
}

/**
 * A transaction handle. `archiveGame` rates inside its own transaction, so the
 * hook takes whatever `db.transaction()` handed it rather than reaching for the
 * pool itself — the rating and the archive it is derived from commit or roll
 * back together.
 */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface RateArchivedGameArgs {
  tx: Tx;
  /** `games.rankedType` as archived. Null for every unranked match. */
  rankedType: string | null;
  participants: ParticipantForRating[];
  /**
   * Whether a previous archive of this game already rated it. Computed by the
   * caller *before* it deletes the old participant rows — see
   * `alreadyRated()`.
   */
  alreadyRated: boolean;
}

export type RateArchivedGameResult =
  | { rated: false; reason: "unranked" | "already_rated" | "no_opponents" }
  | { rated: true; mode: string; changes: RatingChange[] };

/**
 * IDEMPOTENCY — the hard requirement, and how it is met without a new column.
 *
 * `archiveGame` upserts and can legitimately run twice for one match: the game
 * server's POST is fire-and-forget with no delivery bookkeeping, so a retry
 * after a worker restart replays the same body. Rating is an *increment*, so
 * running it twice would apply the deltas twice and inflate the ladder — and
 * unlike the archive itself, the second application is not a no-op that anyone
 * would notice.
 *
 * The obvious fix is a `rated_at` column on `games`. I may not add one, and it
 * turns out not to be needed, because the archive already persists a fact that
 * answers the question: whether `game_participants` holds rows for this game
 * that carry an account and a decided result. Those rows are written by the same
 * transaction that would have rated the match, so their presence is exactly the
 * condition "a previous archive got far enough to rate this game".
 *
 * The subtlety that makes it work is ordering. `archiveGame` DELETEs the old
 * participant rows before inserting the new ones, which would destroy the
 * evidence — so `alreadyRated()` is called *before* the delete, and its answer
 * is carried into the rating step.
 *
 * THE MUTUAL EXCLUSION, and why a row lock is not enough. The read above is
 * useless on its own against two duplicate POSTs arriving at once: both
 * transactions read "not yet rated" before either commits, and both rate. The
 * instinct is `SELECT ... FOR UPDATE` on the participant rows, and it does not
 * work — on a *first* archive there are no participant rows yet, and Postgres
 * cannot lock a row that does not exist. That is not a hypothetical: six
 * concurrent archives of one new match rated it six times and put the winner on
 * 1077 with six wins instead of 1016 with one.
 *
 * So the exclusion is a transaction-scoped ADVISORY lock keyed on the game id.
 * `pg_advisory_xact_lock` needs neither a row nor a column: the first archive to
 * take it holds it until its transaction commits, and every duplicate blocks
 * there, then reads the now-committed participant rows and skips. It is released
 * automatically at commit or rollback, so a crashed archive cannot wedge the
 * game permanently. The key is a 64-bit hash of the game id, so archives of
 * *different* matches never contend — only duplicates of the same one serialize.
 *
 * This holds against a partial first write too: a crash between the participant
 * insert and the rating update rolls the whole transaction back, because they
 * share one. There is no state where participants exist but the rating did not
 * happen.
 *
 * The one behaviour it deliberately does NOT provide is re-rating a corrected
 * record. If a re-archive carries a genuinely different winner, the rating from
 * the first archive stands. Fixing that means reversing the original deltas,
 * which requires knowing what they were — that is what a stored per-match rating
 * delta would buy, and it is the thing worth a schema change if match
 * corrections ever become real. Today the record is server-authored and
 * immutable, so the second body is the same as the first and there is nothing
 * to correct.
 */
export async function alreadyRated(tx: Tx, gameId: string): Promise<boolean> {
  // Serialize duplicate archives of THIS game before reading. Everything after
  // this line runs with at most one archive of this game id in flight, which is
  // what makes the read below a decision rather than a race. Held until the
  // caller's transaction ends, so it is released even if the archive throws.
  await tx.execute(sql`select pg_advisory_xact_lock(${advisoryKey(gameId)})`);

  const rows = await tx
    .select({ clientId: gameParticipants.clientId })
    .from(gameParticipants)
    .where(
      and(
        eq(gameParticipants.gameId, gameId),
        // Only rows that would themselves have been rated count as evidence:
        // an archive that stored nothing but guests never touched the ladder,
        // so it must not block a later archive from rating.
        isNotNull(gameParticipants.userId),
        isNotNull(gameParticipants.won),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

/**
 * A stable 64-bit advisory-lock key for a game id.
 *
 * FNV-1a, computed in BigInt and folded into the signed 64-bit range Postgres'
 * `bigint` accepts. It only has to be deterministic and well spread: a
 * collision between two different game ids costs one archive a brief wait, not
 * a wrong rating, because the participant read is still per-game.
 */
export function advisoryKey(gameId: string): bigint {
  const MASK = (1n << 64n) - 1n;
  let hash = 14695981039346656037n;
  for (let i = 0; i < gameId.length; i++) {
    hash = ((hash ^ BigInt(gameId.charCodeAt(i))) * 1099511628211n) & MASK;
  }
  // Postgres' bigint is signed; wrap the top half into the negative range.
  return hash >= 1n << 63n ? hash - (1n << 64n) : hash;
}

/**
 * Applies a rated match to `leaderboard_entries`.
 *
 * Reads the current ratings, computes the changes, and writes each player's new
 * rating and win/loss counters. Everything runs on the caller's transaction, so
 * a failure here rolls the archive back with it rather than leaving a match
 * archived-but-half-rated.
 */
export async function rateArchivedGame(
  args: RateArchivedGameArgs,
): Promise<RateArchivedGameResult> {
  const { tx, rankedType, participants } = args;

  // The unranked guard, first and unconditional.
  if (!isRankedMode(rankedType)) return { rated: false, reason: "unranked" };
  const mode = rankedType as string;

  if (args.alreadyRated) return { rated: false, reason: "already_rated" };

  const ratable = ratableParticipants(participants);
  if (ratable.length < 2) return { rated: false, reason: "no_opponents" };

  // Current ratings. A player with no row yet is unrated and starts at
  // DEFAULT_ELO, which is also the column default — so a first-time player is
  // rated at 1000 whether or not their row has been created yet.
  const userIds = [...new Set(ratable.map((p) => p.userId))];
  const existing = await tx
    .select({
      userId: leaderboardEntries.userId,
      elo: leaderboardEntries.elo,
    })
    .from(leaderboardEntries)
    .where(
      and(
        eq(leaderboardEntries.mode, mode),
        inArray(leaderboardEntries.userId, userIds),
      ),
    )
    .for("update");

  const currentElo = new Map(existing.map((row) => [row.userId, row.elo]));
  const withRatings = ratable.map((player) => ({
    ...player,
    elo: currentElo.get(player.userId) ?? DEFAULT_ELO,
  }));

  const changes = rateMatch(withRatings);
  if (changes.length === 0) return { rated: false, reason: "no_opponents" };

  for (const change of changes) {
    // Wins and losses move with the rating, in the same statement, so the
    // counters can never disagree with the ladder: a rated match is always
    // exactly one increment to one of the two.
    const win = change.won ? 1 : 0;
    const loss = change.won ? 0 : 1;

    await tx
      .insert(leaderboardEntries)
      .values({
        userId: change.userId,
        mode,
        elo: change.eloAfter,
        wins: win,
        losses: loss,
      })
      .onConflictDoUpdate({
        target: [leaderboardEntries.userId, leaderboardEntries.mode],
        // Incremented from the stored value rather than from a number read
        // earlier in this function: the row is locked above, but expressing the
        // counters as a delta keeps them correct even if that ever changes.
        set: {
          elo: change.eloAfter,
          wins: sql`${leaderboardEntries.wins} + ${win}`,
          losses: sql`${leaderboardEntries.losses} + ${loss}`,
          updatedAt: new Date(),
        },
      });
  }

  return { rated: true, mode, changes };
}
