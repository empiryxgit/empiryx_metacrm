// Run manually to list and clean up orphaned or stale QStash schedules:
//   npm run cleanup:schedules

import { cleanupStaleSchedules } from "../src/infrastructure/queue/qstash";

async function main() {
  console.log("Cleaning up stale QStash schedules not matching current PUBLIC_BASE_URL...");
  const result = await cleanupStaleSchedules();
  console.log(`Cleanup completed. Deleted ${result.deleted} stale schedule(s).`);
}

main().catch((err) => {
  console.error("Failed to clean up QStash schedules:", err);
  process.exit(1);
});
