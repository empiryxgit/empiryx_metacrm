// Applies pending Drizzle migrations. Works against either driver: point
// DATABASE_URL at local Docker Postgres for dev, or at Neon's pooled
// connection string (the *non*-HTTP one, `postgres://...neon.tech/...`) when
// migrating a Neon database - drizzle-kit's migrator needs a real TCP
// connection regardless of which driver the running app uses.
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set.");
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
