/**
 * handlers.ts — COPY agent task handlers
 * Handles: generate_weekly_calendar, write_caption, write_review_response
 */

import Anthropic from '@anthropic-ai/sdk'
import { SupabaseClient } from '@supabase/supabase-js'
import { Queue } from 'bullmq'
import { v4 as uuidv4 } from 'uuid'
import Redis from 'ioredis'
import { buildSystemPrompt } from './prompts.js'

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

interface TaskPayload {
  task_id: string
  brand_id: string
  task_type: string
  input: Record<string, unknown>
}

interface BrandRow {
  id: string
  name: string
  voice_rules: Record<string, unknown>
  content_pillars: Array<{ slug: string; name: string; weight: number; description: string }>
  hashtag_sets: Record<string, string[]>
  posting_schedule: Record<string, unknown>
}

export async function handleTask(
  payload: TaskPayload,
  supabase: SupabaseClient,
  imageQueue: Queue,
  redis: Redis
): Promise<Record<string, unknown>> {
  switch (payload.task_type) {
    case 'generate_weekly_calendar':
      return generateWeeklyCalendar(payload, supabase, redis)
    case 'write_caption':
      return writeCaption(payload, supabase, imageQueue, redis)
    case 'write_review_response':
      return writeReviewResponse(payload, supabase, redis)
    default:
      throw new Error(`Unknown task type: ${payload.task_type}`)
  }
}

// ─── Generate Weekly Calendar ───────────────────────────────────
async function generateWeeklyCalendar(
  payload: TaskPayload,
  supabase: SupabaseClient,
  redis: Redis
): Promise<Record<string, unknown>> {
  const { brand_id } = payload
  const weekStart = (payload.input.week_start as string) ?? getNextMonday()

  // Load brand
  const { data: brand } = await supabase
    .from('mktg_brands')
    .select('*')
    .eq('id', brand_id)
    .single()
  if (!brand) throw new Error(`Brand ${brand_id} not found`)

  // Load memory context
  const memoryContext = await loadMemoryContext(supabase, brand_id)
  const systemPrompt = buildSystemPrompt(brand as BrandRow, memoryContext)

  const calendarPrompt = `Generate a 7-day social media content calendar for the week starting ${weekStart}.

REQUIREMENTS:
- Plan 15 posts total across Instagram Feed, Facebook Page, and Google Business Profile
- Follow the posting schedule: IG Mon/Wed/Fri at 10am+2pm, FB Tue/Thu at 9am+12pm, GBP Mon at 8am
- Distribute across ALL 7 content pillars. Max 2 posts of same pillar per week.
- For each post, provide: day, platform, pillar, topic (specific product/project/tip), and suggested image tags

Respond with ONLY valid JSON:
{
  "week_start": "${weekStart}",
  "slots": [
    {"day": "mon", "platform": "instagram_feed", "pillar": "product_showcase", "topic": "specific topic", "time": "10:00", "image_tags": ["mulch", "yard"]},
    ...
  ]
}`

  const response = await claude.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: calendarPrompt }]
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : '{"slots":[]}'
  await trackTokenUsage(redis, response.usage)

  // Parse calendar
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse calendar JSON from Claude response')

  const calendar = JSON.parse(jsonMatch[0]) as { week_start: string; slots: Array<{ day: string; platform: string; pillar: string; topic: string; time: string; image_tags?: string[] }> }

  // Count pillars
  const pillarCounts: Record<string, number> = {}
  for (const slot of calendar.slots) {
    pillarCounts[slot.pillar] = (pillarCounts[slot.pillar] ?? 0) + 1
  }

  // Check rotation (max 2 same pillar)
  const rotationWarning = Object.values(pillarCounts).some(count => count > 2)

  // Save calendar
  const { data: calendarRow } = await supabase
    .from('mktg_content_calendar')
    .upsert({
      brand_id,
      week_start: weekStart,
      plan: calendar,
      pillar_counts: pillarCounts,
      status: 'active',
      rotation_warning: rotationWarning
    }, { onConflict: 'brand_id,week_start' })
    .select('id')
    .single()

  const calendarId = calendarRow?.id

  // Dispatch write_caption tasks for each slot
  for (const slot of calendar.slots) {
    const captionTaskId = uuidv4()
    await supabase.from('mktg_agent_tasks').insert({
      task_id: captionTaskId,
      brand_id,
      assigned_agent: 'copy',
      task_type: 'write_caption',
      status: 'pending',
      priority: 'normal',
      approval_tier: 'AUTO_EXECUTE',
      input: {
        brand_id,
        platform: slot.platform,
        pillar: slot.pillar,
        topic: slot.topic,
        image_tags: slot.image_tags ?? [],
        calendar_id: calendarId,
        scheduled_time: slot.time,
        scheduled_day: slot.day
      }
    })
  }

  return {
    calendar_id: calendarId,
    slots_count: calendar.slots.length,
    pillar_counts: pillarCounts,
    rotation_warning: rotationWarning,
    caption_tasks_created: calendar.slots.length
  }
}

