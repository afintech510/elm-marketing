/**
 * googleAdsCampaignAgent — Creates and manages Google Ads campaigns.
 * Every mutation routes through guardMutation(). No exceptions.
 */

import { createClient } from "@supabase/supabase-js";
import { getGoogleAdsClient } from "../../auth/google";
import { guardMutation } from "../../guardrails/mutation-guard";
import { updateAuditAction } from "../../guardrails/audit";
import { enums } from "google-ads-api";
import { ELM_GEO_TARGET } from "./campaign-definitions";

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

function centsToMicros(cents: number): number {
  return cents * 10000;
}

function extractId(resourceName: string): string {
  // e.g., "customers/123/campaigns/456" → "456"
  return resourceName.split("/").pop() || resourceName;
}

export class GoogleAdsCampaignAgent {
  constructor(private brandId: string) {}

  // ── Search Campaign ─────────────────────────────────────────
  async createSearchCampaign(
    params: { name: string; budgetCentsDaily: number },
    triggeredBy: string
  ): Promise<{ campaignId: string; resourceName: string }> {
    // Budget delta is 0 because campaign launches PAUSED (doesn't spend)
    const auditId = await guardMutation({
      brandId: this.brandId,
      action: "create_search_campaign",
      payload: params,
      triggeredBy,
      budgetDeltaCents: 0,
    });

    try {
      const customer = await getGoogleAdsClient(this.brandId);

      // Create budget with unique name (prevents collisions from partial runs)
      const budgetName = `${params.name}-Budget-${Date.now()}`;
      const budgetResult = await customer.campaignBudgets.create([
        {
          name: budgetName,
          amount_micros: centsToMicros(params.budgetCentsDaily),
          delivery_method: enums.BudgetDeliveryMethod.STANDARD,
          explicitly_shared: false,
        },
      ]);
      const budgetResource = budgetResult.results[0].resource_name!;

      // Create campaign (ALWAYS PAUSED)
      const campaignResult = await customer.campaigns.create([
        {
          name: params.name,
          status: enums.CampaignStatus.PAUSED,
          advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
          campaign_budget: budgetResource,
          maximize_conversions: {}, // MAXIMIZE_CONVERSIONS bidding strategy
          network_settings: {
            target_google_search: true,
            target_search_network: true,
            target_content_network: false,
            target_partner_search_network: false,
          },
          // Required in Google Ads API v21+ (field name from proto, not the enum name)
          contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
        },
      ]);
      const campaignResource = campaignResult.results[0].resource_name!;
      const campaignId = extractId(campaignResource);

      // Geo targeting — 50-mile radius
      await customer.campaignCriteria.create([
        {
          campaign: campaignResource,
          proximity: {
            address: {
              city_name: "Center Moriches",
              province_code: "NY",
              country_code: "US",
              postal_code: "11934",
            },
            radius: ELM_GEO_TARGET.radiusMiles,
            radius_units: enums.ProximityRadiusUnits.MILES,
            geo_point: {
              latitude_in_micro_degrees: Math.round(ELM_GEO_TARGET.latitude * 1e6),
              longitude_in_micro_degrees: Math.round(ELM_GEO_TARGET.longitude * 1e6),
            },
          },
        },
      ]);

      // Mirror to DB
      await (supabase as any).from("mktg_google_campaigns").insert({
        brand_id: this.brandId,
        google_campaign_id: campaignId,
        name: params.name,
        type: "SEARCH",
        status: "PAUSED",
        budget_cents_daily: params.budgetCentsDaily,
        bidding_strategy: "MAXIMIZE_CONVERSIONS",
        created_by_agent: true,
      });

      await updateAuditAction(auditId, {
        status: "success",
        targetResource: campaignResource,
        result: { campaignId },
      });

      return { campaignId, resourceName: campaignResource };
    } catch (err: any) {
      await updateAuditAction(auditId, {
        status: "error",
        result: { error: err.message?.slice(0, 500) },
      });
      throw err;
    }
  }

