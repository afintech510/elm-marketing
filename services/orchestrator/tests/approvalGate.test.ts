import { describe, it, expect } from 'vitest'
import { getApprovalTier } from '../src/approvalGate.js'

describe('getApprovalTier', () => {
  it('returns AUTO_EXECUTE for status checks', () => {
    expect(getApprovalTier('STATUS_CHECK')).toBe('AUTO_EXECUTE')
  })

  it('returns AUTO_EXECUTE for analytics reports', () => {
    expect(getApprovalTier('ANALYTICS_REPORT')).toBe('AUTO_EXECUTE')
  })

  it('returns AUTO_EXECUTE for publish now', () => {
    expect(getApprovalTier('PUBLISH_NOW')).toBe('AUTO_EXECUTE')
  })

  it('returns DRAFT_AND_SHOW for calendar generation', () => {
    expect(getApprovalTier('GENERATE_CALENDAR')).toBe('DRAFT_AND_SHOW')
  })

  it('returns DRAFT_AND_SHOW for content creation', () => {
    expect(getApprovalTier('CREATE_CONTENT')).toBe('DRAFT_AND_SHOW')
  })

  it('returns DRAFT_AND_SHOW for review responses', () => {
    expect(getApprovalTier('REVIEW_RESPONSE')).toBe('DRAFT_AND_SHOW')
  })

  it('returns ALWAYS_ASK for settings changes', () => {
    expect(getApprovalTier('SETTINGS_CHANGE')).toBe('ALWAYS_ASK')
  })

  it('defaults to DRAFT_AND_SHOW for unknown intents', () => {
    expect(getApprovalTier('SOME_NEW_INTENT')).toBe('DRAFT_AND_SHOW')
  })
})
