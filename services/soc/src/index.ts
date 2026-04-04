/**
 * ELM Marketing Engine — SOC Agent
 * BullMQ worker consuming from elm:queue:soc
 * Publishes approved content, monitors reviews, fetches engagement, sends review solicitation SMS.
 */

import 'dotenv/config'
import { Worker, Queue } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import Redis from 'ioredis'
import { v4 as uuidv4 } from 'uuid'
import { publishToInstagram, publishToFacebook, fetchPostEngagement } from './meta.js'
import { publishToGBP } from './gbp.js'

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'REDIS_URL']
for (const key of required) {
  if (!process.env[key]) { console.error(`[ELM-SOC] Missing: ${key}`); process.exit(1) }
}

const REDIS_URL = process.env.REDIS_URL!
const redisOpts = (() => {
  const parsed = new URL(REDIS_URL)
  return { host: parsed.hostname, port: parseInt(parsed.port || '6379', 10) }
})()

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)
const redis = new Redis(REDIS_URL)
const copyQueue = new Queue('elm:queue:copy', { connection: redisOpts })

const META_TOKEN = process.env.META_ACCESS_TOKEN ?? ''
const META_PAGE_ID = process.env.META_PAGE_ID ?? ''
const META_IG_ID = process.env.META_IG_ACCOUNT_ID ?? ''

// ─── Task handlers ──────────────────────────────────────────────

async function publishScheduledPosts(brandId: string): Promise<Record<string, unknown>> {
  // Get brand publish_mode
  const { data: brand } = await supabase
    .from('mktg_brands')
    .select('publish_mode, platform_accounts')
    .eq('id', brandId)
    .single()

  // Get scheduled posts ready to publish
  const { data: posts } = await supabase
    .from('mktg_social_posts')
    .select('*, content:mktg_content_library(*)')
    .eq('brand_id', brandId)
    .eq('status', 'scheduled')
    .lte('scheduled_for', new Date().toISOString())
    .limit(10)

  if (!posts || posts.length === 0) {
    // Also check approved content that needs social_posts rows created
    const { data: approved } = await supabase
      .from('mktg_content_library')
      .select('*')
      .eq('brand_id', brandId)
      .in('status', ['approved', 'scheduled'])
      .limit(10)

    if (!approved || approved.length === 0) {
      return { published: 0, reason: 'no_scheduled_posts' }
    }

    // Create social_posts entries for approved content
    for (const content of approved) {
      const idempotencyKey = `${content.id}:${content.platform}:${new Date().toISOString().slice(0, 10)}`

      // Check idempotency
      const { data: existing } = await supabase
        .from('mktg_social_posts')
        .select('id')
        .eq('idempotency_key', idempotencyKey)
        .single()

      if (existing) continue

      await supabase.from('mktg_social_posts').insert({
        brand_id: brandId,
        content_id: content.id,
        platform: content.platform,
        idempotency_key: idempotencyKey,
        status: 'scheduled',
        scheduled_for: content.scheduled_for ?? new Date().toISOString()
      })
    }

    return { published: 0, created_posts: approved.length }
  }

  let published = 0
  let skipped = 0

  for (const post of posts) {
    const content = post.content as { body: string; hashtags: string[]; cta_url: string | null; image_asset_ids: string[] } | null
    if (!content) continue

    // Idempotency check
    if (post.platform_post_id) { skipped++; continue }

    // Draft-only mode gate (S-004)
    if (brand?.publish_mode === 'draft_only') {
      await supabase
        .from('mktg_social_posts')
        .update({ status: 'approved' })
        .eq('id', post.id)
      console.log(`[SOC] Draft-only mode — skipping publish for ${post.id}`)
      skipped++
      continue
    }

    // Build caption with hashtags
    const caption = content.hashtags?.length
      ? `${content.body}\n\n${content.hashtags.map((h: string) => `#${h}`).join(' ')}`
      : content.body

    // Get image URL if available
    let imageUrl: string | null = null
    if (content.image_asset_ids?.length > 0) {
      const { data: asset } = await supabase
        .from('mktg_image_assets')
        .select('storage_path')
        .eq('id', content.image_asset_ids[0])
        .single()
      if (asset) {
        const { data: urlData } = supabase.storage.from('marketing-assets').getPublicUrl(asset.storage_path)
        imageUrl = urlData?.publicUrl ?? null
      }
    }

    // Publish based on platform
    let result: { success: boolean; platform_post_id?: string; error?: string }

    const platform = post.platform as string
    if (platform.startsWith('instagram') && META_TOKEN && META_IG_ID) {
      result = await publishToInstagram(caption, imageUrl ?? '', META_TOKEN, META_IG_ID, redis)
    } else if (platform.startsWith('facebook') && META_TOKEN && META_PAGE_ID) {
      result = await publishToFacebook(caption, imageUrl, META_TOKEN, META_PAGE_ID, redis)
    } else if (platform === 'google_business_profile') {
      const gbpLocationId = (brand?.platform_accounts as Record<string, { location_id?: string }>)?.gbp?.location_id
      if (gbpLocationId) {
        result = await publishToGBP(caption, imageUrl, content.cta_url, gbpLocationId, '', redis)
      } else {
        result = { success: false, error: 'GBP location_id not configured' }
      }
    } else {
      result = { success: false, error: `No API credentials for ${platform}` }
      console.warn(`[SOC] No API credentials for ${platform} — skipping`)
    }

    // Update post status
    if (result.success) {
      await supabase.from('mktg_social_posts').update({
        platform_post_id: result.platform_post_id,
        status: 'published',
        published_at: new Date().toISOString()
      }).eq('id', post.id)

      await supabase.from('mktg_content_library').update({ status: 'published' }).eq('id', post.content_id)
      published++
    } else {
      await supabase.from('mktg_social_posts').update({
        status: 'failed',
        engagement: { error: result.error }
      }).eq('id', post.id)
      console.error(`[SOC] Publish failed for ${post.id}: ${result.error}`)
    }
  }

  return { published, skipped, total: posts.length }
}

