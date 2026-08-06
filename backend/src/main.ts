import { buildApp } from "./app.ts";
import { config } from "./config.ts";
import { closeDatabase } from "./db/index.ts";
import { closeRedis } from "./redis.ts";

const app = await buildApp();

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (err) {
  app.log.error({ err }, "failed to start");
  process.exit(1);
}

/**
 * Drain in order: stop accepting requests, then close backing services. Doing
 * it the other way round makes in-flight requests fail against a dead pool.
 */
async function shutdown(signal: string): Promise<void> {
  app.log.info(`${signal} received, shutting down`);
  try {
    await app.close();
    await Promise.allSettled([closeDatabase(), closeRedis()]);
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, "error during shutdown");
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
