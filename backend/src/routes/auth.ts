import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  generateRefreshToken,
  hashRefreshToken,
  issueAccessToken,
} from "../auth/tokens.ts";
import { config, isProduction } from "../config.ts";
import { db } from "../db/index.ts";
import { refreshTokens, users } from "../db/schema.ts";
import { createUser } from "../services/users.ts";

/** Name of the httpOnly cookie carrying the refresh token. */
const REFRESH_COOKIE = "refresh_token";

/**
 * Stores the refresh token in an httpOnly cookie so page scripts cannot read
 * it — an XSS then cannot walk off with a long-lived session.
 *
 * SameSite=Lax rather than Strict: the client and API sit on different ports
 * in development, and Lax still blocks the cross-site POSTs that matter.
 * Secure is off in development because localhost is plain HTTP.
 */
function setRefreshCookie(reply: FastifyReply, token: string, expiresAt: Date) {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    path: "/",
    expires: expiresAt,
  });
}

const RefreshBodySchema = z.object({ refreshToken: z.string().min(1) });
const DevLoginBodySchema = z.object({
  // Reuse an existing account across restarts, or omit to mint a new one.
  userId: z.uuid().optional(),
  role: z.enum(["root", "admin", "mod", "flagged", "banned"]).optional(),
  // Bare display name. The game shows the verified check for any username
  // without a dot (isVerifiedUsername in src/core/ApiSchemas.ts), so a name
  // given here is rendered bare and gets the badge. Dots are rejected because
  // they would silently produce an unverified name.
  username: z
    .string()
    .min(3)
    .max(24)
    .refine((v) => !v.includes("."), {
      message: "username must not contain a dot (it would drop the badge)",
    })
    .optional(),
  // Defaults to true so the badge is on by default in dev; pass false to see
  // how an ordinary "Name.1234" account renders.
  verified: z.boolean().default(true),
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
    // Two callers with different habits: the browser client sends nothing and
    // relies on the httpOnly cookie (`credentials: "include"` in
    // src/client/Auth.ts), while scripts and tests pass the token in the body.
    const fromBody = RefreshBodySchema.safeParse(request.body);
    const presented = fromBody.success
      ? fromBody.data.refreshToken
      : request.cookies[REFRESH_COOKIE];
    if (!presented) {
      return reply.code(401).send({ error: "No refresh token" });
    }

    const tokenHash = hashRefreshToken(presented);
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
    setRefreshCookie(reply, next.token, next.expiresAt);
    // `jwt` and `expiresIn` are what the client destructures (doRefreshJwt in
    // src/client/Auth.ts). `token`/`refreshToken` are kept alongside for the
    // scripted callers that already read them.
    return reply.send({
      jwt: access.token,
      expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
      token: access.token,
      refreshToken: next.token,
      expiresAt: access.expiresAt.toISOString(),
    });
  });

  /**
   * POST /auth/logout — revokes a single refresh token.
   */
  app.post("/auth/logout", async (request, reply) => {
    const fromBody = RefreshBodySchema.safeParse(request.body);
    const presented = fromBody.success
      ? fromBody.data.refreshToken
      : request.cookies[REFRESH_COOKIE];
    if (presented) {
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.tokenHash, hashRefreshToken(presented)));
    }
    reply.clearCookie(REFRESH_COOKIE, { path: "/" });
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

      // "premium" renders the name bare, which is what earns the verified
      // check; anything else renders "base.1234". See resolveDisplayUsername.
      const identity = {
        usernameBase: parsed.data.username ?? "DevPlayer",
        usernameDiscriminator: String(
          Math.floor(Math.random() * 10_000),
        ).padStart(4, "0"),
        usernameStatus: parsed.data.verified ? "premium" : "claimed",
      };

      user ??= await createUser({
        role: parsed.data.role ?? null,
        ...identity,
        adfree: true,
        canCreatePublicLobbies: true,
        unlimitedRanked: true,
      });

      // Re-logging into an existing account applies the requested name/badge
      // too, so flipping them does not require a fresh account each time.
      if (parsed.data.username !== undefined || !user.usernameStatus) {
        const [updated] = await db
          .update(users)
          .set({
            usernameBase: identity.usernameBase,
            usernameStatus: identity.usernameStatus,
            // Keep the existing suffix if there is one; it is only shown for
            // non-verified accounts anyway.
            usernameDiscriminator:
              user.usernameDiscriminator ?? identity.usernameDiscriminator,
          })
          .where(eq(users.id, user.id))
          .returning();
        if (updated) user = updated;
      }

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

      // Set the cookie too, so hitting this route in a browser leaves a real
      // session behind — that is how you sign in locally without OAuth.
      setRefreshCookie(reply, refresh.token, refresh.expiresAt);
      return reply.send({
        jwt: access.token,
        expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
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
