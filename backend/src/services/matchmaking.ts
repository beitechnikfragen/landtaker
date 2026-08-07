import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { leaderboardEntries, users } from "../db/schema.ts";
import { redis } from "../redis.ts";
import { DEFAULT_ELO } from "./elo.ts";

/**
 * Ranked matchmaking: the 1v1 and 2v2 queues.
 *
 * Two parties talk to this module and neither is ours to change:
 *
 *   - the client (src/client/Matchmaking.ts) holds a WebSocket open while
 *     queued. It sends one `{type:"join", jwt}` message ~2s after the socket
 *     opens, then expects `{type:"queue-size", count}` at least every 15s (its
 *     watchdog reconnects on silence) and eventually
 *     `{type:"match-assignment", gameId}`.
 *
 *   - the game worker (src/server/Worker.ts) long-polls
 *     `POST /matchmaking/checkin` with a gameId it has pre-allocated, and
 *     aborts after 20s. A 200 with no `assignment` means "nothing to do".
 *     A 200 WITH an assignment means it must create that game.
 *
 * The queue itself is ephemeral and lives in Redis. Losing it costs the queued
 * players nothing worse than a bounce back to the menu: the client reconnects
 * on an unexpected close and re-sends its join. Nothing here may be the reason
 * the process dies — every Redis call is wrapped, and a Redis outage makes
 * matchmaking unavailable rather than fatal.
 */

/**
 * The two queues. These strings are not free-form: they are the client's
 * `?mode=` query value, the worker's `mode` field, AND the `mode` column in
 * `leaderboard_entries` (RankedType.OneVOne / TwoVTwo in the game's
 * src/core/game/Game.ts). The rating lookup below matches on this value
 * directly, so renaming it would silently rate everyone at DEFAULT_ELO.
 */
export type MatchmakingMode = "1v1" | "2v2";

/** How many players a formed match holds, per mode. */
export const MATCH_SIZE: Record<MatchmakingMode, number> = {
  "1v1": 2,
  "2v2": 4,
};

/** Teams per match, per mode. 1v1 is two teams of one; 2v2 two teams of two. */
export const TEAM_COUNT: Record<MatchmakingMode, number> = {
  "1v1": 2,
  "2v2": 2,
};

export function isMatchmakingMode(v: unknown): v is MatchmakingMode {
  return v === "1v1" || v === "2v2";
}

// ---------------------------------------------------------------------------
// Rating windows
// ---------------------------------------------------------------------------

/**
 * The acceptable rating gap between the strongest and weakest player in a
 * candidate match, as a function of how long the *longest-waiting* of them has
 * been queued.
 *
 * WHY IT WIDENS
 *
 * A fixed window is only correct for a population that is both large and
 * normally distributed around the middle. Ours is neither: this is a small
 * ladder, and the players most in need of a match — a 400 and a 2200 — are
 * exactly the ones a fixed window strands forever. A 1500 finds someone within
 * ±100 in seconds; a 2200 would sit in an empty band until they quit. Widening
 * converts "no match" into "an imperfect match", which is the right trade for
 * a ranked queue whose real failure mode is nobody playing at all.
 *
 * WHY THESE NUMBERS
 *
 * The floor is 100 elo. With K=32 (see elo.ts) a 100-point gap is roughly a
 * 64% expected score for the favourite — noticeably uphill but not a foregone
 * conclusion, so an instant match is still a real game.
 *
 * The growth is linear at 100 elo per 10s of waiting. Linear, not exponential:
 * exponential growth spends its first 30s barely moving (which is where most
 * matches actually form) and then overshoots into absurdity. Linear means the
 * window is predictable — a player can be told "you will be matched within a
 * minute" and it will be true.
 *
 * The cap is 2000 elo, reached at 190s. Past that the window is effectively
 * "anyone", because a 2000-point spread already admits the entire realistic
 * ladder. Capping rather than growing forever is honest bookkeeping: it makes
 * the widening bounded and testable, and beyond this point the constraint is
 * not the window but whether a second human is queued at all.
 *
 * Note this is deliberately NOT a per-player window. Both players' windows
 * must admit the pair (see `pairIsAcceptable`), so a freshly-queued 1500 is
 * never dragged into a match with a 3000 just because the 3000 has waited five
 * minutes. The long waiter's patience widens *their* tolerance; it does not
 * override their opponent's.
 */
