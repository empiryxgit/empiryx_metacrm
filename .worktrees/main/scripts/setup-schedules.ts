// Run once after each deploy (or whenever PUBLIC_BASE_URL changes):
//   npm run setup:schedules
//
// Registers the recurring reconciliation schedule with QStash. This is a
// one-time/idempotent setup step, not something the app does on every
// request - QStash schedules persist independently of your deployments.

import { ensureReconciliationSchedule } from "../src/infrastructure/queue/qstash";

async function main() {
  const cron = process.env.RECONCILIATION_CRON ?? "*/15 * * * *"; // every 15 minutes
  const scheduleId = await ensureReconciliationSchedule({ cron });
  console.log(`Reconciliation schedule active: ${scheduleId} (${cron})`);
}

main().catch((err) => {
  console.error("Failed to set up QStash schedules:", err);
  process.exit(1);
});
