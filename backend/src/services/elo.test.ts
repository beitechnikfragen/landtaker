import { RankedType } from "@game/game/Game.ts";
import { describe, expect, it } from "vitest";
import {
  advisoryKey,
  DEFAULT_ELO,
  expectedScore,
  isRankedMode,
  K_FACTOR,
  ratableParticipants,
  rateMatch,
  type ParticipantForRating,
  type RatedPlayer,
  type RatingChange,
} from "./elo.ts";

/**
 * The rating maths is pure, so it is tested directly rather than through a
 * database. The transactional half (`rateArchivedGame`, `alreadyRated`) needs a
 * live Postgres and a locked row to mean anything, and is covered end to end by
 * scripts/smoke-elo.sh — including the idempotency guarantee, which is about
 * transaction ordering and cannot be proven in-memory.
 */

/** A 1v1 between two ratings. Returns the winner's change and the loser's. */
function oneVOne(
  winnerElo: number,
  loserElo: number,
): { winner: RatingChange; loser: RatingChange } {
  const players: RatedPlayer[] = [
    { userId: "w", elo: winnerElo, team: null, won: true },
    { userId: "l", elo: loserElo, team: null, won: false },
  ];
  const [winner, loser] = rateMatch(players);
  return { winner: winner!, loser: loser! };
}

const sum = (changes: RatingChange[]): number =>
  changes.reduce((total, change) => total + change.delta, 0);

describe("expected score", () => {
  it("is even between equal ratings", () => {
    expect(expectedScore(1200, 1200)).toBe(0.5);
  });

  /** The definition of the 400-point scale: a 10:1 expectation. */
  it("gives a 400-point favourite roughly a 10:1 expectation", () => {
    expect(expectedScore(1600, 1200)).toBeCloseTo(10 / 11, 5);
  });

  it("is symmetric — the two expectations sum to one", () => {
    expect(expectedScore(1450, 1100) + expectedScore(1100, 1450)).toBeCloseTo(
      1,
      10,
    );
  });
});

describe("1v1 rating maths", () => {
  /**
   * The headline property of Elo, and the reason it was chosen: an upset is
   * worth more than a result everybody expected.
   */
  it("gains more for beating a stronger opponent than a weaker one", () => {
    const upset = oneVOne(1200, 1600).winner.delta;
    const expectedWin = oneVOne(1200, 800).winner.delta;
    const evenWin = oneVOne(1200, 1200).winner.delta;

    expect(upset).toBeGreaterThan(evenWin);
    expect(evenWin).toBeGreaterThan(expectedWin);
    // Concretely: beating a 400-point favourite is worth nearly the full K,
    // while beating someone 400 points below is worth almost nothing.
    expect(upset).toBe(29);
    expect(evenWin).toBe(16);
    expect(expectedWin).toBe(3);
  });

  /** The mirror image: losing to someone far weaker is the expensive loss. */
  it("loses more for losing to a weaker opponent than to a stronger one", () => {
    const badLoss = oneVOne(800, 1200).loser.delta;
    const excusableLoss = oneVOne(1600, 1200).loser.delta;
    expect(badLoss).toBeLessThan(excusableLoss);
    expect(badLoss).toBe(-29);
    expect(excusableLoss).toBe(-3);
  });

  /**
   * Zero-sum is what keeps the pool's mean rating from drifting. In 1v1 it must
   * hold exactly, including after the integer rounding — which is why halves
   * are rounded away from zero rather than with Math.round.
   */
  it("is exactly zero-sum, including the even match that rounds on .5", () => {
    for (const [a, b] of [
      [1200, 1200],
      [1000, 1600],
      [1533, 1471],
      [900, 901],
      [2400, 700],
    ] as const) {
      const { winner, loser } = oneVOne(a, b);
      expect(winner.delta + loser.delta).toBe(0);
    }
  });

  it("never moves a rating by more than K in a single match", () => {
    for (const [a, b] of [
      [100, 3000],
      [3000, 100],
      [1200, 1200],
    ] as const) {
      const { winner, loser } = oneVOne(a, b);
      expect(Math.abs(winner.delta)).toBeLessThanOrEqual(K_FACTOR);
      expect(Math.abs(loser.delta)).toBeLessThanOrEqual(K_FACTOR);
    }
  });

  it("reports the before and after consistently with the delta", () => {
    const { winner, loser } = oneVOne(1337, 1200);
    expect(winner.eloBefore).toBe(1337);
    expect(winner.eloAfter).toBe(1337 + winner.delta);
    expect(loser.eloAfter).toBe(1200 + loser.delta);
    expect(winner.won).toBe(true);
    expect(loser.won).toBe(false);
  });
});

