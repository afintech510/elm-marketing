/**
 * Google Product Category taxonomy mapping for ELM bulk materials.
 * Uses Google's standard taxonomy IDs.
 * Ref: https://support.google.com/merchants/answer/6324436
 */

// Category slug → Google taxonomy ID + product type path
export const CATEGORY_TAXONOMY: Record<string, { googleCategoryId: number; productType: string }> = {
  mulch: {
    googleCategoryId: 6847, // Home & Garden > Lawn & Garden > Gardening > Mulch
    productType: "Landscape Materials > Mulch",
  },
  "topsoil-fill": {
    googleCategoryId: 6847, // Home & Garden > Lawn & Garden > Gardening > Soil
    productType: "Landscape Materials > Topsoil & Fill",
  },
  topsoil: {
    googleCategoryId: 6847,
    productType: "Landscape Materials > Topsoil & Compost",
  },
  "gravel-stone": {
    googleCategoryId: 6069, // Home & Garden > Lawn & Garden > Landscaping > Gravel & Pebbles
    productType: "Landscape Materials > Gravel & Stone",
  },
  sand: {
    googleCategoryId: 6069,
    productType: "Landscape Materials > Sand",
  },
  "natural-stone": {
    googleCategoryId: 6069,
    productType: "Landscape Materials > Natural Stone",
  },
  base: {
    googleCategoryId: 6069,
    productType: "Landscape Materials > Base & Fill",
  },
};

// Material class → sourcing badge per ELM copy rules
export const SOURCING_BADGE: Record<string, string | null> = {
  mulch: "Processed locally",
  topsoil: "Locally sourced",
  sand: "Locally sourced",
  gravel: "Locally sourced",
  stone: null, // crushed/decorative stone gets no badge
  default: null,
};

export function getGoogleCategory(categorySlug: string) {
  return CATEGORY_TAXONOMY[categorySlug] || {
    googleCategoryId: 6069, // default: landscaping
    productType: "Landscape Materials",
  };
}

export function getSourcingBadge(materialClass: string): string | null {
  return SOURCING_BADGE[materialClass] ?? SOURCING_BADGE.default ?? null;
}
