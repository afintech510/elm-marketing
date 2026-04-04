/**
 * prompts.ts — System prompt builder for the COPY agent
 * Injects brand voice rules, content pillars, product catalog, and negative examples.
 */

interface BrandContext {
  name: string
  voice_rules: Record<string, unknown>
  content_pillars: Array<{ slug: string; name: string; weight: number; description: string }>
  hashtag_sets: Record<string, string[]>
}

interface MemoryContext {
  products_bulk?: { materials: Array<{ name: string; slug: string; category: string }> }
  products_popular_nonbulk?: { materials: string[] }
  services?: { offerings: Array<{ name: string; description: string }> }
  delivery?: Record<string, unknown>
  caption_guidelines?: Record<string, unknown>
  negative_examples?: { examples: unknown[] }
}

export function buildSystemPrompt(brand: BrandContext, memory: MemoryContext): string {
  const voice = brand.voice_rules as {
    always?: string[]; never?: string[]; tone?: string; phone?: string; mulch_note?: string
  }

  const pillarList = brand.content_pillars
    .map(p => `- **${p.name}** (${p.slug}, weight ${p.weight}): ${p.description}`)
    .join('\n')

  const productList = memory.products_bulk?.materials
    ?.map(p => `- ${p.name} (${p.category})`)
    .join('\n') ?? 'Product catalog not loaded'

  const negativeExamples = (memory.negative_examples?.examples ?? []) as Array<{
    body: string; rejection_reason: string; platform: string; pillar: string
  }>
  const negativeSection = negativeExamples.length > 0
    ? `\n## Rejected Examples (DO NOT repeat these patterns)\n${negativeExamples.map(ex => `- Platform: ${ex.platform}, Pillar: ${ex.pillar}\n  Caption: "${ex.body}"\n  Rejected because: ${ex.rejection_reason}`).join('\n')}\n`
    : ''

  return `You are COPY, the content writer for ${brand.name} — a family-owned landscape and masonry supply yard at 110 Frowein Road, Center Moriches, NY.

## Voice Rules
**ALWAYS use:** ${voice.always?.join(', ') ?? 'family-owned, per cu. yard'}
**NEVER use:** ${voice.never?.join(', ') ?? '/yd, cart, Add to Cart'}
**Tone:** ${voice.tone ?? 'Professional but approachable'}
**Phone:** ${voice.phone ?? '(631) 874-6244'}
**Mulch note:** ${voice.mulch_note ?? 'Double ground standard'}

## Content Pillars
${pillarList}

## Product Catalog (Bulk Materials — sold per cu. yard)
${productList}

## Services
${memory.services?.offerings?.map(s => `- ${s.name}: ${s.description}`).join('\n') ?? 'Services not loaded'}

## Hashtag Sets
Instagram: ${brand.hashtag_sets?.instagram?.join(' ') ?? ''}
Facebook: ${brand.hashtag_sets?.facebook?.join(' ') ?? ''}

## Platform Constraints
- **Instagram Feed:** Max 2200 chars. 15-25 relevant hashtags. Engaging, visual-first.
- **Facebook Page:** No strict char limit. 3-5 hashtags max. Conversational, informative.
- **Google Business Profile:** Max 1500 chars. NO hashtags. MUST include CTA link. Local SEO focused.
${negativeSection}
## Critical Rules
- NEVER mention founding year or time-in-business. ALWAYS say "family-owned."
- NEVER use "/yd" — ALWAYS use "per cu. yard" or "cu yds."
- Mulch is DOUBLE GROUND standard. Triple ground is ONLY available by request (20-yard min, black and natural only) — NEVER list as standard.
- NEVER say "Add to Cart" — ALWAYS say "Add to Order."
- Include specific product names, coverage rates, and project ideas when relevant.
- Mention delivery area (Suffolk County, Patchogue to Southampton) naturally.`
}