async function checkNewReviews(brandId: string): Promise<Record<string, unknown>> {
  // Phase 1: Placeholder — actual Google/Yelp API integration in Phase 06
  // For now, just check if there are reviews with no response
  const { data: reviews } = await supabase
    .from('mktg_reviews')
    .select('id')
    .eq('brand_id', brandId)
    .eq('response_status', 'pending')
    .is('response_draft', null)
    .limit(5)

  if (!reviews || reviews.length === 0) {
    return { new_reviews: 0 }
  }

  // Dispatch write_review_response tasks to COPY
  for (const review of reviews) {
    await copyQueue.add('write_review_response', {
      brand_id: brandId,
      task_type: 'write_review_response',
      input: { brand_id: brandId, review_id: review.id }
    }, { attempts: 2 })
  }

  return { new_reviews: reviews.length, response_tasks_dispatched: reviews.length }
}

async function fetchEngagement(brandId: string): Promise<Record<string, unknown>> {
  // Get recent published posts that need engagement data
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  const { data: posts } = await supabase
    .from('mktg_social_posts')
    .select('*')
    .eq('brand_id', brandId)
    .eq('status', 'published')
    .gte('published_at', cutoff)
    .is('engagement_fetched_at', null)
    .limit(20)

  if (!posts || posts.length === 0) return { fetched: 0 }

  let fetched = 0
  for (const post of posts) {
    if (!post.platform_post_id || !META_TOKEN) continue

    const platform = (post.platform as string).startsWith('instagram') ? 'instagram' as const : 'facebook' as const
    const engagement = await fetchPostEngagement(post.platform_post_id, META_TOKEN, platform)

    if (engagement) {
      await supabase.from('mktg_social_posts').update({
        engagement,
        engagement_fetched_at: new Date().toISOString()
      }).eq('id', post.id)
      fetched++
    }
  }

  return { fetched, total: posts.length }
}

