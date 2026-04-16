#!/usr/bin/env tsx
/**
 * Phase 00 — Google Ads + Merchant API Bootstrap
 *
 * Idempotent script that creates:
 *   1. Conversion action "Website Order" (Purchase, data-driven attribution)
 *   2. Conversion action "Quote Submit" (Lead form, PMax audience signal)
 *   3. OmnichannelSettings for US region (enables LIA program)
 *
 * Store entity: comes from GBP link (already verified + linked to GMC).
 * The Merchant API LfpStoreServiceClient is for feed partners, not merchants.
 *
 * Usage: npx tsx scripts/google-bootstrap.ts
 * Env:   Reads from .env.local or process.env
 */

import "dotenv/config";
import { z } from "zod";
import { GoogleAdsApi, enums } from "google-ads-api";
import { OmnichannelSettingsServiceClient } from "@google-shopping/accounts";
import { OAuth2Client } from "google-auth-library";
import { writeFileSync } from "fs";
import { join } from "path";

// ── Env validation ──────────────────────────────────────────────
const envSchema = z.object({
  GOOGLE_ADS_DEVELOPER_TOKEN: z.string().min(1),
  GOOGLE_ADS_CUSTOMER_ID: z.string().regex(/^\d+$/, "Must be digits only, no dashes"),
  GMC_MERCHANT_ID: z.string().regex(/^\d+$/),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1),
  GOOGLE_ADS_REFRESH_TOKEN: z.string().min(1),
});

const env = envSchema.safeParse(process.env);
if (!env.success) {
  console.error("❌ Missing or invalid environment variables:");
  for (const issue of env.error.issues) {
    console.error(`   ${issue.path.join(".")}: ${issue.message}`);
  }
  console.error("\nSet these in .env.local or VPS env before running.");
  process.exit(1);
}

const {
  GOOGLE_ADS_DEVELOPER_TOKEN,
  GOOGLE_ADS_CUSTOMER_ID,
  GMC_MERCHANT_ID,
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
  GOOGLE_ADS_REFRESH_TOKEN,
} = env.data;

// ── Constants ───────────────────────────────────────────────────
const STORE_CODE = "ELM-FROWEIN-01";
const STORE_URI = "https://easternlm.com";

// ── Results tracking ────────────────────────────────────────────
const results: Record<string, unknown> = {
  phase: "00",
  ranAt: new Date().toISOString(),
  googleAdsCustomerId: GOOGLE_ADS_CUSTOMER_ID,
  gmcMerchantId: GMC_MERCHANT_ID,
  storeCode: STORE_CODE,
};

// ── Google Ads client ───────────────────────────────────────────
const googleAds = new GoogleAdsApi({
  client_id: GOOGLE_OAUTH_CLIENT_ID,
  client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
  developer_token: GOOGLE_ADS_DEVELOPER_TOKEN,
});

const customer = googleAds.Customer({
  customer_id: GOOGLE_ADS_CUSTOMER_ID,
  refresh_token: GOOGLE_ADS_REFRESH_TOKEN,
  // login_customer_id: undefined — Path B, no MCC
});

// ── OAuth2 client for Merchant API ──────────────────────────────
function getMerchantAuthClient(): OAuth2Client {
  const oauth2 = new OAuth2Client(GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: GOOGLE_ADS_REFRESH_TOKEN });
  return oauth2;
}

// ════════════════════════════════════════════════════════════════
// 1 & 2. Conversion Actions
// ════════════════════════════════════════════════════════════════
async function ensureConversionAction(
  name: string,
  config: {
    category: number;
    alwaysUseDefault: boolean;
  }
): Promise<string> {
  console.log(`\n🔍 Checking conversion action "${name}"...`);

  // Search for existing
  const query = `
    SELECT conversion_action.resource_name, conversion_action.name
    FROM conversion_action
    WHERE conversion_action.name = '${name}'
  `;

  try {
    const rows = await customer.query(query);
    if (rows.length > 0) {
      const resourceName = (rows[0] as any).conversion_action?.resource_name;
      console.log(`   ✅ Already exists: ${resourceName}`);
      return resourceName;
    }
  } catch (err: any) {
    console.log(`   ⚠️  Query error (may be first run): ${err.message?.slice(0, 120)}`);
  }

  // Create
  console.log(`   Creating "${name}"...`);
  try {
    const result = await customer.conversionActions.create([
      {
        name,
        category: config.category,
        type: enums.ConversionActionType.UPLOAD_CLICKS,
        status: enums.ConversionActionStatus.ENABLED,
        value_settings: {
          default_value: 0,
          default_currency_code: "USD",
          always_use_default_value: config.alwaysUseDefault,
        },
        counting_type: enums.ConversionActionCountingType.ONE_PER_CLICK,
        click_through_lookback_window_days: 30,
        view_through_lookback_window_days: 1,
      },
    ]);

    const resourceName = result.results?.[0]?.resource_name;
    console.log(`   ✅ Created: ${resourceName}`);
    return resourceName || "UNKNOWN";
  } catch (err: any) {
    if (err.message?.includes("DUPLICATE_NAME") || err.message?.includes("already exists")) {
      console.log(`   ⚠️  Already exists (race). Re-querying...`);
      const rows = await customer.query(
        `SELECT conversion_action.resource_name FROM conversion_action WHERE conversion_action.name = '${name}'`
      );
      const resourceName = (rows[0] as any).conversion_action?.resource_name;
      return resourceName || "UNKNOWN";
    }
    throw err;
  }
}

