import {
  AdminBanCreateSchema,
  AdminCreditAdjustSchema,
  AdminUserPatchSchema,
  AdminUserQuerySchema,
} from "@game/AdminApiSchemas.ts";
import { and, count, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/index.ts";
import {
  bans,
  cosmetics,
  shopConfig,
  shopPurchases,
  shopRotations,
  users,
} from "../db/schema.ts";
import { requireAdmin } from "../plugins/auth.ts";
import {
  banExpiresAt,
  buildUserUpdate,
  clampCredits,
  getUserDetail,
  listAudit,
  listUsers,
  recordAudit,
  roleChangeRefusal,
} from "../services/admin.ts";
import {
  getOrCreateCurrentRotation,
  getShopConfig,
  SHOP_CONFIG_ID,
} from "../services/shop.ts";
import { resolveDisplayUsername } from "../services/users.ts";
import { CosmeticUpsertSchema, findCosmetic } from "./shop.ts";

/**
 * Admin panel API. Every route is behind `requireAdmin`, which re-reads the
 * caller's role from the database rather than trusting the token claim — see
 * plugins/auth.ts for why.
 *
 * Mutations write an audit entry. That is not optional bookkeeping: these
 * routes move credits and change roles, and the log is the only way to
 * reconstruct who did what.
 */
export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  /** Identifies the caller for the audit log without a second round trip. */
  async function actorName(userId: string): Promise<string | null> {
    const actor = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        usernameBase: true,
        usernameDiscriminator: true,
        usernameStatus: true,
        email: true,
      },
    });
    if (!actor) return null;
    return resolveDisplayUsername(actor) ?? actor.email ?? null;
  }

  /**
   * GET /admin/users — the searchable user table.
   */
  app.get(
    "/admin/users",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const parsed = AdminUserQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid query" });
      }
      return reply.send(await listUsers(parsed.data));
    },
  );

  /**
   * GET /admin/users/:id — one account in full, including ban history and
   * linked identities.
   */
  app.get<{ Params: { id: string } }>(
    "/admin/users/:id",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const detail = await getUserDetail(request.params.id);
      if (!detail) return reply.code(404).send({ error: "User not found" });
      return reply.send(detail);
    },
  );

  /**
   * PATCH /admin/users/:id — edit entitlements, role, credits, flares.
   *
   * Role changes are checked separately and more strictly than the rest: they
   * are the only field that can escalate privilege.
   */
  app.patch<{ Params: { id: string } }>(
    "/admin/users/:id",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const parsed = AdminUserPatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: parsed.error.issues[0]?.message ?? "Invalid patch" });
      }
      const patch = parsed.data;
      const targetId = request.params.id;

      const target = await db.query.users.findFirst({
        where: eq(users.id, targetId),
      });
      if (!target) return reply.code(404).send({ error: "User not found" });

      if ("role" in patch) {
        const refusal = roleChangeRefusal({
          actorId: request.userId!,
          actorRole: request.userRole,
          targetId,
          targetCurrentRole: target.role,
          nextRole: patch.role ?? null,
        });
        if (refusal) return reply.code(403).send({ error: refusal });
      }

      const update = buildUserUpdate(patch);
      await db.update(users).set(update).where(eq(users.id, targetId));

      // `before` is limited to the keys actually changed — logging the whole
      // row would bury the change and copy email addresses into the log.
      const before: Record<string, unknown> = {};
      for (const key of Object.keys(update)) {
        before[key] = (target as Record<string, unknown>)[key];
      }

      await recordAudit({
        actorId: request.userId!,
        actorName: await actorName(request.userId!),
        action: "user.update",
        targetId,
        detail: { before, after: update },
        log: request.log,
      });

      return reply.send(await getUserDetail(targetId));
    },
  );

  /**
   * POST /admin/users/:id/credits — grant or deduct credits.
   *
   * A delta, not an absolute: two concurrent +100 grants must total +200. An
   * absolute PATCH would silently drop one of them.
   */
  app.post<{ Params: { id: string } }>(
    "/admin/users/:id/credits",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const parsed = AdminCreditAdjustSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
      }
      const { delta, reason } = parsed.data;
      const targetId = request.params.id;

      const target = await db.query.users.findFirst({
        where: eq(users.id, targetId),
        columns: { credits: true },
      });
      if (!target) return reply.code(404).send({ error: "User not found" });

      const next = clampCredits(target.credits, delta);
      await db
        .update(users)
        .set({ credits: next })
        .where(eq(users.id, targetId));

      await recordAudit({
        actorId: request.userId!,
        actorName: await actorName(request.userId!),
        action: "user.credits",
        targetId,
        detail: { delta, reason, before: target.credits, after: next },
        log: request.log,
      });

      return reply.send({ credits: next });
    },
  );

  /**
   * POST /admin/users/:id/bans — issue a ban.
   *
   * The game server reads bans through /join_verify and refuses the connection
   * (Worker.ts), so this takes effect on the player's next join rather than
   * mid-match. Kicking someone out of a live game is the in-game admin menu's
   * job, not this one's.
   */
  app.post<{ Params: { id: string } }>(
    "/admin/users/:id/bans",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const parsed = AdminBanCreateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
      }
      const targetId = request.params.id;

      const target = await db.query.users.findFirst({
        where: eq(users.id, targetId),
        columns: { id: true, role: true },
      });
      if (!target) return reply.code(404).send({ error: "User not found" });

      // Banning yourself out of the panel, or an admin banning their way past
      // the role ladder, are both refused for the same reason role changes are.
      if (targetId === request.userId) {
        return reply.code(403).send({ error: "You cannot ban yourself" });
      }
      if (
        (target.role === "root" || target.role === "admin") &&
        request.userRole !== "root"
      ) {
        return reply
          .code(403)
          .send({ error: "Only root may ban an admin account" });
      }

      const expiresAt = banExpiresAt(parsed.data.durationHours, new Date());
      const [created] = await db
        .insert(bans)
        .values({
          userId: targetId,
          category: parsed.data.category,
          reason: parsed.data.reason ?? null,
          expiresAt,
          createdBy: request.userId!,
        })
        .returning();

      await recordAudit({
        actorId: request.userId!,
        actorName: await actorName(request.userId!),
        action: "user.ban",
        targetId,
        detail: {
          banId: created?.id,
          category: parsed.data.category,
          reason: parsed.data.reason ?? null,
          expiresAt: expiresAt?.toISOString() ?? null,
        },
        log: request.log,
      });

      return reply.code(201).send(await getUserDetail(targetId));
    },
  );

  /**
   * DELETE /admin/users/:id/bans/:banId — lift a ban.
   *
   * Sets `liftedAt` rather than deleting the row: the ban history is evidence,
   * and a player asking "why was I banned in March" needs it to still exist.
   */
  app.delete<{ Params: { id: string; banId: string } }>(
    "/admin/users/:id/bans/:banId",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const { id: targetId, banId } = request.params;

      const lifted = await db
        .update(bans)
        .set({ liftedAt: new Date() })
        .where(
          and(
            eq(bans.id, banId),
            eq(bans.userId, targetId),
            // Lifting an already-lifted ban would move its timestamp and lose
            // when it was actually lifted.
            isNull(bans.liftedAt),
          ),
        )
        .returning();

      if (lifted.length === 0) {
        return reply.code(404).send({ error: "Active ban not found" });
      }

      await recordAudit({
        actorId: request.userId!,
        actorName: await actorName(request.userId!),
        action: "user.unban",
        targetId,
        detail: { banId },
        log: request.log,
      });

      return reply.send(await getUserDetail(targetId));
    },
  );

  /**
   * GET /admin/audit — the action log, newest first, optionally for one target.
   */
  app.get(
    "/admin/audit",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const parsed = z
        .object({
          targetId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
          offset: z.coerce.number().int().min(0).default(0),
        })
        .safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid query" });
      }
      return reply.send(await listAudit(parsed.data));
    },
  );

  // -------------------------------------------------------------------------
  // Shop: cosmetics catalog + drop rotation
  // -------------------------------------------------------------------------

  /** GET /admin/cosmetics — the whole catalog, published or not. */
  app.get(
    "/admin/cosmetics",
    { preHandler: requireAdmin },
    async (_request, reply) => {
      const rows = await db
        .select()
        .from(cosmetics)
        .orderBy(cosmetics.kind, cosmetics.name);
      return reply.send({
        cosmetics: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          name: row.name,
          displayName: row.displayName,
          rarity: row.rarity,
          artist: row.artist,
          priceSoft: row.priceSoft,
          priceHard: row.priceHard,
          payload: row.payload,
          published: row.published,
          createdAt: row.createdAt.toISOString(),
        })),
      });
    },
  );

  /**
   * POST /admin/cosmetics — create or update by (kind, name).
   *
   * An upsert rather than separate create/update verbs: (kind, name) is the
   * natural key that flares are built from, so "the flag called de" is the
   * identity the operator thinks in, not a generated row id.
   */
  app.post(
    "/admin/cosmetics",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const parsed = CosmeticUpsertSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
      }
      const item = parsed.data;

      const [saved] = await db
        .insert(cosmetics)
        .values({
          kind: item.kind,
          name: item.name,
          displayName: item.displayName ?? null,
          rarity: item.rarity ?? null,
          artist: item.artist ?? null,
          priceSoft: item.priceSoft ?? null,
          priceHard: item.priceHard ?? null,
          payload: item.payload ?? {},
          published: item.published ?? false,
        })
        .onConflictDoUpdate({
          target: [cosmetics.kind, cosmetics.name],
          set: {
            displayName: item.displayName ?? null,
            rarity: item.rarity ?? null,
            artist: item.artist ?? null,
            priceSoft: item.priceSoft ?? null,
            priceHard: item.priceHard ?? null,
            payload: item.payload ?? {},
            published: item.published ?? false,
          },
        })
        .returning();

      await recordAudit({
        actorId: request.userId!,
        actorName: await actorName(request.userId!),
        action: "cosmetic.upsert",
        targetId: saved?.id ?? null,
        detail: { kind: item.kind, name: item.name, published: item.published },
        log: request.log,
      });

      return reply.send({ id: saved?.id, kind: item.kind, name: item.name });
    },
  );

  /**
   * DELETE /admin/cosmetics/:kind/:name
   *
   * Refused once anyone owns it: the flare on their account would outlive the
   * catalog entry and render as a broken item rather than disappearing.
   * Unpublishing is the way to retire something that has been sold.
   */
  app.delete<{ Params: { kind: string; name: string } }>(
    "/admin/cosmetics/:kind/:name",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const existing = await findCosmetic(
        request.params.kind,
        request.params.name,
      );
      if (!existing) return reply.code(404).send({ error: "Not found" });

      const [{ value: sold } = { value: 0 }] = await db
        .select({ value: count() })
        .from(shopPurchases)
        .where(eq(shopPurchases.cosmeticId, existing.id));

      if (sold > 0) {
        return reply.code(409).send({
          error: `${sold} player(s) own this — unpublish it instead of deleting`,
        });
      }

      await db.delete(cosmetics).where(eq(cosmetics.id, existing.id));

      await recordAudit({
        actorId: request.userId!,
        actorName: await actorName(request.userId!),
        action: "cosmetic.delete",
        targetId: existing.id,
        detail: { kind: existing.kind, name: existing.name },
        log: request.log,
      });

      return reply.send({ deleted: true });
    },
  );

  /** GET /admin/shop/config — the drop cadence. */
  app.get(
    "/admin/shop/config",
    { preHandler: requireAdmin },
    async (_request, reply) => {
      return reply.send(await getShopConfig());
    },
  );

  /**
   * PUT /admin/shop/config — change how often a drop rotates, and how big.
   *
   * Takes effect at the next window boundary rather than immediately: windows
   * are derived from a fixed epoch, so changing the cadence mid-window would
   * otherwise retroactively move the boundary a live drop is sitting in.
   */
  app.put(
    "/admin/shop/config",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const parsed = z
        .object({
          rotationHours: z
            .number()
            .int()
            .min(1)
            .max(24 * 30),
          itemsPerRotation: z.number().int().min(1).max(100),
        })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid config" });
      }

      await db
        .insert(shopConfig)
        .values({ id: SHOP_CONFIG_ID, ...parsed.data, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: shopConfig.id,
          set: { ...parsed.data, updatedAt: new Date() },
        });

      await recordAudit({
        actorId: request.userId!,
        actorName: await actorName(request.userId!),
        action: "shop.config",
        targetId: SHOP_CONFIG_ID,
        detail: parsed.data,
        log: request.log,
      });

      return reply.send(parsed.data);
    },
  );

  /** GET /admin/shop/rotation — the live drop, as the players see it. */
  app.get(
    "/admin/shop/rotation",
    { preHandler: requireAdmin },
    async (_request, reply) => {
      const rotation = await getOrCreateCurrentRotation();
      return reply.send({
        startsAt: rotation.startsAt.toISOString(),
        endsAt: rotation.endsAt.toISOString(),
        cosmeticIds: rotation.cosmeticIds,
      });
    },
  );

  /**
   * POST /admin/shop/rotation — replace the live drop's lineup by hand.
   *
   * Marks the row pinned so the engine treats it as a deliberate choice.
   */
  app.post(
    "/admin/shop/rotation",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const parsed = z
        .object({ cosmeticIds: z.uuid().array().max(100) })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid rotation" });
      }

      const current = await getOrCreateCurrentRotation();
      await db
        .update(shopRotations)
        .set({ cosmeticIds: parsed.data.cosmeticIds, pinned: true })
        .where(eq(shopRotations.startsAt, current.startsAt));

      await recordAudit({
        actorId: request.userId!,
        actorName: await actorName(request.userId!),
        action: "shop.rotation",
        targetId: current.startsAt.toISOString(),
        detail: { cosmeticIds: parsed.data.cosmeticIds },
        log: request.log,
      });

      return reply.send({ cosmeticIds: parsed.data.cosmeticIds });
    },
  );

  /**
   * POST /admin/users/:id/currency — grant or deduct shop currency.
   *
   * Separate from the credits endpoint: credits are the legacy balance that
   * UserMeResponse still carries, while soft/hard are what the shop spends.
   */
  app.post<{ Params: { id: string } }>(
    "/admin/users/:id/currency",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const parsed = z
        .object({
          currencyType: z.enum(["soft", "hard"]),
          delta: z.number().int().min(-10_000_000).max(10_000_000),
          reason: z.string().trim().min(1).max(500),
        })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
      }
      const targetId = request.params.id;

      const target = await db.query.users.findFirst({
        where: eq(users.id, targetId),
        columns: { currencySoft: true, currencyHard: true },
      });
      if (!target) return reply.code(404).send({ error: "User not found" });

      const isSoft = parsed.data.currencyType === "soft";
      const before = isSoft ? target.currencySoft : target.currencyHard;
      const next = clampCredits(before, parsed.data.delta);

      await db
        .update(users)
        .set(isSoft ? { currencySoft: next } : { currencyHard: next })
        .where(eq(users.id, targetId));

      await recordAudit({
        actorId: request.userId!,
        actorName: await actorName(request.userId!),
        action: "user.currency",
        targetId,
        detail: { ...parsed.data, before, after: next },
        log: request.log,
      });

      return reply.send({
        currencyType: parsed.data.currencyType,
        balance: next,
      });
    },
  );

  /**
   * GET /admin/me — what the panel uses to decide which controls to render.
   * The role here is the freshly-read one, so a demoted admin's panel
   * degrades on its next poll rather than staying open until token expiry.
   */
  app.get("/admin/me", { preHandler: requireAdmin }, async (request, reply) => {
    return reply.send({
      userId: request.userId,
      role: request.userRole,
      isRoot: request.userRole === "root",
    });
  });
}
