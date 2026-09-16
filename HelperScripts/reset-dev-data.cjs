#!/usr/bin/env node
// Truncates ALL TENANT DATA in the 'crm' schema — the schema, migrations,
// indexes, constraints, functions, and enum/types are never touched. Also
// PRESERVES the Platform Admin subsystem (see PRESERVED_PLATFORM_ADMIN_TABLES
// below) rather than wiping it along with everything else — platform admins
// are "deliberately independent from customer users" (see platformAdmins'
// own header comment in src/infrastructure/db/schema.ts) and a dev/test
// reset of TENANT data has no reason to also delete who's allowed to log
// into /admin/login.html or the audit trail of what they've done. Reads
// DATABASE_URL from .env exactly like the rest of this app, so there is
// nothing to configure beyond running it from the repo root with
// `npm install` already done.
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

// Platform Admin is an entirely separate, non-tenant subsystem. These 4
// tables are FK-safe to exclude from the TRUNCATE together: several tenant
// tables DO reference platformAdmins.id (platformAuditLogs.adminId,
// platformNotifications.createdBy, billingOrders.refundedBy,
// platformPackages.updatedBy, platformBillingCycleDiscounts.updatedBy -
// all ON DELETE RESTRICT or SET NULL, never CASCADE), but every one of
// those is the CHILD side of that relationship. TRUNCATE only requires a
// referenced (parent) table to be included when a referencing (child)
// table outside the statement still points at it - the reverse (a child
// being truncated while its parent is left alone) is always fine, no
// CASCADE needed. Nothing anywhere in this schema references
// platformAuditLogs.id, platformPackages.id, or
// platformBillingCycleDiscounts.id at all, and the only things
// referencing platformAdmins.id are either excluded here too
// (platformAuditLogs) or genuine tenant tables already being truncated
// regardless (platformNotifications, billingOrders) - so excluding all
// four preserved tables together has no structural conflict.
//
// platform_notifications and platform_notification_reads are DELIBERATELY
// NOT in this list, even though they're platform_*-prefixed too: unlike
// the four above, platformNotifications.targetCompanyId/targetUserId
// reference companies.id/users.id ON DELETE CASCADE - i.e. they're
// notifications ABOUT tenants, not admin bookkeeping. Excluding them would
// either break this script's single TRUNCATE statement outright (Postgres
// refuses to truncate companies/users while a non-truncated table still
// holds a live FK to them, unless CASCADE is given) or, if CASCADE were
// added to route around that, get wiped anyway - TRUNCATE ... CASCADE
// auto-extends to every table with a live FK to whatever's being
// truncated, platform-admin exclusion list or not. So they get truncated
// along with the rest of the tenant data, same as before this change.
const PRESERVED_PLATFORM_ADMIN_TABLES = ["platform_admins", "platform_audit_logs", "platform_packages", "platform_billing_cycle_discounts"];

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
    const allTables = tableRows.map((r) => r.table_name);
    if (allTables.length === 0) {
      console.log("\nNo tables found in schema 'crm'. Nothing to do.");
      return;
    }

    // Split into what actually gets truncated vs. the preserved Platform
    // Admin island (see PRESERVED_PLATFORM_ADMIN_TABLES's own comment up
    // top for exactly why these 4, and not platform_notifications/
    // platform_notification_reads too).
    const missingPreserved = PRESERVED_PLATFORM_ADMIN_TABLES.filter((t) => !allTables.includes(t));
    if (missingPreserved.length > 0) {
      console.warn(
        `\nWARNING: expected to find and preserve these Platform Admin tables, but they don't exist in 'crm': ` +
          `${missingPreserved.join(", ")}. They can't be excluded if they don't exist — check for a rename/migration ` +
          `drift before proceeding.`,
      );
    }
    const preserved = PRESERVED_PLATFORM_ADMIN_TABLES.filter((t) => allTables.includes(t));
    const tables = allTables.filter((t) => !preserved.includes(t));

    console.log(`\n=== Tables in 'crm' (${allTables.length}) — row counts BEFORE ===`);
    let totalBefore = 0;
    for (const t of allTables) {
      const {
        rows: [{ n }],
      } = await client.query(`SELECT count(*)::int AS n FROM crm.${t};`);
      const tag = preserved.includes(t) ? "  [PRESERVED]" : "";
      console.log(`  ${t.padEnd(35)} ${n}${tag}`);
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
    for (const t of preserved) {
      console.log(`  crm.${t} — Platform Admin data, preserved. See PRESERVED_PLATFORM_ADMIN_TABLES's comment at the top of this file.`);
    }
    console.log(
      `  crm.platform_notifications, crm.platform_notification_reads — NOT preserved, even though they're platform_*- ` +
        `prefixed: they reference companies.id/users.id ON DELETE CASCADE (they're notifications ABOUT tenants, not ` +
        `admin bookkeeping), so they truncate along with the rest of the tenant data below.`,
    );

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
    console.log(`  TOTAL AFTER (truncated tables only): ${totalAfter} rows (expected 0)`);

    console.log("\n=== Platform Admin data — unchanged (verification) ===");
    let totalPreserved = 0;
    for (const t of preserved) {
      const {
        rows: [{ n }],
      } = await client.query(`SELECT count(*)::int AS n FROM crm.${t};`);
      console.log(`  ${t.padEnd(35)} ${n}`);
      totalPreserved += n;
    }
    console.log(`  TOTAL PRESERVED: ${totalPreserved} rows`);

    console.log("\n=== Summary ===");
    console.log(`Database name used: ${db}`);
    console.log(`Tables cleared (${tables.length}): ${tables.join(", ")}`);
    console.log(`Tables preserved (${preserved.length}): ${preserved.length ? preserved.join(", ") : "(none found)"}`);
    console.log(
      `Schema preserved: YES — TRUNCATE is DML only; no DROP/ALTER was issued against any table, column, index, ` +
        `constraint, function, or type.`,
    );
    console.log(
      `Identity sequences reset: YES — RESTART IDENTITY was included in the TRUNCATE (a no-op for UUID-keyed ` +
        `tables that own no sequence, which is most tables in this schema).`,
    );
    console.log(
      `Tables intentionally excluded: Drizzle's migration-history table (lives outside the 'crm' schema), plus the ` +
        `${preserved.length} Platform Admin tables above — see both sections above.`,
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
