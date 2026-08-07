import { PlayerProfileSchema } from "@game/ApiSchemas.ts";
import { describe, expect, it } from "vitest";

/**
 * GET /player/:publicId must satisfy the game's own PlayerProfileSchema, or
 * the client silently drops the profile (fetchPlayerById returns false on a
 * parse failure). Asserting against the game's schema means a drift there
 * fails the build here.
 */
describe("/player/:publicId contract", () => {
  it("accepts the shape we return for a player with no recorded matches", () => {
    const result = PlayerProfileSchema.safeParse({
      createdAt: new Date().toISOString(),
      username: "Boss",
      stats: {},
    });
    expect(result.success).toBe(true);
  });

  it("accepts a null username (player never set one)", () => {
    const result = PlayerProfileSchema.safeParse({
      createdAt: new Date().toISOString(),
      username: null,
      stats: {},
    });
    expect(result.success).toBe(true);
  });

  it("rejects a response missing createdAt", () => {
    const result = PlayerProfileSchema.safeParse({
      username: "Boss",
      stats: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-ISO createdAt", () => {
    const result = PlayerProfileSchema.safeParse({
      createdAt: "yesterday",
      username: "Boss",
      stats: {},
    });
    expect(result.success).toBe(false);
  });
});
