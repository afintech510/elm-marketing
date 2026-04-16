/**
 * Builds a GMC product offer payload from a Supabase product row.
 * Creates both 'online' and 'local' channel offers per product.
 */

import { buildTitle, buildDescription } from "./description-builder";
import { getGoogleCategory } from "./google-taxonomy";

export type SupabaseProduct = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  price_per_unit_cents: number;
  unit_display: string;
  delivery_type: string;
  material_class: string;
  images: string[];
  category_slug: string;
};

export type GmcOffer = {
  offerId: string;
  channel: "ONLINE" | "LOCAL";
  contentLanguage: string;
  feedLabel: string;
  title: string;
  description: string;
  link: string;
  imageLink: string;
  additionalImageLinks: string[];
  availability: string;
  condition: string;
  price: { amountMicros: string; currencyCode: string };
  brand: string;
  identifierExists: boolean;
  productTypes: string[];
  googleProductCategory: string;
  shipping: Array<{
    country: string;
    region: string;
    service: string;
    price: { amountMicros: string; currencyCode: string };
  }>;
};

const BRAND = "Eastern Landscape & Mason Supply";
const SITE_URL = "https://easternlm.com";

export function buildOfferId(brandId: string, slug: string, channel: "online" | "local"): string {
  // GMC offerId max 50 chars. Prefix "elm-" (4) + "-online" (7) = 11 overhead → 39 for slug
  const prefix = brandId === "eastern-lm" ? "elm" : brandId.slice(0, 6);
  const maxSlug = 50 - prefix.length - 1 - channel.length - 1; // prefix-slug-channel
  const trimmedSlug = slug.slice(0, maxSlug);
  return `${prefix}-${trimmedSlug}-${channel}`;
}

export function buildOffer(
  product: SupabaseProduct,
  brandId: string,
  channel: "online" | "local"
): GmcOffer {
  const taxonomy = getGoogleCategory(product.category_slug);
  const priceMicros = (product.price_per_unit_cents * 10000).toString(); // cents → micros

  return {
    offerId: buildOfferId(brandId, product.slug, channel),
    channel: channel === "online" ? "ONLINE" : "LOCAL",
    contentLanguage: "en",
    feedLabel: "US",
    title: buildTitle(product.name),
    description: buildDescription({
      name: product.name,
      description: product.description,
      materialClass: product.material_class,
      categorySlug: product.category_slug,
    }),
    link: `${SITE_URL}/shop/${product.slug}`,
    imageLink: product.images[0] || "",
    additionalImageLinks: product.images.slice(1),
    availability: "in_stock",
    condition: "new",
    price: { amountMicros: priceMicros, currencyCode: "USD" },
    brand: BRAND,
    identifierExists: false, // bulk materials have no GTIN
    productTypes: [taxonomy.productType],
    googleProductCategory: taxonomy.googleCategoryId.toString(),
    shipping: [
      {
        country: "US",
        region: "NY",
        service: "Dump Truck Delivery",
        price: { amountMicros: "0", currencyCode: "USD" }, // calculated at checkout
      },
    ],
  };
}
