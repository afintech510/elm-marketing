/**
 * schemas.ts — Zod validation schemas for all API inputs (S-008)
 */

import { z } from 'zod'

export const chatSchema = z.object({
  content: z.string().min(1).max(2000),
  brand_slug: z.string().min(1).max(50).optional().default('eastern-lm')
}).strict()

export const rejectSchema = z.object({
  reason: z.string().min(1).max(500)
}).strict()

export const editContentSchema = z.object({
  body: z.string().min(1).max(5000).optional(),
  pillar: z.string().min(1).max(50).optional()
}).strict().refine(data => data.body || data.pillar, {
  message: 'At least one of body or pillar must be provided'
})

export const deliveryWebhookSchema = z.object({
  order_id: z.string().min(1),
  customer_phone: z.string().min(1),
  customer_name: z.string().optional(),
  brand_id: z.string().uuid().optional()
}).strict()

export const reviewEditSchema = z.object({
  response_draft: z.string().min(1).max(1000)
}).strict()

// CTA URL allowlist — only easternlm.com domains
export function validateCtaUrl(url: string | null | undefined): boolean {
  if (!url) return true
  try {
    const parsed = new URL(url)
    return parsed.hostname === 'easternlm.com' || parsed.hostname === 'www.easternlm.com' || parsed.hostname === 'staging.easternlm.com'
  } catch {
    return false
  }
}
