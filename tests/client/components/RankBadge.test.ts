import { describe, expect, it } from "vitest";
import {
  RANK_TIERS,
  rankFromElo,
} from "../../../src/client/components/RankBadge";

describe("rankFromElo", () => {
  it("puts elo below the first threshold in the bottom division", () => {
    const rank = rankFromElo(0);
    expect(rank.tier.key).toBe("bronze");
    expect(rank.division).toBe(1);
    expect(rank.label).toBe("Bronze I");
  });

  it("never returns a division outside 1..3", () => {
    // Sweep well past the top tier's span — the last tier has no ceiling, so
    // this is where an unclamped implementation would produce "IIII".
    for (let elo = 0; elo <= 4000; elo += 7) {
      const rank = rankFromElo(elo);
      expect(rank.division).toBeGreaterThanOrEqual(1);
      expect(rank.division).toBeLessThanOrEqual(3);
    }
  });

  it("lands exactly on division I at each tier floor", () => {
    for (const tier of RANK_TIERS) {
      const rank = rankFromElo(tier.floor);
      expect(rank.tier.key).toBe(tier.key);
      expect(rank.division).toBe(1);
    }
  });

  it("is monotonic: more elo never means a lower rank", () => {
    const order = (elo: number) => {
      const rank = rankFromElo(elo);
      return RANK_TIERS.indexOf(rank.tier) * 3 + rank.division;
    };
    let previous = order(0);
    for (let elo = 1; elo <= 3000; elo += 13) {
      const current = order(elo);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  it("reports elo remaining that actually reaches the next division", () => {
    for (const elo of [50, 640, 1350, 1799, 2100]) {
      const rank = rankFromElo(elo);
      if (rank.toNext === null) continue;
      const before = rankFromElo(elo);
      const after = rankFromElo(elo + rank.toNext);
      const rose =
        after.division > before.division || after.tier !== before.tier;
      expect(rose, `elo ${elo} + ${rank.toNext} should promote`).toBe(true);
    }
  });

  it("keeps progress within 0..1", () => {
    for (let elo = 0; elo <= 3000; elo += 11) {
      const { progress } = rankFromElo(elo);
      expect(progress).toBeGreaterThanOrEqual(0);
      expect(progress).toBeLessThanOrEqual(1);
    }
  });

  it("caps the very top of the ladder", () => {
    const top = rankFromElo(9999);
    expect(top.tier.key).toBe("platinum");
    expect(top.division).toBe(3);
    expect(top.toNext).toBeNull();
    expect(top.progress).toBe(1);
  });
});