export const BASE_RATING_WINDOW = 100;
export const WINDOW_GROWTH_PER_SECOND = 10;
export const MAX_RATING_WINDOW = 2000;

/** The rating gap this player will currently accept, given their wait. */
export function ratingWindow(waitedMs: number): number {
  const waitedSeconds = Math.max(0, waitedMs) / 1000;
  return Math.min(
    MAX_RATING_WINDOW,
    BASE_RATING_WINDOW + waitedSeconds * WINDOW_GROWTH_PER_SECOND,
  );
}

/** A player sitting in a queue. */
export interface QueuedPlayer {
  /** Our internal user id — the queue key, one slot per account. */
  userId: string;
  /** The id the game server speaks; what ends up in `matchmakingTeams`. */
  publicId: string;
  /** Ladder rating for this mode, or DEFAULT_ELO when unranked. */
  rating: number;
  /** Epoch ms this player entered the queue. */
  queuedAt: number;
}

/**
 * Whether every player in a candidate group is willing to accept every other.
 *
 * The test is symmetric on purpose: the spread must fit inside the *narrowest*
 * window in the group. One impatient veteran cannot drag a newcomer into a
 * hopeless match, but two long waiters find each other quickly.
 */
export function groupIsAcceptable(group: QueuedPlayer[], now: number): boolean {
  if (group.length < 2) return true;
  let min = Infinity;
  let max = -Infinity;
  let narrowestWindow = Infinity;
  for (const p of group) {
    if (p.rating < min) min = p.rating;
    if (p.rating > max) max = p.rating;
    const w = ratingWindow(now - p.queuedAt);
    if (w < narrowestWindow) narrowestWindow = w;
  }
  return max - min <= narrowestWindow;
}

/**
 * Pull the next match out of a queue snapshot, or null when none forms.
 *
 * Candidates are considered rating-sorted, and a match is a window of
 * `MATCH_SIZE` ADJACENT players in that order. Adjacency matters: it means the
 * chosen group is the tightest possible spread containing those players, so we
 * never pair a 1200 with a 1600 while a 1250 sits between them unmatched.
 *
 * Among all acceptable windows we take the one holding the longest-waiting
 * player, tie-broken by tightest spread. That is what makes the queue fair
 * over time rather than merely tight: pure "tightest spread wins" would let a
 * dense cluster of mid-ladder players match repeatedly while an outlier who
 * has waited three minutes keeps losing to them.
 */
export function findMatch(
  queue: QueuedPlayer[],
  mode: MatchmakingMode,
  now: number,
): QueuedPlayer[] | null {
  const size = MATCH_SIZE[mode];
  if (queue.length < size) return null;

  // Sort by rating; tie-break on queuedAt so the order is total and stable
  // (two identically-rated players must not swap between passes).
  const sorted = [...queue].sort(
    (a, b) => a.rating - b.rating || a.queuedAt - b.queuedAt,
  );

  let best: QueuedPlayer[] | null = null;
  let bestWait = -1;
  let bestSpread = Infinity;

  for (let i = 0; i + size <= sorted.length; i++) {
    const group = sorted.slice(i, i + size);
    if (!groupIsAcceptable(group, now)) continue;

    const longestWait = Math.max(...group.map((p) => now - p.queuedAt));
    const spread =
      Math.max(...group.map((p) => p.rating)) -
      Math.min(...group.map((p) => p.rating));

    if (
      longestWait > bestWait ||
      (longestWait === bestWait && spread < bestSpread)
    ) {
      best = group;
      bestWait = longestWait;
      bestSpread = spread;
    }
  }

  return best;
}

