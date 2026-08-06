import { Redis } from "ioredis";
import { config } from "./config.ts";

/**
 * Redis holds state that is allowed to vanish: party presence, matchmaking
 * queues, rate-limit counters. Anything that must survive a restart belongs in
 * Postgres instead.
 *
 * Lazy connect so importing this module (in tests, in scripts) does not force a
 * live Redis.
 */
export const redis = new Redis(config.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
});

redis.on("error", (err: Error) => {
  // Do not crash the process: the game stays playable without parties or
  // matchmaking, and ioredis reconnects on its own.
  console.error("Redis error:", err.message);
});

export async function closeRedis(): Promise<void> {
  if (redis.status === "end") return;
  await redis.quit();
}
