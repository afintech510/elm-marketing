/**
 * Uploads paid orders with GCLID as offline conversions to Google Ads.
 * Runs every 15 minutes. Deduplicates via mktg_google_conversions_uploaded.
 */

import { createClient } from "@supabase/supabase-js";
import { getGoogleAdsClient, getBrandAccount } from "../../auth/google";
import { writeAuditAction } from "../../guardrails/audit";

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

type UploadResult = {
  uploaded: number;
  skipped: number;
  failed: number;
  noGclid: number;
};

export async function uploadConversions(brandId: string): Promise<UploadResult> {
  const account = await getBrandAccount(brandId);
  const conversionAction = account.conversion_action_purchase;
  if (!conversionAction) {
    throw new Error("No conversion_action_purchase configured");
  }

  // Find paid orders with GCLID that haven't been uploaded yet
  const { data: orders, error } = await (supabase as any)
    .from("orders")
    .select("id, gclid, grand_total_cents, created_at, status")
    .not("gclid", "is", null)
    .in("status", ["paid", "delivered", "completed"])
    .not("id", "in", `(SELECT order_id FROM mktg_google_conversions_uploaded)`)
    .order("created_at", { ascending: true })
    .limit(500);

  if (error) throw new Error(`Failed to query orders: ${error.message}`);
  if (!orders || orders.length === 0) {
    return { uploaded: 0, skipped: 0, failed: 0, noGclid: 0 };
  }

  const customer = await getGoogleAdsClient(brandId);
  const result: UploadResult = { uploaded: 0, skipped: 0, failed: 0, noGclid: 0 };

  for (const order of orders) {
    if (!order.gclid) {
      result.noGclid++;
      continue;
    }

    // Check GCLID age (Google rejects >90 days)
    const orderDate = new Date(order.created_at);
    const daysSinceOrder = (Date.now() - orderDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceOrder > 90) {
      await (supabase as any).from("mktg_google_conversions_uploaded").insert({
        brand_id: brandId,
        order_id: order.id,
        gclid: order.gclid,
        conversion_action_resource: conversionAction,
        upload_status: "expired",
        error_message: `GCLID expired (${Math.round(daysSinceOrder)} days old)`,
      });
      result.skipped++;
      continue;
    }

    try {
      await customer.conversionUploads.uploadClickConversions({
        customer_id: account.google_customer_id,
        conversions: [
          {
            gclid: order.gclid,
            conversion_action: conversionAction,
            conversion_date_time: new Date(order.created_at)
              .toISOString()
              .replace("T", " ")
              .replace("Z", "+00:00"),
            conversion_value: order.grand_total_cents / 100,
            currency_code: "USD",
          },
        ],
        partial_failure: true,
      });

      await (supabase as any).from("mktg_google_conversions_uploaded").insert({
        brand_id: brandId,
        order_id: order.id,
        gclid: order.gclid,
        conversion_action_resource: conversionAction,
        upload_status: "success",
      });
      result.uploaded++;
    } catch (err: any) {
      const errorMsg = err.message?.slice(0, 500) || "Unknown error";
      const status = errorMsg.includes("INVALID_GCLID") ? "invalid_gclid" : "failed";

      await (supabase as any).from("mktg_google_conversions_uploaded").insert({
        brand_id: brandId,
        order_id: order.id,
        gclid: order.gclid,
        conversion_action_resource: conversionAction,
        upload_status: status,
        error_message: errorMsg,
      });
      result.failed++;
    }
  }

  // Audit
  await writeAuditAction({
    brandId,
    agentName: "conversionUpload",
    action: "upload_batch",
    payload: { orderCount: orders.length },
    result,
    status: result.failed === 0 ? "success" : "error",
    triggeredBy: "system",
  });

  return result;
}
