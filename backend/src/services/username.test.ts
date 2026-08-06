import { isVerifiedUsername } from "@game/ApiSchemas.ts";
import { describe, expect, it } from "vitest";

/**
 * The verified check is derived by the game from the rendered name alone: a
 * name without a dot IS verified (isVerifiedUsername). So the badge rule lives
 * in whatever /users/@me puts in `player.username`, and these tests assert our
 * output against the game's own predicate rather than a local copy of it.
 */
describe("verified badge derivation", () => {
  it("treats a bare name as verified", () => {
    expect(isVerifiedUsername("Boss")).toBe(true);
  });

  it("treats a suffixed name as not verified", () => {
    expect(isVerifiedUsername("Normalo.0915")).toBe(false);
  });

  it("does not award the badge to server-assigned temporary names", () => {
    // TEMPORARY#### is bare but not a chosen name, so it must not qualify.
    expect(isVerifiedUsername("TEMPORARY1234")).toBe(false);
  });

  it("treats a missing name as not verified", () => {
    expect(isVerifiedUsername(null)).toBe(false);
    expect(isVerifiedUsername(undefined)).toBe(false);
  });

  /**
   * Mirrors resolveDisplayUsername in users.ts. Kept here as an executable
   * statement of the rule: only premium/indefinite render bare, and only bare
   * names get the badge.
   */
  const render = (base: string, suffix: string, status: string) =>
    ["premium", "indefinite"].includes(status) ? base : `${base}.${suffix}`;

  it.each([
    ["premium", true],
    ["indefinite", true],
    ["claimed", false],
    ["unclaimed", false],
  ])("status %s yields verified=%s", (status, expected) => {
    expect(isVerifiedUsername(render("Boss", "0915", status))).toBe(expected);
  });
});