async function sendReviewSolicitation(data: {
  brand_id: string; input: { order_id: string; customer_phone: string; customer_name?: string; delay_minutes?: number }
}): Promise<Record<string, unknown>> {
  const { order_id, customer_phone, customer_name, delay_minutes = 120 } = data.input

  // Check if already sent
  const { data: existing } = await supabase
    .from('mktg_reviews')
    .select('id')
    .eq('order_id', order_id)
    .eq('solicitation_sent', true)
    .single()

  if (existing) return { status: 'already_sent' }

  // Delay check (should be 2 hours after delivery)
  // In production, BullMQ delay handles this. For now, proceed.

  // RingCentral SMS would go here
  const message = `Hi${customer_name ? ` ${customer_name}` : ''}! Thank you for your order from Eastern Landscape & Mason Supply. We'd love to hear about your experience! Please leave us a review: [Google Review Link]. — Eastern LM (631) 874-6244`

  console.log(`[SOC] Review solicitation SMS to ${customer_phone}: "${message.slice(0, 50)}..."`)

  // Record solicitation in reviews table
  await supabase.from('mktg_reviews').insert({
    brand_id: data.brand_id,
    platform: 'google',
    order_id,
    solicitation_sent: true,
    response_status: 'pending',
    review_text: null,
    rating: null
  })

  // Actual SMS sending via RingCentral (Phase 06 wiring)
  // For now, log the intent
  return { status: 'solicitation_logged', phone: customer_phone }
}

// ─── BullMQ Worker ──────────────────────────────────────────────
const worker = new Worker(
  'elm:queue:soc',
  async (job) => {
    const data = job.data as { task_id?: string; brand_id: string; task_type: string; input?: Record<string, unknown> }
    console.log(`[ELM-SOC] Processing: ${data.task_type}`)

    try {
      let output: Record<string, unknown>

      switch (data.task_type) {
        case 'publish_scheduled_posts':
          output = await publishScheduledPosts(data.brand_id)
          break
        case 'check_new_reviews':
          output = await checkNewReviews(data.brand_id)
          break
        case 'fetch_post_engagement':
          output = await fetchEngagement(data.brand_id)
          break
        case 'send_review_solicitation':
          output = await sendReviewSolicitation(data as unknown as { brand_id: string; input: { order_id: string; customer_phone: string; customer_name?: string; delay_minutes?: number } })
          break
        default:
          throw new Error(`Unknown task: ${data.task_type}`)
      }

      if (data.task_id) {
        await supabase.from('mktg_agent_tasks').update({ status: 'completed', output }).eq('task_id', data.task_id)
      }

      await redis.publish('elm:task_complete', JSON.stringify({
        task_id: data.task_id ?? job.id, agent: 'soc', status: 'completed', output
      }))

      console.log(`[ELM-SOC] Completed: ${data.task_type}`)
      return output
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error(`[ELM-SOC] Failed: ${data.task_type}:`, message)

      if (data.task_id) {
        await supabase.from('mktg_agent_tasks').update({ status: 'failed', output: { error: message } }).eq('task_id', data.task_id)
      }
      await redis.publish('elm:task_complete', JSON.stringify({
        task_id: data.task_id ?? job.id, agent: 'soc', status: 'failed', error: message
      }))
      throw err
    }
  },
  { connection: redisOpts, concurrency: 1, limiter: { max: 10, duration: 60000 } }
)

worker.on('ready', () => console.log('[ELM-SOC] Worker ready — consuming from elm:queue:soc'))
worker.on('error', (err) => console.error('[ELM-SOC] Worker error:', err.message))

process.on('SIGTERM', async () => {
  await worker.close()
  await copyQueue.close()
  await redis.quit()
  process.exit(0)
})
