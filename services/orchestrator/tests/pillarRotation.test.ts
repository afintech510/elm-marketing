import { describe, it, expect } from 'vitest'
import { validateCalendar, validateTwoWeekCoverage } from '../src/pillarRotation.js'
import type { CalendarPlan, ContentPillar } from '../src/types.js'

const PILLARS: ContentPillar[] = [
  { slug: 'product_showcase', name: 'Material of the Week', weight: 2, description: '' },
  { slug: 'delivery_action', name: 'Delivery in Action', weight: 2, description: '' },
  { slug: 'seasonal_tips', name: 'Seasonal Tips', weight: 2, description: '' },
  { slug: 'before_after', name: 'Before/After', weight: 2, description: '' },
  { slug: 'local_community', name: 'Suffolk County', weight: 1, description: '' },
  { slug: 'promotions', name: 'Deals', weight: 1, description: '' },
  { slug: 'behind_scenes', name: 'Behind the Scenes', weight: 1, description: '' },
]

function makePlan(pillarCounts: Record<string, number>): CalendarPlan {
  const slots = []
  for (const [pillar, count] of Object.entries(pillarCounts)) {
    for (let i = 0; i < count; i++) {
      slots.push({ day: 'mon', platform: 'instagram_feed', pillar, topic: 'test', time: '10:00' })
    }
  }
  return { week_start: '2026-04-06', slots }
}

describe('validateCalendar', () => {
  it('passes a well-distributed calendar', () => {
    const plan = makePlan({
      product_showcase: 2, delivery_action: 2, seasonal_tips: 2,
      before_after: 2, local_community: 1, promotions: 1, behind_scenes: 1
    })
    const result = validateCalendar(plan, PILLARS)
    expect(result.valid).toBe(true)
    expect(result.violations).toEqual([])
  })

  it('rejects calendar with 3 posts of same pillar', () => {
    const plan = makePlan({
      product_showcase: 3, delivery_action: 2, seasonal_tips: 2
    })
    const result = validateCalendar(plan, PILLARS)
    expect(result.valid).toBe(false)
    expect(result.violations.some(v => v.includes('product_showcase'))).toBe(true)
  })

  it('warns when high-weight pillar has 0 posts', () => {
    const plan = makePlan({
      product_showcase: 2, seasonal_tips: 2, before_after: 2
    })
    const result = validateCalendar(plan, PILLARS)
    expect(result.valid).toBe(false)
    expect(result.violations.some(v => v.includes('delivery_action'))).toBe(true)
  })

  it('allows low-weight pillars to have 0 posts in a single week', () => {
    const plan = makePlan({
      product_showcase: 2, delivery_action: 2, seasonal_tips: 2,
      before_after: 2
    })
    const result = validateCalendar(plan, PILLARS)
    // Low-weight pillars (community, promotions, behind_scenes) missing is OK in single week
    const highWeightViolations = result.violations.filter(v =>
      !v.includes('local_community') && !v.includes('promotions') && !v.includes('behind_scenes')
    )
    expect(highWeightViolations).toEqual([])
  })

  it('handles empty calendar', () => {
    const plan: CalendarPlan = { week_start: '2026-04-06', slots: [] }
    const result = validateCalendar(plan, PILLARS)
    // Empty calendar should have violations for missing high-weight pillars
    expect(result.valid).toBe(false)
  })
})

describe('validateTwoWeekCoverage', () => {
  it('passes when all pillars covered across 2 weeks', () => {
    const week1 = makePlan({ product_showcase: 2, delivery_action: 2, seasonal_tips: 2, before_after: 1 })
    const week2 = makePlan({ local_community: 1, promotions: 1, behind_scenes: 1, product_showcase: 1 })
    const result = validateTwoWeekCoverage(week2, week1)
    expect(result.valid).toBe(true)
  })

  it('fails when a pillar is missing across 2 weeks', () => {
    const week1 = makePlan({ product_showcase: 2, delivery_action: 2 })
    const week2 = makePlan({ product_showcase: 2, delivery_action: 2 })
    const result = validateTwoWeekCoverage(week2, week1)
    expect(result.valid).toBe(false)
    expect(result.violations.some(v => v.includes('seasonal_tips'))).toBe(true)
  })

  it('handles null previous week (first week)', () => {
    const week1 = makePlan({
      product_showcase: 1, delivery_action: 1, seasonal_tips: 1,
      before_after: 1, local_community: 1, promotions: 1, behind_scenes: 1
    })
    const result = validateTwoWeekCoverage(week1, null)
    expect(result.valid).toBe(true)
  })
})
