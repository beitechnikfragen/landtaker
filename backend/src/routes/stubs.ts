import type { FastifyInstance } from "fastify";
import newsItems from "resources/news.json" with { type: "json" };

/**
 * PLACEHOLDER ROUTES.
 *
 * The upstream closed-source Cloudflare Worker served these; our backend does
 * not implement the features behind them yet. Without the routes the client
 * gets a 404 on every page load and the browser console fills with noise, so
 * each GET below answers with the empty-but-schema-valid payload its consumer
 * expects. Every response here is a stand-in for a feature that still has to
 * be built:
 *
 *   GET  /public/clans/leaderboard  -> needs the clans feature
 *                                      (src/core/ClanApiSchemas.ts,
 *                                       src/client/ClanApi.ts,
 *                                       src/client/ClanModal.ts)
 *   GET  /cosmetics.json            -> needs the cosmetics catalog
 *                                      (src/core/CosmeticSchemas.ts,
 *                                       src/client/Cosmetics.ts)
 *   GET  /reserved_clan_tags        -> needs the clans feature; consumed by the
 *                                      game server's PrivilegeRefresher
 *                                      (src/server/PrivilegeRefresher.ts)
 *   GET  /streams.json              -> needs the live-stream verification cron
 *                                      (src/core/ApiSchemas.ts StreamsFeedSchema)
 *   GET  /news.json                 -> needs a news source
 *                                      (src/core/ApiSchemas.ts NewsItemSchema)
 *   POST /stripe/*                  -> needs the Stripe integration
 *
 * The client's Clans and Store UI show a "coming soon" state on top of these
 * (see src/client/ClanModal.ts and src/client/Store.ts). Delete a route from
 * this file as soon as its real implementation lands.
 */
export async function registerStubRoutes(app: FastifyInstance): Promise<void> {
  // PLACEHOLDER: no clans exist yet, so the board is empty. Shape must satisfy
  // ClanLeaderboardResponseSchema (src/core/ClanApiSchemas.ts): `start`/`end`
  // are required ISO datetimes, `clans` an array of entries. TODO: serve real
  // aggregates once clans are implemented.
  app.get("/public/clans/leaderboard", async (_request, reply) => {
    const now = new Date();
    // A closed, zero-length window is the honest description of "no data".
    const start = new Date(now.getTime());
    return reply.header("cache-control", "public, max-age=60").send({
      start: start.toISOString(),
      end: now.toISOString(),
      clans: [],
      total: 0,
      limit: 0,
    });
  });

  // /cosmetics.json is served for real by routes/shop.ts now.

  // PLACEHOLDER: no clan tags are reserved yet. ReservedClanTagsResponseSchema
  // (src/core/ClanApiSchemas.ts) is a bare string array. Returning [] rather
  // than 404 keeps the game server's PrivilegeRefresher from logging an error
  // every refresh. TODO: serve registered clan tags once clans exist.
  app.get("/reserved_clan_tags", async (_request, reply) => {
    return reply.header("cache-control", "public, max-age=60").send([]);
  });

  // PLACEHOLDER: no stream-verification cron yet. StreamsFeedSchema
  // (src/core/ApiSchemas.ts) requires `verifiedAt`; empty `featured`/`live`
  // mean "show nothing", which is what the bundled resources/streams.json
  // fallback also encodes. TODO: replace with a real Twitch/YouTube liveness
  // check — the client must never decide liveness itself.
  app.get("/streams.json", async (_request, reply) => {
    return reply.header("cache-control", "public, max-age=60").send({
      verifiedAt: new Date().toISOString(),
      featured: [],
      live: [],
    });
  });

  // News comes straight from the game's bundled resources/news.json — one
  // source of truth for the box on the home page. The client parses this with
  // z.array(NewsItemSchema) and falls back to the same bundled file on
  // failure, so the two can never disagree.
  app.get("/news.json", async (_request, reply) => {
    return reply.header("cache-control", "public, max-age=60").send(newsItems);
  });

  /**
   * PLACEHOLDER: Stripe is not integrated.
   *
   * These deliberately fail instead of returning a fake `url`. The client
   * (createCheckoutSession / createCustomCurrencyCheckout in
   * src/client/Api.ts) redirects the browser to whatever `url` comes back, so
   * a placeholder checkout URL would send a paying user somewhere broken —
   * strictly worse than an honest error. 501 Not Implemented says exactly
   * what is true. TODO: implement real Stripe Checkout sessions.
   */
  for (const path of [
    "/stripe/create-checkout-session",
    "/stripe/create-custom-currency-checkout",
  ]) {
    app.post(path, async (_request, reply) =>
      reply.code(501).send({ error: "not_implemented" }),
    );
  }
}
