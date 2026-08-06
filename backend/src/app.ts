import cors from "@fastify/cors";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
} from "fastify";
import { config, isProduction } from "./config.ts";
import { registerAuthRoutes } from "./routes/auth.ts";
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

  app.get("/health", async () => ({ status: "ok" }));

  await registerWellKnownRoutes(app);
  await registerAuthRoutes(app);
  await registerUserRoutes(app);

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
