import { NewsItemSchema, StreamsFeedSchema } from "@game/ApiSchemas.ts";
import {
  ClanLeaderboardResponseSchema,
  ReservedClanTagsResponseSchema,
} from "@game/ClanApiSchemas.ts";
import { CosmeticsSchema } from "@game/CosmeticSchemas.ts";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * The placeholder endpoints in stubs.ts only earn their keep if the client can
 * actually parse them — a stub that fails Zod validation is the same 404 noise
 * with extra steps. These assert the exact bodies stubs.ts returns against the
 * game's own schemas, so schema drift upstream fails the build here.
 */
describe("placeholder endpoint contracts", () => {
  it("GET /public/clans/leaderboard satisfies ClanLeaderboardResponseSchema", () => {
    const now = new Date().toISOString();
    const result = ClanLeaderboardResponseSchema.safeParse({
      start: now,
      end: now,
      clans: [],
      total: 0,
      limit: 0,
    });
    expect(result.success).toBe(true);
  });

  it("GET /cosmetics.json satisfies CosmeticsSchema", () => {
    const result = CosmeticsSchema.safeParse({ patterns: {}, flags: {} });
    expect(result.success).toBe(true);
  });

  it("CosmeticsSchema still requires patterns and flags", () => {
    // Guards the stub: if these became optional upstream we could simplify,
    // and if a third key became required the stub would start failing here
    // rather than silently in the browser.
    expect(CosmeticsSchema.safeParse({}).success).toBe(false);
  });

  it("GET /reserved_clan_tags satisfies ReservedClanTagsResponseSchema", () => {
    const result = ReservedClanTagsResponseSchema.safeParse([]);
    expect(result.success).toBe(true);
  });

  it("GET /streams.json satisfies StreamsFeedSchema", () => {
    const result = StreamsFeedSchema.safeParse({
      verifiedAt: new Date().toISOString(),
      featured: [],
      live: [],
    });
    expect(result.success).toBe(true);
  });

  it("StreamsFeedSchema still requires verifiedAt", () => {
    // The stub must keep sending it; the client treats a feed without it as
    // the legacy payload and falls back to showing nothing.
    expect(
      StreamsFeedSchema.safeParse({ featured: [], live: [] }).success,
    ).toBe(false);
  });

  it("GET /news.json satisfies z.array(NewsItemSchema)", () => {
    const result = z.array(NewsItemSchema).safeParse([]);
    expect(result.success).toBe(true);
  });
});
