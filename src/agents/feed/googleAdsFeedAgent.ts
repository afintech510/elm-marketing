/**
 * googleAdsFeedAgent — Syncs Supabase products → GMC offers.
 *
 * For each active bulk product with real images:
 *   - Builds 'online' + 'local' offers
 *   - Upserts to Merchant API v1
 *   - Tracks status in mktg_google_products
 *   - Removes offers for deactivated products
 */

import { createClient } from "@supabase/supabase-js";
import { getBrandAccount } from "../../auth/google";
import { buildOffer, buildOfferId, type SupabaseProduct } from "./offer-builder";
import { upsertProductInput, deleteProductInput, listProducts } from "../../google/merchant-products";

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

type SyncResult = {
  synced: number;
  errors: number;
  removed: number;
  details: Array<{ slug: string; channel: string; status: string; error?: string }>;
};

// ── Fetch eligible products from Supabase ───────────────────────
async function getEligibleProducts(): Promise<SupabaseProduct[]> {
  const { data: products, error } = await (supabase as any)
    .from("products")
    .select("id, slug, name, description, price_per_unit_cents, unit_display, delivery_type, material_class, images, categories(slug)")
    .eq("is_active", true)
    .eq("delivery_type", "bulk");

  if (error) throw new Error(`Failed to fetch products: ${error.message}`);

  // Filter: must have real images (not placeholder)
  return (products || [])
    .filter((p: any) => {
      const imgs = p.images || [];
      if (imgs.length === 0) return false;
      if (imgs[0].includes("placeholder")) return false;
      return true;
    })
    .map((p: any) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      description: p.description,
      price_per_unit_cents: p.price_per_unit_cents,
      unit_display: p.unit_display,
      delivery_type: p.delivery_type,
      material_class: p.material_class || "default",
      images: p.images || [],
      category_slug: p.categories?.slug || "default",
    }));
}

// ── Sync a single offer ─────────────────────────────────────────
async function syncOffer(
  product: SupabaseProduct,
  brandId: string,
  merchantId: string,
  channel: "online" | "local"
): Promise<{ status: string; error?: string }> {
  const offer = buildOffer(product, brandId, channel);
  const offerId = offer.offerId;

  try {
    await upsertProductInput(brandId, merchantId, offer);

    // Upsert tracking row
    await (supabase as any)
      .from("mktg_google_products")
      .upsert(
        {
          brand_id: brandId,
          product_id: product.id,
          gmc_offer_id: offerId,
          channel,
          content_language: "en",
          feed_label: "US",
          last_synced_at: new Date().toISOString(),
          last_sync_status: "pending", // GMC reviews asynchronously
        },
        { onConflict: "brand_id,gmc_offer_id,channel" }
      );

    return { status: "synced" };
  } catch (err: any) {
    return { status: "error", error: err.message?.slice(0, 200) };
  }
}

// ── Remove offers for deactivated products ──────────────────────
async function removeStaleOffers(
  brandId: string,
  merchantId: string,
  currentOfferIds: Set<string>
): Promise<number> {
  // Get all tracked offers
  const { data: tracked } = await (supabase as any)
    .from("mktg_google_products")
    .select("gmc_offer_id, channel")
    .eq("brand_id", brandId);

  let removed = 0;
  for (const row of tracked || []) {
    if (!currentOfferIds.has(row.gmc_offer_id)) {
      try {
        await deleteProductInput(brandId, merchantId, row.gmc_offer_id);
        await (supabase as any)
          .from("mktg_google_products")
          .delete()
          .eq("brand_id", brandId)
          .eq("gmc_offer_id", row.gmc_offer_id);
        removed++;
      } catch {
        // Non-fatal — product may already be removed from GMC
      }
    }
  }
  return removed;
}

// ── Main sync entry point ───────────────────────────────────────
export async function runFeedSync(brandId: string): Promise<SyncResult> {
  const account = await getBrandAccount(brandId);
  const merchantId = account.merchant_id;
  const products = await getEligibleProducts();

  const result: SyncResult = { synced: 0, errors: 0, removed: 0, details: [] };
  const currentOfferIds = new Set<string>();
  // Online channel only for now. Local (LIA) adds in Phase 02c after store entity setup.
  const channel = "online" as const;

  for (const product of products) {
    const offerId = buildOfferId(brandId, product.slug, channel);
    currentOfferIds.add(offerId);

    const { status, error } = await syncOffer(product, brandId, merchantId, channel);

    if (status === "synced") {
      result.synced++;
    } else {
      result.errors++;
    }

    result.details.push({ slug: product.slug, channel, status, error });
  }

  // Remove stale offers
  result.removed = await removeStaleOffers(brandId, merchantId, currentOfferIds);

  // Write audit log
  await (supabase as any).from("mktg_agent_actions").insert({
    brand_id: brandId,
    agent_name: "googleAdsFeedAgent",
    action: "feed_sync",
    payload: { productCount: products.length },
    result: { synced: result.synced, errors: result.errors, removed: result.removed },
    status: result.errors === 0 ? "success" : "error",
    triggered_by: "system",
  });

  return result;
}
