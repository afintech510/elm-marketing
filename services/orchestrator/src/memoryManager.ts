/**
 * memoryManager.ts — Load and update agent memory from Supabase
 * Adapted from host-hampton-ops/services/hampton/src/memoryManager.ts
 */

import { SupabaseClient } from '@supabase/supabase-js'
import type { IntentCategory, MemoryEntry } from './types.js'

// Which namespaces to load for each intent type
const INTENT_NAMESPACE_MAP: Record<IntentCategory, string[]> = {
  GENERATE_CALENDAR:  ['brand.voice_rules', 'brand.products_bulk', 'brand.services', 'content.pillar_rules', 'content.caption_guidelines', 'content.negative_examples', 'geography.towns_tier_a'],
  CREATE_CONTENT:     ['brand.voice_rules', 'brand.products_bulk', 'brand.services', 'brand.delivery', 'content.pillar_rules', 'content.caption_guidelines', 'content.platform_specs', 'content.negative_examples'],
  PUBLISH_NOW:        ['content.platform_specs'],
  ANALYTICS_REPORT:   ['brand.voice_rules', 'geography.towns_tier_a'],
  COMPETITOR_DIGEST:  ['competitors.seed_accounts'],
  REVIEW_RESPONSE:    ['brand.voice_rules', 'brand.business_hours'],
  SETTINGS_CHANGE:    ['brand.voice_rules'],
  STATUS_CHECK:       [],
  STRATEGY_QUESTION:  ['brand.voice_rules', 'brand.products_bulk', 'brand.services', 'brand.delivery', 'geography.towns_tier_a'],
  UNKNOWN:            ['brand.voice_rules']
}

const BASELINE_NAMESPACES = ['brand.voice_rules']

export class MemoryManager {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Load a single namespace.key entry for a brand
   */
  async load(brandId: string, namespace: string, key: string): Promise<Record<string, unknown> | null> {
    const { data, error } = await this.supabase
      .from('mktg_agent_memory')
      .select('value')
      .eq('brand_id', brandId)
      .eq('namespace', namespace)
      .eq('key', key)
      .single()

    if (error || !data) return null
    return data.value as Record<string, unknown>
  }

  /**
   * Load context for a specific intent — returns flat map of namespace.key → value
   */
  async loadForIntent(brandId: string, intent: IntentCategory): Promise<Record<string, unknown>> {
    const namespaceKeys = [
      ...new Set([...BASELINE_NAMESPACES, ...(INTENT_NAMESPACE_MAP[intent] ?? [])])
    ]

    const results: Record<string, unknown> = {}

    await Promise.all(
      namespaceKeys.map(async (nsKey) => {
        const [namespace, key] = nsKey.split('.')
        if (!namespace || !key) return
        const value = await this.load(brandId, namespace, key)
        if (value !== null) results[nsKey] = value
      })
    )

    return results
  }

  /**
   * Update a memory entry (upsert)
   */
  async update(
    brandId: string,
    namespace: string,
    key: string,
    value: Record<string, unknown>,
    updatedBy: string = 'orchestrator'
  ): Promise<void> {
    const { error } = await this.supabase
      .from('mktg_agent_memory')
      .upsert(
        { brand_id: brandId, namespace, key, value, updated_by: updatedBy },
        { onConflict: 'brand_id,namespace,key' }
      )

    if (error) {
      console.error(`[MemoryManager] Failed to update ${namespace}.${key}:`, error.message)
      throw error
    }
  }

  /**
   * Append to negative examples (keep last 5)
   */
  async appendNegativeExample(
    brandId: string,
    example: { body: string; rejection_reason: string; platform: string; pillar: string; rejected_at: string }
  ): Promise<void> {
    const current = await this.load(brandId, 'content', 'negative_examples')
    const existing: unknown[] = (current && 'examples' in current && Array.isArray(current.examples))
      ? current.examples as unknown[]
      : []
    existing.push(example)

    // Keep only last 5
    const trimmed = existing.slice(-5)
    await this.update(brandId, 'content', 'negative_examples', { examples: trimmed }, 'orchestrator')
  }

  /**
   * Format context as a string for inclusion in Claude prompts
   */
  formatContextForPrompt(context: Record<string, unknown>): string {
    const lines: string[] = ['## Brand Context\n']
    for (const [key, value] of Object.entries(context)) {
      lines.push(`### ${key}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`)
    }
    return lines.join('\n')
  }
}
