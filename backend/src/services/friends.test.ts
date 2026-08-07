import {
  FriendRequestsResponseSchema,
  FriendsListResponseSchema,
  SendFriendRequestResponseSchema,
} from "@game/ApiSchemas.ts";
import { describe, expect, it } from "vitest";
import {
  FRIENDS_PAGE_LIMIT_MAX,
  normalizePaging,
  toFriendEntry,
} from "./friends.ts";

/**
 * These assert the friends responses against the GAME's own schemas, imported
 * through the @game alias — the same objects src/client/FriendsApi.ts parses
 * with. A local copy of the shape would pass while the client silently
 * discarded every response, which is exactly the failure this guards.
 *
 * Database behaviour (the send → accept → remove flow, and the failure cases)
 * needs Postgres and is covered by scripts/smoke-friends.sh.
 */

/** Row shape as selected from `users`, i.e. what toFriendEntry consumes. */
function row(over: Partial<Parameters<typeof toFriendEntry>[0]> = {}) {
  return {
    publicId: "rkoDeCl9fZ-Eos4A",
    usernameBase: "Wonder",
    usernameDiscriminator: "5005",
    usernameStatus: "claimed",
    ...over,
  };
}

describe("friend entry rendering", () => {
  it("renders the discriminated name for an ordinary account", () => {
    const entry = toFriendEntry(row(), new Date("2024-05-01T10:00:00.000Z"));
    expect(entry.username).toBe("Wonder.5005");
    expect(entry.publicId).toBe("rkoDeCl9fZ-Eos4A");
    expect(entry.createdAt).toBe("2024-05-01T10:00:00.000Z");
  });

  /**
   * The verified badge is derived by the game from the name having no dot, so
   * an entitled holder must render bare here or the badge is silently lost.
   */
  it("renders a bare name for an entitled account, earning the badge", () => {
    const entry = toFriendEntry(row({ usernameStatus: "premium" }), new Date());
    expect(entry.username).toBe("Wonder");
    expect(entry.username).not.toContain(".");
  });

  it("does not hand the badge to a merely claimed name", () => {
    const entry = toFriendEntry(row({ usernameStatus: "claimed" }), new Date());
    expect(entry.username).toContain(".");
  });

  it("renders null when the account never set a username", () => {
    const entry = toFriendEntry(
      row({ usernameBase: null, usernameDiscriminator: null }),
      new Date(),
    );
    expect(entry.username).toBeNull();
  });

  /** The client requires a real ISO datetime; a bare date fails the schema. */
  it("emits createdAt as an ISO datetime the schema accepts", () => {
    const entry = toFriendEntry(row(), new Date("2024-05-01T10:00:00.000Z"));
    const parsed = FriendsListResponseSchema.safeParse({
      results: [entry],
      total: 1,
      page: 1,
      limit: 20,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("GET /friends/requests contract", () => {
  it("accepts a populated both-directions response", () => {
    const payload = {
      incoming: [toFriendEntry(row(), new Date())],
      outgoing: [
        toFriendEntry(
          row({ publicId: "other-id", usernameStatus: "premium" }),
          new Date(),
        ),
      ],
    };
    expect(FriendRequestsResponseSchema.safeParse(payload).success).toBe(true);
  });

  it("accepts an empty response", () => {
    expect(
      FriendRequestsResponseSchema.safeParse({ incoming: [], outgoing: [] })
        .success,
    ).toBe(true);
  });

  it("rejects a response missing a direction", () => {
    expect(
      FriendRequestsResponseSchema.safeParse({ incoming: [] }).success,
    ).toBe(false);
  });

  /**
   * publicId is the only identity that may cross the wire. If an entry were
   * ever built from the internal uuid-bearing row, the field would still be a
   * string and the schema would pass — so assert the field set explicitly.
   */
  it("never leaks the internal user id", () => {
    const entry = toFriendEntry(row(), new Date());
    expect(Object.keys(entry).sort()).toEqual([
      "createdAt",
      "publicId",
      "username",
    ]);
  });
});

describe("GET /friends contract", () => {
  it("accepts a paged response", () => {
    const payload = {
      results: [toFriendEntry(row(), new Date())],
      total: 42,
      page: 2,
      limit: 20,
    };
    expect(FriendsListResponseSchema.safeParse(payload).success).toBe(true);
  });

  it("accepts an empty page past the end", () => {
    expect(
      FriendsListResponseSchema.safeParse({
        results: [],
        total: 3,
        page: 9,
        limit: 20,
      }).success,
    ).toBe(true);
  });

  it("rejects a response without paging metadata", () => {
    expect(FriendsListResponseSchema.safeParse({ results: [] }).success).toBe(
      false,
    );
  });
});

describe("POST /friends/requests/:publicId contract", () => {
  /** Both statuses the send route can return must satisfy the client. */
  it("accepts both the requested and accepted outcomes", () => {
    for (const status of ["requested", "accepted"] as const) {
      expect(
        SendFriendRequestResponseSchema.safeParse({ status }).success,
      ).toBe(true);
    }
  });

  it("rejects an invented status", () => {
    expect(
      SendFriendRequestResponseSchema.safeParse({ status: "pending" }).success,
    ).toBe(false);
  });
});

describe("paging clamps", () => {
  it("defaults junk to the first page", () => {
    expect(normalizePaging(undefined, undefined).page).toBe(1);
    expect(normalizePaging("abc", "abc").page).toBe(1);
    expect(normalizePaging(0, 20).page).toBe(1);
    expect(normalizePaging(-5, 20).page).toBe(1);
  });

  it("passes sane values through, including string query params", () => {
    // Query params arrive as strings, which is the only form the route sees.
    expect(normalizePaging("3", "10")).toEqual({ page: 3, limit: 10 });
  });

  /** An unbounded limit would let one request read the whole table. */
  it("caps the limit", () => {
    expect(normalizePaging(1, 100_000).limit).toBe(FRIENDS_PAGE_LIMIT_MAX);
  });

  it("never yields a fractional page or limit", () => {
    const { page, limit } = normalizePaging(2.7, 10.9);
    expect(Number.isInteger(page)).toBe(true);
    expect(Number.isInteger(limit)).toBe(true);
  });
});
