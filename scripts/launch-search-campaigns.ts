#!/usr/bin/env tsx
/**
 * Launch ELM Search campaigns — IDEMPOTENT.
 * Creates 5 Search campaigns (Mulch, Topsoil, Gravel, Stone, Sand), all PAUSED.
 * Each gets one ad group with Phrase + Exact keywords + campaign negatives.
 *
 * Usage: LAUNCH_USER_EMAIL=adam@easternlm.com npx tsx scripts/launch-search-campaigns.ts
 */

import "dotenv/config";
import { GoogleAdsCampaignAgent } from "../src/agents/campaigns/googleAdsCampaignAgent";
import { MATERIAL_CATEGORIES } from "../src/agents/campaigns/campaign-definitions";

async function main() {
  const triggeredBy = process.env.LAUNCH_USER_EMAIL;
  if (!triggeredBy || triggeredBy === "system") {
    console.error("Set LAUNCH_USER_EMAIL to the admin email running this launch.");
    process.exit(1);
  }

  const agent = new GoogleAdsCampaignAgent("eastern-lm");

  console.log("═══════════════════════════════════════════════════");
  console.log(" ELM Search Campaign Launch");
  console.log("═══════════════════════════════════════════════════");
  console.log(`Triggered by: ${triggeredBy}\n`);

  for (const category of MATERIAL_CATEGORIES) {
    // Idempotency check
    const exists = await agent.campaignExists(category.campaignName);
    if (exists) {
      console.log(`⏭️  ${category.campaignName} already exists — skipping`);
      continue;
    }

    console.log(`Creating ${category.campaignName}...`);

    // Create campaign (PAUSED)
    const { campaignId, resourceName } = await agent.createSearchCampaign(
      { name: category.campaignName, budgetCentsDaily: category.budgetCentsDaily },
      triggeredBy
    );

    // Create ad group
    const { resourceName: adGroupResource } = await agent.createAdGroup(
      resourceName,
      { name: `${category.campaignName}-Core` },
      triggeredBy
    );

    // Add keywords (Phrase + Exact)
    const kwCount = await agent.createKeywords(
      adGroupResource,
      category.keywords,
      triggeredBy
    );

    // Add campaign negatives
    await agent.createCampaignNegatives(resourceName, category.negatives, triggeredBy);

    console.log(`✅ ${category.campaignName} created (PAUSED) — ID: ${campaignId}, ${kwCount} keywords`);
  }

  console.log("\n🎯 All Search campaigns created PAUSED. Activate in Google Ads after review.");
}

main().catch((err) => {
  console.error("\n❌ Launch failed:", err.message || err);
  if (err.errors) console.error("Details:", JSON.stringify(err.errors, null, 2));
  process.exit(1);
});