// ─── Write Caption ──────────────────────────────────────────────
async function writeCaption(
  payload: TaskPayload,
  supabase: SupabaseClient,
  imageQueue: Queue,
  redis: Redis
): Promise<Record<string, unknown>> {
  const { brand_id } = payload
  const { platform, pillar, topic, image_tags, calendar_id, scheduled_day, scheduled_time } = payload.input as {
    platform: string; pillar: string; topic: string; image_tags: string[]
    calendar_id?: string; scheduled_day?: string; scheduled_time?: string
  }

  // Load brand + memory
  const { data: brand } = await supabase.from('mktg_brands').select('*').eq('id', brand_id).single()
  if (!brand) throw new Error(`Brand ${brand_id} not found`)

  const memoryContext = await loadMemoryContext(supabase, brand_id)
  const systemPrompt = buildSystemPrompt(brand as BrandRow, memoryContext)

  const captionPrompt = `Write ONE social media caption for ${platform}.

**Topic:** ${topic}
**Content Pillar:** ${pillar}
**Platform:** ${platform}

${platform === 'google_business_profile' ? 'IMPORTANT: Include a CTA link. Use format: https://easternlm.com/shop or https://easternlm.com/delivery/[relevant-town]' : ''}
${platform.startsWith('instagram') ? 'Include 15-25 relevant hashtags at the end, separated by spaces.' : ''}
${platform === 'facebook_page' ? 'Include 3-5 hashtags. Keep conversational.' : ''}

Respond with ONLY valid JSON:
{
  "body": "the full caption text including hashtags if applicable",
  "hashtags": ["array", "of", "hashtags", "without", "hash", "symbol"],
  "cta_url": "url if GBP, null otherwise"
}`

  const response = await claude.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: captionPrompt }]
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : '{}'
  await trackTokenUsage(redis, response.usage)

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse caption JSON')

  const caption = JSON.parse(jsonMatch[0]) as { body: string; hashtags: string[]; cta_url: string | null }

  // Calculate scheduled_for timestamp
  let scheduledFor: string | null = null
  if (scheduled_day && scheduled_time) {
    scheduledFor = calculateScheduledTime(scheduled_day, scheduled_time)
  }

  // Save to content library
  const { data: contentRow } = await supabase
    .from('mktg_content_library')
    .insert({
      brand_id,
      calendar_id: calendar_id ?? null,
      content_type: 'social_post',
      pillar,
      platform,
      body: caption.body,
      hashtags: caption.hashtags ?? [],
      cta_url: caption.cta_url,
      status: 'pending_approval',
      scheduled_for: scheduledFor
    })
    .select('id')
    .single()

  // Dispatch image formatting if tags provided
  if (image_tags?.length > 0 && contentRow) {
    try {
      await imageQueue.add('format_images', {
        brand_id,
        content_id: contentRow.id,
        image_tags,
        platform
      }, { attempts: 2, backoff: { type: 'exponential', delay: 3000 } })
    } catch (err) {
      console.warn('[COPY] Failed to dispatch image task:', err)
    }
  }

  return {
    content_id: contentRow?.id,
    platform,
    pillar,
    body_length: caption.body.length,
    hashtag_count: caption.hashtags?.length ?? 0
  }
}

