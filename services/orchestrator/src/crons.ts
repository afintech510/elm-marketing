/**
 * crons.ts — Brand-scoped cron scheduler
 * All crons loop over active brands (S-014) for multi-brand support.
 */

import cron from 'node-cron'
import { SupabaseClient } from '@supabase/supabase-js'
import { BrandContext } from './brandContext.js'
import { dispatchTask } from './queues.js'
import { isNonCriticalPaused, getDailySpend } from './budget.js'
import { broadcast } from './websocket.js'
import { v4 as uuidv4 } from 'uuid'
import type { Brand, AgentName } from './types.js'

export function initCrons(supabase: SupabaseClient): void {
  const brandCtx = new BrandContext(supabase)

  // Helper: dispatch a task for each active brand
  async function brandScopedDispatch(taskType: string, agent: AgentName, isCritical: boolean = false) {
    // Skip non-critical tasks if budget is >80%
    if (!isCritical && await isNonCriticalPaused()) {
      console.log(`[Cron] Skipping ${taskType} — budget >80%`)
      return
    }

    const brands = await brandCtx.getActiveBrands()
    for (const brand of brands) {
      const task_id = uuidv4()

      // Create task record in Supabase
      await supabase.from('mktg_agent_tasks').insert({
        task_id,
        brand_id: brand.id,
        assigned_agent: agent,
        task_type: taskType,
        status: 'pending',
        priority: 'normal',
        approval_tier: 'AUTO_EXECUTE',
        input: { brand_id: brand.id, task_type: taskType }
      })

      // Dispatch to BullMQ
      await dispatchTask({
        task_id,
        brand_id: brand.id,
        assigned_to: agent,
        task_type: taskType,
        priority: 'normal',
        input: { brand_id: brand.id, task_type: taskType },
        approval_tier: 'AUTO_EXECUTE'
      })

      broadcast({ type: 'task_dispatched', task_id, agent, brand_id: brand.id })
      console.log(`[Cron] Dispatched ${taskType} for ${brand.slug}`)
    }
  }

  // ─── Schedule ─────────────────────────────────────────────────
  // All times are America/New_York

  // Monday 5:00 AM — Generate weekly content calendar
  cron.schedule('0 5 * * 1', () => brandScopedDispatch('generate_weekly_calendar', 'copy', true), {
    timezone: 'America/New_York'
  })

  // Daily 6:00 AM — Check for new reviews
  cron.schedule('0 6 * * *', () => brandScopedDispatch('check_new_reviews', 'soc'), {
    timezone: 'America/New_York'
  })

  // Daily 7:00 AM, 10:00 AM, 2:00 PM — Publish scheduled posts
  cron.schedule('0 7,10,14 * * *', () => brandScopedDispatch('publish_scheduled_posts', 'soc', true), {
    timezone: 'America/New_York'
  })

  // Friday 4:00 PM — Weekly analytics report
  cron.schedule('0 16 * * 5', () => brandScopedDispatch('weekly_analytics_report', 'intel'), {
    timezone: 'America/New_York'
  })

  // Daily 8:00 PM — Fetch post engagement metrics
  cron.schedule('0 20 * * *', () => brandScopedDispatch('fetch_post_engagement', 'soc'), {
    timezone: 'America/New_York'
  })

  // Daily 11:00 PM — Auto-archive stale content
  cron.schedule('0 23 * * *', async () => {
    const { data } = await supabase
      .from('mktg_content_library')
      .update({ status: 'archived' })
      .eq('status', 'pending_approval')
      .lt('created_at', new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString())
      .select('id')

    if (data && data.length > 0) {
      console.log(`[Cron] Auto-archived ${data.length} stale content items`)
    }
  }, { timezone: 'America/New_York' })

  // Daily midnight — Check Meta token expiry
  cron.schedule('0 0 * * *', async () => {
    const spend = await getDailySpend()
    console.log(`[Cron] Daily spend reset check — yesterday: ${spend}¢`)
    // Token expiry check would go here when Meta API is connected
  }, { timezone: 'America/New_York' })

  console.log('[Crons] All schedules registered (America/New_York timezone)')
}
