/**
 * approvalGate.ts — 3-tier approval matrix
 * Adapted from host-hampton-ops/services/hampton/src/approvalGate.ts
 *
 * AUTO_EXECUTE   → dispatch immediately
 * DRAFT_AND_SHOW → surface to owner, auto-execute after 4 hours
 * ALWAYS_ASK     → hold indefinitely
 */

import { SupabaseClient } from '@supabase/supabase-js'
import type { TaskManifest, TaskStatus, ApprovalTier } from './types.js'

const DRAFT_AND_SHOW_TIMEOUT_MS = 4 * 60 * 60 * 1000 // 4 hours

export class ApprovalGate {
  private pendingApprovals = new Map<string, NodeJS.Timeout>()

  constructor(
    private supabase: SupabaseClient,
    private onAutoExecute: (manifest: TaskManifest) => Promise<void>
  ) {}

  async process(manifest: TaskManifest): Promise<{
    action: 'dispatched' | 'pending_approval' | 'held_for_owner'
    message: string
  }> {
    switch (manifest.approval_tier) {
      case 'AUTO_EXECUTE':
        await this.onAutoExecute(manifest)
        return {
          action: 'dispatched',
          message: `Task ${manifest.task_id} dispatched to ${manifest.assigned_to}`
        }

      case 'DRAFT_AND_SHOW':
        await this.holdForApproval(manifest)
        this.scheduleAutoExecute(manifest)
        return {
          action: 'pending_approval',
          message: `Task ${manifest.task_id} awaiting approval. Auto-executes in 4 hours.`
        }

      case 'ALWAYS_ASK':
        await this.holdForApproval(manifest)
        return {
          action: 'held_for_owner',
          message: `Task ${manifest.task_id} requires explicit approval before proceeding.`
        }
    }
  }

  async approve(rowId: string): Promise<void> {
    const { data, error: fetchError } = await this.supabase
      .from('mktg_agent_tasks')
      .select('*')
      .eq('id', rowId)
      .single()

    if (fetchError || !data) throw new Error(`Task ${rowId} not found`)

    this.cancelAutoExecuteTimer(data.task_id)

    await this.supabase
      .from('mktg_agent_tasks')
      .update({ status: 'in_progress' as TaskStatus, approved_at: new Date().toISOString() })
      .eq('id', rowId)

    await this.onAutoExecute(data as unknown as TaskManifest)
  }

  async reject(rowId: string, reason?: string): Promise<void> {
    const { data } = await this.supabase
      .from('mktg_agent_tasks')
      .select('task_id')
      .eq('id', rowId)
      .single()

    if (data?.task_id) this.cancelAutoExecuteTimer(data.task_id)

    await this.supabase
      .from('mktg_agent_tasks')
      .update({
        status: 'cancelled' as TaskStatus,
        rejected_at: new Date().toISOString(),
        rejection_reason: reason ?? 'Rejected by owner'
      })
      .eq('id', rowId)
  }

  isPending(taskId: string): boolean {
    return this.pendingApprovals.has(taskId)
  }

  private async holdForApproval(manifest: TaskManifest): Promise<void> {
    await this.supabase
      .from('mktg_agent_tasks')
      .update({ status: 'pending' as TaskStatus })
      .eq('task_id', manifest.task_id)
  }

  private scheduleAutoExecute(manifest: TaskManifest): void {
    const timer = setTimeout(async () => {
      this.pendingApprovals.delete(manifest.task_id)
      console.log(`[ApprovalGate] 4-hour timeout — auto-executing ${manifest.task_id}`)

      await this.supabase
        .from('mktg_agent_tasks')
        .update({ status: 'in_progress' as TaskStatus, approved_at: new Date().toISOString() })
        .eq('task_id', manifest.task_id)

      await this.onAutoExecute(manifest)
    }, DRAFT_AND_SHOW_TIMEOUT_MS)

    this.pendingApprovals.set(manifest.task_id, timer)
  }

  private cancelAutoExecuteTimer(taskId: string): void {
    const timer = this.pendingApprovals.get(taskId)
    if (timer) {
      clearTimeout(timer)
      this.pendingApprovals.delete(taskId)
    }
  }
}

/**
 * Get the approval tier for an intent
 */
export function getApprovalTier(intent: string): ApprovalTier {
  const APPROVAL_MAP: Record<string, ApprovalTier> = {
    GENERATE_CALENDAR:  'DRAFT_AND_SHOW',
    CREATE_CONTENT:     'DRAFT_AND_SHOW',
    PUBLISH_NOW:        'AUTO_EXECUTE',
    ANALYTICS_REPORT:   'AUTO_EXECUTE',
    COMPETITOR_DIGEST:  'AUTO_EXECUTE',
    REVIEW_RESPONSE:    'DRAFT_AND_SHOW',
    SETTINGS_CHANGE:    'ALWAYS_ASK',
    STATUS_CHECK:       'AUTO_EXECUTE',
    STRATEGY_QUESTION:  'AUTO_EXECUTE',
    UNKNOWN:            'DRAFT_AND_SHOW'
  }
  return APPROVAL_MAP[intent] ?? 'DRAFT_AND_SHOW'
}
