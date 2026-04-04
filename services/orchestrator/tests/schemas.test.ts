import { describe, it, expect } from 'vitest'
import { chatSchema, rejectSchema, deliveryWebhookSchema, validateCtaUrl } from '../src/schemas.js'

describe('chatSchema', () => {
  it('accepts valid input', () => {
    const result = chatSchema.safeParse({ content: 'Plan next week' })
    expect(result.success).toBe(true)
  })

  it('accepts input with brand_slug', () => {
    const result = chatSchema.safeParse({ content: 'Hello', brand_slug: 'eastern-lm' })
    expect(result.success).toBe(true)
  })

  it('rejects empty content', () => {
    const result = chatSchema.safeParse({ content: '' })
    expect(result.success).toBe(false)
  })

  it('rejects content over 2000 chars', () => {
    const result = chatSchema.safeParse({ content: 'a'.repeat(2001) })
    expect(result.success).toBe(false)
  })

  it('rejects unknown keys', () => {
    const result = chatSchema.safeParse({ content: 'Hello', malicious: true })
    expect(result.success).toBe(false)
  })

  it('defaults brand_slug to eastern-lm', () => {
    const result = chatSchema.parse({ content: 'Hello' })
    expect(result.brand_slug).toBe('eastern-lm')
  })
})

describe('rejectSchema', () => {
  it('accepts valid reason', () => {
    expect(rejectSchema.safeParse({ reason: 'Wrong tone' }).success).toBe(true)
  })

  it('rejects empty reason', () => {
    expect(rejectSchema.safeParse({ reason: '' }).success).toBe(false)
  })

  it('rejects unknown keys', () => {
    expect(rejectSchema.safeParse({ reason: 'Bad', extra: true }).success).toBe(false)
  })
})

describe('deliveryWebhookSchema', () => {
  it('accepts valid payload', () => {
    const result = deliveryWebhookSchema.safeParse({
      order_id: '123', customer_phone: '+16315551234'
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing order_id', () => {
    const result = deliveryWebhookSchema.safeParse({ customer_phone: '+16315551234' })
    expect(result.success).toBe(false)
  })

  it('rejects missing customer_phone', () => {
    const result = deliveryWebhookSchema.safeParse({ order_id: '123' })
    expect(result.success).toBe(false)
  })
})

describe('validateCtaUrl', () => {
  it('allows easternlm.com URLs', () => {
    expect(validateCtaUrl('https://easternlm.com/shop/mulch')).toBe(true)
  })

  it('allows www.easternlm.com', () => {
    expect(validateCtaUrl('https://www.easternlm.com/delivery/patchogue')).toBe(true)
  })

  it('allows staging.easternlm.com', () => {
    expect(validateCtaUrl('https://staging.easternlm.com/shop')).toBe(true)
  })

  it('rejects external URLs', () => {
    expect(validateCtaUrl('https://evil.com/phishing')).toBe(false)
  })

  it('allows null/undefined', () => {
    expect(validateCtaUrl(null)).toBe(true)
    expect(validateCtaUrl(undefined)).toBe(true)
  })

  it('rejects invalid URLs', () => {
    expect(validateCtaUrl('not-a-url')).toBe(false)
  })
})
