/**
 * intentClassifier.ts — Classify owner commands for the ELM Marketing Engine
 * Adapted from host-hampton-ops: keyword fast-path + Claude fallback
 */

import Anthropic from '@anthropic-ai/sdk'
import type {
  IntentCategory,
  ClassificationResult,
  AgentName,
  ApprovalTier
} from './types.js'

// ─── Keyword rules (fast path, no API call) ─────────────────────
const KEYWORD_RULES: Array<{
  patterns: RegExp[]
  intent: IntentCategory
  agents: AgentName[]
  approval: ApprovalTier
}> = [
  {
    patterns: [/\bcalendar\b/i, /\bplan\b.*week/i, /\bnext week/i, /\bschedule\b.*content/i, /\bweekly\b.*plan/i],
    intent: 'GENERATE_CALENDAR',
    agents: ['copy'],
    approval: 'DRAFT_AND_SHOW'
  },
  {
    patterns: [/\bwrite\b/i, /\bdraft\b/i, /\bcaption\b/i, /\bcreate\b.*(?:post|content)/i, /\bgenerate\b.*content/i],
    intent: 'CREATE_CONTENT',
    agents: ['copy', 'image'],
    approval: 'DRAFT_AND_SHOW'
  },
  {
    patterns: [/\bpublish\b/i, /\bpost\b.*now/i, /\bshare\b.*(?:ig|instagram|facebook|fb|gbp)/i, /\bgo live/i],
    intent: 'PUBLISH_NOW',
    agents: ['soc'],
    approval: 'AUTO_EXECUTE'
  },
  {
    patterns: [/\banalytics\b/i, /\breport\b/i, /\bperformance\b/i, /\bstats\b/i, /\bmetrics\b/i, /\bhow.*doing/i],
    intent: 'ANALYTICS_REPORT',
    agents: ['intel'],
    approval: 'AUTO_EXECUTE'
  },
  {
    patterns: [/\bcompetitor/i, /\bwhat.*(?:they|others).*posting/i, /\bdigest\b/i],
    intent: 'COMPETITOR_DIGEST',
    agents: ['intel'],
    approval: 'AUTO_EXECUTE'
  },
  {
    patterns: [/\breview\b.*(?:response|reply|answer)/i, /\brespond.*review/i],
    intent: 'REVIEW_RESPONSE',
    agents: ['copy'],
    approval: 'DRAFT_AND_SHOW'
  },
  {
    patterns: [/\bsetting/i, /\bchange\b.*(?:voice|brand|mode|schedule)/i, /\bswitch\b.*(?:live|draft)/i, /\bupdate\b.*config/i],
    intent: 'SETTINGS_CHANGE',
    agents: ['orchestrator'],
    approval: 'ALWAYS_ASK'
  },
  {
    patterns: [/\bstatus\b/i, /\bwhat.*(pending|queued)/i, /\bhow many/i, /\bqueue\b/i],
    intent: 'STATUS_CHECK',
    agents: ['orchestrator'],
    approval: 'AUTO_EXECUTE'
  }
]

// ─── Claude-based classifier (for ambiguous inputs) ──────────────
const CLASSIFICATION_SYSTEM_PROMPT = `You are the intent classifier for the ELM Marketing Engine — an AI system managing social media for Eastern Landscape & Mason Supply, a landscape/masonry supply yard in Center Moriches, NY.

Classify the owner's message into exactly ONE of these intent categories:
GENERATE_CALENDAR, CREATE_CONTENT, PUBLISH_NOW, ANALYTICS_REPORT, COMPETITOR_DIGEST, REVIEW_RESPONSE, SETTINGS_CHANGE, STATUS_CHECK, STRATEGY_QUESTION, UNKNOWN

Rules:
- GENERATE_CALENDAR: planning weekly content, scheduling posts for the week
- CREATE_CONTENT: writing specific captions, blog posts, or content pieces
- PUBLISH_NOW: immediately publishing approved content
- ANALYTICS_REPORT: requesting performance data or reports
- COMPETITOR_DIGEST: asking about what competitors are doing
- REVIEW_RESPONSE: drafting replies to Google/Yelp reviews
- SETTINGS_CHANGE: modifying brand voice, publish mode, schedules
- STATUS_CHECK: asking what's pending, queued, or system health
- STRATEGY_QUESTION: advice questions ("should we", "what do you think")
- UNKNOWN: truly cannot determine

Respond with ONLY valid JSON:
{
  "intent": "INTENT_CATEGORY",
  "confidence": "high|medium|low",
  "agents": ["agent_names"],
  "params": {},
  "clarification_needed": null | "ONE question if truly ambiguous"
}`

export class IntentClassifier {
  private claude: Anthropic

  constructor() {
    this.claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  }

  async classify(ownerMessage: string): Promise<ClassificationResult> {
    // Fast path: keyword matching
    const keywordMatch = this.matchKeywords(ownerMessage)
    if (keywordMatch) return keywordMatch

    // Slow path: Claude API
    return this.classifyWithClaude(ownerMessage)
  }

  private matchKeywords(message: string): ClassificationResult | null {
    for (const rule of KEYWORD_RULES) {
      if (rule.patterns.some(p => p.test(message))) {
        return {
          intent: rule.intent,
          confidence: 'high',
          agents: rule.agents,
          params: {},
          suggested_approval_tier: rule.approval,
          clarification_needed: null
        }
      }
    }
    return null
  }

  private async classifyWithClaude(message: string): Promise<ClassificationResult> {
    try {
      const response = await this.claude.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        system: CLASSIFICATION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: message }]
      })

      const text = response.content[0].type === 'text' ? response.content[0].text : ''
      const parsed = JSON.parse(text) as {
        intent: IntentCategory
        confidence: string
        agents?: string[]
        params?: Record<string, unknown>
        clarification_needed: string | null
      }

      // Find matching rule for approval tier
      const matchingRule = KEYWORD_RULES.find(r => r.intent === parsed.intent)

      return {
        intent: parsed.intent,
        confidence: parsed.confidence as 'high' | 'medium' | 'low',
        agents: (parsed.agents ?? matchingRule?.agents ?? []) as AgentName[],
        params: parsed.params ?? {},
        suggested_approval_tier: matchingRule?.approval ?? 'DRAFT_AND_SHOW',
        clarification_needed: parsed.clarification_needed
      }
    } catch {
      return {
        intent: 'STRATEGY_QUESTION',
        confidence: 'low',
        agents: [],
        params: {},
        suggested_approval_tier: 'AUTO_EXECUTE',
        clarification_needed: null
      }
    }
  }
}
