/**
 * googleAdsOptimizerAgent — Nightly rule-based analysis of campaign performance.
 * Generates recommendations stored in mktg_google_recommendations.
 * Runs after performance pull (6 AM UTC, 1 hour after pull).
 */

import { createClient } from "@supabase/supabase-js";
import { getBrandAccount } from "../../auth/google";
import { writeAuditAction } from "../../guardrails/audit";
import { OPTIMIZER_CONFIG } from "./rules/config";

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

type CampaignPerf = {
  google_campaign_id: string;
  name: string;
  type: string;
  status: string;
  budget_cents_daily: number;
  target_cpa_cents: number | null;
  totalSpendCents: number;
  totalConversions: number;
  totalConvValueCents: number;
  totalClicks: number;
  totalImpressions: number;
  dataDays: number;
  roas: number;
  cpa: number | null;
};

type Recommendation = {
  brand_id: string;
  google_campaign_id: string;
  type: string;
  reason: string;
  proposed_change: Record<string, unknown>;
  estimated_impact: Record<string, unknown> | null;
  created_by_agent: string;
  status: string;
};

async function getCampaignPerformance(brandId: string, days: number): Promise<CampaignPerf[]> {
  // Get campaigns
  const { data: campaigns } = await (supabase as any)
    .from("mktg_google_campaigns")
    .select("google_campaign_id, name, type, status, budget_cents_daily, target_cpa_cents")
    .eq("brand_id", brandId)
    .neq("status", "REMOVED");

  if (!campaigns?.length) return [];

  // Get performance data
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startStr = startDate.toISOString().split("T")[0];

  const { data: perf } = await (supabase as any)
    .from("mktg_google_performance")
    .select("google_campaign_id, cost_micros, conversions, conversion_value_micros, clicks, impressions, date")
    .eq("brand_id", brandId)
    .gte("date", startStr);

  // Aggregate per campaign
  return campaigns.map((c: any) => {
    const rows = (perf || []).filter((p: any) => p.google_campaign_id === c.google_campaign_id);
    const totalCostMicros = rows.reduce((s: number, r: any) => s + Number(r.cost_micros || 0), 0);
    const totalConv = rows.reduce((s: number, r: any) => s + Number(r.conversions || 0), 0);
    const totalConvValueMicros = rows.reduce((s: number, r: any) => s + Number(r.conversion_value_micros || 0), 0);
    const totalClicks = rows.reduce((s: number, r: any) => s + Number(r.clicks || 0), 0);
    const totalImpressions = rows.reduce((s: number, r: any) => s + Number(r.impressions || 0), 0);
    const uniqueDates = new Set(rows.map((r: any) => r.date));

    const totalSpendCents = Math.round(totalCostMicros / 10000);
    const totalConvValueCents = Math.round(totalConvValueMicros / 10000);
    const roas = totalCostMicros > 0 ? totalConvValueMicros / totalCostMicros : 0;
    const cpa = totalConv > 0 ? totalSpendCents / totalConv : null;

    return {
      google_campaign_id: c.google_campaign_id,
      name: c.name,
      type: c.type,
      status: c.status,
      budget_cents_daily: c.budget_cents_daily || 0,
      target_cpa_cents: c.target_cpa_cents,
      totalSpendCents,
      totalConversions: totalConv,
      totalConvValueCents,
      totalClicks,
      totalImpressions,
      dataDays: uniqueDates.size,
      roas,
      cpa,
    };
  });
}

