// Run once after each deploy (or whenever PUBLIC_BASE_URL changes):
//   npm run setup:schedules
//
// Registers the recurring reconciliation AND insight-scan schedules with
// QStash. This is a one-time/idempotent setup step, not something the app
// does on every request - QStash schedules persist independently of your
// deployments.

import { ensureInsightScanSchedule, ensureReconciliationSchedule } from "../src/infrastructure/queue/qstash";

async function main() {
  const reconciliationCron = process.env.RECONCILIATION_CRON ?? "*/15 * * * *"; // every 15 minutes
  const reconciliationScheduleId = await ensureReconciliationSchedule({ cron: reconciliationCron });
  console.log(`Reconciliation schedule active: ${reconciliationScheduleId} (${reconciliationCron})`);

  // RUTA Insight/Alert Engine (Phase E) - every 30 minutes by default. One
  // global schedule, not one per tenant - see insightScanService.ts's own
  // header comment.
  const insightScanCron = process.env.INSIGHT_SCAN_CRON ?? "*/30 * * * *";
  const insightScanScheduleId = await ensureInsightScanSchedule({ cron: insightScanCron });
  console.log(`Insight scan schedule active: ${insightScanScheduleId} (${insightScanCron})`);
}

main().catch((err) => {
  console.error("Failed to set up QStash schedules:", err);
  process.exit(1);
});