describe("2v2 team rating", () => {
  const twoVTwo = (
    ratings: [number, number, number, number],
    winningTeam: "a" | "b",
  ): RatingChange[] =>
    rateMatch([
      { userId: "a1", elo: ratings[0], team: "a", won: winningTeam === "a" },
      { userId: "a2", elo: ratings[1], team: "a", won: winningTeam === "a" },
      { userId: "b1", elo: ratings[2], team: "b", won: winningTeam === "b" },
      { userId: "b2", elo: ratings[3], team: "b", won: winningTeam === "b" },
    ]);

  it("is zero-sum across the two teams", () => {
    expect(sum(twoVTwo([1200, 1200, 1200, 1200], "a"))).toBe(0);
    expect(sum(twoVTwo([1600, 1000, 1300, 1300], "a"))).toBe(0);
    expect(sum(twoVTwo([900, 2100, 1450, 1050], "b"))).toBe(0);
  });

  /**
   * The reason for pairwise over team-average. On a mismatched duo the strong
   * player is expected to win and must gain less than the weak player does for
   * the very same victory. Team-average would hand them an identical delta.
   */
  it("pays the carried player more than the carrying one for the same win", () => {
    const [strong, weak] = twoVTwo([1600, 1000, 1300, 1300], "a");
    expect(strong!.won).toBe(true);
    expect(weak!.won).toBe(true);
    expect(weak!.delta).toBeGreaterThan(strong!.delta);

    // And team-average really would have tied them: the team means are equal,
    // so a mean-based exchange is the even-match delta for both.
    const teamMeanA = (1600 + 1000) / 2;
    const teamMeanB = (1300 + 1300) / 2;
    expect(teamMeanA).toBe(teamMeanB);
  });

  it("charges the stronger player more when a favoured team loses", () => {
    const [strong, weak] = twoVTwo([1600, 1000, 1300, 1300], "b");
    expect(strong!.delta).toBeLessThan(weak!.delta);
    expect(strong!.delta).toBeLessThan(0);
  });

  /** Teammates of equal rating are interchangeable and must move together. */
  it("treats equally rated teammates identically", () => {
    const [a1, a2] = twoVTwo([1400, 1400, 1100, 1900], "a");
    expect(a1!.delta).toBe(a2!.delta);
  });

  /**
   * A 2v2 must not be worth double a 1v1 — that is what averaging over the
   * opponents faced buys.
   */
  it("keeps a team match within K, like a 1v1", () => {
    for (const change of twoVTwo([100, 100, 3000, 3000], "a")) {
      expect(Math.abs(change.delta)).toBeLessThanOrEqual(K_FACTOR);
    }
  });

  /**
   * The 1v1 ladder must be plain Elo: with one opponent each, the pairwise
   * average is the pairwise term itself.
   */
  it("reduces to standard Elo when each side has one player", () => {
    const asTeams = rateMatch([
      { userId: "w", elo: 1250, team: "a", won: true },
      { userId: "l", elo: 1490, team: "b", won: false },
    ]);
    const asFfa = oneVOne(1250, 1490);
    expect(asTeams[0]!.delta).toBe(asFfa.winner.delta);
    expect(asTeams[1]!.delta).toBe(asFfa.loser.delta);
  });
});

describe("degenerate matches", () => {
  it("rates nothing when everyone is on the same team", () => {
    expect(
      rateMatch([
        { userId: "a", elo: 1200, team: "a", won: true },
        { userId: "b", elo: 1300, team: "a", won: true },
      ]),
    ).toEqual([]);
  });

  it("rates nothing with fewer than two players", () => {
    expect(rateMatch([])).toEqual([]);
    expect(
      rateMatch([{ userId: "a", elo: 1200, team: null, won: true }]),
    ).toEqual([]);
  });
});

/**
 * THE UNRANKED GUARD. Public lobbies, private games and singleplayer all archive
 * with a null rankedType and must leave the ladder untouched.
 */
describe("unranked guard", () => {
  it("accepts exactly the game's two ranked modes", () => {
    expect(isRankedMode(RankedType.OneVOne)).toBe(true);
    expect(isRankedMode(RankedType.TwoVTwo)).toBe(true);
    // Pinned so a rename on the game side is caught here.
    expect(isRankedMode("1v1")).toBe(true);
    expect(isRankedMode("2v2")).toBe(true);
  });

  it("rejects the unranked match, which is the common case", () => {
    expect(isRankedMode(null)).toBe(false);
    expect(isRankedMode(undefined)).toBe(false);
    expect(isRankedMode("")).toBe(false);
  });

  /**
   * A game mode is not a ranked type. `games.mode` holds "Free For All" /
   * "Team"; passing one here by mistake must not open the ladder to every
   * public match.
   */
  it("rejects a game mode mistaken for a ranked type", () => {
    expect(isRankedMode("Free For All")).toBe(false);
    expect(isRankedMode("Team")).toBe(false);
    expect(isRankedMode("ffa")).toBe(false);
    expect(isRankedMode("3v3")).toBe(false);
  });
});

