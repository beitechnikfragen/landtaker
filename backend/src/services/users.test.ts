import { describe, expect, it } from "vitest";
import { UserMeResponseSchema } from "@game/ApiSchemas.ts";

/**
 * Guards the shape of /users/@me against the game's own schema. The service
 * itself needs a database, so this pins the contract using a representative
 * payload — the same fields buildUserMeResponse emits.
 *
 * If the game tightens UserMeResponseSchema, this test fails and tells us
 * before players see a broken login.
 */
describe("/users/@me contract", () => {
  const payload = {
    user: {},
    ban: null,
    player: {
      publicId: "rkoDeCl9fZ-Eos4A",
      adfree: true,
      unlimitedRanked: true,
      canCreatePublicLobbies: true,
      username: "DevPlayer.3825",
      usernameBase: "DevPlayer",
      usernameDiscriminator: "3825",
      nextUsernameChangeAt: null,
      achievements: { singleplayerMap: [] },
      leaderboard: {},
      friends: [],
      subscription: null,
    },
  };

  it("accepts a minimal response", () => {
    const result = UserMeResponseSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("accepts a populated response", () => {
    const result = UserMeResponseSchema.safeParse({
      ...payload,
      user: { email: "player@example.com" },
      ban: {
        category: "cheating",
        reason: "automation",
        expiresAt: new Date().toISOString(),
      },
      player: {
        ...payload.player,
        leaderboard: { oneVone: { elo: 1200 }, twoVtwo: { elo: 1100 } },
        friends: ["abc123", "def456"],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a response missing required player fields", () => {
    const { adfree: _omitted, ...playerWithoutAdfree } = payload.player;
    const result = UserMeResponseSchema.safeParse({
      ...payload,
      player: playerWithoutAdfree,
    });
    expect(result.success).toBe(false);
  });
});
