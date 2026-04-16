# Phase 05 — Optimizer Agent & Recommendations Queue

**Role:** Claude Code, Phase 05 of 11.
**Spec:** `elm-google-ads-spec-LOCKED.md` (🔒).
**SOW:** `elm-google-ads-sow.md`.
**Depends on:** Phase 03 PROMOTEd (write path available), Phase 04 PROMOTEd (performance data populated). Can run **in parallel with Phase 06**.
**Max turns:** 40 (resume with `--continue` — largest phase in the build).
**Branches:** `feature/marketing-05` on both `elm-marketing` and `easternLM`.
**Reports to:** `PHASE-05-COMPLETION-REPORT.md` + `PHASE-05-PROGRESS.md`.

---

## 1. Mission

Build the optimizer — the third agent, and the closing-of-the-loop moment for the Marketing Engine. Nightly analysis scans `mktg_google_performance`, applies a set of rules to generate recommendations, scores each with a confidence metric, and writes them to `mktg_google_recommendations` with `status='pending'`. Admin reviews in the Recommendations tab, clicks Approve/Reject; approvals enqueue the campaign agent to apply the change. In `publish_mode='auto'`, high-confidence recommendations auto-apply within budget caps.

Rules are deterministic and conservative at launch. This is not an LLM-based optimizer; it's a rule engine with explainable decisions. Phase 05 v2 can add LLM-generated recommendations once we trust the baseline.

---

## 2. Diagnostic-first (MANDATORY)

1. Read `elm-google-ads-spec-LOCKED.md` §4 (`mktg_google_recommendations` schema), §7.3 (optimizer scope + rules).
2. Verify Phase 03 merged — `GoogleAdsCampaignAgent` has write methods gated by guardrails.
3. Verify Phase 04 merged — `mktg_google_performance` has ≥7 days of data (sanity check; will often be zero spend at first since campaigns are paused).
4. Inspect Phase 02b's `getSearchTerms` method — optimizer uses it for "add negative keyword" rule.
5. Query `mktg_google_accounts` — confirm `publish_mode='suggest'`, `monthly_budget_cap_cents=200000`.
6. Read `/mnt/skills/public/frontend-design/SKILL.md` before building the Recommendations approval UI.
7. Report findings in turn 1.

---

## 3. Context

### 3.1 Rule engine — the 6 launch rules

Each rule is a pure function: `(performance, campaigns) => Recommendation[]`. Deterministic, testable, explainable.

#### Rule R1 — Budget-constrained winner
```
IF campaign.status=ENABLED AND
   campaign has ≥14 days of data AND
   avg ROAS over 14d ≥ 4.0 AND
   impression_share_lost_to_budget (computed from 14d data) ≥ 40%
THEN propose: increase budget by +20%
Confidence: 0.9
Rationale: "ROAS {X}× over 14 days; impression share lost to budget {Y}%. Increasing budget should recover impressions without hurting efficiency."
```

#### Rule R2 — Unprofitable campaign
```
IF campaign.status=ENABLED AND
   campaign has ≥14 days of data AND
   spend_14d ≥ $50 AND
   ROAS_14d < 1.0 AND campaign.type != 'PERFORMANCE_MAX' (PMax needs learning time)
THEN propose: pause campaign
Confidence: 0.75
Rationale: "Campaign spent ${X} over 14 days with ROAS {Y}×. Below break-even by {Z}%. Recommend pause and reallocate."
```

#### Rule R3 — High-spend zero-conversion search term
```
IF search_term (from getSearchTerms last 30d) has:
   spend ≥ $20 AND conversions = 0 AND clicks ≥ 10
THEN propose: add as campaign-level negative keyword
Confidence: 0.85
Rationale: "Search term '{term}' spent ${X} across {Y} clicks with zero conversions. Adding as negative."
```

#### Rule R4 — CPA drift
```
IF campaign has target_cpa set AND
   campaign has ≥14 days of data AND
   actual_cpa_14d > target_cpa × 2.0
THEN propose: adjust target_cpa to actual_cpa × 0.8 (lower target → tighter bidding)
Confidence: 0.6
Rationale: "Actual CPA ${X} is {Y}× target ${Z}. Proposing target adjustment to bring bidder back in line."
```