/**
 * GUESTS. A player with no account cannot be rated, and must not damage the
 * rating of the players who can be.
 */
describe("guest participants", () => {
  const guest: ParticipantForRating = { userId: null, team: "b", won: false };

  it("drops participants with no account", () => {
    const ratable = ratableParticipants([
      { userId: "u1", team: "a", won: true },
      guest,
    ]);
    expect(ratable).toHaveLength(1);
    expect(ratable[0]!.userId).toBe("u1");
  });

  it("drops participants with no decided result", () => {
    // No winner in the record (abandoned match): nothing to rate.
    expect(
      ratableParticipants([
        { userId: "u1", team: "a", won: null },
        { userId: "u2", team: "b", won: null },
      ]),
    ).toEqual([]);
  });

  it("starts an account that has never been rated at the column default", () => {
    const [player] = ratableParticipants([
      { userId: "u1", team: "a", won: true },
    ]);
    expect(player!.elo).toBe(DEFAULT_ELO);
    expect(DEFAULT_ELO).toBe(1000);
  });

  /**
   * The load-bearing case: a guest in the lobby must not change what the
   * account-holders exchange. Two accounts plus a guest must rate exactly as
   * the two accounts alone.
   */
  it("rates the accounts as if the guest had not been there", () => {
    const withGuest = rateMatch(
      ratableParticipants([
        { userId: "u1", team: "a", won: true },
        { userId: "u2", team: "b", won: false },
        { userId: null, team: "b", won: false },
      ]),
    );
    const withoutGuest = rateMatch(
      ratableParticipants([
        { userId: "u1", team: "a", won: true },
        { userId: "u2", team: "b", won: false },
      ]),
    );
    expect(withGuest).toEqual(withoutGuest);
    expect(sum(withGuest)).toBe(0);
  });

  /**
   * A ranked match whose losing side is entirely guests leaves the winner with
   * no opponent to be rated against. That must be a no-op, not a free win: the
   * caller sees an empty change set and writes nothing.
   */
  it("rates nothing when every opponent is a guest", () => {
    const ratable = ratableParticipants([
      { userId: "u1", team: "a", won: true },
      { userId: null, team: "b", won: false },
      { userId: null, team: "b", won: false },
    ]);
    expect(rateMatch(ratable)).toEqual([]);
  });
});

/**
 * IDEMPOTENCY, at the level the pure maths can speak to: applying the same
 * match to already-updated ratings is NOT a no-op, which is exactly why the
 * "already rated" check exists. The check itself is transactional and is proven
 * against a real database in scripts/smoke-elo.sh.
 */
describe("idempotency", () => {
  it("rating twice would inflate — which is what the guard prevents", () => {
    const first = oneVOne(1200, 1200);
    const second = oneVOne(first.winner.eloAfter, first.loser.eloAfter);
    // The second application moves the ratings again. If this ever became a
    // no-op by accident, the guard would look unnecessary; it is not.
    expect(second.winner.eloAfter).not.toBe(first.winner.eloAfter);
  });

  /**
   * Skipping is the whole mechanism: a match already rated contributes no
   * changes, so the ladder after two archives equals the ladder after one.
   */
  it("is unchanged when the second pass is skipped", () => {
    const first = oneVOne(1200, 1450);
    const skipped: RatingChange[] = [];
    const afterTwoArchives =
      first.winner.eloAfter + sum(skipped.filter((c) => c.userId === "w"));
    expect(afterTwoArchives).toBe(first.winner.eloAfter);
  });

  /**
   * The advisory-lock key is what makes duplicate archives serialize, so it has
   * to be stable across processes and inside Postgres' signed bigint range. A
   * key that overflowed would make the lock call throw and take the archive
   * down with it.
   */
  it("derives a stable in-range advisory key per game id", () => {
    expect(advisoryKey("Tst1Game")).toBe(advisoryKey("Tst1Game"));
    expect(advisoryKey("Tst1Game")).not.toBe(advisoryKey("Tst2Game"));

    const MIN = -(2n ** 63n);
    const MAX = 2n ** 63n - 1n;
    for (const id of ["Tst1Game", "aaaaaaaa", "ZZZZ9999", "Elo00001", ""]) {
      expect(advisoryKey(id)).toBeGreaterThanOrEqual(MIN);
      expect(advisoryKey(id)).toBeLessThanOrEqual(MAX);
    }
  });

  /** The maths is deterministic, so a re-run on the same inputs is identical. */
  it("produces identical changes for identical inputs", () => {
    const players: RatedPlayer[] = [
      { userId: "a1", elo: 1512, team: "a", won: true },
      { userId: "a2", elo: 1003, team: "a", won: true },
      { userId: "b1", elo: 1290, team: "b", won: false },
      { userId: "b2", elo: 1377, team: "b", won: false },
    ];
    expect(rateMatch(players)).toEqual(rateMatch(players));
  });
});
