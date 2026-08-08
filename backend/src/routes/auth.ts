import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  generateLoginToken,
  generateRefreshToken,
  hashRefreshToken,
  issueAccessToken,
} from "../auth/tokens.ts";
import { config, isProduction } from "../config.ts";
import { db } from "../db/index.ts";
import { loginTokens, refreshTokens, users } from "../db/schema.ts";
import { isEmailConfigured, sendMagicLinkEmail } from "../services/email.ts";
import {
  discordAuthorizeUrl,
  fetchDiscordProfile,
  isAllowedRedirect,
  signState,
  verifyState,
} from "../services/oauth.ts";
import { createUser, findOrCreateUserByIdentity } from "../services/users.ts";

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

/**
 * Issues a refresh token + access token pair for a user and sets the cookie.
 * Shared by every way of signing in (OAuth callbacks, dev-login) so they
 * cannot drift apart on TTLs or cookie flags.
 */
async function startSession(
  reply: FastifyReply,
  user: { id: string; role: string | null },
) {
  const refresh = generateRefreshToken();
  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: refresh.tokenHash,
    expiresAt: refresh.expiresAt,
  });
  const access = await issueAccessToken({ userId: user.id, role: user.role });
  setRefreshCookie(reply, refresh.token, refresh.expiresAt);
  return { refresh, access };
}

const RefreshBodySchema = z.object({ refreshToken: z.string().min(1) });

