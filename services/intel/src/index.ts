/**
 * ELM Marketing Engine — INTEL Agent
 * BullMQ worker consuming from elm-queue-intel
 * Pulls GA4 analytics, monitors competitors, generates weekly reports.
 */

import 'dotenv/config'
import { Worker } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import Redis from 'ioredis'
import Anthropic from '@anthropic-ai/sdk'

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'REDIS_URL', 'ANTHROPIC_API_KEY']
for (const key of required) {
  if (!process.env[key]) { console.error(`[ELM-INTEL] Missing: ${key}`); process.exit(1) }
}

const REDIS_URL = process.env.REDIS_URL!
const redisOpts = (() => {
  const parsed = new URL(REDIS_URL)
  return { host: parsed.hostname, port: parseInt(parsed.port || '6379', 10) }
})()

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)
const redis = new Redis(REDIS_URL)
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ─── GA4 Analytics ──────────────────────────────────────────────
async function fetchGA4Metrics(brandId: string): Promise<Record<string, unknown> | null> {
  const propertyId = process.env.GA4_PROPERTY_ID
  if (!propertyId) {
    console.log('[INTEL] GA4 not configured — skipping analytics fetch')
    return null
  }

  try {
    // Use Google Analytics Data API v1beta
    const serviceAccountJson = process.env.GOOGLE_GA4_SERVICE_ACCOUNT_JSON
    if (!serviceAccountJson) return null

    const { google } = await import('googleapis')
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(serviceAccountJson),
      scopes: ['https://www.googleapis.com/auth/analytics.readonly']
    })

    const analyticsData = google.analyticsdata({ version: 'v1beta', auth })

    // Last 7 days
    const endDate = new Date().toISOString().slice(0, 10)
    const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

    const response = await analyticsData.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'sessionSource' }],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'screenPageViews' },
          { name: 'averageSessionDuration' }
        ]
      }
    })

    return {
      period: { start: startDate, end: endDate },
      rows: response.data.rows ?? [],
      totals: response.data.totals ?? []
    }
  } catch (err) {
    console.error('[INTEL] GA4 fetch failed:', err instanceof Error ? err.message : err)
    return null
  }
}

// ─── Social Post Performance ────────────────────────────────────
async function getSocialPerformance(brandId: string): Promise<Record<string, unknown>> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const { data: posts } = await supabase
    .from('mktg_social_posts')
    .select('platform, engagement, published_at')
    .eq('brand_id', brandId)
    .eq('status', 'published')
    .gte('published_at', weekAgo)
    .order('published_at', { ascending: false })

  if (!posts || posts.length === 0) return { total_posts: 0 }

  // Aggregate engagement
  let totalLikes = 0, totalComments = 0, totalReach = 0
  const byPlatform: Record<string, number> = {}

  for (const post of posts) {
    const eng = post.engagement as { likes?: number; comments?: number; reach?: number } | null
    totalLikes += eng?.likes ?? 0
    totalComments += eng?.comments ?? 0
    totalReach += eng?.reach ?? 0
    byPlatform[post.platform] = (byPlatform[post.platform] ?? 0) + 1
  }

  return {
    total_posts: posts.length,
    total_likes: totalLikes,
    total_comments: totalComments,
    total_reach: totalReach,
    posts_by_platform: byPlatform,
    avg_engagement_per_post: posts.length > 0 ? Math.round((totalLikes + totalComments) / posts.length) : 0
  }
}

// ─── Competitor Monitoring ──────────────────────────────────────
async function monitorCompetitors(brandId: string): Promise<Record<string, unknown>> {
  const { data: accounts } = await supabase
    .from('mktg_competitor_accounts')
    .select('*')
    .eq('brand_id', brandId)
    .eq('is_active', true)

  if (!accounts || accounts.length === 0) return { monitored: 0 }

  // Phase 1: Create placeholder snapshots
  // Real scraping/API integration comes in Phase 06
  const today = new Date().toISOString().slice(0, 10)
  let created = 0

  for (const account of accounts) {
    // Check if snapshot already exists for today
    const { data: existing } = await supabase
      .from('mktg_competitor_snapshots')
      .select('id')
      .eq('account_id', account.id)
      .eq('snapshot_date', today)
      .single()

    if (existing) continue

    await supabase.from('mktg_competitor_snapshots').insert({
      account_id: account.id,
      snapshot_date: today,
      data: {
        source: 'placeholder',
        note: 'Awaiting API integration in Phase 06'
      }
    })
    created++
  }

  return { monitored: accounts.length, snapshots_created: created }
}

