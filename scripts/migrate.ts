// Applies pending Drizzle migrations. Works against either driver: point
// DATABASE_URL at local Docker Postgres for dev, or at Neon when migrating a
// Neon database - drizzle-kit's migrator needs a real TCP connection
// regardless of which driver the running app uses at runtime.
//
// Runs automatically as part of `npm run build` (see package.json), which
// Vercel executes on every deploy - so this now applies on push, with no
// manual "run this locally against prod" step required. See README.md's
// "Deploying to production" section.
//
// Prefers MIGRATE_DATABASE_URL over DATABASE_URL when both are set. Neon
// gives you two connection strings: a pooled one (`...-pooler.../...`, what
// the app's runtime uses via the Neon HTTP driver - see
// src/infrastructure/db/client.ts) and a direct/unpooled one. Drizzle's
// migrator opens one long-lived session and runs each migration file inside
// its own transaction - the kind of connection use PgBouncer-style pooling
// (which Neon's pooled endpoint uses) is not built for. Set
// MIGRATE_DATABASE_URL to Neon's direct connection string (Vercel ->
// Project -> Settings -> Environment Variables) so migrations always run
// over the right kind of connection; DATABASE_URL alone still works fine
// for local dev, where both would point at the same plain Postgres anyway.
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

async function main() {
  const connectionString = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("Neither MIGRATE_DATABASE_URL nor DATABASE_URL is set.");
  }

  const pool = new Pool({ connectionString });
  const db = drizzle(pool);

  console.log("Applying migrations from ./drizzle ...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied.");

  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