const MagicLinkBodySchema = z.object({
  email: z.email().max(254),
  // window.location.origin from the client (sendMagicLink); checked against
  // the redirect allowlist before it is ever put in an email.
  redirectDomain: z.string().min(1),
});
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
   * Discord OAuth.
   *
   * Registered only when credentials are configured: a half-configured
   * provider that renders a button leading to a Discord error page is worse
   * than one that is plainly absent.
   */
  if (config.DISCORD_CLIENT_ID && config.DISCORD_CLIENT_SECRET) {
    /**
     * GET /auth/login/discord?redirect_uri=...
     *
     * Entry point the client links to (discordLogin in src/client/Auth.ts).
     * Bounces the browser to Discord with a signed state carrying the return
     * URL.
     */
    app.get("/auth/login/discord", async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;
      const target = query.redirect_uri ?? config.CORS_ORIGIN.split(",")[0]!;
      if (!isAllowedRedirect(target)) {
        return reply.code(400).send({ error: "redirect_uri not allowed" });
      }
      return reply.redirect(discordAuthorizeUrl(signState(target)));
    });

    /**
     * GET /auth/callback/discord
     *
     * Where Discord sends the browser back. Exchanges the code, links or
     * creates the account, starts the session, and returns the player to the
     * page they left. Failures redirect with an `auth_error` marker rather
     * than rendering an API error page — the browser is a person here.
     */
    app.get("/auth/callback/discord", async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;
      const target = verifyState(query.state);
      if (!target || !isAllowedRedirect(target)) {
        // Cannot trust the return URL, so this is the one case that must not
        // redirect anywhere.
        return reply.code(400).send({ error: "Invalid or expired state" });
      }

      const fail = (reason: string) => {
        const url = new URL(target);
        url.searchParams.set("auth_error", reason);
        return reply.redirect(url.toString());
      };

      // The user pressed "Cancel" on Discord's consent screen.
      if (query.error || !query.code) return fail(query.error ?? "no_code");

      try {
        const profile = await fetchDiscordProfile(query.code);
        const user = await findOrCreateUserByIdentity({
          provider: "discord",
          providerUserId: profile.id,
          // Exactly the fields DiscordUserSchema declares — the game parses
          // this back out of /users/@me and rejects unknown shapes.
          profile: {
            id: profile.id,
            username: profile.username,
            global_name: profile.global_name,
            avatar: profile.avatar,
            discriminator: profile.discriminator,
          },
          email: profile.email,
          usernameBase: profile.global_name ?? profile.username,
        });
        await startSession(reply, user);
        return reply.redirect(target);
      } catch (err) {
        request.log.error({ err }, "discord oauth callback failed");
        return fail("discord_failed");
      }
    });
  } else {
    app.log.warn(
      "Discord login is disabled: set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET to enable it.",
    );
  }

  /**
   * Magic-link sign-in. Registered only when email is configured, so the
   * client's button reports a failure rather than accepting an address that
   * silently receives nothing.
   */
  if (isEmailConfigured()) {
    /**
     * POST /auth/magic-link  { email, redirectDomain }
     *
     * Emails a single-use link. Always answers 202 regardless of whether the
     * address belongs to an account: a different answer for known and unknown
     * addresses turns this endpoint into an account-existence oracle.
     */
    app.post("/auth/magic-link", async (request, reply) => {
      const parsed = MagicLinkBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: z.prettifyError(parsed.error) });
      }
      const { email, redirectDomain } = parsed.data;

      if (!isAllowedRedirect(redirectDomain)) {
        return reply.code(400).send({ error: "redirectDomain not allowed" });
      }

      // Addresses are compared lowercased; mail domains are case-insensitive
      // and treating "A@x.de" as a separate account would split someone's
      // identity in two.
      const normalized = email.trim().toLowerCase();

      const existing = await db.query.users.findFirst({
        where: eq(users.email, normalized),
      });
      // No account yet: signing in by email is also how one is created, which
      // is what makes this a login rather than only a recovery flow.
      const user = existing ?? (await createUser({ email: normalized }));

      const login = generateLoginToken(config.MAGIC_LINK_TTL_MINUTES);
      await db.insert(loginTokens).values({
        userId: user.id,
        tokenHash: login.tokenHash,
        email: normalized,
        expiresAt: login.expiresAt,
      });

      // The client routes this hash itself: Main.ts opens <token-login>, which
      // polls /auth/login/token with the value.
      const url = `${redirectDomain.replace(/\/$/, "")}/#token-login?token-login=${login.token}`;

      try {
        await sendMagicLinkEmail({
          to: normalized,
          url,
          ttlMinutes: config.MAGIC_LINK_TTL_MINUTES,
        });
      } catch (err) {
        // Swallowed on purpose: reporting a delivery failure would tell the
        // caller their address is real, which is exactly what the uniform 202
        // avoids. Both branches did identical work, so the timing does not
        // leak it either. The log is where this surfaces.
        request.log.error({ err }, "magic link delivery failed");
      }

      return reply.code(202).send({ ok: true });
    });

    /**
     * GET /auth/login/token?login-token=...
     *
     * Redeems the emailed token and starts a session. Responds `{ email }`,
     * which is what tempTokenLogin() in src/client/Auth.ts reads.
     */
    app.get("/auth/login/token", async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;
      const presented = query["login-token"];
      if (!presented) {
        return reply.code(400).send({ error: "Missing login-token" });
      }

      const tokenHash = hashRefreshToken(presented);

      // Claim the token inside a transaction: two clicks racing (the client
      // polls every 3s) must not both mint a session.
      const claimed = await db.transaction(async (tx) => {
        const row = await tx.query.loginTokens.findFirst({
          where: and(
            eq(loginTokens.tokenHash, tokenHash),
            isNull(loginTokens.consumedAt),
            gt(loginTokens.expiresAt, new Date()),
          ),
        });
        if (!row) return null;
        const updated = await tx
          .update(loginTokens)
          .set({ consumedAt: new Date() })
          .where(
            and(eq(loginTokens.id, row.id), isNull(loginTokens.consumedAt)),
          )
          .returning();
        // Lost the race — the other request consumed it first.
        return updated.length > 0 ? row : null;
      });

      if (!claimed) {
        return reply.code(401).send({ error: "Invalid or expired token" });
      }

      const user = await db.query.users.findFirst({
        where: eq(users.id, claimed.userId),
      });
      if (!user) return reply.code(401).send({ error: "Invalid token" });

      // Proving control of the address is what verifies it, so an account that
      // reached here without one now has it.
      if (!user.email) {
        await db
          .update(users)
          .set({ email: claimed.email })
          .where(eq(users.id, user.id));
      }

      await startSession(reply, user);
      return reply.send({ email: claimed.email });
    });
  } else {
    app.log.warn(
      "Magic-link sign-in is disabled: set RESEND_API_KEY to enable it.",
    );
  }

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

      // Same username = same account, across browsers and sessions. Without
      // this every dev sign-in minted a fresh user, so elo and history seeded
      // onto one browser's account silently vanished in another.
      user ??=
        (await db.query.users.findFirst({
          where: eq(
            users.email,
            `${identity.usernameBase.toLowerCase()}@dev.localhost`,
          ),
          orderBy: (u, { asc }) => [asc(u.createdAt)],
        })) ?? null;

      user ??= await createUser({
        role: parsed.data.role ?? null,
        ...identity,
        // The client treats "has an email" as a linked account (a magic-link
        // user has nothing else either), so without one a dev session would
        // sign in but the whole signed-in UI would stay hidden.
        email: `${identity.usernameBase.toLowerCase()}@dev.localhost`,
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

      // Sets the cookie too, so hitting this route in a browser leaves a real
      // session behind — that is how you sign in locally without OAuth.
      const { refresh, access } = await startSession(reply, user);
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
