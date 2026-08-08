import {
  AdminBanCreateSchema,
  AdminCreditAdjustSchema,
  AdminUserPatchSchema,
  AdminUserQuerySchema,
} from "@game/AdminApiSchemas.ts";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/index.ts";
import { bans, users } from "../db/schema.ts";
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
import { resolveDisplayUsername } from "../services/users.ts";

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