/**
 * Split a formed match into teams, as `matchmakingTeams` — an array of teams,
 * each an array of publicIds. `GameServer.matchmakingTeamIndex` resolves a
 * joining client to its team by finding its publicId in this structure, so the
 * shape is `string[][]` and the ids must be publicIds, not user ids.
 *
 * 1v1 is `[[a],[b]]`: two teams of one. Worker.ts documents that exact shape.
 *
 * 2v2 pairs the strongest with the weakest and the two in the middle
 * ("1+4 vs 2+3"). For four players sorted by rating this is provably the split
 * that minimises the difference in team totals — the only alternatives are
 * 1+2 vs 3+4 and 1+3 vs 2+4, both of which put more rating on one side. It
 * needs no search and no randomness, so the same four players always produce
 * the same teams, which makes it testable and makes a re-run after a crash
 * reproduce the previous assignment.
 */
export function formTeams(
  match: QueuedPlayer[],
  mode: MatchmakingMode,
): string[][] {
  const sorted = [...match].sort(
    (a, b) => b.rating - a.rating || a.userId.localeCompare(b.userId),
  );

  if (mode === "1v1") {
    return sorted.map((p) => [p.publicId]);
  }

  // sorted = [strongest, second, third, weakest]
  const [s0, s1, s2, s3] = sorted;
  return [
    [s0.publicId, s3.publicId],
    [s1.publicId, s2.publicId],
  ];
}

// ---------------------------------------------------------------------------
// Redis-backed queue
// ---------------------------------------------------------------------------

/**
 * Keys. One hash per mode holds the queue; the field is the userId, so an
 * account can only ever occupy one slot — a second tab replaces the first
 * rather than doubling the player's odds.
 */
function queueKey(mode: MatchmakingMode): string {
  return `mm:queue:${mode}`;
}

/**
 * Lock guarding a matching pass. Without it, two backend instances polled by
 * two workers at the same instant could each pull the same players out of the
 * queue and create two games for them. Short TTL: a pass is a handful of Redis
 * round-trips, and a crashed holder must not wedge the queue.
 */
function lockKey(mode: MatchmakingMode): string {
  return `mm:lock:${mode}`;
}
const LOCK_TTL_MS = 5000;

/**
 * How long a queue entry may go without a heartbeat before it is swept.
 *
 * A player who closes the tab normally is removed on socket close. This sweep
 * exists for the case that close never arrives — a killed browser, a laptop
 * lid, a backend instance that died holding the socket. A stale entry that
 * gets matched produces a game nobody joins, which burns a worker slot and
 * strands the other three players, so this is not optional bookkeeping.
 *
 * 20s: the client is written to expect a queue-size push every ~3s and gives
 * up after 15s of silence, so a live client refreshes its entry far more often
 * than this. Anything that has been quiet for 20s is not coming back.
 */
export const ENTRY_STALE_MS = 20_000;

/** Serialised queue entry. Kept flat and small; it is rewritten every ~3s. */
interface StoredEntry {
  publicId: string;
  rating: number;
  queuedAt: number;
  seenAt: number;
  /** Which backend instance holds this player's socket. */
  instanceId: string;
}

/**
 * Every Redis interaction goes through here. Matchmaking is a feature that is
 * allowed to be unavailable; it is never allowed to take the process down or
 * turn a client message into an unhandled rejection.
 */
async function safeRedis<T>(op: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await op();
  } catch (err) {
    console.error(
      "matchmaking: redis unavailable:",
      err instanceof Error ? err.message : String(err),
    );
    return fallback;
  }
}

/**
 * The player's rating for this mode. An account with no ladder row yet is not
 * an error — it is a new player, and DEFAULT_ELO is where the ladder starts
 * them (elo.ts uses the same default when rating their first game), so they
 * queue against the middle of the field rather than the bottom.
 */
export async function ratingFor(
  userId: string,
  mode: MatchmakingMode,
): Promise<number> {
  const [row] = await db
    .select({ elo: leaderboardEntries.elo })
    .from(leaderboardEntries)
    .where(
      and(
        eq(leaderboardEntries.userId, userId),
        eq(leaderboardEntries.mode, mode),
      ),
    )
    .limit(1);
  return row?.elo ?? DEFAULT_ELO;
}

