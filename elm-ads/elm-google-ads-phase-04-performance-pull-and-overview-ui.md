# Phase 04 — Performance Pull & Overview UI

**Role:** Claude Code, Phase 04 of 11.
**Spec:** `elm-google-ads-spec-LOCKED.md` (🔒).
**SOW:** `elm-google-ads-sow.md`.
**Depends on:** Phase 02b PROMOTEd. Can run **in parallel with Phase 03** and Phase 06.
**Max turns:** 25 (resume with `--continue`).
**Branches:** `feature/marketing-04` on `elm-marketing` + `easternLM`.
**Reports to:** `PHASE-04-COMPLETION-REPORT.md` + `PHASE-04-PROGRESS.md`.

---

## 1. Mission

Pull daily performance data from Google Ads into `mktg_google_performance`, and surface it in an Overview dashboard on the admin Marketing tab. This phase creates the analytical foundation for Phase 05 (optimizer) and gives Adam immediate visibility into campaign spend and conversions — even if campaigns are still paused (they'll show zeros until activated).

Cadence: daily pull at 5 AM UTC. Covers the prior day's data (Google Ads reporting has ~2-3 hour lag; 5 AM is safely after the prior day closes in ET).

---

## 2. Diagnostic-first (MANDATORY)

1. Read `elm-google-ads-spec-LOCKED.md` §4 (`mktg_google_performance` schema), §6 (campaign types — PMax/Search/Local/Shopping).
2. Verify Phase 02b merged — `GoogleAdsCampaignsReader` class exists, can call `customer.query(...)`.
3. Query live `mktg_google_performance` — should be empty (Phase 04 is first to populate).
4. Check timezone assumption: Adam's business operates in ET. Google Ads API returns data in account timezone. Confirm `5409526270` timezone setting (likely America/New_York). Store dates as `date` type in DB; aggregate daily in ET.
5. Check existing admin layout at `easternLM/src/app/admin/marketing/page.tsx` — Phase 01 created a minimal placeholder; this phase replaces with real Overview content for one tab, leaves other tabs stubbed for Phase 07.
6. Read `/mnt/skills/public/frontend-design/SKILL.md` before writing any UI code. Recharts + Tailwind + shadcn/ui — follow the skill's principles to avoid generic AI aesthetics.
7. Report findings in turn 1.

---

## 3. Context

### 3.1 GAQL query for performance

```sql
SELECT
  campaign.id,
  segments.date,
  metrics.impressions,
  metrics.clicks,
  metrics.cost_micros,
  metrics.conversions,
  metrics.conversions_value,
  metrics.ctr,
  metrics.average_cpc
FROM campaign
WHERE segments.date DURING YESTERDAY
  AND campaign.status != 'REMOVED'
```

**Note:** `campaign.advertising_channel_type` filter not needed — we want all types.

### 3.2 Micros everywhere (reminder)

All cost/value fields return in micros. Store in DB:
- `cost_micros` kept as-is in `mktg_google_performance.cost_micros` (BIGINT)
- `conversion_value_micros` same
- Convert to cents/dollars only at UI render boundary

### 3.3 Upsert semantics

`mktg_google_performance` has UNIQUE constraint on `(brand_id, google_campaign_id, date)`. Use UPSERT — if we re-pull the same date (e.g., Google updated yesterday's numbers 6 hours later), we overwrite with new values.

Google Ads can restate recent data up to 3 days back. Strategy: daily cron pulls YESTERDAY by default. Every Monday, pull last 7 days to catch restatements.

### 3.4 ROAS calculation

ROAS = conversion_value / cost. Store the computed value in `mktg_google_performance.roas` for query simplicity:
```ts
const roas = cost_micros > 0 ? (conversion_value_micros / cost_micros) : null;
```

Null when no spend (division by zero).

### 3.5 Overview dashboard content

Six visualizations, all Recharts-based:

1. **Spend last 30 days** — stacked bar chart, one stack per campaign, daily x-axis
2. **Conversions last 30 days** — line chart, total conversions per day, single line
3. **ROAS trend last 30 days** — line chart, daily ROAS, reference line at 3.0 (target)
4. **Top 5 campaigns this month** — table: name, spend, clicks, conversions, ROAS
5. **KPI tiles row at top** — 4 tiles: MTD spend, MTD conversions, MTD ROAS, MTD CPA
6. **Spend vs. budget cap** — progress bar, current monthly projected spend vs `monthly_budget_cap_cents`

All server-rendered via Next.js server component; pulls from Supabase directly (no API layer needed — easternLM already has service-role client).

Date range: default "this month" (MTD). Phase 07 adds a date range picker; Phase 04 hardcodes MTD.

### 3.6 Visualization colors

Match existing easternLM admin analytics palette (per memory — revenue analytics uses stacked bar, payment-method color-coded). If existing palette isn't documented, use Recharts default but check existing `/admin/orders` analytics colors for consistency. Green for positive KPIs, amber for approaching cap (75%+), red for over cap.

---

## 4. Tasks (ordered)

### 4.1 Performance pull worker

`elm-marketing/src/workers/google-performance-pull.worker.ts`:

```ts
new Worker('google-performance-pull', async (job) => {
  const { brandId, dateRange } = job.data;
  const agent = new GoogleAdsCampaignAgent(brandId);
  const reader = new GoogleAdsCampaignsReader(brandId);

  const rows = await reader.getPerformance({
    sinceDate: dateRange.start,
    untilDate: dateRange.end,
  });

  let upserted = 0;
  for (const row of rows) {
    await supabase.from('mktg_google_performance').upsert({
      brand_id: brandId,
      google_campaign_id: String(row.campaignId),
      date: row.date,
      impressions: row.impressions,
      clicks: row.clicks,
      cost_micros: row.costMicros,
      conversions: row.conversions,
      conversion_value_micros: row.conversionValueMicros,
      ctr: row.ctr,
      avg_cpc_micros: row.avgCpcMicros,
      roas: row.costMicros > 0 ? (row.conversionValueMicros / row.costMicros) : null,
      pulled_at: new Date().toISOString(),
    }, { onConflict: 'brand_id,google_campaign_id,date' });
    upserted++;
  }

  await writeAuditAction({
    brandId,
    agentName: 'googleAdsCampaignAgent',
    action: 'pull_performance',
    status: 'success',
    payload: { dateRange },
    result: { upserted },
  });

  return { upserted };
}, { connection, concurrency: 1 });
```

### 4.2 Reader method

Extend `GoogleAdsCampaignsReader` in `src/google/ads-campaigns.ts` (from Phase 02b):

```ts
async getPerformance(params: {
  sinceDate: string;  // YYYY-MM-DD
  untilDate: string;
}): Promise<PerformanceRow[]> {
  const customer = await getGoogleAdsClient(this.brandId);
  const query = `
    SELECT
      campaign.id,
      segments.date,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      metrics.ctr,
      metrics.average_cpc
    FROM campaign
    WHERE segments.date BETWEEN '${params.sinceDate}' AND '${params.untilDate}'
      AND campaign.status != 'REMOVED'
  `;
  const results = await customer.query(query);
  return results.map(r => ({
    campaignId: r.campaign.id,
    date: r.segments.date,
    impressions: Number(r.metrics.impressions),
    clicks: Number(r.metrics.clicks),
    costMicros: Number(r.metrics.cost_micros),
    conversions: Number(r.metrics.conversions),
    conversionValueMicros: Number(r.metrics.conversions_value) * 1_000_000,  // API returns dollars; convert
    ctr: Number(r.metrics.ctr),
    avgCpcMicros: Number(r.metrics.average_cpc),
  }));
}
```

**Watch for:** Google Ads API returns `conversions_value` in dollars (float), not micros. This is an exception to the "everything is micros" rule. Convert manually.

### 4.3 Cron triggers

Two crons:

```
# Daily: pull yesterday
0 5 * * *     /usr/bin/node /app/dist/cron/trigger-performance-pull-daily.js

# Weekly: backfill last 7 days (catches restatements)
0 5 * * 1     /usr/bin/node /app/dist/cron/trigger-performance-pull-weekly.js
```

`trigger-performance-pull-daily.ts`:
```ts
const yesterday = formatDate(subDays(new Date(), 1));
await performancePullQueue.add('daily', {
  brandId: 'eastern-lm',
  dateRange: { start: yesterday, end: yesterday },
});
process.exit(0);
```

`trigger-performance-pull-weekly.ts`:
```ts
const end = formatDate(subDays(new Date(), 1));
const start = formatDate(subDays(new Date(), 7));
await performancePullQueue.add('weekly-backfill', {
  brandId: 'eastern-lm',
  dateRange: { start, end },
});
process.exit(0);
```

### 4.4 Manual pull endpoint

`src/routes/internal/performance-pull.ts`:
```ts
// POST /internal/performance-pull — requires X-Internal-Token
// Body: { brandId, startDate, endDate }
// Validates date range (max 90 days to avoid runaway ops quota)
app.post('/internal/performance-pull', requireInternalToken, async (req, res) => {
  const { brandId, startDate, endDate } = req.body;
  const daysSpan = differenceInDays(new Date(endDate), new Date(startDate));
  if (daysSpan > 90) {
    return res.status(400).json({ error: 'Max 90 days per pull' });
  }
  const job = await performancePullQueue.add('manual', {
    brandId,
    dateRange: { start: startDate, end: endDate },
  });
  res.json({ jobId: job.id });
});
```

### 4.5 Overview dashboard page

`easternLM/src/app/admin/marketing/page.tsx` — replace Phase 01 stub with functional Overview.

**Read `/mnt/skills/public/frontend-design/SKILL.md` first.** Follow its design principles.

Structure:
```tsx
// Server component
export default async function MarketingOverviewPage() {
  const brandId = 'eastern-lm';
  const mtdData = await getMTDStats(brandId);
  const daily = await getDailyPerformance(brandId, 30);
  const topCampaigns = await getTopCampaigns(brandId, 5);
  const account = await getBrandAccount(brandId);

  return (
    <MarketingLayout activeTab="overview">
      <KpiRow stats={mtdData} budgetCap={account.monthly_budget_cap_cents} />
      <SpendVsCapProgressBar actual={mtdData.spendCents} cap={account.monthly_budget_cap_cents} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <SpendTrendChart data={daily} />
        <ConversionsTrendChart data={daily} />
      </div>
      <RoasTrendChart data={daily} targetRoas={3.0} />
      <TopCampaignsTable campaigns={topCampaigns} />
    </MarketingLayout>
  );
}
```

`MarketingLayout` is a shared component with the 6-tab nav (Overview active, others linked-but-placeholder until Phase 07):
```
Overview (active) | Accounts | Product Feed | Campaigns | Recommendations | Conversions
```

Click nav links → navigate to `/admin/marketing/{accounts,feed,campaigns,recommendations,conversions}` — all these are Phase 07 work; Phase 04 only renders a "Coming in Phase 07" placeholder in those routes.

### 4.6 KPI tile component

```tsx
// KpiTile: { label, value, format, delta?, deltaColor? }
<KpiRow>
  <KpiTile label="MTD Spend" value={mtdData.spendCents / 100} format="currency" />
  <KpiTile label="MTD Conversions" value={mtdData.conversions} format="number" />
  <KpiTile label="MTD ROAS" value={mtdData.roas} format="ratio" target={3.0} />
  <KpiTile label="MTD CPA" value={mtdData.cpaCents / 100} format="currency" />
</KpiRow>
```

Design via frontend-design skill — avoid card-with-label-and-value generic look. Use typography hierarchy, numeric tabular lining, subtle color for delta-to-target.

### 4.7 Tests

Unit (vitest):
- ROAS calculation: correct value for positive cost, null for zero cost
- Date range validation rejects ranges >90 days in manual endpoint
- Micros conversion round-trips

Integration:
- Pull performance for a date range with no campaigns → 0 upserts, success
- Pull performance for a date range with test data in staging → correct rows in `mktg_google_performance`
- Re-pull same date → upsert (no duplicates), updated `pulled_at`

UI snapshot tests (optional, Phase 08 handles full E2E):
- Overview page renders without error on empty data (zero campaigns/spend state)
- Overview page renders with mock data (populated state)

### 4.8 CLAUDE.md additions

```markdown
## Phase 04 additions

- Daily performance pull: 5 AM UTC, yesterday's data.
- Weekly backfill: Monday 5 AM UTC, last 7 days (catches Google's restated data).
- Performance stored with costs in micros (BIGINT). Convert to cents/dollars at UI boundary only.
- ROAS pre-computed and stored (conversion_value / cost). Null when zero cost.
- Overview UI is server-rendered, Recharts, follows frontend-design skill.
- Phase 04 only implements Overview tab. Other 5 tabs show "Coming in Phase 07" placeholder.
- `conversions_value` field from Google Ads is DOLLARS (float), not micros — convert before storing.
```

---

## 5. Acceptance criteria

1. ✅ Daily performance pull cron fires at 5 AM UTC; populates `mktg_google_performance` for yesterday
2. ✅ Weekly backfill cron fires Monday 5 AM; updates last 7 days (tests: manipulate prior-week data in Google Ads test, verify DB reflects restatement)
3. ✅ Upsert on (brand_id, google_campaign_id, date) unique — no duplicates from multiple pulls
4. ✅ ROAS column correctly computed and stored
5. ✅ Micros preserved as BIGINT in DB; no precision loss
6. ✅ Manual pull endpoint `/internal/performance-pull` responds 401 without token, 200 with token, validates 90-day max range
7. ✅ Overview page renders at `/admin/marketing` with KPI row, progress bar, charts, top campaigns table — all server-rendered
8. ✅ Overview renders gracefully with zero data (fresh account) — shows "No performance data yet" copy, not blank/broken
9. ✅ Spend-vs-cap progress bar color-coded: green <75%, amber 75-100%, red >100%
10. ✅ Top campaigns table sorted by spend DESC, limited to 5
11. ✅ Tab nav renders all 6 tabs; clicking non-Overview tabs shows "Coming in Phase 07" placeholder page
12. ✅ frontend-design skill principles evident in the UI (non-generic typography, spacing, component composition)
13. ✅ No plaintext tokens in logs; grep check clean
14. ✅ Every performance pull writes `mktg_agent_actions` audit row with upserted count

---

## 6. Scope boundaries — DO NOT DO

- ❌ Optimizer rules / recommendations (Phase 05)
- ❌ Campaign activation / pause UI (Phase 07 — only Overview displays status)
- ❌ Budget editing UI (Phase 07)
- ❌ Feed sync status UI (Phase 07)
- ❌ Conversion upload (Phase 06)
- ❌ Date range picker on Overview (hardcoded MTD for Phase 04)
- ❌ Drill-down to per-campaign performance page (Phase 07)
- ❌ Any mutations to Google Ads

---

## 7. Risk callouts

1. **`conversions_value` units trap.** API returns dollars (float), not micros. Converting with `× 1_000_000` is correct but easy to miss in code review. Include an explicit unit test for this conversion.
2. **Empty data state.** At launch, campaigns are paused → zero impressions/clicks/conversions. Overview must render gracefully with empty arrays, not crash or show misleading "data loading" state.
3. **90-day backfill ops cost.** Manual endpoint permits up to 90 days. At ~20 campaigns × 90 days = 1,800 rows per pull = ~1-2 ops against the 15K daily quota. Fine in isolation, but if Adam triggers 10 of these in a day while Phase 02a is also running, you approach the cap. Log every pull's op-cost-estimate in audit.
4. **Timezone drift.** Google Ads account timezone is ET. Cron runs UTC. 5 AM UTC = 1 AM ET = safely after day close. Don't drift to 4 AM UTC thinking it's ET-morning — it's actually 12 AM ET, and yesterday may not yet be fully closed in reporting.
5. **Recharts bundle size.** Recharts is ~90kb gzipped. If it's not already in easternLM deps, adding it is fine but note it in completion report for bundle-size review.

---

## 8. Orchestration

Session start: `claude --max-turns 25` + paste this file.
Resume: `claude --continue`.
Completion: write completion report, push branch, stop.

Can merge in parallel with Phase 03. No code path overlap — 03 writes to Google Ads, 04 reads from Google Ads + writes to `mktg_google_performance` + reads from it for UI.

---

## 9. Review

Reviewer checks all 14 acceptance criteria, plus:
- Micros/dollars conversion correctness (especially `conversions_value`)
- Upsert idempotency (re-run same date → no duplicates)
- Overview UI loads in <1s on cold request
- frontend-design skill was actually consulted (look for patterns from the skill in the UI code)
- G4 audit writes on every pull
- G1 no Content API

Verdict: `PROMOTE` → unblocks Phase 05 (optimizer needs performance data) · `FIX` → re-run · `ESCALATE`.

---

*Phase 04 · April 16, 2026 · ~25 turn budget · Paste-ready.*
