import type { Cosmetics } from "@game/CosmeticSchemas.ts";
import { and, desc, eq, gt, lte, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import {
  cosmetics,
  shopConfig,
  shopPurchases,
  shopRotations,
  users,
} from "../db/schema.ts";

/**
 * Shop: the cosmetics catalog, the rotating drop window, and purchases.
 *
 * Entitlement is a flare string on the user — that is what the game reads
 * (src/client/Cosmetics.ts cosmeticRelationship). Everything here ultimately
 * exists to put the right flare on the right account.
 */

export const SHOP_CONFIG_ID = "default";
export const COSMETIC_KINDS = [
  "pattern",
  "flag",
  "crown",
  "skin",
  "effect",
] as const;
export type CosmeticKind = (typeof COSMETIC_KINDS)[number];

type CosmeticRow = typeof cosmetics.$inferSelect;

// ---------------------------------------------------------------------------
// Pure helpers
//
// Free of database access so the suite can exercise them — the backend has no
// Postgres in tests, and rotation timing plus purchase authorization are
// exactly the rules that must not be left unverified.
// ---------------------------------------------------------------------------

/**
 * The flare that grants ownership of an item.
 *
 * Must match what the client checks, or a purchase silently grants nothing:
 * patterns are keyed by name AND palette (Cosmetics.ts builds
 * `pattern:<name>:<palette>`), everything else by name alone.
 */
export function flareFor(
  kind: CosmeticKind,
  name: string,
  colorPaletteName?: string,
): string {
  if (kind === "pattern") {
    // The client always includes a palette segment, defaulting when unset.
    return `pattern:${name}:${colorPaletteName ?? "default"}`;
  }
  return `${kind}:${name}`;
}

/** Whether existing flares already grant this item (exact or wildcard). */
export function alreadyOwns(
  flares: readonly string[],
  kind: CosmeticKind,
  flare: string,
): boolean {
  return flares.includes(flare) || flares.includes(`${kind}:*`);
}

/**
 * Start of the rotation window containing `now`, aligned to a fixed epoch.
 *
 * Anchored rather than relative so every window boundary is predictable and
 * identical across restarts: a server restart must not shift the drop schedule
 * for everyone. The epoch is arbitrary but fixed.
 */
export const ROTATION_EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0, 0);

export function rotationWindow(
  now: Date,
  rotationHours: number,
): { startsAt: Date; endsAt: Date } {
  const periodMs = rotationHours * 60 * 60 * 1000;
  const elapsed = now.getTime() - ROTATION_EPOCH;
  // Floor toward negative infinity so dates before the epoch still land on a
  // boundary instead of rounding the wrong way.
  const index = Math.floor(elapsed / periodMs);
  const startsAt = new Date(ROTATION_EPOCH + index * periodMs);
  return { startsAt, endsAt: new Date(startsAt.getTime() + periodMs) };
}

/**
 * Deterministic 32-bit hash. Used to seed drop selection so a given window
 * always picks the same items — a player refreshing the shop must not see the
 * lineup change, and two backend instances must agree without coordinating.
 */
