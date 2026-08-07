import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { redis } from "../redis.ts";
import {
  BASE_RATING_WINDOW,
  dequeue,
  enqueue,
  ENTRY_STALE_MS,
  findMatch,
  formTeams,
  groupIsAcceptable,
  heartbeat,
  isMatchmakingMode,
  MATCH_SIZE,
  MAX_RATING_WINDOW,
  type QueuedPlayer,
  queueSize,
  ratingWindow,
  readQueue,
  takeAssignment,
  tryFormMatch,
} from "./matchmaking.ts";

/**
 * The pairing maths is pure and tested directly — no Redis, no database, no
 * fake clock plumbing. `now` is a parameter everywhere for exactly this
 * reason: the widening policy is the part most likely to be tuned later, and
 * it must be possible to prove a change did what was intended.
 *
 * The Redis-backed half is tested against a real Redis when one is reachable
 * (docker compose up -d) and skipped otherwise, so `vitest run` stays green on
 * a machine with no infrastructure rather than failing for the wrong reason.
 */

const NOW = 1_000_000_000;

function player(userId: string, rating: number, waitedMs = 0): QueuedPlayer {
  return {
    userId,
    publicId: `pub-${userId}`,
    rating,
    queuedAt: NOW - waitedMs,
  };
}

describe("ratingWindow", () => {
  it("starts at the base window for a player who just queued", () => {
    expect(ratingWindow(0)).toBe(BASE_RATING_WINDOW);
  });

  it("widens linearly with waiting time", () => {
    // 100 elo per 10s => +100 after 10s, +300 after 30s.
    expect(ratingWindow(10_000)).toBe(BASE_RATING_WINDOW + 100);
    expect(ratingWindow(30_000)).toBe(BASE_RATING_WINDOW + 300);
  });

  it("is monotonic", () => {
    let previous = -1;
    for (let ms = 0; ms <= 400_000; ms += 5_000) {
      const w = ratingWindow(ms);
      expect(w).toBeGreaterThanOrEqual(previous);
      previous = w;
    }
  });

  it("caps so the window never grows without bound", () => {
    expect(ratingWindow(10 * 60_000)).toBe(MAX_RATING_WINDOW);
    expect(ratingWindow(60 * 60_000)).toBe(MAX_RATING_WINDOW);
  });

  it("treats a negative wait as no wait (clock skew must not widen)", () => {
    expect(ratingWindow(-50_000)).toBe(BASE_RATING_WINDOW);
  });
});

describe("groupIsAcceptable", () => {
  it("accepts a pair inside the base window", () => {
    const group = [player("a", 1500), player("b", 1580)];
    expect(groupIsAcceptable(group, NOW)).toBe(true);
  });

  it("rejects a pair outside the base window", () => {
    const group = [player("a", 1500), player("b", 1700)];
    expect(groupIsAcceptable(group, NOW)).toBe(false);
  });

  it("accepts that same pair once both have waited long enough", () => {
    // 200 apart needs a 200 window => 10s of waiting, for BOTH of them.
    const group = [player("a", 1500, 15_000), player("b", 1700, 15_000)];
    expect(groupIsAcceptable(group, NOW)).toBe(true);
  });

  it("uses the narrowest window, so one long waiter cannot drag in a newcomer", () => {
    // The veteran has waited five minutes and would accept anyone; the
    // newcomer just arrived and would not. The pair must be refused.
    const veteran = player("veteran", 2500, 300_000);
    const newcomer = player("newcomer", 1000, 0);
    expect(ratingWindow(300_000)).toBe(MAX_RATING_WINDOW);
    expect(groupIsAcceptable([veteran, newcomer], NOW)).toBe(false);
  });

  it("is trivially true for a group of one", () => {
    expect(groupIsAcceptable([player("a", 1500)], NOW)).toBe(true);
  });
});

