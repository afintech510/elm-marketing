#!/usr/bin/env tsx
/**
 * Manual performance pull — backfills last N days (default 7).
 * Usage: npx tsx scripts/pull-performance.ts [days]
 */
import "dotenv/config";
import { pullBackfill } from "../src/agents/performance/pull-performance";

const days = parseInt(process.argv[2] || "7", 10);
console.log(`Pulling ${days} days of performance data for eastern-lm...`);

pullBackfill("eastern-lm", days)
  .then((r) => console.log(`Done: ${r.rows} rows across ${r.campaigns} campaigns`))
  .catch((e) => { console.error("Failed:", e.message); process.exit(1); });
