#!/usr/bin/env node
// Truncates ALL DATA in every table of the 'crm' schema — the schema,
// migrations, indexes, constraints, functions, and enum/types are never
// touched. Reads DATABASE_URL from .env exactly like the rest of this app,
// so there is nothing to configure beyond running it from the repo root
// with `npm install` already done.
//
// Usage (run from the repo root, e.g. the empiryx_metacrm/ folder):
//   node reset-dev-data.cjs             # DRY RUN — prints exactly what
//                                        # would happen, deletes nothing
//   node reset-dev-data.cjs --confirm   # actually executes the TRUNCATE
//
// Always run the dry run first and read the "Target" block it prints
// (database name, user, host) before ever adding --confirm. If that block
// does not look like your dev/test database, stop — do not pass --confirm.

require("dotenv").config();
const { Pool } = require("pg");

const CONFIRM = process.argv.includes("--confirm");

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set (see .env.example). Run this from the repo root.");
    process.exit(1);
  }

  const pool = new Pool({ connectionString, max: 2 });
  const client = await pool.connect();
  try {
    const {
      rows: [{ db, usr }],
    } = await client.query("SELECT current_database() AS db, current_user AS usr;");
    console.log("=== Target ===");
    console.log(`  Database: ${db}`);
    console.log(`  User:     ${usr}`);
    console.log(`  Host:     ${new URL(connectionString).hostname}`);
    console.log("  >>> STOP AND CHECK THE ABOVE. Do not proceed with --confirm if this looks like production. <<<");

    // Every application table lives in the 'crm' schema (see
    // drizzle.config.ts's schemaFilter: ["crm"]). Drizzle's own migration
    // bookkeeping table lives in a separate 'drizzle' schema and is never
    // touched here. TRUNCATE is DML, not DDL — it cannot drop or alter a
    // table, column, index, constraint, function, or type regardless of
    // what tables are named below; the table list itself is read live from
    // Postgres's own catalog, never hardcoded, so it can never drift out of
    // date with the real schema.
    const { rows: tableRows } = await client.query(`
      SELECT c.relname AS table_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'crm' AND c.relkind = 'r'
      ORDER BY c.relname;
    `);
    const tables = tableRows.map((r) => r.table_name);
    if (tables.length === 0) {
      console.log("\nNo tables found in schema 'crm'. Nothing to do.");
      return;
    }

    console.log(`\n=== Tables in 'crm' (${tables.length}) — row counts BEFORE ===`);
    let totalBefore = 0;
    for (const t of tables) {
      const {
        rows: [{ n }],
      } = await client.query(`SELECT count(*)::int AS n FROM crm.${t};`);
      console.log(`  ${t.padEnd(35)} ${n}`);
      totalBefore += n;
    }
    console.log(`  TOTAL: ${totalBefore} rows`);

    const { rows: migRows } = await client.query(`
      SELECT n.nspname AS schema, c.relname AS name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname ILIKE '%drizzle%';
    `);
    console.log(`\n=== Excluded from this reset (never touched) ===`);
    if (migRows.length > 0) {
      for (const r of migRows) {
        console.log(
          `  ${r.schema}.${r.name} — Drizzle's own migration-history bookkeeping table. Truncating it would make ` +
            `Drizzle think no migrations have ever been applied, even though the real schema is untouched, so it is ` +
            `deliberately outside the 'crm' schema this script targets.`,
        );
      }
    } else {
      console.log("  (no Drizzle migration table found via this connection — verify separately before assuming none exists)");
    }

    if (!CONFIRM) {
      console.log("\n>>> DRY RUN ONLY — nothing was deleted. Re-run with --confirm to actually truncate the tables above. <<<");
      return;
    }

    console.log("\n=== EXECUTING TRUNCATE ===");
    const qualified = tables.map((t) => `crm.${t}`).join(", ");
    await client.query(`TRUNCATE TABLE ${qualified} RESTART IDENTITY CASCADE;`);
    console.log("Truncate committed.");

    console.log("\n=== Row counts AFTER ===");
    let totalAfter = 0;
    let anyNonZero = false;
    for (const t of tables) {
      const {
        rows: [{ n }],
      } = await client.query(`SELECT count(*)::int AS n FROM crm.${t};`);
      totalAfter += n;
      if (n !== 0) {
        anyNonZero = true;
        console.log(`  WARNING: ${t} still has ${n} rows`);
      }
    }
    console.log(`  TOTAL AFTER: ${totalAfter} rows (expected 0)`);

    console.log("\n=== Summary ===");
    console.log(`Database name used: ${db}`);
    console.log(`Tables cleared (${tables.length}): ${tables.join(", ")}`);
    console.log(
      `Schema preserved: YES — TRUNCATE is DML only; no DROP/ALTER was issued against any table, column, index, ` +
        `constraint, function, or type.`,
    );
    console.log(
      `Identity sequences reset: YES — RESTART IDENTITY was included in the TRUNCATE (a no-op for UUID-keyed ` +
        `tables that own no sequence, which is most tables in this schema).`,
    );
    console.log(
      `Tables intentionally excluded: Drizzle's migration-history table (lives outside the 'crm' schema) — see above.`,
    );
    console.log(`All-zero verification: ${anyNonZero ? "FAILED — see WARNING lines above" : "PASSED — every table is empty"}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
