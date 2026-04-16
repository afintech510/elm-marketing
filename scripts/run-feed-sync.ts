#!/usr/bin/env tsx
/**
 * Manual feed sync trigger — runs the googleAdsFeedAgent for eastern-lm.
 * Usage: npx tsx scripts/run-feed-sync.ts
 */

import "dotenv/config";
import { runFeedSync } from "../src/agents/feed/googleAdsFeedAgent";

async function main() {
  console.log("Starting feed sync for eastern-lm...\n");
  const result = await runFeedSync("eastern-lm");

  console.log(`\n═══════════════════════════════════════`);
  console.log(` Feed sync complete`);
  console.log(`═══════════════════════════════════════`);
  console.log(`  Synced:  ${result.synced}`);
  console.log(`  Errors:  ${result.errors}`);
  console.log(`  Removed: ${result.removed}`);

  if (result.errors > 0) {
    console.log(`\nErrors:`);
    for (const d of result.details.filter((x) => x.status === "error")) {
      console.log(`  ${d.slug} [${d.channel}]: ${d.error}`);
    }
  }
}

main().catch((err) => {
  console.error("Feed sync failed:", err.message);
  process.exit(1);
});