// ─── Write Review Response ──────────────────────────────────────
async function writeReviewResponse(
  payload: TaskPayload,
  supabase: SupabaseClient,
  redis: Redis
): Promise<Record<string, unknown>> {
  const { brand_id } = payload
  const reviewId = payload.input.review_id as string

  // Load review
  const { data: review } = await supabase
    .from('mktg_reviews')
    .select('*')
    .eq('id', reviewId)
    .single()
  if (!review) throw new Error(`Review ${reviewId} not found`)

  // Load brand
  const { data: brand } = await supabase.from('mktg_brands').select('*').eq('id', brand_id).single()
  if (!brand) throw new Error(`Brand ${brand_id} not found`)

  const memoryContext = await loadMemoryContext(supabase, brand_id)
  const systemPrompt = buildSystemPrompt(brand as BrandRow, memoryContext)

  const responsePrompt = `Write a professional, grateful response to this ${review.rating}-star Google review.

Reviewer: ${review.reviewer_name ?? 'Customer'}
Review text: "${review.review_text ?? '(no text)'}"

Requirements:
- Keep under 500 characters
- Be genuine and specific to what they mentioned
- If negative (1-3 stars): acknowledge concern, offer to make it right, include phone number
- If positive (4-5 stars): thank them, mention something specific from their review
- Brand voice: family-owned, professional, local pride
- Sign off with the business name

Respond with ONLY the response text (no JSON, no quotes).`

  const response = await claude.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    system: systemPrompt,
    messages: [{ role: 'user', content: responsePrompt }]
  })

  const draft = response.content[0].type === 'text' ? response.content[0].text.trim() : ''
  await trackTokenUsage(redis, response.usage)

  // Save draft
  await supabase
    .from('mktg_reviews')
    .update({ response_draft: draft, response_status: 'pending' })
    .eq('id', reviewId)

  return { review_id: reviewId, response_length: draft.length }
}

// ─── Helpers ────────────────────────────────────────────────────

async function loadMemoryContext(supabase: SupabaseClient, brandId: string): Promise<Record<string, unknown>> {
  const { data } = await supabase
    .from('mktg_agent_memory')
    .select('namespace, key, value')
    .eq('brand_id', brandId)

  const context: Record<string, unknown> = {}
  for (const row of data ?? []) {
    context[`${row.namespace}_${row.key}`] = row.value
  }

  return {
    products_bulk: context['brand_products_bulk'],
    products_popular_nonbulk: context['brand_products_popular_nonbulk'],
    services: context['brand_services'],
    delivery: context['brand_delivery'],
    caption_guidelines: context['content_caption_guidelines'],
    negative_examples: context['content_negative_examples']
  }
}

async function trackTokenUsage(redis: Redis, usage: { input_tokens: number; output_tokens: number }): Promise<void> {
  // Rough cost: Sonnet input=$3/MTok, output=$15/MTok
  const costCents = Math.ceil((usage.input_tokens * 0.3 + usage.output_tokens * 1.5) / 1000)
  const date = new Date().toISOString().slice(0, 10)
  const key = `elm:budget:${date}:copy`
  const totalKey = `elm:budget:${date}:total`

  await redis.incrby(key, costCents)
  await redis.incrby(totalKey, costCents)
  await redis.expire(key, 86400)
  await redis.expire(totalKey, 86400)
}

function getNextMonday(): string {
  const now = new Date()
  const dayOfWeek = now.getDay()
  const daysUntilMonday = dayOfWeek === 0 ? 1 : (8 - dayOfWeek)
  const monday = new Date(now)
  monday.setDate(now.getDate() + daysUntilMonday)
  return monday.toISOString().slice(0, 10)
}

function calculateScheduledTime(day: string, time: string): string {
  const dayMap: Record<string, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 }
  const targetDay = dayMap[day] ?? 1

  const now = new Date()
  const currentDay = now.getDay()
  const daysUntil = targetDay >= currentDay ? targetDay - currentDay : 7 - currentDay + targetDay

  const target = new Date(now)
  target.setDate(now.getDate() + daysUntil)

  const [hours, minutes] = time.split(':').map(Number)
  target.setHours(hours ?? 10, minutes ?? 0, 0, 0)

  return target.toISOString()
}
