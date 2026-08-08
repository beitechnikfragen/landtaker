import { describe, expect, it } from "vitest";
import {
  alreadyOwns,
  flareFor,
  hashSeed,
  pickForRotation,
  purchaseRefusal,
  ROTATION_EPOCH,
  rotationWindow,
} from "./shop.ts";

/**
 * The shop spends currency and grants entitlements, so the rules that decide
 * both are tested exhaustively. All pure functions — the suite has no Postgres,
 * and a rotation boundary or an ownership check that is only exercised against
 * a live database is one that is not exercised.
 */

describe("flareFor", () => {
  it("keys patterns by name AND palette, as the client does", () => {
    // Cosmetics.ts builds `pattern:<name>:<palette>`; a mismatch here means a
    // purchase debits currency and grants nothing.
    expect(flareFor("pattern", "waves", "ocean")).toBe("pattern:waves:ocean");
  });

  it("defaults the palette segment rather than omitting it", () => {
    expect(flareFor("pattern", "waves")).toBe("pattern:waves:default");
  });

  it("keys every other kind by name alone", () => {
    expect(flareFor("flag", "de")).toBe("flag:de");
    expect(flareFor("crown", "gold")).toBe("crown:gold");
    expect(flareFor("skin", "winter")).toBe("skin:winter");
    expect(flareFor("effect", "sparkle")).toBe("effect:sparkle");
  });
});

describe("alreadyOwns", () => {
  it("recognises an exact flare", () => {
    expect(alreadyOwns(["flag:de"], "flag", "flag:de")).toBe(true);
  });

  it("recognises the per-kind wildcard", () => {
    // "flag:*" is how a staff/bundle grant covers everything of a kind.
    expect(alreadyOwns(["flag:*"], "flag", "flag:de")).toBe(true);
  });

  it("does not let one kind's wildcard cover another", () => {
    expect(alreadyOwns(["flag:*"], "crown", "crown:gold")).toBe(false);
  });

  it("is false for an empty flare list", () => {
    expect(alreadyOwns([], "flag", "flag:de")).toBe(false);
  });
});

