/**
 * ELM Marketing Engine — IMAGE Agent
 * BullMQ worker consuming from elm:queue:image
 * Formats uploaded photos for each social platform using Sharp.
 */

import 'dotenv/config'
import { Worker } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import Redis from 'ioredis'
import { v4 as uuidv4 } from 'uuid'
import { formatForPlatform, formatForAllPlatforms, getImageDimensions, PLATFORM_SPECS } from './formatter.js'

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'REDIS_URL']
for (const key of required) {
  if (!process.env[key]) { console.error(`[ELM-IMAGE] Missing: ${key}`); process.exit(1) }
}

const REDIS_URL = process.env.REDIS_URL!
const redisOpts = (() => {
  const parsed = new URL(REDIS_URL)
  return { host: parsed.hostname, port: parseInt(parsed.port || '6379', 10) }
})()

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)
const redis = new Redis(REDIS_URL)
const BUCKET = 'marketing-assets'

// ─── Task handlers ──────────────────────────────────────────────
async function handleFormatImages(data: {
  brand_id: string; content_id: string; image_tags: string[]; platform: string
}): Promise<Record<string, unknown>> {
  const { brand_id, content_id, image_tags, platform } = data

  // Find raw uploads matching tags
  const { data: assets } = await supabase
    .from('mktg_image_assets')
    .select('*')
    .eq('brand_id', brand_id)
    .eq('asset_type', 'raw_upload')
    .overlaps('tags', image_tags)
    .order('created_at', { ascending: false })
    .limit(3)

  if (!assets || assets.length === 0) {
    console.warn(`[ELM-IMAGE] No raw uploads matching tags: ${image_tags.join(', ')}`)
    return { formatted: 0, reason: 'no_matching_uploads' }
  }

  const formattedIds: string[] = []

  for (const asset of assets) {
    // Download raw image from Supabase Storage
    const { data: fileData, error } = await supabase.storage.from(BUCKET).download(asset.storage_path)
    if (error || !fileData) {
      console.warn(`[ELM-IMAGE] Failed to download ${asset.storage_path}:`, error?.message)
      continue
    }

    const rawBuffer = Buffer.from(await fileData.arrayBuffer())

    // Format for the target platform (or all if not specified)
    const platforms = platform ? [platform] : ['instagram_feed', 'facebook_page', 'google_business_profile']

    for (const plat of platforms) {
      const formatted = await formatForPlatform(rawBuffer, plat)
      const dims = PLATFORM_SPECS[plat]
      const storagePath = `formatted/${plat}/${asset.id}.jpg`

      // Upload formatted version
      await supabase.storage.from(BUCKET).upload(storagePath, formatted, {
        contentType: 'image/jpeg',
        upsert: true
      })

      // Create asset record
      const assetType = `formatted_${plat.replace('_page', '').replace('_feed', '').replace('_profile', '')}` as string
      const { data: newAsset } = await supabase
        .from('mktg_image_assets')
        .insert({
          brand_id,
          asset_type: assetType.startsWith('formatted_') ? assetType : 'watermarked',
          storage_path: storagePath,
          original_asset_id: asset.id,
          dimensions: dims ? { width: dims.width, height: dims.height } : null,
          file_size_bytes: formatted.length,
          tags: asset.tags
        })
        .select('id')
        .single()

      if (newAsset) formattedIds.push(newAsset.id)
    }
  }

  // Update content library with formatted asset IDs
  if (content_id && formattedIds.length > 0) {
    await supabase
      .from('mktg_content_library')
      .update({ image_asset_ids: formattedIds })
      .eq('id', content_id)
  }

  return { formatted: formattedIds.length, asset_ids: formattedIds }
}

async function handleFormatSingle(data: {
  brand_id: string; asset_id: string; platforms: string[]
}): Promise<Record<string, unknown>> {
  const { brand_id, asset_id, platforms } = data

  const { data: asset } = await supabase
    .from('mktg_image_assets')
    .select('*')
    .eq('id', asset_id)
    .single()

  if (!asset) throw new Error(`Asset ${asset_id} not found`)

  const { data: fileData, error } = await supabase.storage.from(BUCKET).download(asset.storage_path)
  if (error || !fileData) throw new Error(`Failed to download: ${error?.message}`)

  const rawBuffer = Buffer.from(await fileData.arrayBuffer())
  const formattedIds: string[] = []

  for (const plat of platforms) {
    const formatted = await formatForPlatform(rawBuffer, plat)
    const dims = PLATFORM_SPECS[plat]
    const storagePath = `formatted/${plat}/${asset_id}.jpg`

    await supabase.storage.from(BUCKET).upload(storagePath, formatted, {
      contentType: 'image/jpeg', upsert: true
    })

    const { data: newAsset } = await supabase
      .from('mktg_image_assets')
      .insert({
        brand_id,
        asset_type: 'watermarked',
        storage_path: storagePath,
        original_asset_id: asset_id,
        dimensions: dims ? { width: dims.width, height: dims.height } : null,
        file_size_bytes: formatted.length,
        tags: asset.tags
      })
      .select('id')
      .single()

    if (newAsset) formattedIds.push(newAsset.id)
  }

  return { formatted: formattedIds.length, asset_ids: formattedIds }
}

// ─── BullMQ Worker ──────────────────────────────────────────────
const worker = new Worker(
  'elm:queue:image',
  async (job) => {
    console.log(`[ELM-IMAGE] Processing: ${job.name} (${job.id})`)

    try {
      let output: Record<string, unknown>

      switch (job.name) {
        case 'format_images':
          output = await handleFormatImages(job.data)
          break
        case 'format_single':
          output = await handleFormatSingle(job.data)
          break
        default:
          throw new Error(`Unknown task: ${job.name}`)
      }

      // Publish completion
      if (job.data.task_id) {
        await supabase
          .from('mktg_agent_tasks')
          .update({ status: 'completed', output })
          .eq('task_id', job.data.task_id)
      }

      await redis.publish('elm:task_complete', JSON.stringify({
        task_id: job.data.task_id ?? job.id,
        agent: 'image',
        status: 'completed',
        output
      }))

      console.log(`[ELM-IMAGE] Completed: ${job.name}`)
      return output
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error(`[ELM-IMAGE] Failed: ${job.name}:`, message)

      if (job.data.task_id) {
        await supabase
          .from('mktg_agent_tasks')
          .update({ status: 'failed', output: { error: message } })
          .eq('task_id', job.data.task_id)
      }

      await redis.publish('elm:task_complete', JSON.stringify({
        task_id: job.data.task_id ?? job.id,
        agent: 'image',
        status: 'failed',
        error: message
      }))

      throw err
    }
  },
  {
    connection: redisOpts,
    concurrency: 1,
    limiter: { max: 3, duration: 60000 }
  }
)

worker.on('ready', () => console.log('[ELM-IMAGE] Worker ready — consuming from elm:queue:image'))
worker.on('error', (err) => console.error('[ELM-IMAGE] Worker error:', err.message))

process.on('SIGTERM', async () => {
  await worker.close()
  await redis.quit()
  process.exit(0)
})