#### Rule R5 — Stalled PMax
```
IF campaign.type=PERFORMANCE_MAX AND
   campaign.status=ENABLED AND
   campaign has ≥21 days of data AND
   total_conversions_21d < 5
THEN propose: {either lower target_roas by 30% OR pause if budget > $500 burned}
Confidence: 0.7
Rationale: "PMax has run {N} days with only {M} conversions. Not enough signal to optimize. Options: loosen target ROAS to feed more impressions, or pause until conversion volume picks up."
```

#### Rule R6 — Zero-impression campaign
```
IF campaign.status=ENABLED AND
   campaign has ≥7 days of data AND
   impressions_7d = 0
THEN propose: investigate disapproval or raise target_cpa
Confidence: 0.5 (low — could be many causes)
Rationale: "No impressions in 7 days. Possible causes: ad disapprovals, target CPA too aggressive, keywords no-match. Recommend review in Google Ads UI."
```

### 3.2 Confidence thresholds

```
confidence < 0.5 → never proposed (filtered out)
confidence 0.5 - 0.7 → suggested (human approval required even in auto mode)
confidence 0.7 - 0.85 → auto-applied ONLY in publish_mode='auto' (explicit opt-in)
confidence ≥ 0.85 → auto-applied in publish_mode='auto' subject to budget cap
```

In `publish_mode='suggest'` (the launch default), ALL confidence levels require human approval. The threshold tiers only matter in 'auto' mode.

Thresholds and rule parameters stored in `src/agents/optimizer/rules/config.ts` — edit-once, don't scatter magic numbers.

### 3.3 Recommendation deduplication

Same recommendation shouldn't be re-proposed every night if admin hasn't acted on it. Dedupe logic:

```ts
// Before inserting new recommendation:
const existing = await supabase
  .from('mktg_google_recommendations')
  .select('id')
  .eq('brand_id', brandId)
  .eq('google_campaign_id', campaignId)
  .eq('type', recType)
  .eq('status', 'pending')
  .limit(1);

if (existing.data?.length > 0) {
  // Already pending — update estimated_impact if changed, else no-op
  return;
}
```

Also: expire pending recommendations older than 14 days automatically. Status → `expired`. Fresh run after expiration can re-propose if conditions still hold.

### 3.4 Rule execution loop

```
Daily 6 AM UTC (after 5 AM performance pull completes):
  Load all ENABLED campaigns for brand
  Load performance data last 30 days
  For each rule in [R1, R2, R3, R4, R5, R6]:
    matches = rule(campaigns, performance)
    for each match:
      Check dedup: already pending?
      If new:
        INSERT mktg_google_recommendations with status='pending', confidence, reason, proposed_change
  Expire recommendations > 14 days old → status='expired'
  Send email summary to admin (count of pending, new today)
```

### 3.5 Approval → apply flow

```
Admin clicks "Approve" on recommendation in UI
  ↓
POST /api/marketing/google/recommendations/:id/approve
  ↓
1. Mark recommendation: status='approved', decided_at=now(), decided_by=<admin email>
2. Enqueue BullMQ job 'google-apply-recommendation' with { recommendationId }
3. Respond 200 with { queued: true }
  ↓
Worker picks up job, runs applyRecommendation(recId):
  ↓
1. Load recommendation, verify status='approved'
2. Construct mutation call based on recommendation.type + proposed_change:
   - BUDGET_INCREASE → campaignAgent.updateCampaignBudget(campaignId, newBudgetCents, `recommendation:${recId}`)
   - PAUSE_CAMPAIGN → campaignAgent.updateCampaignStatus(campaignId, 'PAUSED', `recommendation:${recId}`)
   - ADD_NEGATIVE_KEYWORD → campaignAgent.createCampaignNegative(campaignId, keyword, `recommendation:${recId}`)
   - ADJUST_TARGET_CPA → campaignAgent.updateCampaignTargetCpa(campaignId, newTargetCpaCents, `recommendation:${recId}`)
   - ADJUST_TARGET_ROAS → ...
3. Mutation goes through guardMutation() — if guardrail rejects, recommendation marked 'rejected_by_guardrail'
4. On success: recommendation.applied_at=now(), recommendation.apply_result={campaign change result}
5. On failure: status='error', apply_result={error details}
```

### 3.6 Auto-mode branch

