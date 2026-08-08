import {
  AdminBanCreateSchema,
  AdminCreditAdjustSchema,
  AdminUserPatchSchema,
  AdminUserQuerySchema,
  AssignableRoleSchema,
} from "@game/AdminApiSchemas.ts";
import { describe, expect, it } from "vitest";
import {
  banExpiresAt,
  buildUserUpdate,
  clampCredits,
  isUuid,
  mayAssignRole,
  normalizeFlares,
  roleChangeRefusal,
} from "./admin.ts";

/**
 * The admin routes are the only place in the backend that can escalate
 * privilege, so the ladder gets tested exhaustively. Everything here is a pure
 * function precisely so it can be: the suite has no Postgres, and an
 * authorization rule that is only exercised against a live database is a rule
 * that is not exercised.
 */

describe("mayAssignRole", () => {
  it("lets root assign any panel-assignable role", () => {
    for (const role of AssignableRoleSchema.options) {
      expect(mayAssignRole("root", role)).toBe(true);
    }
    expect(mayAssignRole("root", null)).toBe(true);
  });

  it("refuses root even to root — bootstrapping a second root is a DB write", () => {
    expect(mayAssignRole("root", "root")).toBe(false);
    expect(mayAssignRole("admin", "root")).toBe(false);
  });

  it("refuses admin-grants-admin, which would break the one-way ladder", () => {
    // An admin who can mint another admin can mint a spare account and use it
    // to undo their own demotion.
    expect(mayAssignRole("admin", "admin")).toBe(false);
  });

  it("lets an admin assign the moderation roles", () => {
    expect(mayAssignRole("admin", "mod")).toBe(true);
    expect(mayAssignRole("admin", "flagged")).toBe(true);
    expect(mayAssignRole("admin", "banned")).toBe(true);
    expect(mayAssignRole("admin", null)).toBe(true);
  });
});

describe("roleChangeRefusal", () => {
  const base = {
    actorId: "actor-1",
    actorRole: "admin" as string | null,
    targetId: "target-1",
    targetCurrentRole: null as string | null,
    nextRole: "mod" as string | null,
  };

  it("allows an ordinary promotion to mod by an admin", () => {
    expect(roleChangeRefusal(base)).toBeNull();
  });

  it("refuses changing your own role", () => {
    // Locking yourself out needs a database write to recover from.
    expect(
      roleChangeRefusal({ ...base, targetId: base.actorId, nextRole: null }),
    ).toBe("You cannot change your own role");
  });

  it("allows a no-op patch of your own role", () => {
    // The panel may resend the current value; only an actual change is refused.
    expect(
      roleChangeRefusal({
        ...base,
        targetId: base.actorId,
        actorRole: "admin",
        nextRole: "admin",
      }),
    ).toBeNull();
  });

  it("refuses an admin touching a root account", () => {
    expect(
      roleChangeRefusal({ ...base, targetCurrentRole: "root", nextRole: null }),
    ).toBe("Only root may modify a root account");
  });

  it("refuses an admin demoting another admin", () => {
    expect(
      roleChangeRefusal({
        ...base,
        targetCurrentRole: "admin",
        nextRole: null,
      }),
    ).toBe("Only root may demote an admin");
  });

  it("lets root demote an admin", () => {
    expect(
      roleChangeRefusal({
        ...base,
        actorRole: "root",
        targetCurrentRole: "admin",
        nextRole: null,
      }),
    ).toBeNull();
  });

  it("refuses an admin granting admin", () => {
    expect(roleChangeRefusal({ ...base, nextRole: "admin" })).toBe(
      "Only root may grant the admin role",
    );
  });

  it("refuses assigning root through the API", () => {
    expect(
      roleChangeRefusal({ ...base, actorRole: "root", nextRole: "root" }),
    ).toBe("The root role cannot be assigned through the panel");
  });

  it("treats a null actor role as unprivileged", () => {
    // Defence in depth: requireAdmin should have rejected this caller already.
    expect(
      roleChangeRefusal({ ...base, actorRole: null, nextRole: "admin" }),
    ).toBe("Only root may grant the admin role");
  });
});

describe("clampCredits", () => {
  it("adds and subtracts", () => {
    expect(clampCredits(100, 50)).toBe(150);
    expect(clampCredits(100, -50)).toBe(50);
  });

  it("floors at zero rather than going negative", () => {
    expect(clampCredits(10, -50)).toBe(0);
  });

  it("caps at the ceiling instead of rejecting the grant", () => {
    expect(clampCredits(999, 50, 1000)).toBe(1000);
  });

  it("leaves an in-range balance exactly where the arithmetic puts it", () => {
    expect(clampCredits(0, 0)).toBe(0);
    expect(clampCredits(1, -1)).toBe(0);
  });
});

describe("banExpiresAt", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");

  it("treats null and undefined as permanent", () => {
    expect(banExpiresAt(null, now)).toBeNull();
    expect(banExpiresAt(undefined, now)).toBeNull();
  });

  it("adds the duration in hours", () => {
    expect(banExpiresAt(24, now)?.toISOString()).toBe(
      "2026-01-02T00:00:00.000Z",
    );
    expect(banExpiresAt(1, now)?.toISOString()).toBe(
      "2026-01-01T01:00:00.000Z",
    );
  });
});

