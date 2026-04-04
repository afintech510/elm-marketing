/**
 * ELM Marketing Engine — COPY Agent
 * BullMQ worker consuming from elm-queue-copy
 * Generates content calendars, captions, and review responses via Claude.
 */

import 'dotenv/config'
import { Worker, Queue } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import Redis from 'ioredis'
import { handleTask } from './handlers.js'

// ─── Validate environment ────────────────────────────────────────
const required = ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'REDIS_URL']
for (const key of required) {
  if (!process.env[key]) {
    console.error(`[ELM-COPY] Missing env var: ${key}`)
    process.exit(1)
  }
}

const REDIS_URL = process.env.REDIS_URL!
const redisOpts = (() => {
  const parsed = new URL(REDIS_URL)
  return { host: parsed.hostname, port: parseInt(parsed.port || '6379', 10) }
})()

// ─── Clients ────────────────────────────────────────────────────
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)
const redis = new Redis(REDIS_URL)
const imageQueue = new Queue('elm-queue-image', { connection: redisOpts })

// ─── BullMQ Worker ──────────────────────────────────────────────
const worker = new Worker(
  'elm-queue-copy',
  async (job) => {
    const payload = job.data as { task_id: string; brand_id: string; task_type: string; input: Record<string, unknown> }
    console.log(`[ELM-COPY] Processing: ${payload.task_type} (${payload.task_id})`)

    try {
      const output = await handleTask(payload, supabase, imageQueue, redis)

      // Update task as completed
      await supabase
        .from('mktg_agent_tasks')
        .update({ status: 'completed', output })
        .eq('task_id', payload.task_id)

      // Publish completion event
      await redis.publish('elm:task_complete', JSON.stringify({
        task_id: payload.task_id,
        agent: 'copy',
        status: 'completed',
        output
      }))

      console.log(`[ELM-COPY] Completed: ${payload.task_type} (${payload.task_id})`)
      return output
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error(`[ELM-COPY] Failed: ${payload.task_type} (${payload.task_id}):`, message)

      // Update task as failed
      await supabase
        .from('mktg_agent_tasks')
        .update({ status: 'failed', output: { error: message } })
        .eq('task_id', payload.task_id)

      await redis.publish('elm:task_complete', JSON.stringify({
        task_id: payload.task_id,
        agent: 'copy',
        status: 'failed',
        error: message
      }))

      throw err // Let BullMQ handle retry
    }
  },
  {
    connection: redisOpts,
    concurrency: 1,
    limiter: { max: 5, duration: 60000 }
  }
)

worker.on('ready', () => console.log('[ELM-COPY] Worker ready — consuming from elm-queue-copy'))
worker.on('error', (err) => console.error('[ELM-COPY] Worker error:', err.message))

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[ELM-COPY] Shutting down...')
  await worker.close()
  await imageQueue.close()
  await redis.quit()
  process.exit(0)
})
