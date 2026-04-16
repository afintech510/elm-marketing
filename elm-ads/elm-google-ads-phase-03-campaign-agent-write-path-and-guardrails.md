# Phase 03 — Campaign Agent (Write Path) & Guardrails & Search/PMax Launch

**Role:** Claude Code, Phase 03 of 11.
**Spec:** `elm-google-ads-spec-LOCKED.md` (🔒).
**SOW:** `elm-google-ads-sow.md`.
**Depends on:** Phase 02b PROMOTEd (read path + client wrapper). Can run **in parallel with Phase 04** (different API endpoints).
**Max turns:** 30 (resume with `--continue`).
**Branch:** `feature/marketing-03` on `elm-marketing`.
**Reports to:** `PHASE-03-COMPLETION-REPORT.md` + `PHASE-03-PROGRESS.md`.

---

## 1. Mission

Turn `googleAdsCampaignAgent` into a full read+write agent with bulletproof guardrails, then launch the 5 paused Search campaigns (Mulch, Topsoil, Gravel, Stone, Sand) and 1 paused Performance Max campaign for ELM. After this phase, the agent can create/modify/pause/delete campaigns, ad groups, and keywords — gated by `publish_mode`, `monthly_budget_cap_cents`, and full audit logging on every mutation.

**Every campaign this phase creates launches with `status=PAUSED`.** Adam manually activates in the admin UI (Phase 07) after reviewing.

This is the highest-consequence phase in the build. The guardrail system is the most important code in the entire Marketing Engine — it's the only thing standing between the agent and a runaway Google Ads bill.

---

## 2. Diagnostic-first (MANDATORY)

1. Read `elm-google-ads-spec-LOCKED.md` §6.1 (Search + PMax strategy), §7.2 (campaign agent scope), SOW §4 (all 8 guardrails).
2. Verify Phase 02b merged: `src/google/ads-campaigns.ts` exists with `GoogleAdsCampaignsReader` class. `GoogleAdsCampaignAgent` has read methods. `mktg_google_campaigns` table populated with current state.
3. Query `mktg_google_campaigns` — if 02c's Local campaign exists, its budget counts toward the cap. Note existing daily budget total before implementing cap check.
4. Query `mktg_google_accounts` for `brand_id='eastern-lm'` — confirm `publish_mode='suggest'`, `monthly_budget_cap_cents=200000`. These values drive the guardrail.
5. Review existing Google Ads campaigns on CID `5409526270` — 02b's sync surfaces them. If legacy campaigns exist with high budgets, they may consume cap headroom. Document before creating new campaigns.
6. Verify conversion actions from Phase 00 exist on the account: query `ConversionAction` via GAQL for resource names stored in `conversion_action_purchase` and `conversion_action_lead`. These are referenced in campaign bidding strategies.
7. Report findings in turn 1 before implementation.

---

## 3. Context

### 3.1 The three guardrails (SOW G2, G3, G4)

Every mutation goes through a single choke point. No exceptions.

