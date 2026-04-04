/**
 * router.ts — Decomposes classified intent into ordered task manifests
 * Adapted from host-hampton-ops/services/hampton/src/router.ts
 */

import Anthropic from '@anthropic-ai/sdk'
import { v4 as uuidv4 } from 'uuid'
import type {
  IntentCategory,
  ClassificationResult,
  TaskManifest,
  AgentName,
  ApprovalTier,
  Brand
} from './types.js'
import { getApprovalTier } from './approvalGate.js'

const ELM_ROUTER_PROMPT = `You are the task router for the ELM Marketing Engine — an AI system managing social media for Eastern Landscape & Mason Supply, a bulk materials yard in Center Moriches, NY.

AGENT ROSTER (all active):
- copy: Content generation — captions, calendars, review responses
- image: Photo formatting — resize, crop, watermark for platform specs
- soc: Social media — publishing to IG/FB/GBP, review monitoring, engagement fetching
- intel: Analytics — GA4 reports, competitor monitoring, weekly digests

DEPENDENCY RULES:
1. copy must complete before image (image needs captions for context)
2. copy + image must complete before soc (posts need both caption + formatted photo)
3. No circular dependencies

APPROVAL TIERS:
- AUTO_EXECUTE: Status checks, analytics, competitor monitoring, engagement fetching
- DRAFT_AND_SHOW: Content generation, calendar planning, review responses
- ALWAYS_ASK: Settings changes, publish mode changes

Respond with ONLY a valid JSON array of task objects:
[{
  "assigned_to": "agent_name",
  "task_type": "specific_task",
  "priority": "urgent|high|normal|low",
  "depends_on_indices": [],
  "input": { "instructions": "detailed instructions" },
  "approval_tier": "AUTO_EXECUTE|DRAFT_AND_SHOW|ALWAYS_ASK"
}]`

export class Router {
  private claude: Anthropic

  constructor() {
    this.claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  }

  async buildTaskPlan(
    ownerCommand: string,
    classification: ClassificationResult,
    memoryContext: string,
    brand: Brand
  ): Promise<TaskManifest[]> {
    // Strategy questions and status checks → no tasks
    if (classification.intent === 'STRATEGY_QUESTION' || classification.intent === 'STATUS_CHECK' || classification.intent === 'UNKNOWN') {
      return []
    }

    // ALWAYS_ASK intents → single blocked task
    if (classification.intent === 'SETTINGS_CHANGE') {
      return [{
        task_id: uuidv4(),
        brand_id: brand.id,
        assigned_to: 'orchestrator',
        task_type: 'settings_change',
        priority: 'normal',
        input: { original_command: ownerCommand, blocked_reason: 'Settings changes require explicit owner confirmation.' },
        approval_tier: 'ALWAYS_ASK'
      }]
    }

    // Ask Claude to build the task plan
    const rawTasks = await this.askClaudeForPlan(ownerCommand, memoryContext, brand)
    return this.resolveManifests(rawTasks, brand)
  }

  private async askClaudeForPlan(
    ownerCommand: string,
    memoryContext: string,
    brand: Brand
  ): Promise<RawClaudeTask[]> {
    try {
      const response = await this.claude.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: ELM_ROUTER_PROMPT,
        messages: [{
          role: 'user',
          content: `Brand: ${brand.name} (${brand.slug})\nPublish mode: ${brand.publish_mode}\n\n${memoryContext}\n\n---\n\nOwner command: "${ownerCommand}"\n\nBuild the task plan.`
        }]
      })

      const text = response.content[0].type === 'text' ? response.content[0].text : '[]'
      const jsonMatch = text.match(/\[[\s\S]*\]/)
      if (!jsonMatch) return []

      return JSON.parse(jsonMatch[0]) as RawClaudeTask[]
    } catch (err) {
      console.error('[Router] Failed to get task plan:', err)
      return []
    }
  }

  private resolveManifests(rawTasks: RawClaudeTask[], brand: Brand): TaskManifest[] {
    const taskIds: string[] = rawTasks.map(() => uuidv4())
    const manifests: TaskManifest[] = []

    for (let i = 0; i < rawTasks.length; i++) {
      const raw = rawTasks[i]!
      const depends_on = (raw.depends_on_indices ?? [])
        .map((idx: number) => taskIds[idx])
        .filter((id): id is string => id !== undefined)

      manifests.push({
        task_id: taskIds[i]!,
        brand_id: brand.id,
        assigned_to: raw.assigned_to as AgentName,
        task_type: raw.task_type ?? 'unknown',
        priority: (raw.priority ?? 'normal') as 'urgent' | 'high' | 'normal' | 'low',
        depends_on: depends_on.length > 0 ? depends_on : undefined,
        input: raw.input ?? {},
        approval_tier: (raw.approval_tier as ApprovalTier) ?? getApprovalTier(raw.task_type ?? '')
      })
    }

    return manifests
  }
}

interface RawClaudeTask {
  assigned_to: string
  task_type: string
  priority: string
  depends_on_indices: number[]
  input: Record<string, unknown>
  approval_tier: string
}