export function hashSeed(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Picks `count` items for a window, seeded so the choice is reproducible.
 *
 * A seeded shuffle rather than a random sample: sampling with replacement
 * could pick the same item twice, and an unseeded choice would differ between
 * instances and across restarts.
 */
export function pickForRotation<T>(
  pool: readonly T[],
  count: number,
  seed: number,
): T[] {
  if (count <= 0 || pool.length === 0) return [];
  const items = [...pool];
  // Fisher-Yates driven by a small LCG seeded from the window.
  let state = seed || 1;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items.slice(0, Math.min(count, items.length));
}

/**
 * Why a purchase must be refused, or null if it may proceed.
 *
 * Returned as a reason string rather than a boolean so the route can answer
 * something the player can act on ("not enough currency" vs "not in this
 * drop") instead of a bare 400.
 */
export function purchaseRefusal(args: {
  item: Pick<CosmeticRow, "priceSoft" | "priceHard" | "published"> | null;
  currencyType: "soft" | "hard";
  balance: number;
  inRotation: boolean;
  owned: boolean;
}): string | null {
  const { item, currencyType, balance, inRotation, owned } = args;
  if (item === null) return "no such cosmetic";
  if (!item.published) return "cosmetic not available";
  if (owned) return "already owned";
  if (!inRotation) return "not in the current rotation";

  const price = currencyType === "soft" ? item.priceSoft : item.priceHard;
  if (price === null || price === undefined) {
    return `not purchasable with ${currencyType} currency`;
  }
  if (balance < price) return "insufficient currency";
  return null;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * Assembles GET /cosmetics.json from the published catalog.
 *
 * `patterns` and `flags` are required by CosmeticsSchema even when empty, so
 * they are always present; the rest are omitted when empty rather than sent as
 * `{}`, matching how the schema treats absence.
 */
export async function buildCosmeticsCatalog(): Promise<Cosmetics> {
  const rows = await db
    .select()
    .from(cosmetics)
    .where(eq(cosmetics.published, true));

  const catalog: Record<string, Record<string, unknown>> = {
    patterns: {},
    flags: {},
    crowns: {},
    skins: {},
  };
  // Effects nest one level deeper: effects[effectType][name].
  const effects: Record<string, Record<string, unknown>> = {};

  for (const row of rows) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const base = {
      name: row.name,
      ...(row.displayName ? { displayName: row.displayName } : {}),
      ...(row.rarity ? { rarity: row.rarity } : {}),
      ...(row.artist ? { artist: row.artist } : {}),
      ...(row.priceSoft !== null ? { priceSoft: row.priceSoft } : {}),
      ...(row.priceHard !== null ? { priceHard: row.priceHard } : {}),
      ...payload,
    };

    if (row.kind === "effect") {
      // effectType lives in the payload; without it the effect cannot be
      // slotted, so skip rather than emit an unplaceable entry.
      const effectType = payload.effectType;
      if (typeof effectType !== "string") continue;
      effects[effectType] ??= {};
      effects[effectType][row.name] = base;
      continue;
    }

    const bucket =
      row.kind === "pattern"
        ? "patterns"
        : row.kind === "flag"
          ? "flags"
          : row.kind === "crown"
            ? "crowns"
            : row.kind === "skin"
              ? "skins"
              : null;
    if (bucket === null) continue;
    catalog[bucket][row.name] = base;
  }

  const result: Record<string, unknown> = {
    patterns: catalog.patterns,
    flags: catalog.flags,
  };
  if (Object.keys(catalog.crowns).length > 0) result.crowns = catalog.crowns;
  if (Object.keys(catalog.skins).length > 0) result.skins = catalog.skins;
  if (Object.keys(effects).length > 0) result.effects = effects;

  return result as Cosmetics;
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

export async function getShopConfig(): Promise<{
  rotationHours: number;
  itemsPerRotation: number;
}> {
  const row = await db.query.shopConfig.findFirst({
    where: eq(shopConfig.id, SHOP_CONFIG_ID),
  });
  // Defaults mirror the column defaults so a missing row behaves like a fresh
  // install rather than throwing.
  return {
    rotationHours: row?.rotationHours ?? 6,
    itemsPerRotation: row?.itemsPerRotation ?? 4,
  };
}

/**
 * The drop that is live at `now`, creating it if the window has rolled over.
 *
 * Generated on demand rather than by a scheduler: with the window derived from
 * a fixed epoch, the first request after a boundary produces exactly the same
 * lineup any scheduler would have, and there is no background job to fail
 * silently.
 */
export async function getOrCreateCurrentRotation(now = new Date()): Promise<{
  startsAt: Date;
  endsAt: Date;
  cosmeticIds: string[];
}> {
  const config = await getShopConfig();
  const window = rotationWindow(now, config.rotationHours);

  const existing = await db.query.shopRotations.findFirst({
    where: and(lte(shopRotations.startsAt, now), gt(shopRotations.endsAt, now)),
    orderBy: desc(shopRotations.startsAt),
  });
  if (existing) {
    return {
      startsAt: existing.startsAt,
      endsAt: existing.endsAt,
      cosmeticIds: existing.cosmeticIds,
    };
  }

  const pool = await db
    .select({ id: cosmetics.id })
    .from(cosmetics)
    .where(eq(cosmetics.published, true))
    .orderBy(cosmetics.id);

  const picked = pickForRotation(
    pool.map((row) => row.id),
    config.itemsPerRotation,
    hashSeed(window.startsAt.toISOString()),
  );

  const [created] = await db
    .insert(shopRotations)
    .values({
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      cosmeticIds: picked,
    })
    // Two requests can race across a window boundary; the unique index on
    // startsAt means the first wins and the second falls through to read its
    // row rather than inserting a second, different lineup for the same window.
    .onConflictDoNothing({ target: shopRotations.startsAt })
    .returning();

  if (created) {
    return {
      startsAt: created.startsAt,
      endsAt: created.endsAt,
      cosmeticIds: created.cosmeticIds,
    };
  }

  const winner = await db.query.shopRotations.findFirst({
    where: and(lte(shopRotations.startsAt, now), gt(shopRotations.endsAt, now)),
    orderBy: desc(shopRotations.startsAt),
  });
  return {
    startsAt: winner?.startsAt ?? window.startsAt,
    endsAt: winner?.endsAt ?? window.endsAt,
    cosmeticIds: winner?.cosmeticIds ?? picked,
  };
}

// ---------------------------------------------------------------------------
// Purchase
// ---------------------------------------------------------------------------

export type PurchaseResult =
  | { ok: true; flare: string; balance: number }
  | { ok: false; reason: string };

/**
 * Buys a cosmetic with soft or hard currency.
 *
 * The balance check and the debit happen in one transaction with a guarded
 * UPDATE: two concurrent purchases on the same account must not both pass a
 * check that only one balance can satisfy. The flare append is in the same
 * transaction, so a debit can never land without the entitlement it paid for.
 */
export async function purchaseCosmetic(args: {
  userId: string;
  kind: CosmeticKind;
  name: string;
  currencyType: "soft" | "hard";
  colorPaletteName?: string;
  now?: Date;
}): Promise<PurchaseResult> {
  const { userId, kind, name, currencyType } = args;
  const now = args.now ?? new Date();

  const item = await db.query.cosmetics.findFirst({
    where: and(eq(cosmetics.kind, kind), eq(cosmetics.name, name)),
  });

  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { flares: true, currencySoft: true, currencyHard: true },
  });
  if (!user) return { ok: false, reason: "no such user" };

  const flare = flareFor(kind, name, args.colorPaletteName);
  const rotation = await getOrCreateCurrentRotation(now);
  const balance =
    currencyType === "soft" ? user.currencySoft : user.currencyHard;

  const refusal = purchaseRefusal({
    item: item ?? null,
    currencyType,
    balance,
    inRotation: item ? rotation.cosmeticIds.includes(item.id) : false,
    owned: alreadyOwns(user.flares ?? [], kind, flare),
  });
  if (refusal !== null) return { ok: false, reason: refusal };

  const price =
    (currencyType === "soft" ? item!.priceSoft : item!.priceHard) ?? 0;
  const column = currencyType === "soft" ? "currency_soft" : "currency_hard";

  return await db.transaction(async (tx) => {
    // The WHERE clause re-checks the balance at write time. Without it, two
    // requests could both read a sufficient balance and both debit.
    const debited = await tx
      .update(users)
      .set({
        [currencyType === "soft" ? "currencySoft" : "currencyHard"]:
          sql`${sql.identifier(column)} - ${price}`,
        // array_append is atomic and avoids read-modify-write on the flare
        // list, which would drop a concurrent grant from the admin panel.
        flares: sql`array_append(coalesce(${users.flares}, '{}'), ${flare})`,
      })
      .where(
        and(
          eq(users.id, userId),
          sql`${sql.identifier(column)} >= ${price}`,
          // Re-check ownership too: a double-clicked purchase must not append
          // the same flare twice and charge for it twice.
          sql`not (coalesce(${users.flares}, '{}') @> array[${flare}]::text[])`,
        ),
      )
      .returning({
        soft: users.currencySoft,
        hard: users.currencyHard,
      });

    if (debited.length === 0) {
      // Lost the race, or the balance moved between the check and the write.
      return { ok: false, reason: "purchase could not be completed" };
    }

    await tx.insert(shopPurchases).values({
      userId,
      cosmeticId: item!.id,
      flare,
      currencyType,
      pricePaid: price,
    });

    return {
      ok: true,
      flare,
      balance: currencyType === "soft" ? debited[0].soft : debited[0].hard,
    };
  });
}