function runRules(campaigns: CampaignPerf[], brandId: string): Recommendation[] {
  const recs: Recommendation[] = [];
  const cfg = OPTIMIZER_CONFIG;

  for (const c of campaigns) {
    if (c.status !== "ENABLED") continue;

    // R1: Budget winner
    if (c.roas >= cfg.r1.minRoas && c.dataDays >= cfg.r1.minDataDays) {
      recs.push({
        brand_id: brandId,
        google_campaign_id: c.google_campaign_id,
        type: "BUDGET_INCREASE",
        reason: `${c.name}: ROAS ${c.roas.toFixed(1)}x over ${c.dataDays}d. Recommend +${cfg.r1.budgetIncreasePercent * 100}% budget.`,
        proposed_change: {
          field: "budget_cents_daily",
          from: c.budget_cents_daily,
          to: Math.round(c.budget_cents_daily * (1 + cfg.r1.budgetIncreasePercent)),
        },
        estimated_impact: { metric: "conversions", delta: "+15-20%" },
        created_by_agent: "googleAdsOptimizerAgent",
        status: "pending",
      });
    }

    // R2: Unprofitable (non-PMax)
    if (
      c.type !== "PERFORMANCE_MAX" &&
      c.roas < cfg.r2.maxRoas &&
      c.totalSpendCents >= cfg.r2.minSpendCents &&
      c.dataDays >= cfg.r2.minDataDays
    ) {
      recs.push({
        brand_id: brandId,
        google_campaign_id: c.google_campaign_id,
        type: "PAUSE_CAMPAIGN",
        reason: `${c.name}: ROAS ${c.roas.toFixed(2)}x with $${(c.totalSpendCents / 100).toFixed(0)} spend over ${c.dataDays}d. Recommend pause.`,
        proposed_change: { field: "status", from: "ENABLED", to: "PAUSED" },
        estimated_impact: { metric: "cost", delta: `-$${(c.budget_cents_daily / 100).toFixed(0)}/day` },
        created_by_agent: "googleAdsOptimizerAgent",
        status: "pending",
      });
    }

    // R5: Stalled PMax
    if (
      c.type === "PERFORMANCE_MAX" &&
      c.dataDays >= cfg.r5.minDataDays &&
      c.totalConversions < cfg.r5.maxConversions
    ) {
      recs.push({
        brand_id: brandId,
        google_campaign_id: c.google_campaign_id,
        type: "PAUSE_CAMPAIGN",
        reason: `PMax ${c.name}: only ${c.totalConversions} conversions in ${c.dataDays}d. Consider pausing or lowering target ROAS.`,
        proposed_change: { field: "status", from: "ENABLED", to: "PAUSED" },
        estimated_impact: null,
        created_by_agent: "googleAdsOptimizerAgent",
        status: "pending",
      });
    }

    // R6: Zero impressions
    if (c.dataDays >= cfg.r6.minDataDays && c.totalImpressions === 0) {
      recs.push({
        brand_id: brandId,
        google_campaign_id: c.google_campaign_id,
        type: "INVESTIGATE",
        reason: `${c.name}: 0 impressions for ${c.dataDays} days. Check for disapprovals, low bids, or targeting issues.`,
        proposed_change: { action: "investigate" },
        estimated_impact: null,
        created_by_agent: "googleAdsOptimizerAgent",
        status: "pending",
      });
    }
  }

  return recs;
}

async function deduplicateAndInsert(recs: Recommendation[]): Promise<number> {
  let inserted = 0;
  for (const rec of recs) {
    // Check for existing pending rec of same type for same campaign
    const { data: existing } = await (supabase as any)
      .from("mktg_google_recommendations")
      .select("id")
      .eq("brand_id", rec.brand_id)
      .eq("google_campaign_id", rec.google_campaign_id)
      .eq("type", rec.type)
      .eq("status", "pending")
      .limit(1);

    if (existing?.length) continue;

    await (supabase as any).from("mktg_google_recommendations").insert(rec);
    inserted++;
  }
  return inserted;
}

async function expireOldRecommendations(brandId: string): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - OPTIMIZER_CONFIG.recommendationExpiryDays);

  const { data } = await (supabase as any)
    .from("mktg_google_recommendations")
    .update({ status: "expired" })
    .eq("brand_id", brandId)
    .eq("status", "pending")
    .lt("created_at", cutoff.toISOString())
    .select("id");

  return data?.length || 0;
}

export async function runOptimizer(brandId: string): Promise<{ generated: number; expired: number }> {
  const campaigns = await getCampaignPerformance(brandId, 14);
  const recs = runRules(campaigns, brandId);
  const inserted = await deduplicateAndInsert(recs);
  const expired = await expireOldRecommendations(brandId);

  await writeAuditAction({
    brandId,
    agentName: "googleAdsOptimizerAgent",
    action: "run_daily",
    payload: { campaignsAnalyzed: campaigns.length, rulesEvaluated: recs.length },
    result: { generated: inserted, expired },
    status: "success",
    triggeredBy: "system",
  });

  return { generated: inserted, expired };
}