/** publicId for a user; null when the account vanished mid-queue. */
export async function publicIdFor(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ publicId: users.publicId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.publicId ?? null;
}

/**
 * Put a player in a queue, or refresh the entry that is already there.
 *
 * `queuedAt` is preserved across refreshes — the heartbeat must not reset the
 * wait, or a player's rating window would never widen and they would sit in
 * the queue forever accepting only near-identical opponents.
 *
 * Returns false when Redis is unavailable, which the route turns into a closed
 * socket rather than a silent no-op queue.
 */
export async function enqueue(
  mode: MatchmakingMode,
  player: { userId: string; publicId: string; rating: number },
  instanceId: string,
  now: number = Date.now(),
): Promise<boolean> {
  return safeRedis(async () => {
    const key = queueKey(mode);
    const existing = await redis.hget(key, player.userId);
    let queuedAt = now;
    if (existing !== null) {
      const parsed = parseEntry(existing);
      // Only inherit a wait that is still live. A stale entry is a ghost of a
      // previous session; letting it carry its age forward would hand the
      // returning player a maximally-wide window immediately.
      if (parsed !== null && now - parsed.seenAt <= ENTRY_STALE_MS) {
        queuedAt = parsed.queuedAt;
      }
    }
    const entry: StoredEntry = {
      publicId: player.publicId,
      rating: player.rating,
      queuedAt,
      seenAt: now,
      instanceId,
    };
    await redis.hset(key, player.userId, JSON.stringify(entry));
    return true;
  }, false);
}

/** Refresh the liveness stamp without disturbing the wait. No-op if absent. */
export async function heartbeat(
  mode: MatchmakingMode,
  userId: string,
  now: number = Date.now(),
): Promise<void> {
  await safeRedis(async () => {
    const key = queueKey(mode);
    const raw = await redis.hget(key, userId);
    if (raw === null) return;
    const parsed = parseEntry(raw);
    if (parsed === null) return;
    parsed.seenAt = now;
    await redis.hset(key, userId, JSON.stringify(parsed));
  }, undefined);
}

/**
 * Remove a player from a queue. Called on socket close, on replacement by a
 * newer connection, and after a match is assigned.
 */
export async function dequeue(
  mode: MatchmakingMode,
  userId: string,
): Promise<void> {
  await safeRedis(async () => {
    await redis.hdel(queueKey(mode), userId);
  }, undefined);
}

function parseEntry(raw: string): StoredEntry | null {
  try {
    const v = JSON.parse(raw) as Partial<StoredEntry>;
    if (
      typeof v.publicId !== "string" ||
      typeof v.rating !== "number" ||
      typeof v.queuedAt !== "number" ||
      typeof v.seenAt !== "number"
    ) {
      return null;
    }
    return {
      publicId: v.publicId,
      rating: v.rating,
      queuedAt: v.queuedAt,
      seenAt: v.seenAt,
      instanceId: typeof v.instanceId === "string" ? v.instanceId : "",
    };
  } catch {
    return null;
  }
}

/**
 * Read a queue, dropping (and deleting) entries whose heartbeat has lapsed.
 *
 * Sweeping on read rather than on a timer means a queue nobody is looking at
 * costs nothing, and a queue being matched is always swept immediately before
 * the pairing decision — which is the only moment staleness actually hurts.
 */
export async function readQueue(
  mode: MatchmakingMode,
  now: number = Date.now(),
): Promise<QueuedPlayer[]> {
  return safeRedis(async () => {
    const key = queueKey(mode);
    const raw = await redis.hgetall(key);
    const live: QueuedPlayer[] = [];
    const dead: string[] = [];
    for (const [userId, value] of Object.entries(raw)) {
      const parsed = parseEntry(value);
      if (parsed === null || now - parsed.seenAt > ENTRY_STALE_MS) {
        dead.push(userId);
        continue;
      }
      live.push({
        userId,
        publicId: parsed.publicId,
        rating: parsed.rating,
        queuedAt: parsed.queuedAt,
      });
    }
    if (dead.length > 0) {
      await redis.hdel(key, ...dead);
    }
    return live;
  }, []);
}

