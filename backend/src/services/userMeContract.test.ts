import { UserMeResponseSchema } from "@game/ApiSchemas.ts";
import { describe, expect, it } from "vitest";

/**
 * /users/@me is the widest contract the backend owes the game, so the parts
 * this file adds — the ranked record and the recent-match strip — are asserted
 * against the game's real UserMeResponseSchema (through the @game alias)
 * rather than a local copy of the shape. A local copy would keep passing after
 * the game changed the response.
 *
 * The database side (the join, the ordering, the limit) needs a live Postgres
 * and belongs in scripts/smoke-*.sh, like the archive tests.
 */

/** A minimal response with everything required present. */
function baseResponse(): any {
  return {
    user: {},
    ban: null,
    player: {
      publicId: "abc123",
      adfree: false,
      unlimitedRanked: false,
      canCreatePublicLobbies: false,
      achievements: { singleplayerMap: [] },
      friends: [],
      subscription: null,
    },
  };
}

describe("users/@me ranked record", () => {
  it("accepts elo with wins and losses", () => {
    const res = baseResponse();
    res.player.leaderboard = {
      oneVone: { elo: 1842, wins: 47, losses: 31 },
      twoVtwo: { elo: 1210, wins: 4, losses: 9 },
    };
    expect(UserMeResponseSchema.safeParse(res).success).toBe(true);
  });

  /**
   * An API deployment that predates the counters sends elo alone. That has to
   * keep parsing, or upgrading the game client would break against an older
   * backend.
   */
  it("still accepts a record carrying only elo", () => {
    const res = baseResponse();
    res.player.leaderboard = { oneVone: { elo: 1000 } };
    expect(UserMeResponseSchema.safeParse(res).success).toBe(true);
  });

  it("rejects a non-numeric win count", () => {
    const res = baseResponse();
    res.player.leaderboard = { oneVone: { elo: 1000, wins: "many" } };
    expect(UserMeResponseSchema.safeParse(res).success).toBe(false);
  });
});

describe("users/@me recent matches", () => {
  it("accepts a finished match", () => {
    const res = baseResponse();
    res.player.recentMatches = [
      {
        gameId: "jZNnxVes",
        map: "Europe",
        mode: "Free For All",
        rankedType: null,
        placement: 3,
        won: false,
        endedAt: "2026-08-07T17:30:00.000Z",
      },
    ];
    expect(UserMeResponseSchema.safeParse(res).success).toBe(true);
  });

  /**
   * Every descriptive field is nullable because the archive stores whatever
   * the game server recorded: an aborted match can land with no map, mode or
   * placement, and that must not fail the whole /users/@me response.
   */
  it("accepts a match with nothing but an id", () => {
    const res = baseResponse();
    res.player.recentMatches = [
      {
        gameId: "abc",
        map: null,
        mode: null,
        rankedType: null,
        placement: null,
        won: null,
        endedAt: null,
      },
    ];
    expect(UserMeResponseSchema.safeParse(res).success).toBe(true);
  });

  it("treats an empty history as valid", () => {
    const res = baseResponse();
    res.player.recentMatches = [];
    expect(UserMeResponseSchema.safeParse(res).success).toBe(true);
  });

  /** Absent means "this API does not serve history", which is not an error. */
  it("treats an absent history as valid", () => {
    expect(UserMeResponseSchema.safeParse(baseResponse()).success).toBe(true);
  });

  it("rejects a match without an id", () => {
    const res = baseResponse();
    res.player.recentMatches = [{ map: "Europe" }];
    expect(UserMeResponseSchema.safeParse(res).success).toBe(false);
  });

  /**
   * `map` and `mode` are open strings on purpose — the archive keeps what the
   * game server sent, so a map added after this deployment must not 500 the
   * account endpoint.
   */
  it("accepts a map name it has never seen", () => {
    const res = baseResponse();
    res.player.recentMatches = [
      {
        gameId: "x",
        map: "SomeMapAddedLater",
        mode: "SomeModeAddedLater",
        rankedType: null,
        placement: 1,
        won: true,
        endedAt: "2026-08-07T17:30:00.000Z",
      },
    ];
    expect(UserMeResponseSchema.safeParse(res).success).toBe(true);
  });
});
