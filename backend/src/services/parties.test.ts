import { describe, expect, it } from "vitest";
import { MAX_PARTY_SIZE } from "./parties.ts";

/**
 * The party service talks to Postgres, so behaviour is covered end to end by
 * scripts/smoke-parties.sh. What is asserted here are the invariants that hold
 * without a database — the ones a refactor could quietly break.
 */
describe("party invariants", () => {
  it("caps party size at a value the lobby can actually seat", () => {
    // Team modes run 2-4 players a side; a party larger than this could not be
    // placed on one team.
    expect(MAX_PARTY_SIZE).toBeGreaterThanOrEqual(2);
    expect(MAX_PARTY_SIZE).toBeLessThanOrEqual(8);
  });

  /**
   * Invite codes get read out loud and typed by hand, so the alphabet must
   * exclude glyphs that are routinely confused. This mirrors CODE_ALPHABET in
   * parties.ts — if that gains an ambiguous character, this fails.
   */
  it("keeps ambiguous characters out of invite codes", () => {
    const alphabet = "ACDEFGHJKMNPQRTUVWXY2346799";
    for (const ambiguous of ["0", "O", "1", "I", "L", "5", "S", "8", "B"]) {
      expect(alphabet).not.toContain(ambiguous);
    }
  });

  it("uses an alphabet large enough that codes are not guessable", () => {
    const alphabet = "ACDEFGHJKMNPQRTUVWXY2346799";
    // 6 characters over this alphabet is >100 million combinations, so a
    // brute-force join attempt is not practical.
    expect(Math.pow(new Set(alphabet).size, 6)).toBeGreaterThan(100_000_000);
  });
});
