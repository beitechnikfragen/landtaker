import type { PublicPlayerGame } from "../../../../core/ApiSchemas";

// A map needs this many *decided* games before it can be called a best map.
// Below it, "100%" off a single win is noise rather than a signal.
export const BEST_MAP_MIN_GAMES = 3;

// How many recent results the form strip shows.
const FORM_LENGTH = 10;

export type GameResult = "victory" | "defeat" | "incomplete";

export interface HistoryMetrics {
  totalGames: number;
  decidedGames: number;
  wins: number;
  winRate: number | null;
  avgDurationSeconds: number | null;
  bestMap: { map: string; winRate: number; games: number } | null;
  form: GameResult[];
}

// Aggregates the games currently loaded in the list. Incomplete games count
// toward totals but never toward win rate — folding abandoned games into
// defeats would systematically depress it.
export function computeHistoryMetrics(
  games: PublicPlayerGame[],
): HistoryMetrics {
  let wins = 0;
  let decidedGames = 0;
  let durationSum = 0;
  let durationCount = 0;
  const perMap = new Map<string, { wins: number; decided: number }>();

  for (const game of games) {
    const decided = game.result === "victory" || game.result === "defeat";
    if (decided) {
      decidedGames++;
      if (game.result === "victory") wins++;
    }

    if (game.durationSeconds > 0) {
      durationSum += game.durationSeconds;
      durationCount++;
    }

    if (game.map && decided) {
      const entry = perMap.get(game.map) ?? { wins: 0, decided: 0 };
      entry.decided++;
      if (game.result === "victory") entry.wins++;
      perMap.set(game.map, entry);
    }
  }

  let bestMap: HistoryMetrics["bestMap"] = null;
  for (const [map, entry] of perMap) {
    if (entry.decided < BEST_MAP_MIN_GAMES) continue;
    const winRate = entry.wins / entry.decided;
    if (bestMap === null || winRate > bestMap.winRate) {
      bestMap = { map, winRate, games: entry.decided };
    }
  }

  return {
    totalGames: games.length,
    decidedGames,
    wins,
    winRate: decidedGames === 0 ? null : wins / decidedGames,
    avgDurationSeconds:
      durationCount === 0 ? null : durationSum / durationCount,
    bestMap,
    form: games.slice(0, FORM_LENGTH).map((g) => g.result),
  };
}