For `publish_mode='auto'`:
```
During optimizer run, for each candidate recommendation:
  IF confidence ≥ threshold for auto AND
     mutation would pass budget cap AND
     rule is not in AUTO_APPLY_DENYLIST (e.g., PAUSE_CAMPAIGN never auto-applies)
  THEN:
    INSERT mktg_google_recommendations with status='auto_applied', decided_at=now(), decided_by='system'
    Immediately enqueue apply job
```

**Never auto-apply destructive changes.** PAUSE_CAMPAIGN requires human approval regardless. `AUTO_APPLY_DENYLIST = ['PAUSE_CAMPAIGN', 'REMOVE_CAMPAIGN']`.

### 3.7 Email digest

At the end of each nightly run, send an email summary to `office@easternLM.com` via Resend (already configured on `send.easternlm.com` per existing infra):

```
Subject: ELM Marketing — Optimizer ran (3 new, 5 pending)

New recommendations today:
  • R1 [Budget +20%] ELM-Search-Mulch — ROAS 4.3× with 45% impr. share lost to budget. Confidence 0.9.
    → Review: https://easternlm.com/admin/marketing/recommendations

All pending (5):
  ...

View all: https://easternlm.com/admin/marketing/recommendations
```

Only sent if count > 0. Don't spam daily with "no changes."

---

## 4. Tasks (ordered)

### 4.1 Rule engine scaffold

```
src/agents/optimizer/
├── optimizer-agent.ts          — orchestrator
├── rules/
│   ├── config.ts               — thresholds, denylists, magic numbers
│   ├── types.ts                — Rule, Recommendation, Context types
│   ├── r1-budget-winner.ts
│   ├── r2-unprofitable.ts
│   ├── r3-zero-conv-term.ts
│   ├── r4-cpa-drift.ts
│   ├── r5-stalled-pmax.ts
│   ├── r6-zero-impressions.ts
│   └── index.ts                — exports RULES = [r1, r2, ...]
├── deduplicator.ts             — existing-recommendation check
├── expirer.ts                  — 14d expiration sweep
└── emailer.ts                  — digest via Resend
```

Each rule:
```ts
// src/agents/optimizer/rules/types.ts
export interface Rule {
  id: string;                   // 'R1'
  name: string;
  type: RecommendationType;
  evaluate(ctx: RuleContext): Recommendation[];
}

export interface RuleContext {
  brandId: string;
  campaigns: CampaignWithPerformance[];  // joined data
  searchTerms: SearchTermReport[];        // for R3
  account: Account;
}
```

### 4.2 Optimizer orchestrator

```ts
// src/agents/optimizer/optimizer-agent.ts
export class GoogleAdsOptimizerAgent {
  async runDaily(brandId: string): Promise<OptimizerRunSummary> {
    const ctx = await this.buildContext(brandId);
    const allRecs: Recommendation[] = [];

    for (const rule of RULES) {
      const recs = rule.evaluate(ctx);
      allRecs.push(...recs);
    }

    // Filter by confidence floor
    const filtered = allRecs.filter(r => r.confidence >= 0.5);

    // Dedupe against existing pending
    const fresh: Recommendation[] = [];
    for (const rec of filtered) {
      if (!await isDuplicatePending(ctx.brandId, rec)) fresh.push(rec);
    }

    // Insert all as pending
    for (const rec of fresh) {
      await insertRecommendation(ctx.brandId, rec, 'pending');
    }

    // Auto-apply branch
    let autoApplied = 0;
    if (ctx.account.publish_mode === 'auto') {
      for (const rec of fresh) {
        if (canAutoApply(rec)) {
          try {
            await applyRecommendation(ctx.brandId, rec, 'system');
            autoApplied++;
          } catch (e) {
            // Guardrail violation — rec stays pending for human
          }
        }
      }
    }

    // Expire old
    const expired = await expireOldRecommendations(ctx.brandId, 14);

    // Email digest if there are new recs
    if (fresh.length > 0) {
      await sendOptimizerDigest(ctx.brandId, { new: fresh.length, pending: /* count */ });
    }

    await writeAuditAction({
      brandId,
      agentName: 'googleAdsOptimizerAgent',
      action: 'daily_run',
      status: 'success',
      payload: {},
      result: { total: allRecs.length, newPending: fresh.length - autoApplied, autoApplied, expired },
    });

    return { ...summary };
  }

  async applyApprovedRecommendation(recId: string, approvedBy: string): Promise<ApplyResult> {
    // Load rec, verify status='approved', dispatch to campaign agent mutation
    // triggeredBy = `recommendation:${recId}` — guardrail recognizes this as human-blessed
  }
}
```