```ts
// src/guardrails/mutation-guard.ts
export async function guardMutation(opts: {
  brandId: string;
  action: string;           // 'create_campaign' | 'update_budget' | 'pause_campaign' | ...
  targetResource?: string;
  payload: Record<string, unknown>;
  triggeredBy: string;      // user email | 'system' | 'recommendation:<id>'
  budgetDeltaCents?: number; // positive = spend increase; negative or 0 = safe
}): Promise<void> {
  const account = await getBrandAccount(opts.brandId);

  // G2: publish_mode enforcement
  if (account.publish_mode === 'read_only') {
    await writeAuditAction({ ...opts, status: 'rejected_by_guardrail',
      result: { reason: 'publish_mode=read_only' } });
    throw new GuardrailViolation('publish_mode=read_only blocks all writes');
  }
  if (account.publish_mode === 'suggest' && opts.triggeredBy === 'system') {
    // System-initiated writes (cron, scheduled) NOT allowed in suggest mode
    // EXCEPT when triggeredBy starts with 'recommendation:' (human-approved)
    await writeAuditAction({ ...opts, status: 'rejected_by_guardrail',
      result: { reason: 'publish_mode=suggest blocks unapproved system writes' } });
    throw new GuardrailViolation('publish_mode=suggest requires human-approved trigger');
  }
  // publish_mode='auto' → allow with budget cap check below
  // publish_mode='suggest' with human triggeredBy (email) or 'recommendation:<id>' → allow

  // G3: budget cap enforcement (only matters for budget-increasing mutations)
  if (opts.budgetDeltaCents && opts.budgetDeltaCents > 0) {
    const currentMonthlyTotalCents = await calculateCurrentMonthlyBudgetCents(opts.brandId);
    const projected = currentMonthlyTotalCents + (opts.budgetDeltaCents * 30);  // monthly projection
    if (projected > account.monthly_budget_cap_cents) {
      await writeAuditAction({ ...opts, status: 'rejected_by_guardrail',
        result: { reason: 'monthly_budget_cap_exceeded', currentCents: currentMonthlyTotalCents, capCents: account.monthly_budget_cap_cents } });
      throw new GuardrailViolation(
        `Budget cap exceeded: projected $${(projected/100).toFixed(2)} > cap $${(account.monthly_budget_cap_cents/100).toFixed(2)}`
      );
    }
  }

  // G4: audit (pending — will be marked success/error after mutation completes)
  await writeAuditAction({ ...opts, status: 'pending' });
}
```

**Key design decisions baked in:**
- `read_only` blocks EVERYTHING. No override.
- `suggest` blocks system/cron-originated writes. Only human-approved (user email or recommendation ID) allowed.
- `auto` allows system writes but budget cap still applies.
- Budget cap enforcement uses **projected monthly total** = current daily sum × 30. Conservative. Rejects potential blowouts before they happen.
- Audit row written BEFORE mutation (status='pending'), UPDATEd after (status='success' | 'error').

### 3.2 Calculating current monthly budget total

```ts
// src/guardrails/budget-calculator.ts
export async function calculateCurrentMonthlyBudgetCents(brandId: string): Promise<number> {
  const { data } = await supabase
    .from('mktg_google_campaigns')
    .select('budget_cents_daily')
    .eq('brand_id', brandId)
    .eq('status', 'ENABLED');  // paused campaigns don't spend
  const dailySum = (data ?? []).reduce((s, c) => s + (c.budget_cents_daily ?? 0), 0);
  return dailySum * 30;  // rough monthly
}
```

**Note:** uses `status='ENABLED'` — PAUSED campaigns don't count toward spend. This means Phase 03 creates ALL new campaigns paused, so they don't affect the cap until Adam activates them.

### 3.3 Campaign launch plan (spec §6.1)

**5 Search campaigns:**

```
ELM-Search-Mulch
  Keywords (Phrase + Exact):
    "mulch delivery long island", "mulch near me suffolk county",
    "natural mulch delivered", "black mulch long island",
    "bulk mulch delivery", "mulch by the yard"
  Negatives: bagged, playground, rubber, wholesale-only

ELM-Search-Topsoil
  Keywords: "topsoil delivery", "screened topsoil long island",
    "topsoil near me", "topsoil by the yard", "black dirt delivered"
  Negatives: bagged, free, fill-dirt

ELM-Search-Gravel
  Keywords: "gravel delivery long island", "pea gravel suffolk county",
    "rca delivered", "crushed stone delivery", "gravel by the yard"
  Negatives: wholesale, dump-truck-rental, aquarium

ELM-Search-Stone
  Keywords: "bluestone delivery", "crushed bluestone long island",
    "decorative stone delivered", "pocono river rock", "burgundy stone delivery"
  Negatives: retail-wall, jewelry, pebbles-bagged

ELM-Search-Sand
  Keywords: "mason sand delivery", "concrete sand near me",
    "bulk sand long island", "playground sand delivered", "pool base sand"
  Negatives: beach, wholesale, sand-bags
```

**Shared negative keyword list (campaign-level, applied to all 5):**
```
bagged, bag, bags, wholesale, commercial-only,
free, rental, review, reviews, jobs, careers
```

