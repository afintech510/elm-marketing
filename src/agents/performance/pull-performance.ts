/**
 * Pulls daily Google Ads performance data into mktg_google_performance.
 * Runs daily at 5 AM UTC for the previous day, weekly backfill on Mondays.
 */

import { createClient } from "@supabase/supabase-js";
import { getGoogleAdsClient, getBrandAccount } from "../../auth/google";
import { writeAuditAction } from "../../guardrails/audit";

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

type PerfRow = {
  brand_id: string;
  google_campaign_id: string;
  date: string;
  impressions: number;
  clicks: number;
  cost_micros: number;
  conversions: number;
  conversion_value_micros: number;
  ctr: number | null;
  avg_cpc_micros: number | null;
  roas: number | null;
};

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

export async function pullPerformance(
  brandId: string,
  startDate: string,
  endDate: string
): Promise<{ rows: number; campaigns: number }> {
  const customer = await getGoogleAdsClient(brandId);

  const query = `
    SELECT
      campaign.id,
      campaign.name,
      segments.date,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      metrics.ctr,
      metrics.average_cpc
    FROM campaign
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
      AND campaign.status != 'REMOVED'
    ORDER BY segments.date DESC, metrics.cost_micros DESC
  `;

  const results = await customer.query(query);

  const rows: PerfRow[] = results.map((row: any) => {
    const costMicros = Number(row.metrics?.cost_micros || 0);
    const convValueMicros = Math.round((Number(row.metrics?.conversions_value || 0)) * 1_000_000);
    const roas = costMicros > 0 ? convValueMicros / costMicros : null;

    return {
      brand_id: brandId,
      google_campaign_id: String(row.campaign?.id || ""),
      date: String(row.segments?.date || ""),
      impressions: Number(row.metrics?.impressions || 0),
      clicks: Number(row.metrics?.clicks || 0),
      cost_micros: costMicros,
      conversions: Number(row.metrics?.conversions || 0),
      conversion_value_micros: convValueMicros,
      ctr: row.metrics?.ctr != null ? Number(row.metrics.ctr) : null,
      avg_cpc_micros: row.metrics?.average_cpc != null ? Number(row.metrics.average_cpc) : null,
      roas,
    };
  });

  if (rows.length === 0) {
    return { rows: 0, campaigns: 0 };
  }

  // Upsert to mktg_google_performance
  const { error } = await (supabase as any)
    .from("mktg_google_performance")
    .upsert(rows, { onConflict: "brand_id,google_campaign_id,date" });

  if (error) {
    throw new Error(`Failed to upsert performance data: ${error.message}`);
  }

  const uniqueCampaigns = new Set(rows.map((r) => r.google_campaign_id));

  // Audit
  await writeAuditAction({
    brandId,
    agentName: "performancePull",
    action: "pull_daily",
    payload: { startDate, endDate },
    result: { rows: rows.length, campaigns: uniqueCampaigns.size },
    status: "success",
    triggeredBy: "system",
  });

  return { rows: rows.length, campaigns: uniqueCampaigns.size };
}

/** Pull yesterday's data (default daily job) */
export async function pullYesterday(brandId: string) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = formatDate(yesterday);
  return pullPerformance(brandId, dateStr, dateStr);
}

/** Backfill last N days */
export async function pullBackfill(brandId: string, days: number = 7) {
  const end = new Date();
  end.setDate(end.getDate() - 1);
  const start = new Date();
  start.setDate(start.getDate() - days);
  return pullPerformance(brandId, formatDate(start), formatDate(end));
}
