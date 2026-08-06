import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDatabase, db } from "./index.ts";

/**
 * Applies pending migrations from ./drizzle. Run after `npm run db:generate`
 * has turned schema.ts changes into SQL.
 */
try {
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied.");
} catch (err) {
  console.error("Migration failed:", err);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