**Budgets at launch:** $20/day each Search campaign (paused) + $50/day PMax (paused). Total if activated: $150/day × 30 = $4,500/mo. **This exceeds the $2,000/mo cap** — intentional. Adam will selectively activate and adjust budgets after review. The cap is enforced on activation or budget increase, not on creation-while-paused.

**1 Performance Max campaign:**

```
ELM-PMax-All-Products
  Asset groups (one per material category, 5 total):
    - Mulch (listing groups targeting mulch product types)
    - Topsoil
    - Gravel (RCA + pea + natural + crushed stone)
    - Stone (bluestone + whitestone + pocono + burgundy)
    - Sand (concrete + mason)
  Feed: GMC merchant_id=5578269156 (already linked via Phase 00)
  Geographic targeting: 50-mile radius around Center Moriches (40.800, -72.813)
  Bidding: MAXIMIZE_CONVERSION_VALUE (optimizes for revenue)
  Target ROAS: 3.0 (first 60 days learning, then evaluate)
  Brand exclusions: "Eastern Landscape", "Eastern LM" — prevent branded cannibalization
  Budget: $50/day (paused)
```

### 3.4 Bidding strategy choice

For Search campaigns at launch:
- **First 30 days:** `MAXIMIZE_CONVERSIONS` (no TCPA yet — no conversion data)
- **Day 30+:** switch to `MAXIMIZE_CONVERSIONS` with `target_cpa_micros` — optimizer agent (Phase 05) monitors and proposes TCPA adjustments

For PMax at launch: `MAXIMIZE_CONVERSION_VALUE` with `target_roas=3.0` — a bit aggressive but gives the algorithm a clear signal. Phase 05 tunes.

Conversion tracking: all campaigns reference the `CONVERSION_ACTION_PURCHASE` from Phase 00 as the primary conversion goal. `CONVERSION_ACTION_LEAD` is a secondary action (optimize_for=false).

### 3.5 Creation idempotency

Launch script must be idempotent — running twice does NOT create duplicate campaigns. Strategy: check `mktg_google_campaigns` for existing `name` matching the target; skip if found. Alternative: check `mktg_agent_actions` for prior `create_campaign` with same name.

---

## 4. Tasks (ordered)

### 4.1 Guardrail module

Build `src/guardrails/` with:
- `mutation-guard.ts` — the single choke point (§3.1 above)
- `budget-calculator.ts` — `calculateCurrentMonthlyBudgetCents` (§3.2)
- `errors.ts` — `GuardrailViolation` typed error
- `audit.ts` — `writeAuditAction`, `updateAuditAction` helpers for the pending→success/error pattern

Unit tests (vitest) for every guardrail path:
- `read_only` + any triggeredBy → throws GuardrailViolation, audit row has `status='rejected_by_guardrail'`, reason
- `suggest` + `triggeredBy='system'` → throws, rejected
- `suggest` + `triggeredBy='admin@email.com'` → allows, budget cap check runs
- `suggest` + `triggeredBy='recommendation:<uuid>'` → allows
- `auto` + system trigger, within cap → allows
- `auto` + system trigger, exceeds cap → throws, rejected
- Budget calc handles empty campaigns, mixed ENABLED+PAUSED, zero budgets

### 4.2 Extend campaign agent with write methods

Update `src/agents/googleAdsCampaignAgent.ts` (from 02b) with mutation methods. Every method wraps `guardMutation()` and updates the audit row on completion.