describe("rotationWindow", () => {
  it("aligns to the epoch, not to the current time", () => {
    // Anchored windows mean a restart cannot shift everyone's drop schedule.
    const now = new Date(ROTATION_EPOCH + 90 * 60 * 1000); // +1h30m
    const w = rotationWindow(now, 6);
    expect(w.startsAt.getTime()).toBe(ROTATION_EPOCH);
    expect(w.endsAt.getTime()).toBe(ROTATION_EPOCH + 6 * 60 * 60 * 1000);
  });

  it("rolls over exactly on the boundary", () => {
    const sixHours = 6 * 60 * 60 * 1000;
    const justBefore = new Date(ROTATION_EPOCH + sixHours - 1);
    const exactly = new Date(ROTATION_EPOCH + sixHours);

    expect(rotationWindow(justBefore, 6).startsAt.getTime()).toBe(
      ROTATION_EPOCH,
    );
    expect(rotationWindow(exactly, 6).startsAt.getTime()).toBe(
      ROTATION_EPOCH + sixHours,
    );
  });

  it("honours a different cadence", () => {
    const now = new Date(ROTATION_EPOCH + 3 * 60 * 60 * 1000);
    expect(rotationWindow(now, 1).startsAt.getTime()).toBe(
      ROTATION_EPOCH + 3 * 60 * 60 * 1000,
    );
    expect(rotationWindow(now, 24).startsAt.getTime()).toBe(ROTATION_EPOCH);
  });

  it("still lands on a boundary before the epoch", () => {
    // Math.floor on a negative elapsed must round down, not toward zero, or
    // the window would cover the wrong span.
    const before = new Date(ROTATION_EPOCH - 60 * 1000);
    const w = rotationWindow(before, 6);
    expect(w.startsAt.getTime()).toBe(ROTATION_EPOCH - 6 * 60 * 60 * 1000);
    expect(w.endsAt.getTime()).toBe(ROTATION_EPOCH);
    expect(w.startsAt.getTime()).toBeLessThanOrEqual(before.getTime());
    expect(w.endsAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it("always produces a window containing the instant asked about", () => {
    for (const offsetHours of [0, 0.5, 5.99, 6, 100, 1000]) {
      const now = new Date(ROTATION_EPOCH + offsetHours * 60 * 60 * 1000);
      const w = rotationWindow(now, 6);
      expect(w.startsAt.getTime()).toBeLessThanOrEqual(now.getTime());
      expect(w.endsAt.getTime()).toBeGreaterThan(now.getTime());
    }
  });
});

describe("pickForRotation", () => {
  const pool = ["a", "b", "c", "d", "e", "f", "g", "h"];

  it("is deterministic for a seed", () => {
    // A player refreshing the shop must not see the lineup change, and two
    // instances must agree without coordinating.
    expect(pickForRotation(pool, 4, 12345)).toEqual(
      pickForRotation(pool, 4, 12345),
    );
  });

  it("differs between seeds", () => {
    const a = pickForRotation(pool, 4, 1);
    const b = pickForRotation(pool, 4, 999);
    expect(a).not.toEqual(b);
  });

  it("never repeats an item within a drop", () => {
    const picked = pickForRotation(pool, 8, 42);
    expect(new Set(picked).size).toBe(picked.length);
  });

  it("returns the whole pool when asked for more than exists", () => {
    expect(pickForRotation(pool, 100, 7)).toHaveLength(pool.length);
  });

  it("handles empty pools and non-positive counts", () => {
    expect(pickForRotation([], 4, 1)).toEqual([]);
    expect(pickForRotation(pool, 0, 1)).toEqual([]);
    expect(pickForRotation(pool, -1, 1)).toEqual([]);
  });

  it("does not mutate the caller's pool", () => {
    const original = [...pool];
    pickForRotation(pool, 3, 5);
    expect(pool).toEqual(original);
  });

  it("tolerates a zero seed", () => {
    // hashSeed can in principle return 0; an LCG seeded with 0 would be stuck.
    expect(pickForRotation(pool, 3, 0)).toHaveLength(3);
  });
});

describe("hashSeed", () => {
  it("is stable for the same input", () => {
    expect(hashSeed("2026-01-01T00:00:00.000Z")).toBe(
      hashSeed("2026-01-01T00:00:00.000Z"),
    );
  });

  it("differs across windows", () => {
    expect(hashSeed("2026-01-01T00:00:00.000Z")).not.toBe(
      hashSeed("2026-01-01T06:00:00.000Z"),
    );
  });
});

describe("purchaseRefusal", () => {
  const item = { priceSoft: 100, priceHard: 10, published: true };
  const base = {
    item,
    currencyType: "soft" as const,
    balance: 500,
    inRotation: true,
    owned: false,
  };

  it("allows a well-formed purchase", () => {
    expect(purchaseRefusal(base)).toBeNull();
  });

  it("refuses an unknown cosmetic", () => {
    expect(purchaseRefusal({ ...base, item: null })).toBe("no such cosmetic");
  });

  it("refuses an unpublished cosmetic", () => {
    // Staging state for a future drop — buyable would leak it early.
    expect(
      purchaseRefusal({ ...base, item: { ...item, published: false } }),
    ).toBe("cosmetic not available");
  });

  it("refuses something already owned", () => {
    expect(purchaseRefusal({ ...base, owned: true })).toBe("already owned");
  });

  it("refuses an item outside the current drop", () => {
    // The whole point of a rotation: yesterday's item is not on sale today.
    expect(purchaseRefusal({ ...base, inRotation: false })).toBe(
      "not in the current rotation",
    );
  });

  it("refuses a currency the item has no price in", () => {
    expect(
      purchaseRefusal({
        ...base,
        item: { ...item, priceSoft: null },
      }),
    ).toBe("not purchasable with soft currency");
  });

  it("refuses an insufficient balance", () => {
    expect(purchaseRefusal({ ...base, balance: 99 })).toBe(
      "insufficient currency",
    );
  });

  it("allows a balance exactly equal to the price", () => {
    expect(purchaseRefusal({ ...base, balance: 100 })).toBeNull();
  });

  it("checks the hard price when paying hard", () => {
    expect(
      purchaseRefusal({ ...base, currencyType: "hard", balance: 10 }),
    ).toBeNull();
    expect(purchaseRefusal({ ...base, currencyType: "hard", balance: 9 })).toBe(
      "insufficient currency",
    );
  });

  it("allows a free item priced at zero", () => {
    // 0 is falsy; a truthiness check on price would refuse this.
    expect(
      purchaseRefusal({
        ...base,
        item: { ...item, priceSoft: 0 },
        balance: 0,
      }),
    ).toBeNull();
  });

  it("checks ownership before rotation", () => {
    // Owning something no longer on sale should read as "already owned",
    // not the confusing "not in the current rotation".
    expect(purchaseRefusal({ ...base, owned: true, inRotation: false })).toBe(
      "already owned",
    );
  });
});