### 4.3 Individual rule implementations

Each rule file: the evaluation logic + vitest unit tests with realistic fixtures.

Example R1 test:
```ts
describe('R1 — Budget-constrained winner', () => {
  it('proposes +20% budget when ROAS 4.5× and impression share lost 50%', () => {
    const ctx = buildCtx({
      campaigns: [{ id: '123', type: 'SEARCH', status: 'ENABLED',
        budget_cents_daily: 5000,
        perf14d: { spend: 700, convValue: 3150, impressionShareLostBudget: 0.5 } }],
    });
    const recs = r1.evaluate(ctx);
    expect(recs).toHaveLength(1);
    expect(recs[0].type).toBe('BUDGET_INCREASE');
    expect(recs[0].proposed_change).toEqual({ field: 'budget_cents_daily', from: 5000, to: 6000 });
    expect(recs[0].confidence).toBe(0.9);
  });

  it('does not propose when ROAS below 4.0', () => { /* ... */ });
  it('does not propose when impression share lost < 40%', () => { /* ... */ });
  it('does not propose when <14 days of data', () => { /* ... */ });
  it('does not propose when campaign PAUSED', () => { /* ... */ });
});
```

Every rule has ≥5 tests: happy path + each filter condition (false case).

### 4.4 Deduplicator

```ts
// src/agents/optimizer/deduplicator.ts
export async function isDuplicatePending(brandId: string, rec: Recommendation): Promise<boolean> {
  const { data } = await supabase
    .from('mktg_google_recommendations')
    .select('id')
    .eq('brand_id', brandId)
    .eq('google_campaign_id', rec.google_campaign_id ?? null)
    .eq('type', rec.type)
    .eq('status', 'pending')
    .limit(1);
  return (data ?? []).length > 0;
}
```

For rules like R3 (negative keyword) with per-term uniqueness, check `proposed_change.keyword` matches too.

### 4.5 Expirer

```ts
export async function expireOldRecommendations(brandId: string, days: number): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  const { data, error } = await supabase
    .from('mktg_google_recommendations')
    .update({ status: 'expired' })
    .eq('brand_id', brandId)
    .eq('status', 'pending')
    .lt('created_at', cutoff)
    .select('id');
  return data?.length ?? 0;
}
```

### 4.6 Apply handler

```ts
export async function applyRecommendation(
  brandId: string,
  rec: Recommendation,
  approvedBy: string
): Promise<ApplyResult> {
  const agent = new GoogleAdsCampaignAgent(brandId);
  const triggeredBy = `recommendation:${rec.id}`;

  try {
    let result;
    switch (rec.type) {
      case 'BUDGET_INCREASE':
      case 'BUDGET_DECREASE':
        result = await agent.updateCampaignBudget(
          rec.google_campaign_id!,
          rec.proposed_change.to,
          triggeredBy,
        );
        break;
      case 'PAUSE_CAMPAIGN':
        result = await agent.updateCampaignStatus(rec.google_campaign_id!, 'PAUSED', triggeredBy);
        break;
      case 'ADD_NEGATIVE_KEYWORD':
        result = await agent.createCampaignNegative(
          rec.google_campaign_id!,
          rec.proposed_change.keyword,
          triggeredBy,
        );
        break;
      case 'ADJUST_TARGET_CPA':
        result = await agent.updateCampaignTargetCpa(
          rec.google_campaign_id!,
          rec.proposed_change.to,
          triggeredBy,
        );
        break;
      // ... others
      default:
        throw new Error(`Unknown recommendation type: ${rec.type}`);
    }

    await supabase.from('mktg_google_recommendations').update({
      applied_at: new Date().toISOString(),
      apply_result: result,
    }).eq('id', rec.id);

    return { success: true, result };
  } catch (err) {
    await supabase.from('mktg_google_recommendations').update({
      status: err instanceof GuardrailViolation ? 'rejected_by_guardrail' : 'error',
      apply_result: { error: serializeError(err) },
    }).eq('id', rec.id);
    throw err;
  }
}
```

### 4.7 Worker + cron

