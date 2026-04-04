/**
 * queues.ts — BullMQ queue setup for the ELM Marketing Engine
 *
 * Replaces Hampton's raw Redis pub/sub with durable BullMQ queues.
 * Each agent gets its own queue with automatic retry, backoff, and DLQ.
 */

import { Queue, QueueEvents } from 'bullmq'
import type { AgentName, TaskManifest } from './types.js'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

// Parse Redis URL for BullMQ connection
function parseRedisUrl(url: string): { host: string; port: number } {
  const parsed = new URL(url)
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10)
  }
}

const connection = parseRedisUrl(REDIS_URL)

// Queue name convention: elm:queue:{agent}
const QUEUE_PREFIX = 'elm:queue'
const queueName = (agent: AgentName) => `${QUEUE_PREFIX}:${agent}`

// Default job options
const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 50 }
}

// ─── Queue instances ────────────────────────────────────────────
const queues = new Map<AgentName, Queue>()
const queueEventInstances = new Map<AgentName, QueueEvents>()

const AGENTS: AgentName[] = ['copy', 'image', 'soc', 'intel']

for (const agent of AGENTS) {
  const q = new Queue(queueName(agent), { connection })
  queues.set(agent, q)

  const events = new QueueEvents(queueName(agent), { connection })
  queueEventInstances.set(agent, events)
}

/**
 * Dispatch a task to an agent's BullMQ queue.
 * Called after approval gate clears.
 */
export async function dispatchTask(manifest: TaskManifest): Promise<string> {
  const queue = queues.get(manifest.assigned_to)
  if (!queue) {
    throw new Error(`No queue for agent: ${manifest.assigned_to}`)
  }

  const job = await queue.add(
    manifest.task_type,
    {
      task_id: manifest.task_id,
      brand_id: manifest.brand_id,
      task_type: manifest.task_type,
      input: manifest.input,
      context: manifest.context ?? {}
    },
    {
      ...DEFAULT_JOB_OPTIONS,
      priority: priorityToNumber(manifest.priority),
      jobId: manifest.task_id // Ensures idempotent job creation
    }
  )

  console.log(`[Queues] Dispatched ${manifest.task_id} → ${manifest.assigned_to} (job ${job.id})`)
  return job.id!
}

/**
 * Get queue for an agent (used for health checks and event listeners)
 */
export function getQueue(agent: AgentName): Queue | undefined {
  return queues.get(agent)
}

/**
 * Get queue events for an agent (used for completion listeners)
 */
export function getQueueEvents(agent: AgentName): QueueEvents | undefined {
  return queueEventInstances.get(agent)
}

/**
 * Get counts for all queues (for health endpoint)
 */
export async function getQueueCounts(): Promise<Record<string, { waiting: number; active: number; completed: number; failed: number }>> {
  const counts: Record<string, { waiting: number; active: number; completed: number; failed: number }> = {}
  for (const [agent, queue] of queues) {
    const c = await queue.getJobCounts('waiting', 'active', 'completed', 'failed')
    counts[agent] = {
      waiting: c.waiting ?? 0,
      active: c.active ?? 0,
      completed: c.completed ?? 0,
      failed: c.failed ?? 0
    }
  }
  return counts
}

/**
 * Close all queues (graceful shutdown)
 */
export async function closeQueues(): Promise<void> {
  for (const [, queue] of queues) await queue.close()
  for (const [, events] of queueEventInstances) await events.close()
}

// Convert priority string to BullMQ numeric priority (lower = higher priority)
function priorityToNumber(priority: string): number {
  switch (priority) {
    case 'urgent': return 1
    case 'high':   return 2
    case 'normal': return 3
    case 'low':    return 4
    default:       return 3
  }
}

export { AGENTS, connection as redisConnection }