describe("findMatch (1v1)", () => {
  it("returns null when the queue is too small", () => {
    expect(findMatch([player("a", 1500)], "1v1", NOW)).toBeNull();
    expect(findMatch([], "1v1", NOW)).toBeNull();
  });

  it("returns null when nobody is within range of anybody", () => {
    const queue = [player("a", 800), player("b", 1500), player("c", 2200)];
    expect(findMatch(queue, "1v1", NOW)).toBeNull();
  });

  it("pairs the two closest-rated players, not the two who arrived first", () => {
    // Arrival order is a, b, c. By rating, b and c are adjacent and close;
    // a is far below. Arrival order alone would pair a with b.
    const queue = [
      player("a", 1000, 30_000),
      player("b", 1500, 1000),
      player("c", 1540, 500),
    ];
    const match = findMatch(queue, "1v1", NOW);
    expect(match).not.toBeNull();
    expect(match!.map((p) => p.userId).sort()).toEqual(["b", "c"]);
  });

  it("never skips over an intermediate rating", () => {
    // 1200/1250/1300 all mutually acceptable. Whichever pair is chosen must be
    // adjacent by rating — 1200 with 1300 while 1250 waits would be wrong.
    const queue = [player("a", 1200), player("b", 1250), player("c", 1300)];
    const match = findMatch(queue, "1v1", NOW)!;
    const ratings = match.map((p) => p.rating).sort((x, y) => x - y);
    expect(ratings[1] - ratings[0]).toBe(50);
  });

  it("prefers the window containing the longest waiter", () => {
    // Two acceptable pairs exist: (a,b) is tighter, but c has waited far
    // longer and must be served first.
    const queue = [
      player("a", 1500, 0),
      player("b", 1510, 0),
      player("c", 1900, 60_000),
      player("d", 1930, 1000),
    ];
    const match = findMatch(queue, "1v1", NOW)!;
    expect(match.map((p) => p.userId).sort()).toEqual(["c", "d"]);
  });

  it("matches an outlier once widening has caught up", () => {
    // A 2400 and a 1400 are 1000 apart: impossible at first...
    const fresh = [player("high", 2400, 0), player("low", 1400, 0)];
    expect(findMatch(fresh, "1v1", NOW)).toBeNull();

    // ...and possible once both have waited 90s (window 1000).
    const waited = [player("high", 2400, 90_000), player("low", 1400, 90_000)];
    expect(ratingWindow(90_000)).toBe(1000);
    expect(findMatch(waited, "1v1", NOW)).not.toBeNull();
  });

  it("is deterministic for the same snapshot", () => {
    const queue = [
      player("a", 1500, 5000),
      player("b", 1520, 4000),
      player("c", 1540, 3000),
    ];
    const first = findMatch(queue, "1v1", NOW)!.map((p) => p.userId);
    const second = findMatch(queue, "1v1", NOW)!.map((p) => p.userId);
    expect(first).toEqual(second);
  });
});

describe("findMatch (2v2)", () => {
  it("needs four players", () => {
    const three = [player("a", 1500), player("b", 1510), player("c", 1520)];
    expect(findMatch(three, "2v2", NOW)).toBeNull();
    expect(MATCH_SIZE["2v2"]).toBe(4);
  });

  it("takes four adjacent ratings when they all fit", () => {
    const queue = [
      player("a", 1500),
      player("b", 1520),
      player("c", 1540),
      player("d", 1560),
    ];
    const match = findMatch(queue, "2v2", NOW)!;
    expect(match).toHaveLength(4);
  });

  it("rejects four players whose spread exceeds the narrowest window", () => {
    const queue = [
      player("a", 1000),
      player("b", 1020),
      player("c", 1040),
      player("d", 1900),
    ];
    expect(findMatch(queue, "2v2", NOW)).toBeNull();
  });

  it("picks the tightest fitting foursome out of a larger queue", () => {
    const queue = [
      player("a", 1000, 0),
      player("b", 1200, 0),
      player("c", 1500, 0),
      player("d", 1520, 0),
      player("e", 1540, 0),
      player("f", 1560, 0),
    ];
    const match = findMatch(queue, "2v2", NOW)!;
    expect(match.map((p) => p.userId).sort()).toEqual(["c", "d", "e", "f"]);
  });
});

