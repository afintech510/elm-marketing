/**
 * Campaign definitions for ELM Search + PMax launch.
 * All campaigns launch PAUSED. Adam activates after review.
 */

export type MaterialCategory = {
  slug: string;
  campaignName: string;
  budgetCentsDaily: number;
  keywords: string[];
  negatives: string[];
};

export const MATERIAL_CATEGORIES: MaterialCategory[] = [
  {
    slug: "mulch",
    campaignName: "ELM-Search-Mulch",
    budgetCentsDaily: 2000,
    keywords: [
      "mulch delivery long island",
      "mulch near me suffolk county",
      "natural mulch delivered",
      "black mulch long island",
      "bulk mulch delivery",
      "mulch by the yard",
    ],
    negatives: ["bagged", "playground", "rubber", "wholesale-only"],
  },
  {
    slug: "topsoil",
    campaignName: "ELM-Search-Topsoil",
    budgetCentsDaily: 2000,
    keywords: [
      "topsoil delivery",
      "screened topsoil long island",
      "topsoil near me",
      "topsoil by the yard",
      "black dirt delivered",
    ],
    negatives: ["bagged", "free", "fill-dirt"],
  },
  {
    slug: "gravel",
    campaignName: "ELM-Search-Gravel",
    budgetCentsDaily: 2000,
    keywords: [
      "gravel delivery long island",
      "pea gravel suffolk county",
      "rca delivered",
      "crushed stone delivery",
      "gravel by the yard",
    ],
    negatives: ["wholesale", "dump-truck-rental", "aquarium"],
  },
  {
    slug: "stone",
    campaignName: "ELM-Search-Stone",
    budgetCentsDaily: 2000,
    keywords: [
      "bluestone delivery",
      "crushed bluestone long island",
      "decorative stone delivered",
      "pocono river rock",
      "burgundy stone delivery",
    ],
    negatives: ["retail-wall", "jewelry", "pebbles-bagged"],
  },
  {
    slug: "sand",
    campaignName: "ELM-Search-Sand",
    budgetCentsDaily: 2000,
    keywords: [
      "mason sand delivery",
      "concrete sand near me",
      "bulk sand long island",
      "playground sand delivered",
      "pool base sand",
    ],
    negatives: ["beach", "wholesale", "sand-bags"],
  },
];

export const SHARED_NEGATIVES_NAME = "ELM-Shared-Negatives";
export const SHARED_NEGATIVES = [
  "bagged", "bag", "bags", "wholesale", "commercial-only",
  "free", "rental", "review", "reviews", "jobs", "careers",
];

export const PMAX_CONFIG = {
  campaignName: "ELM-PMax-All-Products",
  budgetCentsDaily: 5000,
  targetRoas: 3.0,
  brandExclusions: ["Eastern Landscape", "Eastern LM"],
};

// 50-mile radius around Center Moriches, NY
export const ELM_GEO_TARGET = {
  latitude: 40.800,
  longitude: -72.813,
  radiusMiles: 50,
};