```ts
export class GoogleAdsCampaignAgent {
  // ... existing read methods from 02b ...

  async createSearchCampaign(params: CreateSearchCampaignParams, triggeredBy: string): Promise<CampaignCreated> {
    const auditId = await guardMutation({
      brandId: this.brandId,
      action: 'create_search_campaign',
      payload: params,
      triggeredBy,
      budgetDeltaCents: params.budgetCentsDaily,  // will be 0 impact since created PAUSED
    });

    try {
      const customer = await getGoogleAdsClient(this.brandId);

      // Create budget
      const [budgetResult] = await customer.campaignBudgets.create([{
        name: `${params.name}-Budget`,
        amount_micros: centsToMicros(params.budgetCentsDaily),
        delivery_method: 'STANDARD',
      }]);

      // Create campaign (always PAUSED at creation)
      const [campaignResult] = await customer.campaigns.create([{
        name: params.name,
        status: 'PAUSED',  // NON-NEGOTIABLE
        advertising_channel_type: 'SEARCH',
        campaign_budget: budgetResult.resource_name,
        bidding_strategy_type: 'MAXIMIZE_CONVERSIONS',
        network_settings: {
          target_google_search: true,
          target_search_network: true,
          target_content_network: false,  // no display on Search
          target_partner_search_network: false,
        },
        geo_target_type_setting: {
          positive_geo_target_type: 'PRESENCE_OR_INTEREST',
          negative_geo_target_type: 'PRESENCE',
        },
      }]);

      // Apply 50-mile radius geo targeting
      await customer.campaignCriteria.create([{
        campaign: campaignResult.resource_name,
        proximity: ELM_PROXIMITY_50_MILES,
      }]);

      // Mirror to DB
      await supabase.from('mktg_google_campaigns').insert({
        brand_id: this.brandId,
        google_campaign_id: extractCampaignId(campaignResult.resource_name),
        name: params.name,
        type: 'SEARCH',
        status: 'PAUSED',
        budget_cents_daily: params.budgetCentsDaily,
        bidding_strategy: 'MAXIMIZE_CONVERSIONS',
        created_by_agent: true,
      });

      await updateAuditAction(auditId, {
        status: 'success',
        targetResource: campaignResult.resource_name,
        result: { campaignId: extractCampaignId(campaignResult.resource_name) },
      });

      return { campaignId: extractCampaignId(campaignResult.resource_name), resourceName: campaignResult.resource_name };
    } catch (err) {
      await updateAuditAction(auditId, { status: 'error', result: { error: serializeError(err) } });
      throw err;
    }
  }

  async createAdGroup(campaignId: string, params: CreateAdGroupParams, triggeredBy: string): Promise<AdGroupCreated>
  async createKeyword(adGroupId: string, keyword: string, matchType: MatchType, triggeredBy: string): Promise<KeywordCreated>
  async createCampaignNegative(campaignId: string, keyword: string, triggeredBy: string): Promise<void>
  async createSharedNegativeList(name: string, keywords: string[], triggeredBy: string): Promise<SharedSetCreated>
  async attachSharedNegativeList(campaignId: string, sharedSetResourceName: string, triggeredBy: string): Promise<void>

  async updateCampaignBudget(campaignId: string, newBudgetCentsDaily: number, triggeredBy: string): Promise<void>
  async updateCampaignStatus(campaignId: string, status: 'ENABLED' | 'PAUSED', triggeredBy: string): Promise<void>
  async updateCampaignTargetCpa(campaignId: string, newTargetCpaCents: number, triggeredBy: string): Promise<void>

  async createPmaxCampaign(params: CreatePmaxParams, triggeredBy: string): Promise<CampaignCreated>
  async createAssetGroup(campaignId: string, params: AssetGroupParams, triggeredBy: string): Promise<AssetGroupCreated>
}
```

**Critical: `updateCampaignStatus` with `status='ENABLED'` triggers the budget cap check.** Currently paused campaign with $50/day budget, when activated, adds $1,500/mo to spend. Cap check happens in `guardMutation({budgetDeltaCents: campaign.budget_cents_daily})`.

### 4.3 Keyword builder with match type logic

`src/agents/campaigns/keyword-builder.ts`:
```ts
export function buildKeywordSet(rawKeywords: string[]): KeywordCriterion[] {
  const criteria: KeywordCriterion[] = [];
  for (const kw of rawKeywords) {
    // Phrase match
    criteria.push({ text: kw, match_type: 'PHRASE' });
    // Exact match
    criteria.push({ text: `[${kw}]`, match_type: 'EXACT' });
  }
  return criteria;
}
```

**Decision: NO broad match at launch.** Broad match spends fast and needs tight monitoring. Phrase + Exact only. Phase 05 optimizer can propose broad-match-experiments later.

