/**
 * alerting.ts — SMS alerting on critical errors (S-019)
 * Rate-limited: max 5 SMS per hour.
 */

import Redis from 'ioredis'

let redis: Redis | null = null

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
    redis.on('error', (err) => console.error('[Alerting] Redis error:', err.message))
  }
  return redis
}

const ADMIN_PHONE = process.env.ADMIN_PHONE ?? ''
const RINGCENTRAL_JWT = process.env.RINGCENTRAL_JWT_TOKEN ?? ''
const SMS_FROM = process.env.RINGCENTRAL_SMS_FROM ?? '+16318746244'
const RATE_LIMIT_KEY = 'elm:alerts:count'
const MAX_ALERTS_PER_HOUR = 5

/**
 * Send an alert SMS to the admin. Rate-limited to 5/hour.
 */
export async function sendAlert(message: string): Promise<boolean> {
  console.warn(`[ALERT] ${message}`)

  if (!ADMIN_PHONE || !RINGCENTRAL_JWT) {
    console.log('[Alerting] SMS not configured — alert logged only')
    return false
  }

  const r = getRedis()

  // Rate limit check
  const count = await r.incr(RATE_LIMIT_KEY)
  if (count === 1) await r.expire(RATE_LIMIT_KEY, 3600)
  if (count > MAX_ALERTS_PER_HOUR) {
    console.warn('[Alerting] Rate limit exceeded — suppressing SMS')
    return false
  }

  try {
    // RingCentral JWT auth → get access token
    const authRes = await fetch('https://platform.ringcentral.com/restapi/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: RINGCENTRAL_JWT
      })
    })

    if (!authRes.ok) {
      console.error('[Alerting] RingCentral auth failed')
      return false
    }

    const { access_token } = await authRes.json() as { access_token: string }

    // Send SMS
    const smsRes = await fetch(
      'https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/sms',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: { phoneNumber: SMS_FROM },
          to: [{ phoneNumber: ADMIN_PHONE }],
          text: `[ELM Marketing] ${message}`
        })
      }
    )

    if (!smsRes.ok) {
      console.error('[Alerting] SMS send failed:', await smsRes.text())
      return false
    }

    console.log(`[Alerting] SMS sent to ${ADMIN_PHONE}`)
    return true
  } catch (err) {
    console.error('[Alerting] SMS error:', err instanceof Error ? err.message : err)
    return false
  }
}

// Convenience methods for common alert types
export const alertAgentFailure = (agent: string, taskType: string, error: string) =>
  sendAlert(`Agent ${agent} failed on ${taskType}: ${error}`)

export const alertCircuitBreaker = (platform: string) =>
  sendAlert(`Circuit breaker OPEN for ${platform} — 5 consecutive failures. Auto-retry in 15 min.`)

export const alertBudgetExceeded = (spentCents: number, limitCents: number) =>
  sendAlert(`Daily token budget exceeded: $${(spentCents / 100).toFixed(2)} / $${(limitCents / 100).toFixed(2)}. Non-critical tasks paused.`)
