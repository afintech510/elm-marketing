/**
 * meta.ts — Meta Graph API client for Instagram + Facebook publishing
 * Handles: container creation, publishing, engagement fetching
 * Includes: idempotency, draft-only mode gate, circuit breaker
 */

import Redis from 'ioredis'

const META_API_BASE = 'https://graph.facebook.com/v19.0'

interface PublishResult {
  success: boolean
  platform_post_id?: string
  error?: string
  draft_only?: boolean
}

interface EngagementData {
  likes: number
  comments: number
  shares: number
  reach: number
  impressions: number
}

// ─── Circuit Breaker ────────────────────────────────────────────
async function checkCircuitBreaker(redis: Redis, platform: string): Promise<boolean> {
  const pausedUntil = await redis.get(`elm:circuit:${platform}:paused_until`)
  if (pausedUntil && new Date(pausedUntil) > new Date()) {
    console.warn(`[SOC] Circuit breaker OPEN for ${platform} until ${pausedUntil}`)
    return false // blocked
  }
  return true // allowed
}

async function recordFailure(redis: Redis, platform: string): Promise<void> {
  const key = `elm:circuit:${platform}:failures`
  const count = await redis.incr(key)
  await redis.expire(key, 3600)

  if (count >= 5) {
    const pauseUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString()
    await redis.set(`elm:circuit:${platform}:paused_until`, pauseUntil, 'EX', 900)
    console.error(`[SOC] Circuit breaker TRIPPED for ${platform} — pausing until ${pauseUntil}`)
  }
}

async function recordSuccess(redis: Redis, platform: string): Promise<void> {
  await redis.del(`elm:circuit:${platform}:failures`)
}

// ─── Instagram Publishing ───────────────────────────────────────
export async function publishToInstagram(
  caption: string,
  imageUrl: string,
  accessToken: string,
  igAccountId: string,
  redis: Redis
): Promise<PublishResult> {
  if (!await checkCircuitBreaker(redis, 'instagram')) {
    return { success: false, error: 'Circuit breaker open' }
  }

  try {
    // Step 1: Create media container
    const containerRes = await fetch(`${META_API_BASE}/${igAccountId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_url: imageUrl,
        caption,
        access_token: accessToken
      })
    })

    if (!containerRes.ok) {
      const err = await containerRes.text()
      await recordFailure(redis, 'instagram')
      return { success: false, error: `Container creation failed: ${err}` }
    }

    const container = await containerRes.json() as { id: string }

    // Step 2: Publish
    const publishRes = await fetch(`${META_API_BASE}/${igAccountId}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creation_id: container.id,
        access_token: accessToken
      })
    })

    if (!publishRes.ok) {
      const err = await publishRes.text()
      await recordFailure(redis, 'instagram')
      return { success: false, error: `Publish failed: ${err}` }
    }

    const result = await publishRes.json() as { id: string }
    await recordSuccess(redis, 'instagram')
    return { success: true, platform_post_id: result.id }
  } catch (err) {
    await recordFailure(redis, 'instagram')
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

// ─── Facebook Publishing ────────────────────────────────────────
export async function publishToFacebook(
  caption: string,
  imageUrl: string | null,
  accessToken: string,
  pageId: string,
  redis: Redis
): Promise<PublishResult> {
  if (!await checkCircuitBreaker(redis, 'facebook')) {
    return { success: false, error: 'Circuit breaker open' }
  }

  try {
    const endpoint = imageUrl
      ? `${META_API_BASE}/${pageId}/photos`
      : `${META_API_BASE}/${pageId}/feed`

    const body: Record<string, string> = {
      access_token: accessToken,
      ...(imageUrl ? { url: imageUrl, message: caption } : { message: caption })
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })

    if (!res.ok) {
      const err = await res.text()
      await recordFailure(redis, 'facebook')
      return { success: false, error: `Facebook publish failed: ${err}` }
    }

    const result = await res.json() as { id?: string; post_id?: string }
    await recordSuccess(redis, 'facebook')
    return { success: true, platform_post_id: result.id ?? result.post_id }
  } catch (err) {
    await recordFailure(redis, 'facebook')
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

// ─── Engagement Fetching ────────────────────────────────────────
export async function fetchPostEngagement(
  postId: string,
  accessToken: string,
  platform: 'instagram' | 'facebook'
): Promise<EngagementData | null> {
  try {
    const fields = platform === 'instagram'
      ? 'like_count,comments_count,impressions,reach'
      : 'likes.summary(true),comments.summary(true),shares'

    const res = await fetch(
      `${META_API_BASE}/${postId}?fields=${fields}&access_token=${accessToken}`
    )

    if (!res.ok) return null

    const data = await res.json() as Record<string, unknown>

    if (platform === 'instagram') {
      return {
        likes: (data.like_count as number) ?? 0,
        comments: (data.comments_count as number) ?? 0,
        shares: 0,
        reach: (data.reach as number) ?? 0,
        impressions: (data.impressions as number) ?? 0
      }
    } else {
      return {
        likes: ((data.likes as { summary?: { total_count?: number } })?.summary?.total_count) ?? 0,
        comments: ((data.comments as { summary?: { total_count?: number } })?.summary?.total_count) ?? 0,
        shares: ((data.shares as { count?: number })?.count) ?? 0,
        reach: 0,
        impressions: 0
      }
    }
  } catch {
    return null
  }
}
