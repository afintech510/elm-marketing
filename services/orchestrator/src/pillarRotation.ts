/**
 * pillarRotation.ts — Content pillar rotation validation
 * Enforces: max 2 same pillar/week, min 1 each pillar per 2-week window
 */

import type { CalendarPlan, ContentPillar } from './types.js'

const ALL_PILLARS = [
  'product_showcase', 'delivery_action', 'seasonal_tips', 'before_after',
  'local_community', 'promotions', 'behind_scenes'
]

export interface RotationValidation {
  valid: boolean
  violations: string[]
}

/**
 * Validate a weekly calendar against pillar rotation rules
 */
export function validateCalendar(plan: CalendarPlan, pillars: ContentPillar[]): RotationValidation {
  const violations: string[] = []

  // Count pillars in this week
  const pillarCounts = new Map<string, number>()
  for (const slot of plan.slots) {
    const count = pillarCounts.get(slot.pillar) ?? 0
    pillarCounts.set(slot.pillar, count + 1)
  }

  // Rule 1: max 2 same pillar per week
  for (const [pillar, count] of pillarCounts) {
    if (count > 2) {
      violations.push(`Pillar "${pillar}" appears ${count} times (max 2 per week)`)
    }
  }

  // Rule 2: ensure pillars are represented (soft check — full enforcement over 2 weeks)
  const weightedPillars = pillars.filter(p => p.weight >= 2).map(p => p.slug)
  for (const pillar of weightedPillars) {
    if (!pillarCounts.has(pillar)) {
      violations.push(`High-weight pillar "${pillar}" has 0 posts this week`)
    }
  }

  return {
    valid: violations.length === 0,
    violations
  }
}

/**
 * Check 2-week rolling window coverage (compares current + previous week)
 */
export function validateTwoWeekCoverage(
  currentPlan: CalendarPlan,
  previousPlan: CalendarPlan | null
): RotationValidation {
  const violations: string[] = []
  const twoWeekCounts = new Map<string, number>()

  // Count current week
  for (const slot of currentPlan.slots) {
    const count = twoWeekCounts.get(slot.pillar) ?? 0
    twoWeekCounts.set(slot.pillar, count + 1)
  }

  // Count previous week if available
  if (previousPlan) {
    for (const slot of previousPlan.slots) {
      const count = twoWeekCounts.get(slot.pillar) ?? 0
      twoWeekCounts.set(slot.pillar, count + 1)
    }
  }

  // Min 1 per pillar over 2-week window
  for (const pillar of ALL_PILLARS) {
    if (!twoWeekCounts.has(pillar) || twoWeekCounts.get(pillar) === 0) {
      violations.push(`Pillar "${pillar}" has 0 posts in the 2-week window`)
    }
  }

  return {
    valid: violations.length === 0,
    violations
  }
}
