/**
 * brandCompliance.ts — Validate generated content against brand voice rules
 * Used as a post-generation check before saving to content library.
 */

export interface VoiceRules {
  always?: string[]
  never?: string[]
}

/**
 * Check content for brand rule violations.
 * Returns array of violation descriptions (empty = compliant).
 */
export function validateBrandCompliance(content: string, rules: VoiceRules): string[] {
  const violations: string[] = []
  const lower = content.toLowerCase()

  // Check "never" list
  if (rules.never) {
    for (const term of rules.never) {
      if (lower.includes(term.toLowerCase())) {
        violations.push(`Contains forbidden term: "${term}"`)
      }
    }
  }

  // Specific pattern checks
  if (/\/yd\b/i.test(content)) {
    violations.push('Uses "/yd" — should use "per cu. yard"')
  }

  if (/add\s+to\s+cart/i.test(content)) {
    violations.push('Uses "Add to Cart" — should use "Add to Order"')
  }

  if (/established\s+in\s+\d{4}/i.test(content) || /founded\s+in\s+\d{4}/i.test(content)) {
    violations.push('Mentions founding year — should say "family-owned" instead')
  }

  if (/triple\s+ground\s+(?:standard|mulch)/i.test(content)) {
    violations.push('Implies triple ground is standard — only available by request (20yd min)')
  }

  return violations
}

/**
 * Generate an idempotency key for social post publishing.
 * Deterministic: same inputs always produce same key.
 */
export function generateIdempotencyKey(
  contentId: string,
  platform: string,
  scheduledDate: string
): string {
  return `${contentId}:${platform}:${scheduledDate}`
}
