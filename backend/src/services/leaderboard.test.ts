import {
  RankedLeaderboardResponseSchema,
  TribeLeaderboardResponseSchema,
} from "@game/ApiSchemas.ts";
import { RankedType } from "@game/game/Game.ts";
import { describe, expect, it } from "vitest";
import {
  fetchTribeLeaderboard,
  isValidRankedPage,
  pageBoundsMessage,
  RANKED_MAX_PAGE,
  RANKED_PAGE_SIZE,
} from "./leaderboard.ts";

/**
 * The ranked board's row builder needs Postgres, so what is pinned here is the
 * part a refactor breaks silently: the wire shape, checked against the game's
 * OWN schema rather than a local copy. The client discards a response that
 * fails to parse without surfacing anything, so a drift here is invisible in
 * play until someone notices an empty board.
 */
describe("ranked leaderboard contract", () => {
  const entry = {
    rank: 1,
    elo: 1450,
    peakElo: null,
    wins: 12,
    losses: 3,
    total: 15,
    public_id: "rkoDeCl9fZ-Eos4A",
    accountUsername: "DevPlayer.3825",
  };

  it("accepts a populated board", () => {
    const result = RankedLeaderboardResponseSchema.safeParse({
      [RankedType.OneVOne]: [entry],
      [RankedType.TwoVTwo]: [{ ...entry, elo: 1200, accountUsername: null }],
    });
    expect(result.success).toBe(true);
  });

  /**
   * The common state in development and on a fresh install. It must parse as
   * an empty board, not fail — an empty ladder is a normal board, not an error.
   */
  it("accepts empty ladders", () => {
    const result = RankedLeaderboardResponseSchema.safeParse({
      [RankedType.OneVOne]: [],
      [RankedType.TwoVTwo]: [],
    });
    expect(result.success).toBe(true);
    expect(result.data?.[RankedType.OneVOne]).toEqual([]);
    expect(result.data?.[RankedType.TwoVTwo]).toEqual([]);
  });

  /**
   * accountUsername is nullable because a player may never have set a name;
   * the client falls back to public_id. If the schema ever required a string,
   * every nameless player would drop the whole page.
   */
  it("accepts a null accountUsername", () => {
    const result = RankedLeaderboardResponseSchema.safeParse({
      [RankedType.OneVOne]: [{ ...entry, accountUsername: null }],
      [RankedType.TwoVTwo]: [],
    });
    expect(result.success).toBe(true);
  });

  it("serves both ranked ladders under the keys the game names", () => {
    // Guards against the modes being spelled by hand somewhere.
    expect(RankedType.OneVOne).toBe("1v1");
    expect(RankedType.TwoVTwo).toBe("2v2");
  });
});

describe("ranked leaderboard paging", () => {
  /**
   * The client stops paging when a page comes back shorter than its own page
   * size (playerPageSize in LeaderboardPlayerList). A mismatch either truncates
   * the board or makes it request pages forever.
   */
  it("uses the page size the client expects", () => {
    expect(RANKED_PAGE_SIZE).toBe(50);
  });

  it("accepts pages within bounds and rejects the rest", () => {
    expect(isValidRankedPage(1)).toBe(true);
    expect(isValidRankedPage(RANKED_MAX_PAGE)).toBe(true);
    expect(isValidRankedPage(RANKED_MAX_PAGE + 1)).toBe(false);
    expect(isValidRankedPage(0)).toBe(false);
    expect(isValidRankedPage(-3)).toBe(false);
    expect(isValidRankedPage(1.5)).toBe(false);
    expect(isValidRankedPage(Number.NaN)).toBe(false);
  });

  /**
   * The client detects the end of the board by pattern-matching this message
   * (isPageBoundsMessage in src/client/Api.ts). Reword it and "reached the
   * last page" degrades into "the request failed".
   */
  it("phrases the out-of-bounds message the way the client matches it", () => {
    expect(pageBoundsMessage()).toMatch(/^Page must be between \d+ and \d+$/);
  });
});

describe("tribe leaderboard placeholder", () => {
  /**
   * There is no tribe data in this backend. The placeholder must still satisfy
   * the game's schema so the client renders an empty board instead of erroring.
   */
  it("is schema-valid and empty", () => {
    const result = TribeLeaderboardResponseSchema.safeParse(
      fetchTribeLeaderboard(new Date("2026-08-07T12:00:00Z")),
    );
    expect(result.success).toBe(true);
    expect(result.data?.tribes).toEqual([]);
  });

  it("reports an inclusive 30-day window as YYYY-MM-DD", () => {
    const board = fetchTribeLeaderboard(new Date("2026-08-07T12:00:00Z"));
    expect(board.windowDays).toBe(30);
    expect(board.end).toBe("2026-08-07");
    // Inclusive: 30 days ending on the 7th begins on 2026-07-09.
    expect(board.start).toBe("2026-07-09");
  });
});
