/**
 * gbp.ts — Google Business Profile API client
 * Handles: LocalPost creation with CTA links
 */

import Redis from 'ioredis'

interface GbpPublishResult {
  success: boolean
  platform_post_id?: string
  error?: string
}

/**
 * Publish a LocalPost to Google Business Profile
 * Uses Google My Business API v4 with service account auth
 */
export async function publishToGBP(
  caption: string,
  imageUrl: string | null,
  ctaUrl: string | null,
  locationId: string,
  accessToken: string,
  redis: Redis
): Promise<GbpPublishResult> {
  // Check circuit breaker
  const pausedUntil = await redis.get('elm:circuit:gbp:paused_until')
  if (pausedUntil && new Date(pausedUntil) > new Date()) {
    return { success: false, error: 'Circuit breaker open for GBP' }
  }

  try {
    const postBody: Record<string, unknown> = {
      languageCode: 'en-US',
      summary: caption,
      topicType: 'STANDARD'
    }

    // Add media if provided
    if (imageUrl) {
      postBody.media = [{ mediaFormat: 'PHOTO', sourceUrl: imageUrl }]
    }

    // Add CTA button if URL provided
    if (ctaUrl) {
      postBody.callToAction = {
        actionType: 'LEARN_MORE',
        url: ctaUrl
      }
    }

    const res = await fetch(
      `https://mybusiness.googleapis.com/v4/accounts/-/locations/${locationId}/localPosts`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(postBody)
      }
    )

    if (!res.ok) {
      const err = await res.text()
      // Record failure for circuit breaker
      const failKey = 'elm:circuit:gbp:failures'
      const count = await redis.incr(failKey)
      await redis.expire(failKey, 3600)
      if (count >= 5) {
        await redis.set('elm:circuit:gbp:paused_until', new Date(Date.now() + 15 * 60 * 1000).toISOString(), 'EX', 900)
      }
      return { success: false, error: `GBP publish failed: ${err}` }
    }

    const result = await res.json() as { name?: string }
    await redis.del('elm:circuit:gbp:failures')
    return { success: true, platform_post_id: result.name }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}
