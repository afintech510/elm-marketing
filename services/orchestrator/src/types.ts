/**
 * types.ts — Shared types for the ELM Marketing Engine orchestrator
 */

// ─── Agent Names ────────────────────────────────────────────────
export type AgentName =
  | 'orchestrator'
  | 'copy'
  | 'image'
  | 'soc'
  | 'intel'

// Future agents (multi-brand / Phase 2+)
export type FutureAgentName = 'outbound' | 'list' | 'paid'

// ─── Approval Tiers ─────────────────────────────────────────────
export type ApprovalTier =
  | 'AUTO_EXECUTE'       // Execute immediately, report completion
  | 'DRAFT_AND_SHOW'     // Surface to owner, auto-execute after 4-hour timeout
  | 'ALWAYS_ASK'         // Never proceed without explicit owner confirmation

// ─── Intent Categories ──────────────────────────────────────────
export type IntentCategory =
  | 'GENERATE_CALENDAR'      // Plan next week's content
  | 'CREATE_CONTENT'         // Write specific content
  | 'PUBLISH_NOW'            // Publish approved content immediately
  | 'ANALYTICS_REPORT'       // Performance reports
  | 'COMPETITOR_DIGEST'      // Competitor intelligence
  | 'REVIEW_RESPONSE'        // Draft response to review
  | 'SETTINGS_CHANGE'        // Change brand settings
  | 'STATUS_CHECK'           // System status / what's pending
  | 'STRATEGY_QUESTION'      // Owner asking for advice
  | 'UNKNOWN'                // Cannot classify

// ─── Task Status ────────────────────────────────────────────────
export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled'

// ─── Task Manifest ──────────────────────────────────────────────
export interface TaskManifest {
  task_id: string
  brand_id: string
  assigned_to: AgentName
  task_type: string
  priority: 'urgent' | 'high' | 'normal' | 'low'
  depends_on?: string[]
  input: Record<string, unknown>
  approval_tier: ApprovalTier
  deadline?: Date
  context?: Record<string, unknown>
}

// ─── Task Record (as stored in Supabase) ────────────────────────
export interface TaskRecord {
  id: string
  task_id: string
  brand_id: string
  assigned_agent: AgentName
  task_type: string
  status: TaskStatus
  priority: string
  depends_on: string[] | null
  input: Record<string, unknown>
  output: Record<string, unknown> | null
  token_usage: Record<string, unknown> | null
  approval_tier: ApprovalTier
  approved_at: string | null
  rejected_at: string | null
  rejection_reason: string | null
  retry_count: number
  created_at: string
  updated_at: string
  deadline: string | null
}

// ─── Memory Entry ───────────────────────────────────────────────
export interface MemoryEntry {
  id: string
  brand_id: string
  namespace: string
  key: string
  value: Record<string, unknown>
  updated_by: string
  version: number
}

// ─── Classification Result ──────────────────────────────────────
export interface ClassificationResult {
  intent: IntentCategory
  confidence: 'high' | 'medium' | 'low'
  agents: AgentName[]
  params: Record<string, unknown>
  suggested_approval_tier: ApprovalTier
  clarification_needed: string | null
}

// ─── Brand ──────────────────────────────────────────────────────
export interface Brand {
  id: string
  slug: string
  name: string
  publish_mode: 'draft_only' | 'live'
  voice_rules: Record<string, unknown>
  content_pillars: ContentPillar[]
  platform_accounts: Record<string, unknown>
  hashtag_sets: Record<string, string[]>
  posting_schedule: Record<string, unknown>
  geo_target: Record<string, unknown>
  is_active: boolean
}

export interface ContentPillar {
  slug: string
  name: string
  weight: number
  description: string
}

// ─── Calendar Plan ──────────────────────────────────────────────
export interface CalendarSlot {
  day: string           // 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
  platform: string
  pillar: string
  topic: string
  time: string
}

export interface CalendarPlan {
  week_start: string
  slots: CalendarSlot[]
}

// ─── Budget ─────────────────────────────────────────────────────
export interface BudgetCheck {
  allowed: boolean
  spent_cents: number
  limit_cents: number
  percentage: number
}

// ─── WebSocket Events ───────────────────────────────────────────
export interface WsEvent {
  type: 'task_dispatched' | 'task_completed' | 'task_failed' | 'content_ready' | 'content_approved' | 'alert'
  task_id?: string
  agent?: string
  brand_id?: string
  data?: Record<string, unknown>
  message?: string
}
