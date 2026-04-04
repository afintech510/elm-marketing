/**
 * feedback.ts — Rejection feedback loop
 * When content is rejected, the reason is appended to negative_examples
 * memory so agents learn from mistakes.
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { MemoryManager } from './memoryManager.js'

export class FeedbackLoop {
  private memory: MemoryManager

  constructor(private supabase: SupabaseClient) {
    this.memory = new MemoryManager(supabase)
  }

  /**
   * Process a content rejection: update status and append to negative examples
   */
  async processRejection(contentId: string, reason: string): Promise<void> {
    // Get the content item
    const { data: content, error } = await this.supabase
      .from('mktg_content_library')
      .select('brand_id, body, platform, pillar')
      .eq('id', contentId)
      .single()

    if (error || !content) {
      console.error('[Feedback] Content not found:', contentId)
      return
    }

    // Update content status
    await this.supabase
      .from('mktg_content_library')
      .update({ status: 'rejected', rejection_reason: reason })
      .eq('id', contentId)

    // Append to negative examples in agent memory
    await this.memory.appendNegativeExample(content.brand_id, {
      body: content.body?.slice(0, 200) ?? '',
      rejection_reason: reason,
      platform: content.platform,
      pillar: content.pillar,
      rejected_at: new Date().toISOString()
    })

    console.log(`[Feedback] Rejection processed for ${contentId}: "${reason}"`)
  }
}