/** Current queue size, for the client's `queue-size` push. */
export async function queueSize(
  mode: MatchmakingMode,
  now: number = Date.now(),
): Promise<number> {
  return (await readQueue(mode, now)).length;
}

// ---------------------------------------------------------------------------
// Assignment fan-out
// ---------------------------------------------------------------------------

/**
 * A matched player's pending assignment, published so that whichever backend
 * instance is holding their socket can deliver `match-assignment`.
 *
 * This is a per-user key rather than a pub/sub message because delivery must
 * survive a race: the checkin request that forms the match can land on
 * instance A microseconds before instance B's socket loop next checks. A
 * key with a TTL is readable whenever B gets around to looking; a published
 * message that arrived a moment too early is gone.
 *
 * TTL is 60s — comfortably longer than the client's own 15s watchdog cycle,
 * short enough that an assignment for a player who never came back expires
 * instead of ambushing them on their next queue.
 */
const ASSIGNMENT_TTL_SECONDS = 60;

function assignmentKey(userId: string): string {
  return `mm:assigned:${userId}`;
}

export async function publishAssignment(
  userId: string,
  gameId: string,
): Promise<void> {
  await safeRedis(async () => {
    await redis.set(
      assignmentKey(userId),
      gameId,
      "EX",
      ASSIGNMENT_TTL_SECONDS,
    );
  }, undefined);
}

/** Read and consume a pending assignment. Null when there is none. */
export async function takeAssignment(userId: string): Promise<string | null> {
  return safeRedis(async () => {
    const key = assignmentKey(userId);
    const gameId = await redis.get(key);
    if (gameId !== null) await redis.del(key);
    return gameId;
  }, null);
}

// ---------------------------------------------------------------------------
// Matching pass
// ---------------------------------------------------------------------------

export interface Assignment {
  players: string[];
  teams: string[][];
}

/**
 * Try to form one match for `mode` and hand it the worker's pre-allocated
 * `gameId`. Returns the assignment the worker should act on, or null.
 *
 * Under a lock, so two concurrent checkins cannot claim the same players. The
 * matched players are removed from the queue and given their assignment inside
 * the same pass, so a second checkin arriving immediately sees a queue that no
 * longer contains them.
 */
export async function tryFormMatch(
  mode: MatchmakingMode,
  gameId: string,
  now: number = Date.now(),
): Promise<Assignment | null> {
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const acquired = await safeRedis(
    async () =>
      (await redis.set(lockKey(mode), token, "PX", LOCK_TTL_MS, "NX")) === "OK",
    false,
  );
  if (!acquired) return null;

  try {
    const queue = await readQueue(mode, now);
    const match = findMatch(queue, mode, now);
    if (match === null) return null;

    // Remove them BEFORE announcing, so nothing can match them twice.
    await safeRedis(
      async () =>
        await redis.hdel(queueKey(mode), ...match.map((p) => p.userId)),
      0,
    );

    const teams = formTeams(match, mode);
    for (const p of match) {
      await publishAssignment(p.userId, gameId);
    }
    return { players: match.map((p) => p.publicId), teams };
  } finally {
    // Only release a lock we still hold: if the pass overran the TTL, the lock
    // now belongs to someone else and deleting it would let a third pass in.
    await safeRedis(async () => {
      const held = await redis.get(lockKey(mode));
      if (held === token) await redis.del(lockKey(mode));
    }, undefined);
  }
}

/**
 * Resolve a batch of userIds to publicIds. Used nowhere in the hot path; kept
 * for the route's join handler, which needs exactly one.
 */
export async function publicIdsFor(
  userIds: string[],
): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, publicId: users.publicId })
    .from(users)
    .where(inArray(users.id, userIds));
  return new Map(rows.map((r) => [r.id, r.publicId]));
}
