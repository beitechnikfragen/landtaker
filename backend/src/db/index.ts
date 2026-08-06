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

export const db = drizzle(pool, { schema });

export type Database = typeof db;

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
