import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/index.ts";
import { cosmetics } from "../db/schema.ts";
import { requireAuth } from "../plugins/auth.ts";
import {
  buildCosmeticsCatalog,
  COSMETIC_KINDS,
  getOrCreateCurrentRotation,
  purchaseCosmetic,
} from "../services/shop.ts";

/**
 * Player-facing shop routes: the catalog, the live drop, and buying.
 *
 * Admin CRUD over the same data lives in routes/admin.ts behind requireAdmin.
 */
export async function registerShopRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /cosmetics.json — the catalog the client parses with CosmeticsSchema.
   *
   * Cached for a minute: it changes only when an admin edits an item, and the
   * client re-fetches on its own schedule. The drop rotation is NOT in here —
   * it lives at /shop/rotation so a rotation flip is not delayed by this cache.
   */
  app.get("/cosmetics.json", async (_request, reply) => {
    const catalog = await buildCosmeticsCatalog();
    return reply.header("cache-control", "public, max-age=60").send(catalog);
  });

  /**
   * GET /shop/rotation — which items are on sale, and when the drop ends.
   *
   * Uncached. A player who loads this as a window closes must see the same
   * lineup the purchase endpoint will enforce; a stale cache would show items
   * that no longer sell.
   */
  app.get("/shop/rotation", async (_request, reply) => {
    const rotation = await getOrCreateCurrentRotation();

    const items =
      rotation.cosmeticIds.length === 0
        ? []
        : await db
            .select({
              kind: cosmetics.kind,
              name: cosmetics.name,
              displayName: cosmetics.displayName,
              rarity: cosmetics.rarity,
              priceSoft: cosmetics.priceSoft,
              priceHard: cosmetics.priceHard,
            })
            .from(cosmetics)
            .where(inArray(cosmetics.id, rotation.cosmeticIds));

    return reply.header("cache-control", "no-store").send({
      startsAt: rotation.startsAt.toISOString(),
      endsAt: rotation.endsAt.toISOString(),
      items,
    });
  });

  /**
   * POST /shop/purchase — buy a cosmetic with soft or hard currency.
   *
   * The body shape is fixed by the client (Api.ts purchaseWithCurrency), which
   * already sends exactly these fields.
   */
  app.post(
    "/shop/purchase",
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = z
        .object({
          cosmeticType: z.enum(COSMETIC_KINDS),
          cosmeticName: z.string().min(1).max(200),
          currencyType: z.enum(["soft", "hard"]),
          colorPaletteName: z.string().max(200).optional(),
        })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid purchase request" });
      }

      const result = await purchaseCosmetic({
        userId: request.userId!,
        kind: parsed.data.cosmeticType,
        name: parsed.data.cosmeticName,
        currencyType: parsed.data.currencyType,
        colorPaletteName: parsed.data.colorPaletteName,
      });

      if (!result.ok) {
        // 409 rather than 400: the request was well-formed, the account state
        // just does not permit it (owned already, too poor, not on sale).
        return reply.code(409).send({ error: result.reason });
      }

      return reply.send({ flare: result.flare, balance: result.balance });
    },
  );

  /**
   * GET /shop/purchases — the caller's own purchase history.
   */
  app.get(
    "/shop/purchases",
    { preHandler: requireAuth },
    async (request, reply) => {
      const rows = await db.query.shopPurchases.findMany({
        where: (p, { eq: is }) => is(p.userId, request.userId!),
        orderBy: (p, { desc }) => desc(p.createdAt),
        limit: 100,
      });
      return reply.send({
        purchases: rows.map((row) => ({
          flare: row.flare,
          currencyType: row.currencyType,
          pricePaid: row.pricePaid,
          createdAt: row.createdAt.toISOString(),
        })),
      });
    },
  );
}

/** Shared by the admin cosmetics routes; exported so both validate identically. */
export const CosmeticUpsertSchema = z.object({
  kind: z.enum(COSMETIC_KINDS),
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    // The name is embedded in a flare ("flag:<name>"), where ":" is the
    // separator — allowing it would make ownership strings ambiguous.
    .refine((v) => !v.includes(":"), {
      message: "Name cannot contain ':'",
    }),
  displayName: z.string().trim().max(200).nullable().optional(),
  rarity: z.string().trim().max(50).nullable().optional(),
  artist: z.string().trim().max(200).nullable().optional(),
  priceSoft: z.number().int().min(0).max(10_000_000).nullable().optional(),
  priceHard: z.number().int().min(0).max(10_000_000).nullable().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  published: z.boolean().optional(),
});

/** Looks a cosmetic up by its natural key, for the admin routes. */
export async function findCosmetic(kind: string, name: string) {
  return db.query.cosmetics.findFirst({
    where: and(eq(cosmetics.kind, kind), eq(cosmetics.name, name)),
  });
}