### 4.4 Launch script (the big one)

`scripts/launch-search-and-pmax.ts`:

```ts
// scripts/launch-search-and-pmax.ts
// Idempotent — safe to re-run. Skips campaigns already present in mktg_google_campaigns.

import { GoogleAdsCampaignAgent } from '../src/agents/googleAdsCampaignAgent.js';
import { MATERIAL_CATEGORIES, PMAX_ASSET_GROUPS } from './campaign-definitions.js';

async function main() {
  const triggeredBy = process.env.LAUNCH_USER_EMAIL ?? 'system';
  if (triggeredBy === 'system') {
    console.error('Set LAUNCH_USER_EMAIL to the admin running this launch.');
    process.exit(1);
  }

  const agent = new GoogleAdsCampaignAgent('eastern-lm');

  // 1. Shared negative list
  const sharedNegatives = await ensureSharedNegativeList(agent, triggeredBy);

  // 2. Search campaigns (5 categories)
  for (const category of MATERIAL_CATEGORIES) {
    const existing = await findExistingCampaign(category.campaignName);
    if (existing) {
      console.log(`⏭️  ${category.campaignName} already exists — skipping`);
      continue;
    }

    const { campaignId } = await agent.createSearchCampaign({
      name: category.campaignName,
      budgetCentsDaily: 2000,
    }, triggeredBy);

    const { adGroupId } = await agent.createAdGroup(campaignId, {
      name: `${category.campaignName}-Core`,
      cpcBidMicrosCents: 150,  // $1.50 starting CPC
    }, triggeredBy);

    for (const kw of buildKeywordSet(category.keywords)) {
      await agent.createKeyword(adGroupId, kw.text, kw.match_type, triggeredBy);
    }

    // Campaign-level negatives
    for (const neg of category.negatives) {
      await agent.createCampaignNegative(campaignId, neg, triggeredBy);
    }

    // Attach shared negatives
    await agent.attachSharedNegativeList(campaignId, sharedNegatives.resourceName, triggeredBy);

    console.log(`✅ ${category.campaignName} created (PAUSED): ${campaignId}`);
  }

  // 3. PMax campaign
  const pmaxExisting = await findExistingCampaign('ELM-PMax-All-Products');
  if (!pmaxExisting) {
    const { campaignId: pmaxId } = await agent.createPmaxCampaign({
      name: 'ELM-PMax-All-Products',
      budgetCentsDaily: 5000,
      targetRoas: 3.0,
      brandExclusions: ['Eastern Landscape', 'Eastern LM'],
    }, triggeredBy);

    for (const assetGroup of PMAX_ASSET_GROUPS) {
      await agent.createAssetGroup(pmaxId, assetGroup, triggeredBy);
    }

    console.log(`✅ ELM-PMax-All-Products created (PAUSED): ${pmaxId}`);
  }

  console.log('\n🎯 All campaigns created PAUSED. Activate in admin UI after review.');
}

main().catch((err) => {
  console.error('Launch failed:', err);
  process.exit(1);
});
```

Runs via `npm run launch-search-pmax` by Adam after Phase 03 deploys. Not scheduled, not automatic — human-initiated one-time launch.

### 4.5 Campaign definitions file

`scripts/campaign-definitions.ts` — centralizes keywords, negatives, asset groups for easy editing:
```ts
export const MATERIAL_CATEGORIES = [
  {
    slug: 'mulch',
    campaignName: 'ELM-Search-Mulch',
    keywords: [
      'mulch delivery long island',
      'mulch near me suffolk county',
      // ... (spec §3.3 above)
    ],
    negatives: ['bagged', 'playground', 'rubber', 'wholesale-only'],
  },
  // ... 4 more
];

export const SHARED_NEGATIVES_NAME = 'ELM-Shared-Negatives';
export const SHARED_NEGATIVES = ['bagged', 'bag', 'bags', /* ... */];

export const PMAX_ASSET_GROUPS = [
  {
    name: 'Mulch-Asset-Group',
    headlines: [/* 5-15 headlines, 30 char max each */],
    longHeadlines: [/* 1-5 long headlines, 90 char max */],
    descriptions: [/* 2-5 descriptions, 90 char max */],
    businessName: 'Eastern Landscape & Mason Supply',
    callToAction: 'SHOP_NOW',
    listingGroupFilter: {
      case: 'productType',
      productType: { level: 'LEVEL_2', value: 'Mulch' },
    },
  },
  // ... 4 more
];
```

