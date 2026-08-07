import {
  BEST_MAP_MIN_GAMES,
  computeHistoryMetrics,
} from "../src/client/components/baseComponents/stats/GameHistoryMetrics";
import type { PublicPlayerGame } from "../src/core/ApiSchemas";

function game(over: Partial<PublicPlayerGame> = {}): PublicPlayerGame {
  return {
    gameId: "g1",
    start: "2026-08-08T10:00:00.000Z",
    durationSeconds: 600,
    map: "Montreal",
    mode: "ffa",
    type: "public",
    playerTeams: null,
    rankedType: "1v1",
    result: "victory",
    totalPlayers: 20,
    username: "Alice",
    clanTag: null,
    ...over,
  } as PublicPlayerGame;
}

describe("computeHistoryMetrics", () => {
  it("returns an empty shape for no games", () => {
    const m = computeHistoryMetrics([]);
    expect(m.totalGames).toBe(0);
    expect(m.winRate).toBeNull();
    expect(m.avgDurationSeconds).toBeNull();
    expect(m.bestMap).toBeNull();
    expect(m.form).toEqual([]);
  });

  it("computes win rate over decided games only", () => {
    const m = computeHistoryMetrics([
      game({ result: "victory" }),
      game({ result: "defeat" }),
      game({ result: "victory" }),
    ]);
    expect(m.totalGames).toBe(3);
    expect(m.decidedGames).toBe(3);
    expect(m.wins).toBe(2);
    expect(m.winRate).toBeCloseTo(2 / 3);
  });

  it("excludes incomplete games from win rate but counts them in total", () => {
    const m = computeHistoryMetrics([
      game({ result: "victory" }),
      game({ result: "incomplete" }),
      game({ result: "incomplete" }),
    ]);
    expect(m.totalGames).toBe(3);
    expect(m.decidedGames).toBe(1);
    expect(m.winRate).toBe(1);
  });

  it("returns null win rate when every game is incomplete", () => {
    const m = computeHistoryMetrics([game({ result: "incomplete" })]);
    expect(m.winRate).toBeNull();
  });

  it("includes zero-second games in duration average", () => {
    const m = computeHistoryMetrics([
      game({ durationSeconds: 100 }),
      game({ durationSeconds: 200 }),
      game({ durationSeconds: 0 }),
    ]);
    expect(m.avgDurationSeconds).toBe(100);
  });

  it("returns null average when no games exist", () => {
    const m = computeHistoryMetrics([]);
    expect(m.avgDurationSeconds).toBeNull();
  });

  it("requires a minimum number of games before naming a best map", () => {
    const below = computeHistoryMetrics([
      game({ map: "Europe", result: "victory" }),
      game({ map: "Europe", result: "victory" }),
    ]);
    expect(below.bestMap).toBeNull();

    const atThreshold = computeHistoryMetrics([
      game({ map: "Europe", result: "victory" }),
      game({ map: "Europe", result: "victory" }),
      game({ map: "Europe", result: "defeat" }),
    ]);
    expect(atThreshold.bestMap).toEqual({
      map: "Europe",
      winRate: 2 / 3,
      games: 3,
    });
    expect(BEST_MAP_MIN_GAMES).toBe(3);
  });

  it("picks the map with the highest win rate among qualifying maps", () => {
    const m = computeHistoryMetrics([
      game({ map: "Europe", result: "victory" }),
      game({ map: "Europe", result: "victory" }),
      game({ map: "Europe", result: "victory" }),
      game({ map: "Asia", result: "victory" }),
      game({ map: "Asia", result: "defeat" }),
      game({ map: "Asia", result: "defeat" }),
    ]);
    expect(m.bestMap?.map).toBe("Europe");
  });

  it("counts only decided games toward a map's threshold", () => {
    const m = computeHistoryMetrics([
      game({ map: "Europe", result: "victory" }),
      game({ map: "Europe", result: "victory" }),
      game({ map: "Europe", result: "incomplete" }),
    ]);
    expect(m.bestMap).toBeNull();
  });

  it("names a best map once the threshold is met", () => {
    const m = computeHistoryMetrics([
      game({ map: "Africa", result: "victory" }),
      game({ map: "Africa", result: "victory" }),
      game({ map: "Africa", result: "victory" }),
    ]);
    expect(m.bestMap).toEqual({
      map: "Africa",
      winRate: 1,
      games: 3,
    });
  });

  it("excludes empty-string maps from best map calculation", () => {
    const m = computeHistoryMetrics([
      game({ map: "", result: "victory" }),
      game({ map: "", result: "victory" }),
      game({ map: "", result: "victory" }),
    ]);
    expect(m.bestMap).toBeNull();
  });

  it("caps the form list at 10, preserving input order", () => {
    const games = Array.from({ length: 14 }, (_, i) =>
      game({ gameId: `g${i}`, result: i === 0 ? "defeat" : "victory" }),
    );
    const m = computeHistoryMetrics(games);
    expect(m.form).toHaveLength(10);
    expect(m.form[0]).toBe("defeat");
  });
});
