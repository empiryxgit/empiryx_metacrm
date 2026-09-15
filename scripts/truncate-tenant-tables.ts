// Truncates every tenant/application data table in the `crm` schema -
// everything EXCEPT the platform-superadmin login table (`platform_admins`,
// see scripts/create-platform-admin.ts) - so a dev/staging database can be
// wiped back to empty without also locking yourself out of the platform
// admin panel.
//
// Table list is read live from information_schema (not hand-maintained), so
// it never drifts from src/infrastructure/db/schema.ts as tables are added.
//
// Usage:
//   npx tsx scripts/truncate-tenant-tables.ts            # DRY RUN (default) - lists what would happen, touches nothing
//   npx tsx scripts/truncate-tenant-tables.ts --yes      # actually truncates, after an interactive typed confirmation
//   npx tsx scripts/truncate-tenant-tables.ts --yes --force   # skips the interactive prompt too (e.g. CI/non-TTY) - use with care
//
// Same connection-string convention as scripts/migrate.ts: prefers
// MIGRATE_DATABASE_URL (Neon's direct/unpooled connection string) over
// DATABASE_URL when both are set, since this also needs a plain
// non-PgBouncer-style session; DATABASE_URL alone is fine for local dev.
import "dotenv/config";
import { Pool } from "pg";
import * as readline from "node:readline/promises";

const SCHEMA = "crm";

// Tables that must NEVER be truncated by this script. Extend this list
// (not the CLI) if another table should always survive a wipe.
const NEVER_TRUNCATE = new Set<string>([
  "platform_admins", // the actual superadmin login table - losing this locks you out of /platform-admin entirely
]);

function redactedHost(connectionString: string): string {
  try {
    const u = new URL(connectionString);
    return `${u.hostname}${u.port ? ":" + u.port : ""}${u.pathname}`;
  } catch {
    return "(unparseable connection string)";
  }
}

async function main() {
  const args = process.argv.slice(2);
  const yes = args.includes("--yes");
  const force = args.includes("--force");

  const connectionString = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("Neither MIGRATE_DATABASE_URL nor DATABASE_URL is set.");
  }

  const pool = new Pool({ connectionString });

  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
    [SCHEMA],
  );

  const allTables = rows.map((r) => r.table_name);
  const toTruncate = allTables.filter((t) => !NEVER_TRUNCATE.has(t));
  const preserved = allTables.filter((t) => NEVER_TRUNCATE.has(t));

  console.log(`Target database: ${redactedHost(connectionString)}`);
  console.log(`Schema: ${SCHEMA}\n`);
  console.log(`Will TRUNCATE (${toTruncate.length} tables):`);
  for (const t of toTruncate) console.log(`  - ${SCHEMA}.${t}`);
  console.log(`\nWill PRESERVE (${preserved.length} table${preserved.length === 1 ? "" : "s"}, never truncated by this script):`);
  for (const t of preserved) console.log(`  - ${SCHEMA}.${t}`);

  if (toTruncate.length === 0) {
    console.log("\nNothing to truncate.");
    await pool.end();
    return;
  }

  if (!yes) {
    console.log("\nDry run only - nothing was touched. Re-run with --yes to actually truncate.");
    await pool.end();
    return;
  }

  if (!force) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `\nType TRUNCATE to permanently delete all rows from the ${toTruncate.length} table(s) above on ${redactedHost(connectionString)}: `,
    );
    rl.close();
    if (answer.trim() !== "TRUNCATE") {
      console.log("Confirmation did not match - aborted, nothing was touched.");
      await pool.end();
      process.exit(1);
    }
  }

  const qualified = toTruncate.map((t) => `${SCHEMA}.${t}`).join(", ");
  console.log("\nTruncating...");
  // One multi-table statement so Postgres handles FK ordering itself; CASCADE
  // is a defensive no-op here (every table an included table's FK points at
  // is also in this same list, except platform_admins, which nothing in
  // this list is ever referenced BY) but guards against a future schema
  // change quietly introducing a table this script doesn't know to exclude.
  await pool.query(`TRUNCATE TABLE ${qualified} RESTART IDENTITY CASCADE;`);
  console.log(`Done. Truncated ${toTruncate.length} table(s); ${preserved.join(", ")} left untouched.`);

  await pool.end();
}

main().catch((err) => {
  console.error("Truncate failed:", err);
  process.exit(1);
});