describe("normalizeFlares", () => {
  it("drops duplicates but keeps first-seen order", () => {
    expect(normalizeFlares(["b", "a", "b"])).toEqual(["b", "a"]);
  });

  it("trims and drops empties", () => {
    expect(normalizeFlares([" pattern:x ", "", "   "])).toEqual(["pattern:x"]);
  });

  it("collapses entries that differ only by surrounding whitespace", () => {
    // Ownership checks compare exact strings, so " flag:de" and "flag:de"
    // would otherwise both sit in the column meaning the same thing.
    expect(normalizeFlares(["flag:de", " flag:de"])).toEqual(["flag:de"]);
  });
});

describe("buildUserUpdate", () => {
  it("includes only the keys the caller sent", () => {
    expect(buildUserUpdate({ credits: 5 })).toEqual({ credits: 5 });
  });

  it("distinguishes an omitted role from a null one", () => {
    // Omitted means "leave alone"; null means "clear back to ordinary player".
    expect(buildUserUpdate({ credits: 1 })).not.toHaveProperty("role");
    expect(buildUserUpdate({ role: null })).toEqual({ role: null });
  });

  it("normalizes flares on the way through", () => {
    expect(buildUserUpdate({ flares: ["a", "a", " b "] })).toEqual({
      flares: ["a", "b"],
    });
  });

  it("passes booleans through including false", () => {
    // `false` is falsy; an `if (patch.adfree)` here would silently drop revokes.
    expect(buildUserUpdate({ adfree: false })).toEqual({ adfree: false });
    expect(buildUserUpdate({ unlimitedRanked: false })).toEqual({
      unlimitedRanked: false,
    });
    expect(buildUserUpdate({ canCreatePublicLobbies: false })).toEqual({
      canCreatePublicLobbies: false,
    });
  });

  it("passes zero credits through", () => {
    // Same trap as above: 0 is falsy but is a legitimate balance to set.
    expect(buildUserUpdate({ credits: 0 })).toEqual({ credits: 0 });
  });
});

describe("isUuid", () => {
  it("accepts a canonical uuid in either case", () => {
    expect(isUuid("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    expect(isUuid("123E4567-E89B-12D3-A456-426614174000")).toBe(true);
  });

  it("rejects search terms that merely look id-ish", () => {
    expect(isUuid("Boss")).toBe(false);
    expect(isUuid("123e4567e89b12d3a456426614174000")).toBe(false);
    expect(isUuid("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wire contracts
// ---------------------------------------------------------------------------

describe("AdminUserPatchSchema", () => {
  it("rejects an empty patch", () => {
    // A patch that changes nothing is a client bug; 200 would hide it.
    expect(AdminUserPatchSchema.safeParse({}).success).toBe(false);
  });

  it("accepts a null role as an explicit clear", () => {
    expect(AdminUserPatchSchema.safeParse({ role: null }).success).toBe(true);
  });

  it("refuses root as an assignable value", () => {
    expect(AdminUserPatchSchema.safeParse({ role: "root" }).success).toBe(
      false,
    );
  });

  it("refuses negative credits", () => {
    expect(AdminUserPatchSchema.safeParse({ credits: -1 }).success).toBe(false);
  });

  it("refuses fractional credits", () => {
    expect(AdminUserPatchSchema.safeParse({ credits: 1.5 }).success).toBe(
      false,
    );
  });
});

describe("AdminCreditAdjustSchema", () => {
  it("requires a reason", () => {
    expect(AdminCreditAdjustSchema.safeParse({ delta: 100 }).success).toBe(
      false,
    );
    expect(
      AdminCreditAdjustSchema.safeParse({ delta: 100, reason: "  " }).success,
    ).toBe(false);
  });

  it("accepts a negative delta", () => {
    expect(
      AdminCreditAdjustSchema.safeParse({ delta: -50, reason: "refund" })
        .success,
    ).toBe(true);
  });
});

describe("AdminBanCreateSchema", () => {
  it("defaults to permanent when no duration is given", () => {
    const parsed = AdminBanCreateSchema.safeParse({ category: "cheating" });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.durationHours).toBeUndefined();
  });

  it("requires a category", () => {
    expect(AdminBanCreateSchema.safeParse({}).success).toBe(false);
    expect(AdminBanCreateSchema.safeParse({ category: " " }).success).toBe(
      false,
    );
  });

  it("refuses a zero or negative duration", () => {
    expect(
      AdminBanCreateSchema.safeParse({ category: "x", durationHours: 0 })
        .success,
    ).toBe(false);
  });
});

describe("AdminUserQuerySchema", () => {
  it("applies defaults for an empty query", () => {
    const parsed = AdminUserQuerySchema.parse({});
    expect(parsed.limit).toBe(50);
    expect(parsed.offset).toBe(0);
  });

  it("coerces the numeric params that arrive as query strings", () => {
    const parsed = AdminUserQuerySchema.parse({ limit: "10", offset: "20" });
    expect(parsed.limit).toBe(10);
    expect(parsed.offset).toBe(20);
  });

  it("caps limit so a caller cannot ask for the whole table", () => {
    expect(AdminUserQuerySchema.safeParse({ limit: "1000" }).success).toBe(
      false,
    );
  });
});
