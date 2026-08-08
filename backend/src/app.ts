import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { config, isProduction } from "./config.ts";
import { registerAdminRoutes } from "./routes/admin.ts";
import { registerAuthRoutes } from "./routes/auth.ts";
import { registerCustomTribeRoutes } from "./routes/customTribes.ts";
import { registerFriendRoutes } from "./routes/friends.ts";
import { registerGameRoutes } from "./routes/games.ts";
import { registerJoinVerifyRoutes } from "./routes/joinVerify.ts";
import { registerLeaderboardRoutes } from "./routes/leaderboard.ts";
import { registerMatchmakingRoutes } from "./routes/matchmaking.ts";
import { registerPartyRoutes } from "./routes/parties.ts";
import { registerPartyEventRoutes } from "./routes/partyEvents.ts";
import { registerShopRoutes } from "./routes/shop.ts";
import { registerStubRoutes } from "./routes/stubs.ts";
import { registerUserRoutes } from "./routes/users.ts";
import { registerWellKnownRoutes } from "./routes/wellKnown.ts";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: isProduction ? "info" : "debug",
      // Bearer tokens and api keys must never reach the logs.
      redact: ["req.headers.authorization", "req.headers['x-api-key']"],
      ...(isProduction ? {} : { transport: { target: "pino-pretty" } }),
    },
    // Behind nginx, so trust the proxy chain for client IPs.
    trustProxy: true,
    // Deprecated in favour of `logController` in Fastify 6, but that expects a
    // LogController instance rather than a plain object — switch when moving
    // to v6, not before.
    disableRequestLogging: isProduction,
  });

  await app.register(cors, {
    origin: config.CORS_ORIGIN.split(",").map((o) => o.trim()),
    credentials: true,
  });

  // The client keeps its refresh token in an httpOnly cookie and calls
  // /auth/refresh with `credentials: "include"` — see doRefreshJwt in
  // src/client/Auth.ts. Without this the cookie is never readable.
  await app.register(cookie);

  /**
   * Treat an empty JSON body as `{}` instead of 400.
   *
   * Fastify's default parser rejects a request that declares
   * `Content-Type: application/json` but sends no body. Browser clients set
   * that header globally and then POST to endpoints that take no arguments
   * (e.g. /parties/leave), which made those calls fail in the browser while
   * passing every curl-based test.
   */
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body: string, done) => {
      if (body === "") return done(null, {});
      try {
        done(null, JSON.parse(body));
      } catch (err) {
        const error = err as FastifyError;
        error.statusCode = 400;
        done(error, undefined);
      }
    },
  );

  app.get("/health", async () => ({ status: "ok" }));

  await registerWellKnownRoutes(app);
  await registerAuthRoutes(app);
  await registerUserRoutes(app);
  await registerPartyRoutes(app);
  await registerPartyEventRoutes(app);
  await registerGameRoutes(app);
  await registerLeaderboardRoutes(app);
  await registerFriendRoutes(app);
  await registerJoinVerifyRoutes(app);
  await registerMatchmakingRoutes(app);
  await registerCustomTribeRoutes(app);
  await registerShopRoutes(app);
  await registerAdminRoutes(app);
  // Placeholder endpoints for features not built yet (clans, cosmetics,
  // streams, news, Stripe) — see routes/stubs.ts.
  await registerStubRoutes(app);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, "unhandled error");
    const status = error.statusCode ?? 500;
    // Never leak internals to the client; the log has the detail. 4xx messages
    // are our own validation text and safe to return.
    void reply
      .code(status)
      .send({ error: status < 500 ? error.message : "Internal error" });
  });

  return app;
}
