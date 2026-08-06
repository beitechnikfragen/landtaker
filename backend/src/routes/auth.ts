import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config, isProduction } from "../config.ts";
import {
  generateRefreshToken,
  hashRefreshToken,
  issueAccessToken,
} from "../auth/tokens.ts";
import { db } from "../db/index.ts";
import { refreshTokens, users } from "../db/schema.ts";
import { createUser } from "../services/users.ts";

const RefreshBodySchema = z.object({ refreshToken: z.string().min(1) });
const DevLoginBodySchema = z.object({
  // Reuse an existing account across restarts, or omit to mint a new one.
  userId: z.uuid().optional(),
  role: z.enum(["root", "admin", "mod", "flagged", "banned"]).optional(),
});

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /auth/refresh
   *
   * Rotates on every use: the presented token is revoked and a new one issued.
   * Response shape matches RefreshResponseSchema (`{ token }`) plus the new
   * refresh token.
   */
  app.post("/auth/refresh", async (request, reply) => {
    const parsed = RefreshBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "refreshToken is required" });
    }

    const tokenHash = hashRefreshToken(parsed.data.refreshToken);
    const existing = await db.query.refreshTokens.findFirst({
      where: and(
        eq(refreshTokens.tokenHash, tokenHash),
        isNull(refreshTokens.revokedAt),
        gt(refreshTokens.expiresAt, new Date()),
      ),
    });
    if (!existing) {
      // Covers unknown, expired and already-rotated tokens alike. A replayed
      // token landing here is a theft signal worth alerting on later.
      return reply.code(401).send({ error: "Invalid refresh token" });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, existing.userId),
    });
    if (!user) return reply.code(401).send({ error: "Invalid refresh token" });

    const next = generateRefreshToken();
    // Rotation and revocation must not half-apply: a crash between them would
    // either strand the session or leave two live tokens.
    await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(refreshTokens)
        .values({
          userId: user.id,
          tokenHash: next.tokenHash,
          expiresAt: next.expiresAt,
        })
        .returning();
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date(), replacedBy: inserted?.id })
        .where(eq(refreshTokens.id, existing.id));
    });

    const access = await issueAccessToken({
      userId: user.id,
      role: user.role,
    });
    return reply.send({
      token: access.token,
      refreshToken: next.token,
      expiresAt: access.expiresAt.toISOString(),
    });
  });

  /**
   * POST /auth/logout — revokes a single refresh token.
   */
  app.post("/auth/logout", async (request, reply) => {
    const parsed = RefreshBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "refreshToken is required" });
    }
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.tokenHash, hashRefreshToken(parsed.data.refreshToken)));
    // Always 204: revoking an already-dead token is not an error, and probing
    // for which tokens exist should not be possible.
    return reply.code(204).send();
  });

  /**
   * POST /auth/dev-login — DEVELOPMENT ONLY.
   *
   * Mints a session without an OAuth provider so the game can be driven end to
   * end before Discord/Google/Steam are wired. Registered only outside
   * production; in production the route does not exist at all.
   */
  if (!isProduction) {
    app.post("/auth/dev-login", async (request, reply) => {
      const parsed = DevLoginBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: z.prettifyError(parsed.error) });
      }

      let user = parsed.data.userId
        ? ((await db.query.users.findFirst({
            where: eq(users.id, parsed.data.userId),
          })) ?? null)
        : null;

      user ??= await createUser({
        role: parsed.data.role ?? null,
        usernameBase: "DevPlayer",
        usernameDiscriminator: String(
          Math.floor(Math.random() * 10_000),
        ).padStart(4, "0"),
        adfree: true,
        canCreatePublicLobbies: true,
        unlimitedRanked: true,
      });

      const refresh = generateRefreshToken();
      await db.insert(refreshTokens).values({
        userId: user.id,
        tokenHash: refresh.tokenHash,
        expiresAt: refresh.expiresAt,
      });
      const access = await issueAccessToken({
        userId: user.id,
        role: user.role,
      });

      return reply.send({
        token: access.token,
        refreshToken: refresh.token,
        expiresAt: access.expiresAt.toISOString(),
        userId: user.id,
        publicId: user.publicId,
      });
    });

    app.log.warn(
      `POST /auth/dev-login is enabled (NODE_ENV=${config.NODE_ENV}). ` +
        `It mints sessions without authentication and is never registered in production.`,
    );
  }
}