Asset group copy must respect ELM copy rules — reuse `stripForbiddenPhrases` from Phase 02a.

### 4.6 Rollback mechanism

If launch script fails partway, operator needs a way to undo. Create `scripts/rollback-launched-campaigns.ts`:
```ts
// Queries mktg_google_campaigns for created_by_agent=true AND created_at > <threshold>
// For each, calls agent.updateCampaignStatus(campaignId, 'REMOVED', 'system:rollback')
// Writes audit rows throughout
```

Never run automatically. Operator docs note: "If launch failed and state is inconsistent, run rollback script, clean up DB, re-run launch."

### 4.7 Tests

Unit (vitest):
- Every guardrail test case from §4.1 passes
- Keyword builder produces Phrase + Exact pair for each input
- Campaign definition validates (all 5 categories have ≥5 keywords, non-empty negatives)

Integration (vitest, against staging Google Ads):
- Create campaign in suggest mode with `triggeredBy='test@example.com'` → success, DB mirror present, audit row success
- Create campaign in suggest mode with `triggeredBy='system'` → GuardrailViolation, no Google Ads side effect, audit row rejected
- Create campaign in read_only mode → GuardrailViolation regardless of trigger
- Set monthly_budget_cap_cents=1000 (low), attempt to create campaign with budgetCentsDaily=100 (would be $3000/mo) → GuardrailViolation
- Activate a paused campaign with budget that would exceed cap → GuardrailViolation

End-to-end (documented manual test):
- Run launch script in staging → 6 campaigns created (5 Search + 1 PMax), all PAUSED, all in mktg_google_campaigns
- Re-run launch script → 6 "already exists, skipping" messages, no duplicates in Google Ads

### 4.8 Observability

- pino structured logs on every mutation: `action`, `brandId`, `triggeredBy`, `result` (success/error/rejected), duration
- Log level `warn` on GuardrailViolation (not error — this is expected behavior)
- Log level `error` only on Google Ads API errors or unhandled exceptions

### 4.9 CLAUDE.md additions

```markdown
## Phase 03 additions

- All mutations route through guardMutation(). No direct API calls bypassing the guard.
- publish_mode='read_only' blocks every write. Admin unlocks in UI (Phase 07).
- publish_mode='suggest' (default): only human triggeredBy (email) or 'recommendation:<id>' writes allowed.
- Budget cap is monthly projection: current ENABLED daily budgets × 30 must fit under monthly_budget_cap_cents.
- ALL new campaigns launch PAUSED. Activation is a separate mutation, still guardrailed.
- Phrase + Exact match only at launch. No broad match.
- Launch script (scripts/launch-search-and-pmax.ts) is idempotent — re-runs skip existing campaigns.
- Rollback script exists but is NEVER scheduled/automatic.
- Audit row pattern: pending → success/error/rejected. Never delete; status is the truth.
```

---

## 5. Acceptance criteria

