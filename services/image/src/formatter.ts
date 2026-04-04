/**
 * formatter.ts — Image formatting pipeline using Sharp
 * Resizes, crops, and watermarks photos for each social platform.
 */

import sharp from 'sharp'

export interface PlatformSpec {
  width: number
  height: number
  fit: 'cover' | 'contain'
  quality: number
}

const PLATFORM_SPECS: Record<string, PlatformSpec> = {
  instagram_feed: { width: 1080, height: 1080, fit: 'cover', quality: 85 },
  instagram_story: { width: 1080, height: 1920, fit: 'cover', quality: 85 },
  instagram_reel: { width: 1080, height: 1920, fit: 'cover', quality: 85 },
  facebook_page: { width: 1200, height: 630, fit: 'cover', quality: 85 },
  facebook_story: { width: 1080, height: 1920, fit: 'cover', quality: 85 },
  google_business_profile: { width: 1200, height: 900, fit: 'cover', quality: 85 }
}

/**
 * Format a raw image buffer for a specific platform
 */
export async function formatForPlatform(
  imageBuffer: Buffer,
  platform: string
): Promise<Buffer> {
  const spec = PLATFORM_SPECS[platform]
  if (!spec) throw new Error(`Unknown platform: ${platform}`)

  let pipeline = sharp(imageBuffer)
    .resize(spec.width, spec.height, {
      fit: spec.fit,
      position: 'centre'
    })

  // Slight brightness boost for Instagram
  if (platform.startsWith('instagram')) {
    pipeline = pipeline.modulate({ brightness: 1.05 })
  }

  // Add watermark
  const watermark = await createWatermark(spec.width)
  pipeline = pipeline.composite([{
    input: watermark,
    gravity: 'southeast',
    blend: 'over'
  }])

  return pipeline
    .jpeg({ quality: spec.quality, mozjpeg: true })
    .toBuffer()
}

/**
 * Format a raw image for all standard platforms
 */
export async function formatForAllPlatforms(
  imageBuffer: Buffer
): Promise<Record<string, Buffer>> {
  const results: Record<string, Buffer> = {}
  const platforms = ['instagram_feed', 'facebook_page', 'google_business_profile']

  for (const platform of platforms) {
    results[platform] = await formatForPlatform(imageBuffer, platform)
  }

  return results
}

/**
 * Get image dimensions
 */
export async function getImageDimensions(buffer: Buffer): Promise<{ width: number; height: number }> {
  const metadata = await sharp(buffer).metadata()
  return { width: metadata.width ?? 0, height: metadata.height ?? 0 }
}

/**
 * Create a text watermark SVG
 */
async function createWatermark(imageWidth: number): Promise<Buffer> {
  const fontSize = Math.max(14, Math.floor(imageWidth * 0.018))
  const padding = Math.floor(imageWidth * 0.02)

  const svg = `<svg width="${imageWidth * 0.25}" height="${fontSize * 2.5}">
    <text
      x="${padding}"
      y="${fontSize * 1.5}"
      font-family="Arial, Helvetica, sans-serif"
      font-size="${fontSize}"
      font-weight="600"
      fill="rgba(255,255,255,0.5)"
      letter-spacing="0.5"
    >Eastern LM</text>
  </svg>`

  return sharp(Buffer.from(svg)).png().toBuffer()
}

export { PLATFORM_SPECS }
