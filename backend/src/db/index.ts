import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { config } from "../config.ts";
import * as schema from "./schema.ts";

/**
 * One pool per process. Fastify is single-threaded per worker, so the pool is
 * the concurrency limit for database work — size it against Postgres'
 * max_connections divided by the number of backend instances.
 */
export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

/**
 * Without this listener a lost connection is an unhandled 'error' event, and
 * Node kills the whole process — so a Postgres restart takes the backend down
 * with it instead of failing the queries that need it. Idle-client errors are
 * not tied to any request, so there is nobody to reject: log and let the pool
 * discard the client and reconnect.
 *
 * Redis already had this guard in redis.ts; the pool was missing it.
 */
pool.on("error", (err: Error) => {
  console.error("postgres pool error:", err.message);
});

export const db = drizzle(pool, { schema });

export type Database = typeof db;

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