1. ✅ Guardrail test matrix: all 8 test cases from §4.1 pass
2. ✅ Creating a campaign in `read_only` mode throws GuardrailViolation, writes audit row status='rejected_by_guardrail', no Google Ads side effect
3. ✅ System-triggered create in `suggest` mode throws GuardrailViolation, audit reflects
4. ✅ Human-triggered (email) create in `suggest` mode succeeds, audit row status='success', DB mirror populated
5. ✅ Activating a campaign that would exceed monthly_budget_cap_cents throws GuardrailViolation
6. ✅ Launch script creates exactly 5 Search campaigns (names: ELM-Search-{Mulch,Topsoil,Gravel,Stone,Sand}), 1 PMax (ELM-PMax-All-Products), 1 shared negative list — all PAUSED
7. ✅ Each Search campaign has ≥1 ad group with ≥10 keyword criteria (Phrase + Exact per seed keyword) plus campaign negatives plus shared-list attachment
8. ✅ PMax campaign has 5 asset groups (one per material category) with correct listingGroupFilter, all copy respects ELM rules (no forbidden phrases, double-ground mulch, etc.)
9. ✅ Re-running launch script is a no-op (no duplicate campaigns created)
10. ✅ Every mutation writes an audit row; pending rows are updated to success/error/rejected
11. ✅ `mktg_google_campaigns` mirror is accurate after launch — type, status, budget, bidding strategy all correct
12. ✅ Rollback script exists and successfully removes agent-created campaigns when run
13. ✅ No plaintext tokens in logs, no Content API imports (grep checks)
14. ✅ PMax asset group copy passes `stripForbiddenPhrases` (test assertion)
15. ✅ Completion report lists every campaign created with resource name + verification that status is PAUSED

---

## 6. Scope boundaries — DO NOT DO

- ❌ Activate any campaign (always PAUSED)
- ❌ Build optimizer rules or recommendations (Phase 05)
- ❌ Performance data queries (Phase 04)
- ❌ Admin UI for activation/budget editing (Phase 07)
- ❌ Multi-brand launches — only `eastern-lm` exists
- ❌ GCLID capture or conversion upload (Phase 06)
- ❌ Broad match keywords
- ❌ Modify Phase 02c's Local campaign — it stays as-is

---

## 7. Risk callouts

1. **Guardrail bypass is catastrophic.** The agent having direct access to `google-ads-api` mutations without going through `guardMutation()` means an LLM-generated code change could accidentally bypass the check. Reviewer MUST grep for `customer.campaigns.create`, `customer.campaignBudgets.create`, `customer.adGroups.create`, etc., outside of `src/agents/googleAdsCampaignAgent.ts` — should be zero matches outside the agent + scripts/launch-*.ts.
2. **PMax asset group RSA-like character limits.** Headlines: 30 chars. Long headlines: 90. Descriptions: 90. Builder must validate or Google rejects the whole campaign.
3. **Misrepresentation flag — PMax feed dependency.** PMax uses GMC feed (via `merchant_id` link). If products are in disapproved state from Misrepresentation, PMax still creates but serves zero impressions. Not a bug; document.
4. **Target ROAS=3.0 on day 1 is aggressive.** PMax needs ~15-30 conversions minimum to work. With no conversion history, PMax may burn $50/day for weeks with no results before the algorithm learns. Optimizer (Phase 05) proposes lowering target or pausing if zero progress after 14 days.
5. **Budget cap calculation races with active campaigns.** If two activation attempts happen simultaneously, both might read current_total_monthly before either commits. Low risk (single admin user, no concurrent sessions), but worth calling out. Phase 05 optimizer auto-applied changes will be serialized via BullMQ concurrency=1, so no race there.

---

## 8. Orchestration

Session start: `claude --max-turns 30` + paste this file.
Resume: `claude --continue`.
Completion: write completion report, push branch, stop.

After PROMOTE: Adam runs `npm run launch-search-pmax` with `LAUNCH_USER_EMAIL=adam@easternlm.com` to trigger creation. Campaigns land PAUSED in Google Ads, mirrored in DB. Adam reviews in Google Ads UI before activating (Phase 07 admin UI adds activation controls).

---

## 9. Review

Reviewer checks all 15 acceptance criteria, plus:
- **Grep for direct API mutations outside the agent** — highest-priority check. Zero matches allowed outside `src/agents/googleAdsCampaignAgent.ts` and `scripts/launch-*.ts`.
- G2, G3, G4 guardrail enforcement on every test case
- G8 copy rules on asset group content
- All campaigns PAUSED in Google Ads UI after launch
- Audit trail completeness — every mutation has a paired audit row

Verdict: `PROMOTE` → unblocks Phase 05 · `FIX` → re-run with fix instructions · `ESCALATE` → Adam decides (likely if guardrail bypass path discovered).

---

*Phase 03 · April 16, 2026 · ~30 turn budget · Paste-ready. Highest-consequence phase — review carefully.*
