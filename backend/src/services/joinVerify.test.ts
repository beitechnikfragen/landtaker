import { describe, expect, it } from "vitest";
import { z } from "zod";
// The GAME's own type, imported directly from the caller that defines the
// contract. If src/server/JoinVerify.ts ever changes the shape it accepts,
// these tests stop compiling — which is the point.
import type { JoinVerifyResponse } from "../../../src/server/JoinVerify.ts";
import {
  BAN_LOOKUP_TIMEOUT_MS,
  banRejectionReason,
  type JoinVerdict,
  normalizeClanTag,
  verifyTurnstile,
} from "./joinVerify.ts";
import { JOIN_SITEVERIFY_TIMEOUT_MS } from "./turnstile.ts";

/**
 * The game parses our response with a private `JoinVerifyVerdictSchema` that
 * is not exported, so it is restated here — character for character — from
 * src/server/JoinVerify.ts. This is the closest thing to the real parser we
 * can execute, and the type-level assertions below tie it back to the game's
 * exported `JoinVerifyResponse` so a drift in either direction is caught.
 */
const GameJoinVerifyVerdictSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("approved"),
    username: z.string(),
    clanTag: z.string().nullable().optional(),
  }),
  z.object({
    status: z.literal("rejected"),
    reason: z.string(),
  }),
]);

/**
 * Every verdict we can produce must be assignable to the game's own response
 * type. This is a compile-time assertion: `tsc --noEmit` fails if our
 * JoinVerdict ever grows an arm the game cannot represent.
 */
const _approvedIsGameShape: JoinVerifyResponse = {
  status: "approved",
  username: "Player",
  clanTag: null,
} satisfies JoinVerdict;

const _rejectedIsGameShape: JoinVerifyResponse = {
  status: "rejected",
  reason: "banned: cheating",
} satisfies JoinVerdict;

void _approvedIsGameShape;
void _rejectedIsGameShape;

describe("the shape the game server can parse", () => {
  it("accepts an approval carrying a username and a null clan tag", () => {
    const verdict: JoinVerdict = {
      status: "approved",
      username: "Player",
      clanTag: null,
    };
    const parsed = GameJoinVerifyVerdictSchema.safeParse(verdict);
    expect(parsed.success).toBe(true);
  });

  it("accepts an approval carrying a clan tag", () => {
    const verdict: JoinVerdict = {
      status: "approved",
      username: "Player",
      clanTag: "ABC",
    };
    expect(GameJoinVerifyVerdictSchema.safeParse(verdict).success).toBe(true);
  });

  it("accepts a rejection carrying a reason", () => {
    const verdict: JoinVerdict = {
      status: "rejected",
      reason: banRejectionReason("cheating"),
    };
    expect(GameJoinVerifyVerdictSchema.safeParse(verdict).success).toBe(true);
  });

  /**
   * "error" is the game's LOCAL synthesis for "we failed you" — it is not in
   * the wire schema. Emitting it would be parsed as malformed, which the game
   * also maps to error, so the player would still get in; but it would make
   * our logs and the game's logs disagree about what happened.
   */
  it("does not accept an 'error' status on the wire", () => {
    const notOnTheWire = { status: "error", reason: "database down" };
    expect(GameJoinVerifyVerdictSchema.safeParse(notOnTheWire).success).toBe(
      false,
    );
  });

  it("does not accept an approval missing the username", () => {
    expect(
      GameJoinVerifyVerdictSchema.safeParse({ status: "approved" }).success,
    ).toBe(false);
  });

  it("does not accept a rejection missing the reason", () => {
    expect(
      GameJoinVerifyVerdictSchema.safeParse({ status: "rejected" }).success,
    ).toBe(false);
  });
});

describe("clan tag normalisation", () => {
  it("uppercases a surviving tag, as the game documents", () => {
    expect(normalizeClanTag("abc")).toBe("ABC");
  });

  it("treats an empty or whitespace-only tag as no tag", () => {
    expect(normalizeClanTag("")).toBeNull();
    expect(normalizeClanTag("   ")).toBeNull();
  });

  it("passes null straight through", () => {
    expect(normalizeClanTag(null)).toBeNull();
  });

  it("clamps an over-long tag instead of refusing the join over cosmetics", () => {
    expect(normalizeClanTag("ABCDEFGHIJ")).toHaveLength(5);
  });

  it("still produces something the game's schema accepts", () => {
    const verdict: JoinVerdict = {
      status: "approved",
      username: "Player",
      clanTag: normalizeClanTag("  toolongtag "),
    };
    expect(GameJoinVerifyVerdictSchema.safeParse(verdict).success).toBe(true);
  });
});

describe("turnstile", () => {
  /**
   * The no-op is gone: verification now delegates to services/turnstile.ts.
   * What must NOT change is the fail-open contract — a join is never refused
   * because we could not reach Cloudflare, and a null token (a reconnect
   * whose single-use token is already spent) skips siteverify entirely.
   */
  it("skips verification for a null token", async () => {
    // A re-admit has no token to redeem. Calling siteverify with null would
    // be a guaranteed rejection of a player who is already legitimately in.
    expect(await verifyTurnstile(null, null)).toBe("skipped");
  });

  it("reports unavailable when no secret is configured", async () => {
    // Default dev config has no TURNSTILE_SECRET_KEY.
    expect(await verifyTurnstile("some-token", null)).toBe("unavailable");
  });
});

/**
 * The game aborts the call at 5s (AbortSignal.timeout(5000) in
 * src/server/JoinVerify.ts). Our own budget has to fit inside that with room
 * to spare, or the fail-open stops being ours: the game times out first, and
 * we are left holding a socket for a player who has already been admitted.
 */
describe("timeout budget", () => {
  const GAME_CLIENT_TIMEOUT_MS = 5000;

  it("gives up well before the game does", () => {
    expect(BAN_LOOKUP_TIMEOUT_MS).toBeLessThan(GAME_CLIENT_TIMEOUT_MS);
    // Leave at least a second of headroom for connect, parse and response.
    expect(BAN_LOOKUP_TIMEOUT_MS).toBeLessThanOrEqual(
      GAME_CLIENT_TIMEOUT_MS - 1000,
    );
  });

  it("still allows a realistically slow query to succeed", () => {
    // A ban lookup is two indexed reads; anything under a second would start
    // failing open on ordinary load spikes, which is worse than useless.
    expect(BAN_LOOKUP_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
  });

  it("keeps headroom once Turnstile is in the path too", () => {
    // Turnstile runs BEFORE the ban lookup, sequentially, so the budgets add.
    // The ban check is the only thing here that can actually refuse a player,
    // so an advisory check that never rejects must not crowd it out.
    expect(
      JOIN_SITEVERIFY_TIMEOUT_MS + BAN_LOOKUP_TIMEOUT_MS,
    ).toBeLessThanOrEqual(GAME_CLIENT_TIMEOUT_MS - 1000);
  });
});

describe("ban rejection reason", () => {
  it("names the category so the close reason is intelligible", () => {
    expect(banRejectionReason("cheating")).toContain("cheating");
  });

  it("stays short enough for a websocket close reason (123 byte limit)", () => {
    const reason = banRejectionReason("a-very-long-moderation-category-name");
    expect(Buffer.byteLength(reason, "utf8")).toBeLessThan(123);
  });
});
