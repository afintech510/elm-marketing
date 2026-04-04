import { describe, it, expect } from 'vitest'
import { validateBrandCompliance, generateIdempotencyKey } from '../src/brandCompliance.js'

const RULES = {
  always: ['family-owned', 'per cu. yard', 'Add to Order'],
  never: ['/yd', 'cart', 'Add to Cart', 'established in', 'founding year', 'triple ground standard', 'responsibly sourced']
}

describe('validateBrandCompliance', () => {
  it('passes compliant content', () => {
    const content = 'Our family-owned yard delivers premium screened topsoil at $45 per cu. yard. Add to Order today!'
    expect(validateBrandCompliance(content, RULES)).toEqual([])
  })

  it('catches /yd notation', () => {
    const content = 'Screened topsoil at $45/yd delivered to your door.'
    const violations = validateBrandCompliance(content, RULES)
    expect(violations.some(v => v.includes('/yd'))).toBe(true)
  })

  it('catches Add to Cart', () => {
    const content = 'Shop our mulch selection and Add to Cart for delivery.'
    const violations = validateBrandCompliance(content, RULES)
    expect(violations.some(v => v.includes('Add to Cart'))).toBe(true)
  })

  it('catches founding year', () => {
    const content = 'Established in 1998, we have served Suffolk County for decades.'
    const violations = validateBrandCompliance(content, RULES)
    expect(violations.some(v => v.includes('founding year'))).toBe(true)
  })

  it('catches "founded in" year variant', () => {
    const content = 'Founded in 2001, Eastern LM is your local supplier.'
    const violations = validateBrandCompliance(content, RULES)
    expect(violations.some(v => v.includes('founding year'))).toBe(true)
  })

  it('catches triple ground standard', () => {
    const content = 'All our mulch is triple ground standard for the finest texture.'
    const violations = validateBrandCompliance(content, RULES)
    expect(violations.some(v => v.includes('triple ground'))).toBe(true)
  })

  it('catches "never" list terms from rules', () => {
    const content = 'Our responsibly sourced materials are the best choice.'
    const violations = validateBrandCompliance(content, RULES)
    expect(violations.some(v => v.includes('responsibly sourced'))).toBe(true)
  })

  it('catches multiple violations in one string', () => {
    const content = 'Established in 1998, get topsoil at $45/yd. Add to Cart now!'
    const violations = validateBrandCompliance(content, RULES)
    expect(violations.length).toBeGreaterThanOrEqual(3)
  })

  it('handles empty content', () => {
    expect(validateBrandCompliance('', RULES)).toEqual([])
  })

  it('handles empty rules', () => {
    expect(validateBrandCompliance('Anything goes here', {})).toEqual([])
  })
})

describe('generateIdempotencyKey', () => {
  it('produces deterministic key', () => {
    const key1 = generateIdempotencyKey('abc-123', 'instagram_feed', '2026-04-07')
    const key2 = generateIdempotencyKey('abc-123', 'instagram_feed', '2026-04-07')
    expect(key1).toBe(key2)
  })

  it('produces different keys for different inputs', () => {
    const key1 = generateIdempotencyKey('abc-123', 'instagram_feed', '2026-04-07')
    const key2 = generateIdempotencyKey('abc-123', 'facebook_page', '2026-04-07')
    expect(key1).not.toBe(key2)
  })

  it('includes all components', () => {
    const key = generateIdempotencyKey('content-1', 'instagram_feed', '2026-04-07')
    expect(key).toBe('content-1:instagram_feed:2026-04-07')
  })
})