// ════════════════════════════════════════════════════════════════
// 3. OmnichannelSettings for US
// ════════════════════════════════════════════════════════════════
async function ensureOmnichannelSettings(): Promise<string> {
  console.log(`\n🔍 Checking OmnichannelSettings for US...`);

  const authClient = getMerchantAuthClient();
  const client = new OmnichannelSettingsServiceClient({ authClient: authClient as any });
  const parent = `accounts/${GMC_MERCHANT_ID}`;
  const name = `${parent}/omnichannelSettings/US`;

  // Check if exists
  try {
    const response = await client.getOmnichannelSetting({ name });
    const settings = Array.isArray(response) ? response[0] : response;
    console.log(`   ✅ Already exists: ${(settings as any).name || name}`);
    return (settings as any).name || name;
  } catch (err: any) {
    if (err.code !== 5) {
      // 5 = NOT_FOUND — expected if not yet created
      console.log(`   ⚠️  Error checking (code ${err.code}): ${err.message?.slice(0, 120)}`);
      console.log(`   Attempting to create anyway...`);
    } else {
      console.log(`   Not found. Creating...`);
    }
  }

  // Create
  try {
    const response = await client.createOmnichannelSetting({
      parent,
      omnichannelSetting: {
        regionCode: "US",
        lsfType: "GHLSF",
        inStock: { uri: `${STORE_URI}/shop` },
        pickup: { uri: `${STORE_URI}/delivery` },
      },
    });
    const settings = Array.isArray(response) ? response[0] : response;
    console.log(`   ✅ Created: ${(settings as any).name || name}`);
    return (settings as any).name || name;
  } catch (err: any) {
    if (err.message?.includes("ALREADY_EXISTS") || err.code === 6) {
      console.log(`   ✅ Already exists (confirmed).`);
      return name;
    }
    // Non-fatal: log and continue — omnichannel might need manual setup
    console.log(`   ⚠️  Could not create OmnichannelSettings: ${err.message?.slice(0, 200)}`);
    console.log(`   This may need manual setup in GMC. Continuing...`);
    return `MANUAL_SETUP_REQUIRED`;
  }
}

// ════════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════════
async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log(" ELM Phase 00 — Google Ads + Merchant API Bootstrap");
  console.log("═══════════════════════════════════════════════════");
  console.log(`Customer ID:  ${GOOGLE_ADS_CUSTOMER_ID}`);
  console.log(`Merchant ID:  ${GMC_MERCHANT_ID}`);
  console.log(`Store Code:   ${STORE_CODE}`);

  // 1. Conversion action: Website Order (primary — Purchase)
  const purchaseAction = await ensureConversionAction("Website Order", {
    category: enums.ConversionActionCategory.PURCHASE,
    alwaysUseDefault: false,
  });
  results.conversionActionPurchase = purchaseAction;

  // 2. Conversion action: Quote Submit (secondary — Lead)
  const leadAction = await ensureConversionAction("Quote Submit", {
    category: enums.ConversionActionCategory.SUBMIT_LEAD_FORM,
    alwaysUseDefault: true,
  });
  results.conversionActionLead = leadAction;

  // 3. OmnichannelSettings for US (enables LIA program)
  const omnichannelName = await ensureOmnichannelSettings();
  results.omnichannelSettings = omnichannelName;

  // Note: Store entity comes from GBP link (already verified + linked to GMC).
  // LfpStoreServiceClient is for feed partners, not merchants.
  results.storeNote = "Store entity managed via GBP link, not Merchant API LFP";

  // ── Summary ────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════");
  console.log(" ✅ Phase 00 bootstrap complete.");
  console.log("═══════════════════════════════════════════════════");
  console.log(`\nAdd these to VPS env:`);
  console.log(`  CONVERSION_ACTION_PURCHASE=${purchaseAction}`);
  console.log(`  CONVERSION_ACTION_LEAD=${leadAction}`);
  console.log(`\nStore: ${STORE_CODE} (via GBP link)`);
  console.log(`OmnichannelSettings: ${omnichannelName}`);

  // Write result file
  const outPath = join(__dirname, "..", "docs", "phase-00-bootstrap-result.json");
  writeFileSync(outPath, JSON.stringify(results, null, 2) + "\n");
  console.log(`\nResults written to: ${outPath}`);
}

main().catch((err) => {
  console.error("\n❌ Bootstrap failed:", err.message || err);
  if (err.errors) console.error("Details:", JSON.stringify(err.errors, null, 2));
  process.exit(1);
});
