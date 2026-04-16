/** Optimizer rule thresholds and configuration */

export const OPTIMIZER_CONFIG = {
  // R1: Budget winner — ROAS high, impression share lost
  r1: {
    minRoas: 4.0,
    minDataDays: 14,
    minImpressionShareLostBudget: 0.40,
    budgetIncreasePercent: 0.20,
    confidence: 0.9,
  },
  // R2: Unprofitable — high spend, low ROAS
  r2: {
    maxRoas: 1.0,
    minSpendCents: 5000, // $50
    minDataDays: 14,
    confidence: 0.75,
  },
  // R3: Zero-conversion search term
  r3: {
    minSpendCents: 2000, // $20
    minClicks: 10,
    maxConversions: 0,
    confidence: 0.85,
  },
  // R4: CPA drift
  r4: {
    cpaDriftMultiplier: 2.0, // actual CPA > target × 2.0
    minDataDays: 14,
    confidence: 0.6,
  },
  // R5: Stalled PMax
  r5: {
    minDataDays: 21,
    maxConversions: 5,
    confidence: 0.7,
  },
  // R6: Zero impressions
  r6: {
    minDataDays: 7,
    confidence: 0.5,
  },
  // Auto-apply settings
  autoApplyMinConfidence: 0.85,
  neverAutoApply: ["PAUSE_CAMPAIGN", "REMOVE_CAMPAIGN"],
  recommendationExpiryDays: 14,
};