// ─── Weekly Analytics Report ────────────────────────────────────
async function generateWeeklyReport(brandId: string): Promise<Record<string, unknown>> {
  const ga4 = await fetchGA4Metrics(brandId)
  const social = await getSocialPerformance(brandId)

  // Get brand name for prompt
  const { data: brand } = await supabase.from('mktg_brands').select('name').eq('id', brandId).single()

  const reportPrompt = `Generate a weekly marketing performance report for ${brand?.name ?? 'Eastern LM'}.

## Data Available

### Social Media Performance (past 7 days)
${JSON.stringify(social, null, 2)}

### Website Analytics (GA4)
${ga4 ? JSON.stringify(ga4, null, 2) : 'GA4 not configured — no website data available.'}

### Instructions
- Summarize key metrics in 2-3 bullet points
- Highlight top performing content if any
- Note any concerning trends
- Provide 2-3 actionable recommendations for next week
- Be specific and data-driven
- Keep the entire report under 500 words`

  const response = await claude.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: 'You are INTEL, the analytics agent for Eastern Landscape & Mason Supply. You produce clear, actionable marketing reports.',
    messages: [{ role: 'user', content: reportPrompt }]
  })

  const summary = response.content[0].type === 'text' ? response.content[0].text : 'Report generation failed.'

  // Track token usage
  const costCents = Math.ceil((response.usage.input_tokens * 0.3 + response.usage.output_tokens * 1.5) / 1000)
  const date = new Date().toISOString().slice(0, 10)
  await redis.incrby(`elm:budget:${date}:intel`, costCents)
  await redis.incrby(`elm:budget:${date}:total`, costCents)
  await redis.expire(`elm:budget:${date}:intel`, 86400)
  await redis.expire(`elm:budget:${date}:total`, 86400)

  // Save report
  const periodStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const periodEnd = date

  await supabase.from('mktg_analytics_snapshots').insert({
    brand_id: brandId,
    snapshot_type: 'weekly_report',
    period_start: periodStart,
    period_end: periodEnd,
    data: { ga4, social },
    summary
  })

  return { report_generated: true, period: `${periodStart} to ${periodEnd}`, summary_length: summary.length }
}

// ─── Competitor Digest ──────────────────────────────────────────
async function generateCompetitorDigest(brandId: string): Promise<Record<string, unknown>> {
  // Get recent snapshots
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const { data: snapshots } = await supabase
    .from('mktg_competitor_snapshots')
    .select('*, account:mktg_competitor_accounts(account_handle, display_name, account_type)')
    .gte('snapshot_date', weekAgo)
    .order('snapshot_date', { ascending: false })
    .limit(50)

  if (!snapshots || snapshots.length === 0) {
    return { digest_generated: false, reason: 'no_recent_snapshots' }
  }

  const digestPrompt = `Analyze competitor activity for Eastern Landscape & Mason Supply (landscape/masonry supply yard, Center Moriches, NY).

## Competitor Snapshots (past week)
${JSON.stringify(snapshots.map(s => ({
  account: (s.account as { display_name?: string })?.display_name ?? 'Unknown',
  type: (s.account as { account_type?: string })?.account_type,
  date: s.snapshot_date,
  data: s.data
})), null, 2)}

Provide:
1. Key trends in competitor content (what types of posts, themes, seasonal focus)
2. Engagement patterns (what's working for them)
3. Opportunities for Eastern LM to differentiate
4. Specific content ideas inspired by competitor activity
Keep under 400 words. Be actionable.`

  const response = await claude.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    system: 'You are INTEL, the competitive intelligence agent for Eastern Landscape & Mason Supply.',
    messages: [{ role: 'user', content: digestPrompt }]
  })

  const summary = response.content[0].type === 'text' ? response.content[0].text : ''
  const date = new Date().toISOString().slice(0, 10)
  const costCents = Math.ceil((response.usage.input_tokens * 0.3 + response.usage.output_tokens * 1.5) / 1000)
  await redis.incrby(`elm:budget:${date}:intel`, costCents)
  await redis.incrby(`elm:budget:${date}:total`, costCents)

  await supabase.from('mktg_analytics_snapshots').insert({
    brand_id: brandId,
    snapshot_type: 'competitor_digest',
    period_start: weekAgo,
    period_end: date,
    data: { snapshot_count: snapshots.length },
    summary
  })

  return { digest_generated: true, summary_length: summary.length }
}

// ─── BullMQ Worker ──────────────────────────────────────────────
const worker = new Worker(
  'elm-queue-intel',
  async (job) => {
    const data = job.data as { task_id?: string; brand_id: string; task_type: string }
    console.log(`[ELM-INTEL] Processing: ${data.task_type}`)

    try {
      let output: Record<string, unknown>

      switch (data.task_type) {
        case 'weekly_analytics_report':
          output = await generateWeeklyReport(data.brand_id)
          break
        case 'competitor_digest':
          output = await generateCompetitorDigest(data.brand_id)
          break
        case 'monitor_competitors':
          output = await monitorCompetitors(data.brand_id)
          break
        default:
          throw new Error(`Unknown task: ${data.task_type}`)
      }

      if (data.task_id) {
        await supabase.from('mktg_agent_tasks').update({ status: 'completed', output }).eq('task_id', data.task_id)
      }

      await redis.publish('elm:task_complete', JSON.stringify({
        task_id: data.task_id ?? job.id, agent: 'intel', status: 'completed', output
      }))

      console.log(`[ELM-INTEL] Completed: ${data.task_type}`)
      return output
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error(`[ELM-INTEL] Failed: ${data.task_type}:`, message)

      if (data.task_id) {
        await supabase.from('mktg_agent_tasks').update({ status: 'failed', output: { error: message } }).eq('task_id', data.task_id)
      }
      await redis.publish('elm:task_complete', JSON.stringify({
        task_id: data.task_id ?? job.id, agent: 'intel', status: 'failed', error: message
      }))
      throw err
    }
  },
  { connection: redisOpts, concurrency: 1, limiter: { max: 5, duration: 60000 } }
)

worker.on('ready', () => console.log('[ELM-INTEL] Worker ready — consuming from elm-queue-intel'))
worker.on('error', (err) => console.error('[ELM-INTEL] Worker error:', err.message))

process.on('SIGTERM', async () => {
  await worker.close()
  await redis.quit()
  process.exit(0)
})
