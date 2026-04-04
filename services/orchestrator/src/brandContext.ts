/**
 * brandContext.ts — Load + cache brand configuration and memory
 */

import { SupabaseClient } from '@supabase/supabase-js'
import type { Brand } from './types.js'

// In-memory cache with TTL
interface CacheEntry<T> {
  data: T
  expiresAt: number
}

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const brandCache = new Map<string, CacheEntry<Brand>>()

export class BrandContext {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Load brand by slug (cached)
   */
  async loadBrand(slug: string): Promise<Brand | null> {
    const cached = brandCache.get(slug)
    if (cached && cached.expiresAt > Date.now()) return cached.data

    const { data, error } = await this.supabase
      .from('mktg_brands')
      .select('*')
      .eq('slug', slug)
      .single()

    if (error || !data) return null

    const brand = data as Brand
    brandCache.set(slug, { data: brand, expiresAt: Date.now() + CACHE_TTL_MS })
    return brand
  }

  /**
   * Load brand by ID (cached)
   */
  async loadBrandById(brandId: string): Promise<Brand | null> {
    // Check cache by ID
    for (const [, entry] of brandCache) {
      if (entry.data.id === brandId && entry.expiresAt > Date.now()) return entry.data
    }

    const { data, error } = await this.supabase
      .from('mktg_brands')
      .select('*')
      .eq('id', brandId)
      .single()

    if (error || !data) return null

    const brand = data as Brand
    brandCache.set(brand.slug, { data: brand, expiresAt: Date.now() + CACHE_TTL_MS })
    return brand
  }

  /**
   * Get all active brands (for brand-scoped cron loops)
   */
  async getActiveBrands(): Promise<Brand[]> {
    const { data, error } = await this.supabase
      .from('mktg_brands')
      .select('*')
      .eq('is_active', true)

    if (error || !data) return []
    return data as Brand[]
  }

  /**
   * Get the default brand (eastern-lm)
   */
  async getDefaultBrand(): Promise<Brand | null> {
    return this.loadBrand('eastern-lm')
  }

  /**
   * Invalidate cache for a brand
   */
  invalidate(slug: string): void {
    brandCache.delete(slug)
  }
}