```ts
// src/workers/google-optimize.worker.ts
new Worker('google-optimize', async (job) => {
  const { brandId } = job.data;
  const agent = new GoogleAdsOptimizerAgent();
  return await agent.runDaily(brandId);
}, { connection, concurrency: 1 });

// src/workers/google-apply-recommendation.worker.ts
new Worker('google-apply-recommendation', async (job) => {
  const { recommendationId, approvedBy } = job.data;
  const rec = await loadRecommendation(recommendationId);
  if (rec.status !== 'approved' && rec.status !== 'auto_applied') {
    throw new Error(`Cannot apply rec in status ${rec.status}`);
  }
  return await applyRecommendation(rec.brand_id, rec, approvedBy);
}, { connection, concurrency: 1 });
```

Cron:
```
0 6 * * * /usr/bin/node /app/dist/cron/trigger-optimize.js
```

### 4.8 Admin UI — Recommendations tab

`easternLM/src/app/admin/marketing/recommendations/page.tsx` (replaces Phase 04's "Coming in Phase 07" placeholder for this single tab — the other 4 non-Overview tabs remain stubbed until Phase 07).

Read `/mnt/skills/public/frontend-design/SKILL.md` first.

Structure:
- Filter bar: status (pending/approved/rejected/auto_applied/expired/error), date range, rule type
- List of recommendation cards:
  - Rule name + confidence badge
  - Campaign name + link to Google Ads UI (external link to `https://ads.google.com/aw/campaigns?campaignId=...`)
  - Rationale text
  - Proposed change: "Budget $50/day → $60/day"
  - Estimated impact: "Projected +12% conversions"
  - Approve / Reject buttons (only if status='pending')
  - Timestamp
- Empty state: "No pending recommendations. The optimizer runs daily at 6 AM UTC."

API routes:
- `POST /api/marketing/google/recommendations/:id/approve` — auth'd admin; updates status, enqueues apply worker
- `POST /api/marketing/google/recommendations/:id/reject` — auth'd admin; updates status='rejected', stores reason
- `GET /api/marketing/google/recommendations` — list with filters (server component uses this)

### 4.9 Email digest

`src/agents/optimizer/emailer.ts`:
```ts
export async function sendOptimizerDigest(brandId: string, summary: {
  newCount: number;
  pendingCount: number;
  autoApplied: number;
}): Promise<void> {
  const recipients = ['office@easternLM.com', 'adam@easternLM.com'];  // from config
  const subject = `ELM Marketing — Optimizer ran (${summary.newCount} new, ${summary.pendingCount} pending)`;
  const body = await renderDigestEmail(brandId, summary);
  await resend.emails.send({
    from: env.RESEND_FROM_EMAIL,
    to: recipients,
    subject,
    html: body,
  });
}
```

Render via a simple template (React Email or inline HTML). Link to `/admin/marketing/recommendations`.

### 4.10 Tests

Unit (vitest):
- Every rule: ≥5 tests (happy + false filters). Total ~30 rule tests.
- Deduplicator: existing pending blocks new insert; resolved rec does not block
- Expirer: only affects pending > N days
- Apply handler: dispatches correct mutation per rec type; guardrail rejection handled

Integration (vitest, against staging):
- Full optimizer run with synthetic performance data → expected recommendations generated
- Approve a rec → worker applies → campaign updated in Google Ads → DB mirror updated
- Reject a rec → status changes, no mutation
- Auto mode: rec with confidence ≥ 0.85 auto-applies; confidence 0.7 goes to pending

### 4.11 CLAUDE.md additions

```markdown
## Phase 05 additions

- Optimizer is a DETERMINISTIC RULE ENGINE. No LLM calls. Rules are pure functions in src/agents/optimizer/rules/.
- Six rules at launch: R1 (budget winner), R2 (unprofitable), R3 (zero-conv search term), R4 (CPA drift), R5 (stalled PMax), R6 (zero impressions).
- Confidence thresholds: <0.5 filtered, 0.5-0.7 suggest-only, 0.7-0.85 auto if opted-in, ≥0.85 auto-applied (within budget cap).
- Auto-apply denylist: PAUSE_CAMPAIGN, REMOVE_CAMPAIGN — always require human approval.
- Deduplication prevents re-proposing the same pending rec every night.
- Pending recs expire after 14 days (status='expired').
- Apply flow: approve → enqueue worker → campaignAgent mutation (triggeredBy='recommendation:<id>') → guardrail check → mirror state.
- Email digest sent to office@easternLM.com + adam@easternLM.com only when new recs > 0.
```

---

## 5. Acceptance criteria

1. ✅ All 6 rule functions implemented with ≥5 unit tests each (30+ tests total)
2. ✅ Optimizer runs end-to-end against staging data → generates expected recommendations, persists to `mktg_google_recommendations`
3. ✅ Dedup works: re-running optimizer within same window → no duplicate pending recs
4. ✅ Expirer works: pending recs > 14d old transition to status='expired'
5. ✅ Admin UI at `/admin/marketing/recommendations` renders filter bar + card list + empty state
6. ✅ Approve button: updates rec status, enqueues apply worker, worker executes mutation via campaignAgent, DB reflects change
7. ✅ Reject button: updates status='rejected', no mutation
8. ✅ Guardrail enforcement: approved rec where mutation would exceed budget cap → status='rejected_by_guardrail', rec applied_at=null
9. ✅ Auto mode: setting `publish_mode='auto'` + rec with confidence ≥ 0.85 → auto_applied (test with synthetic low-risk rec like ADD_NEGATIVE_KEYWORD)
10. ✅ PAUSE_CAMPAIGN denylist: even in auto mode with high confidence, PAUSE stays pending
11. ✅ Email digest sent via Resend when new recs > 0; no email when 0 new
12. ✅ Every rule evaluation, rec insert, rec approve/reject, rec apply writes `mktg_agent_actions` audit
13. ✅ Cron 6 AM UTC registered and fires
14. ✅ Frontend-design skill principles evident in UI (non-generic card composition, typography, color)
15. ✅ No plaintext tokens in logs, no Content API imports

---

## 6. Scope boundaries — DO NOT DO

- ❌ LLM-based recommendations (v2 feature; rule engine only for v1)
- ❌ Keyword discovery / expansion (not a rule yet)
- ❌ New rule types beyond the 6 listed
- ❌ A/B testing framework
- ❌ Cross-campaign budget reallocation (R1 increases one budget; no rule takes from another)
- ❌ Device / time-of-day / audience bid adjustments
- ❌ Competitor monitoring
- ❌ Performance drill-down pages (Phase 07)

---

## 7. Risk callouts

1. **Rule parameter tuning is a long-running concern.** Thresholds (ROAS 4.0, spend $50, 14-day window) are educated guesses. Expect adjustment as real data comes in. Store them in `config.ts` for easy tweaking. Document "why these numbers" in code comments.
2. **Impression share lost to budget metric.** Requires additional GAQL segments (`campaign.search_budget_lost_impression_share`). Verify the field name — API schema has shifted across versions. Phase 02b's `getSearchTerms` is separate; R1 needs a different query. If field isn't available in v21 reporting, simulate with a proxy or downgrade confidence.
3. **Auto mode on day 1.** Leave `publish_mode='suggest'` locked. Don't let Adam flip to 'auto' until optimizer has run suggest-mode for ≥30 days with strong human approval correlation. Document this in UI copy next to the auto toggle ("Available after 30 days of suggest-mode history").
4. **Rec explosion.** With 6 rules × 6 campaigns × multiple search terms, a single optimizer run could propose 20+ recs on day 1. Dedup helps, but initial run may be noisy. Prioritize by confidence in UI; top 5 visible by default.
5. **Email fatigue.** Digest daily could become noise. If ≤2 recs consistently pending, switch to weekly digest. Monitor first 30 days.

---

## 8. Orchestration

Session start: `claude --max-turns 40` + paste this file. This is the largest phase; may need 2 sessions.
Resume: `claude --continue`.
Completion: write completion report, push branches, stop.

Can run in parallel with Phase 06 (GCLID capture). No shared code paths.

---

## 9. Review

Reviewer checks all 15 acceptance criteria, plus:
- Every rule's test coverage
- Dedup correctness (critical for rec quality)
- Auto-apply denylist enforced
- Guardrail integration on apply path
- frontend-design skill evidence in UI

Verdict: `PROMOTE` → unblocks Phase 07 (UI polish) · `FIX` → re-run · `ESCALATE` (likely if impression-share-lost metric unavailable).

---

*Phase 05 · April 16, 2026 · ~40 turn budget · Paste-ready. Largest phase in build.*