  // ── Ad Group ────────────────────────────────────────────────
  async createAdGroup(
    campaignResource: string,
    params: { name: string; cpcBidMicros?: number },
    triggeredBy: string
  ): Promise<{ adGroupId: string; resourceName: string }> {
    const auditId = await guardMutation({
      brandId: this.brandId,
      action: "create_ad_group",
      payload: { campaign: campaignResource, ...params },
      triggeredBy,
    });

    try {
      const customer = await getGoogleAdsClient(this.brandId);
      const result = await customer.adGroups.create([
        {
          name: params.name,
          campaign: campaignResource,
          status: enums.AdGroupStatus.ENABLED,
          type: enums.AdGroupType.SEARCH_STANDARD,
          cpc_bid_micros: params.cpcBidMicros || 1500000, // $1.50 default
        },
      ]);
      const resource = result.results[0].resource_name!;

      await updateAuditAction(auditId, {
        status: "success",
        targetResource: resource,
        result: { adGroupId: extractId(resource) },
      });

      return { adGroupId: extractId(resource), resourceName: resource };
    } catch (err: any) {
      await updateAuditAction(auditId, { status: "error", result: { error: err.message?.slice(0, 500) } });
      throw err;
    }
  }

  // ── Keywords (Phrase + Exact) ───────────────────────────────
  async createKeywords(
    adGroupResource: string,
    keywords: string[],
    triggeredBy: string
  ): Promise<number> {
    const auditId = await guardMutation({
      brandId: this.brandId,
      action: "create_keywords",
      payload: { adGroup: adGroupResource, count: keywords.length * 2 },
      triggeredBy,
    });

    try {
      const customer = await getGoogleAdsClient(this.brandId);
      const criteria: any[] = [];

      for (const kw of keywords) {
        criteria.push({
          ad_group: adGroupResource,
          status: enums.AdGroupCriterionStatus.ENABLED,
          keyword: { text: kw, match_type: enums.KeywordMatchType.PHRASE },
        });
        criteria.push({
          ad_group: adGroupResource,
          status: enums.AdGroupCriterionStatus.ENABLED,
          keyword: { text: kw, match_type: enums.KeywordMatchType.EXACT },
        });
      }

      await customer.adGroupCriteria.create(criteria);

      await updateAuditAction(auditId, {
        status: "success",
        result: { keywordsCreated: criteria.length },
      });

      return criteria.length;
    } catch (err: any) {
      await updateAuditAction(auditId, { status: "error", result: { error: err.message?.slice(0, 500) } });
      throw err;
    }
  }

  // ── Campaign Negatives ──────────────────────────────────────
  async createCampaignNegatives(
    campaignResource: string,
    negatives: string[],
    triggeredBy: string
  ): Promise<void> {
    const auditId = await guardMutation({
      brandId: this.brandId,
      action: "create_campaign_negatives",
      payload: { campaign: campaignResource, negatives },
      triggeredBy,
    });

    try {
      const customer = await getGoogleAdsClient(this.brandId);
      const criteria = negatives.map((kw) => ({
        campaign: campaignResource,
        keyword: { text: kw, match_type: enums.KeywordMatchType.PHRASE },
        negative: true,
      }));

      await customer.campaignCriteria.create(criteria);

      await updateAuditAction(auditId, { status: "success", result: { count: negatives.length } });
    } catch (err: any) {
      await updateAuditAction(auditId, { status: "error", result: { error: err.message?.slice(0, 500) } });
      throw err;
    }
  }

  // ── Check if campaign exists in DB ──────────────────────────
  async campaignExists(name: string): Promise<boolean> {
    const { data } = await (supabase as any)
      .from("mktg_google_campaigns")
      .select("id")
      .eq("brand_id", this.brandId)
      .eq("name", name)
      .limit(1);
    return (data?.length ?? 0) > 0;
  }
}