describe("formTeams", () => {
  it("gives 1v1 the [[a],[b]] shape the worker expects", () => {
    const match = [player("a", 1500), player("b", 1400)];
    const teams = formTeams(match, "1v1");
    expect(teams).toHaveLength(2);
    expect(teams[0]).toHaveLength(1);
    expect(teams[1]).toHaveLength(1);
    expect(teams.flat().sort()).toEqual(["pub-a", "pub-b"]);
  });

  it("splits 2v2 into two teams of two", () => {
    const match = [
      player("a", 1600),
      player("b", 1500),
      player("c", 1400),
      player("d", 1300),
    ];
    const teams = formTeams(match, "2v2");
    expect(teams).toHaveLength(2);
    expect(teams[0]).toHaveLength(2);
    expect(teams[1]).toHaveLength(2);
  });

  it("puts every player on exactly one team", () => {
    const match = [
      player("a", 1600),
      player("b", 1500),
      player("c", 1400),
      player("d", 1300),
    ];
    const flat = formTeams(match, "2v2").flat();
    expect(flat).toHaveLength(4);
    expect(new Set(flat).size).toBe(4);
    expect(flat.sort()).toEqual(["pub-a", "pub-b", "pub-c", "pub-d"]);
  });

  it("pairs strongest with weakest to balance the totals", () => {
    // 1600/1500/1400/1300 => 1600+1300 = 2900 vs 1500+1400 = 2900.
    const match = [
      player("a", 1600),
      player("b", 1500),
      player("c", 1400),
      player("d", 1300),
    ];
    const teams = formTeams(match, "2v2");
    const total = (team: string[]) =>
      team
        .map((pub) => match.find((p) => p.publicId === pub)!.rating)
        .reduce((x, y) => x + y, 0);
    expect(total(teams[0])).toBe(total(teams[1]));
  });

  it("beats the alternative splits on an uneven foursome", () => {
    // 2000/1500/1400/1000: 1+4 vs 2+3 => 3000 vs 2900 (diff 100).
    // 1+2 vs 3+4 => 3500 vs 2400 (1100). 1+3 vs 2+4 => 3400 vs 2500 (900).
    const match = [
      player("a", 2000),
      player("b", 1500),
      player("c", 1400),
      player("d", 1000),
    ];
    const teams = formTeams(match, "2v2");
    const total = (team: string[]) =>
      team
        .map((pub) => match.find((p) => p.publicId === pub)!.rating)
        .reduce((x, y) => x + y, 0);
    expect(Math.abs(total(teams[0]) - total(teams[1]))).toBe(100);
  });

  it("is deterministic regardless of input order", () => {
    const ps = [
      player("a", 1600),
      player("b", 1500),
      player("c", 1400),
      player("d", 1300),
    ];
    const forward = formTeams(ps, "2v2");
    const reversed = formTeams([...ps].reverse(), "2v2");
    expect(reversed).toEqual(forward);
  });

  it("keeps identical ratings deterministic via the userId tiebreak", () => {
    const ps = [
      player("a", 1500),
      player("b", 1500),
      player("c", 1500),
      player("d", 1500),
    ];
    expect(formTeams([...ps].reverse(), "2v2")).toEqual(formTeams(ps, "2v2"));
  });
});

