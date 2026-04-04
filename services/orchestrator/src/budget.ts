/**
 * budget.ts — Token budget enforcement via Redis
 *
 * Tracks per-agent daily spend using Redis keys with 24-hour TTL.
 * 80% → pause non-critical tasks, 100% → only owner-initiated commands.
 */

import Redis from 'ioredis'
import type { AgentName, BudgetCheck } from './types.js'

const DAILY_LIMIT_CENTS = parseInt(process.env.DAILY_TOKEN_BUDGET_CENTS ?? '700', 10)

let redis: Redis

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
    redis.on('error', (err) => console.error('[Budget] Redis error:', err))
  }
  return redis
}

function budgetKey(agent: AgentName): string {
  const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  return `elm:budget:${date}:${agent}`
}

function totalBudgetKey(): string {
  const date = new Date().toISOString().slice(0, 10)
  return `elm:budget:${date}:total`
}

/**
 * Check if an agent can proceed with a task.
 */
export async function checkBudget(agent: AgentName): Promise<BudgetCheck> {
  const r = getRedis()
  const spent = parseInt(await r.get(totalBudgetKey()) ?? '0', 10)
  const percentage = (spent / DAILY_LIMIT_CENTS) * 100

  return {
    allowed: spent < DAILY_LIMIT_CENTS,
    spent_cents: spent,
    limit_cents: DAILY_LIMIT_CENTS,
    percentage
  }
}

/**
 * Check if non-critical tasks should be paused (>80% budget)
 */
export async function isNonCriticalPaused(): Promise<boolean> {
  const { percentage } = await checkBudget('orchestrator')
  return percentage >= 80
}

/**
 * Record token spend after a Claude call completes.
 */
export async function recordSpend(agent: AgentName, costCents: number): Promise<void> {
  const r = getRedis()
  const agentKey = budgetKey(agent)
  const totalKey = totalBudgetKey()

  // Increment both agent-specific and total keys
  await r.incrby(agentKey, costCents)
  await r.incrby(totalKey, costCents)

  // Set 24-hour TTL if key is new
  await r.expire(agentKey, 86400)
  await r.expire(totalKey, 86400)

  console.log(`[Budget] Recorded ${costCents}¢ for ${agent}`)
}

/**
 * Get total daily spend across all agents.
 */
export async function getDailySpend(): Promise<number> {
  const r = getRedis()
  return parseInt(await r.get(totalBudgetKey()) ?? '0', 10)
}

/**
 * Get per-agent spend breakdown for today.
 */
export async function getSpendBreakdown(): Promise<Record<string, number>> {
  const r = getRedis()
  const date = new Date().toISOString().slice(0, 10)
  const agents: AgentName[] = ['orchestrator', 'copy', 'image', 'soc', 'intel']
  const breakdown: Record<string, number> = {}

  for (const agent of agents) {
    breakdown[agent] = parseInt(await r.get(`elm:budget:${date}:${agent}`) ?? '0', 10)
  }

  return breakdown
}