describe("isMatchmakingMode", () => {
  it("accepts the two real queues and nothing else", () => {
    expect(isMatchmakingMode("1v1")).toBe(true);
    expect(isMatchmakingMode("2v2")).toBe(true);
    expect(isMatchmakingMode("3v3")).toBe(false);
    expect(isMatchmakingMode("")).toBe(false);
    expect(isMatchmakingMode(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Redis-backed queue. Skipped when no Redis is reachable.
// ---------------------------------------------------------------------------

const redisUp = await (async () => {
  try {
    await redis.connect();
    await redis.ping();
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!redisUp)("queue lifecycle (real Redis)", () => {
  const MODE = "1v1" as const;

  /**
   * Assignments are separate keys with a 60s TTL, so clearing only the queues
   * would leave one test's `mm:assigned:*` visible to the next and make a
   * later `takeAssignment` return a gameId nobody in that test ever matched.
   */
  const clearAll = async () => {
    const assigned = await redis.keys("mm:assigned:*");
    await redis.del(
      "mm:queue:1v1",
      "mm:queue:2v2",
      "mm:lock:1v1",
      "mm:lock:2v2",
      ...assigned,
    );
  };

  beforeEach(clearAll);

  afterAll(async () => {
    await clearAll();
    await redis.quit();
  });

  it("enqueues a player and reports them in the queue", async () => {
    await enqueue(MODE, { userId: "u1", publicId: "p1", rating: 1500 }, "i1");
    const queue = await readQueue(MODE);
    expect(queue).toHaveLength(1);
    expect(queue[0].publicId).toBe("p1");
    expect(await queueSize(MODE)).toBe(1);
  });

  it("holds one slot per account, so a rejoin does not double-queue", async () => {
    await enqueue(MODE, { userId: "u1", publicId: "p1", rating: 1500 }, "i1");
    await enqueue(MODE, { userId: "u1", publicId: "p1", rating: 1500 }, "i2");
    expect(await queueSize(MODE)).toBe(1);
  });

  it("preserves queuedAt across a refresh, so the window keeps widening", async () => {
    // Still inside ENTRY_STALE_MS, i.e. a live queued player reconnecting.
    const start = Date.now() - 10_000;
    await enqueue(
      MODE,
      { userId: "u1", publicId: "p1", rating: 1500 },
      "i1",
      start,
    );
    // A reconnect must not reset the wait, or the window never widens.
    await enqueue(MODE, { userId: "u1", publicId: "p1", rating: 1500 }, "i1");
    const [entry] = await readQueue(MODE);
    expect(entry.queuedAt).toBe(start);
  });

  it("does NOT inherit a wait from a stale entry", async () => {
    // A ghost from a previous session must not hand the returning player a
    // maximally-wide rating window the instant they queue again.
    const ancient = Date.now() - (ENTRY_STALE_MS + 60_000);
    await enqueue(
      MODE,
      { userId: "u1", publicId: "p1", rating: 1500 },
      "i1",
      ancient,
    );
    const rejoinedAt = Date.now();
    await enqueue(
      MODE,
      { userId: "u1", publicId: "p1", rating: 1500 },
      "i1",
      rejoinedAt,
    );
    const [entry] = await readQueue(MODE);
    expect(entry.queuedAt).toBe(rejoinedAt);
  });

  it("removes a player on dequeue (the socket-close path)", async () => {
    await enqueue(MODE, { userId: "u1", publicId: "p1", rating: 1500 }, "i1");
    await enqueue(MODE, { userId: "u2", publicId: "p2", rating: 1500 }, "i1");
    await dequeue(MODE, "u1");
    const queue = await readQueue(MODE);
    expect(queue.map((p) => p.userId)).toEqual(["u2"]);
  });

  it("sweeps an entry whose heartbeat lapsed, so a ghost is never matched", async () => {
    const stale = Date.now() - (ENTRY_STALE_MS + 5_000);
    await enqueue(
      MODE,
      { userId: "ghost", publicId: "pg", rating: 1500 },
      "i1",
      stale,
    );
    expect(await queueSize(MODE)).toBe(0);
    // And it is really gone from Redis, not merely filtered out of the read.
    expect(await redis.hget("mm:queue:1v1", "ghost")).toBeNull();
  });

  it("keeps an entry alive while it is heartbeating", async () => {
    const start = Date.now() - (ENTRY_STALE_MS + 5_000);
    await enqueue(
      MODE,
      { userId: "u1", publicId: "p1", rating: 1500 },
      "i1",
      start,
    );
    // Without a heartbeat this would have been swept (previous test).
    await redis.hset(
      "mm:queue:1v1",
      "u1",
      JSON.stringify({
        publicId: "p1",
        rating: 1500,
        queuedAt: start,
        seenAt: start,
        instanceId: "i1",
      }),
    );
    await heartbeat(MODE, "u1");
    expect(await queueSize(MODE)).toBe(1);
  });

  it("drops an unparseable entry rather than throwing", async () => {
    await redis.hset("mm:queue:1v1", "junk", "not json");
    expect(await readQueue(MODE)).toEqual([]);
    expect(await redis.hget("mm:queue:1v1", "junk")).toBeNull();
  });

  it("forms a 1v1 match and gives both players the same gameId", async () => {
    await enqueue(MODE, { userId: "u1", publicId: "p1", rating: 1500 }, "i1");
    await enqueue(MODE, { userId: "u2", publicId: "p2", rating: 1520 }, "i1");

    const assignment = await tryFormMatch(MODE, "game-abc");
    expect(assignment).not.toBeNull();
    expect(assignment!.players.sort()).toEqual(["p1", "p2"]);
    expect(assignment!.teams).toHaveLength(2);

    expect(await takeAssignment("u1")).toBe("game-abc");
    expect(await takeAssignment("u2")).toBe("game-abc");
    // Consumed exactly once.
    expect(await takeAssignment("u1")).toBeNull();
  });

  it("removes matched players from the queue so they cannot be matched twice", async () => {
    await enqueue(MODE, { userId: "u1", publicId: "p1", rating: 1500 }, "i1");
    await enqueue(MODE, { userId: "u2", publicId: "p2", rating: 1520 }, "i1");
    await tryFormMatch(MODE, "game-abc");
    expect(await queueSize(MODE)).toBe(0);
    expect(await tryFormMatch(MODE, "game-def")).toBeNull();
  });

  it("does not match a player who left the queue before the pass ran", async () => {
    await enqueue(MODE, { userId: "u1", publicId: "p1", rating: 1500 }, "i1");
    await enqueue(MODE, { userId: "u2", publicId: "p2", rating: 1520 }, "i1");
    await dequeue(MODE, "u2");
    expect(await tryFormMatch(MODE, "game-abc")).toBeNull();
    expect(await takeAssignment("u1")).toBeNull();
  });

  it("forms a 2v2 as two teams of two", async () => {
    // Spread of 60, inside the 100 base window, so these four match on sight
    // without needing any widening.
    await enqueue("2v2", { userId: "a", publicId: "pa", rating: 1560 }, "i1");
    await enqueue("2v2", { userId: "b", publicId: "pb", rating: 1540 }, "i1");
    await enqueue("2v2", { userId: "c", publicId: "pc", rating: 1520 }, "i1");
    await enqueue("2v2", { userId: "d", publicId: "pd", rating: 1500 }, "i1");

    const assignment = await tryFormMatch("2v2", "game-2v2");
    expect(assignment).not.toBeNull();
    expect(assignment!.players).toHaveLength(4);
    expect(assignment!.teams).toHaveLength(2);
    expect(assignment!.teams[0]).toHaveLength(2);
    expect(assignment!.teams[1]).toHaveLength(2);
    // Strongest with weakest.
    expect(assignment!.teams[0].sort()).toEqual(["pa", "pd"]);
    expect(assignment!.teams[1].sort()).toEqual(["pb", "pc"]);

    for (const u of ["a", "b", "c", "d"]) {
      expect(await takeAssignment(u)).toBe("game-2v2");
    }
    await redis.del("mm:queue:2v2");
  });

  it("returns null rather than a partial match when the queue is short", async () => {
    await enqueue(MODE, { userId: "u1", publicId: "p1", rating: 1500 }, "i1");
    expect(await tryFormMatch(MODE, "game-abc")).toBeNull();
    expect(await queueSize(MODE)).toBe(1);
  });
});
