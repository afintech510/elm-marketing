# Phase 07 — Marketing Tab UI Polish

**Role:** Claude Code, Phase 07 of 11.
**Spec:** `elm-google-ads-spec-LOCKED.md` (🔒).
**SOW:** `elm-google-ads-sow.md`.
**Depends on:** Phases 03, 04, 05, 06 all PROMOTEd.
**Max turns:** 30 (resume with `--continue`).
**Branch:** `feature/marketing-07` on `easternLM`.
**Reports to:** `PHASE-07-COMPLETION-REPORT.md` + `PHASE-07-PROGRESS.md`.

---

## 1. Mission

Turn the Marketing tab into a production-quality admin interface. By this phase, Overview (Phase 04), Recommendations (Phase 05), and Conversions stub (Phase 06) exist but are minimal. This phase:

- Fleshes out all 6 sub-tabs with full interactivity
- Adds the Accounts tab (publish_mode toggle, budget cap editor, connection controls)
- Adds the Product Feed tab (per-product status, disapproval details, manual sync)
- Adds the Campaigns tab (list, activate/pause, budget edit, link to Google Ads UI)
- Polishes Conversions tab (manual trigger, recent history, upload error detail)
- Shared layout: tab nav, page titles, loading states, empty states, error boundaries

Heaviest UI phase. Read `/mnt/skills/public/frontend-design/SKILL.md` first and frequently.

---

## 2. Diagnostic-first (MANDATORY)

1. Read `elm-google-ads-spec-LOCKED.md` §9 (admin UI spec).
2. Inspect current state of `easternLM/src/app/admin/marketing/*` — confirm which sub-routes exist (from Phases 01, 04, 05, 06) and which need building.
3. Inspect existing admin UI patterns in easternLM — `/admin/orders` is Phase 4's large rebuild, follow its conventions for: two-panel layout (list+detail), filter bar, pagination, bulk actions, real-time via Supabase Realtime.
4. `view /mnt/skills/public/frontend-design/SKILL.md` — read completely before any component work.
5. Inventory which `/internal/*` endpoints on `elm-marketing` exist (Phases 02a, 02b, 06). UI needs: feed sync trigger, campaign read methods, conversion upload trigger, etc.
6. Sketch the information architecture (in progress report): what each sub-tab shows, what actions are available, what data it fetches.
7. Report findings in turn 1.

---

## 3. Context

### 3.1 Tab structure

```
/admin/marketing                    → Overview (done in Phase 04, polish pass)
/admin/marketing/accounts           → Accounts — NEW in Phase 07
/admin/marketing/feed               → Product Feed — NEW in Phase 07
/admin/marketing/campaigns          → Campaigns — NEW in Phase 07
/admin/marketing/recommendations    → Recommendations (done in Phase 05, polish pass)
/admin/marketing/conversions        → Conversions (stub in Phase 06, full here)
```

Shared `MarketingLayout` component wraps all 6 with tab nav + page title.

### 3.2 Per-tab spec

#### Overview (polish only — core done in Phase 04)
- Add date range picker (preset: Today, Yesterday, Last 7 days, Last 30 days, MTD, YTD, Custom)
- When date range changes, re-query `mktg_google_performance`, update all charts
- Add "Active campaigns: X / Paused: Y / Total: Z" summary row
- Clickable KPI tiles → drill into filtered views (click Spend → Campaigns sorted by spend)

#### Accounts
Single-card layout (single brand at launch, layout accommodates multi-brand when MGG lands):

```
[Eastern Landscape & Mason Supply]
  Connected: adam@easternbuilding.supply
  Connected since: Apr 10, 2026

  Google Ads CID:   540-952-6270
  GMC Merchant ID:  5578269156
  Store code:       ELM-FROWEIN-01

  [Publish mode: Suggest ▼]    ← dropdown: Read-only / Suggest / Auto
                                 ← with warning modal when switching TO Auto

  [Monthly budget cap: $2,000]  ← inline editor with validation

  Current spend: $X of $2,000  ← progress bar
  [Disconnect Google]           ← red button, confirmation modal
```

**Publish mode switch guardrails:**
- Switching to `read_only` → immediate no-op confirmation
- Switching to `suggest` → no confirmation
- Switching to `auto` → modal: "Auto mode allows optimizer to apply changes without approval. [Show me what auto would apply right now] [Cancel] [Enable auto mode — I understand]". Show pending recs that would auto-apply in the next run. Button requires explicit click + acknowledgment.

**Budget cap editor:**
- Inline number input, dollars (not cents in UI)
- Validates: min $100, max $100,000
- On blur, confirm dialog: "Change cap from $2,000 to $X? This takes effect immediately — in-flight mutations still gate on this value."
- Update writes to `mktg_google_accounts.monthly_budget_cap_cents`, audit row

**Disconnect button:**
- Red, bottom-of-card
- Modal: "Disconnect Google for Eastern Landscape & Mason Supply? All campaigns will continue running in Google Ads, but no sync or optimization will happen until you reconnect. [Cancel] [Disconnect]"
- On confirm → POST `/api/marketing/google/oauth/revoke` from Phase 01

#### Product Feed
Two-panel layout:

```
┌─── FILTERS ───────────┬─── LIST ─────────────────────────────────┐
│ Status:               │ ● Natural LI Mulch (online)              │
│ [ ] Approved          │   Approved · Last synced 2h ago          │
│ [ ] Pending           │                                          │
│ [ ] Disapproved       │ ● Natural LI Mulch (local)               │
│ [ ] Invalid           │   Disapproved · "Misrepresentation"      │
│                       │   ← this one highlighted                 │
│ Channel:              │                                          │
│ [ ] Online            │ ● Hamptons Chocolate Brown (online)      │
│ [ ] Local             │   Approved · Last synced 2h ago          │
│                       │                                          │
│ [Sync all now] ←      │ ... (all products)                       │
│ [Sync single product] │                                          │
└───────────────────────┴──────────────────────────────────────────┘

DETAIL PANEL (on row click):
┌────────────────────────────────────────────────────────────────┐
│ Natural LI Mulch (local)                                       │
│ GMC offer ID: elm-natural-li-mulch-local                       │
│ Channel: local · Last synced: 2h ago                           │
│                                                                │
│ STATUS: Disapproved                                            │
│ Reason: Misrepresentation — Policy: Business information mismatch │
│                                                                │
│ [View in Merchant Center] (link to GMC)                        │
│ [Force re-sync this product]                                   │
│                                                                │
│ Source Supabase product:                                       │
│   Title: Natural Long Island Mulch — Delivered by the Cubic Yard │
│   Price: $45.00                                                │
│   Image: [thumbnail]                                           │
│   [Edit source product] → /admin/products/<slug>               │
└────────────────────────────────────────────────────────────────┘
```

**Sync all now** button → calls `/internal/feed-sync` on `elm-marketing`. Shows spinner + "Syncing..." toast. Result: summary modal with counts.

**Force re-sync this product** → calls `/internal/feed-sync` with `productId` param (extend Phase 02a's endpoint if not already per-product).

#### Campaigns
Two-panel layout, similar pattern:

```
┌─── LIST ──────────────────────────────────┐
│ ● ELM-Search-Mulch (Search)  PAUSED       │
│   Budget: $20/day · 0 clicks · 0 conv     │
│                                           │
│ ● ELM-Search-Topsoil (Search) PAUSED      │
│   ...                                     │
│                                           │
│ ● ELM-PMax-All-Products (PMax) PAUSED     │
│   Budget: $50/day · 0 clicks · 0 conv     │
│                                           │
│ ● ELM-Local-Pickup (Local) PAUSED         │
│                                           │
│ [Sync campaigns from Google] ←            │
└───────────────────────────────────────────┘

DETAIL PANEL (on row click):
┌────────────────────────────────────────────┐
│ ELM-Search-Mulch                           │
│ Status: PAUSED  [Activate] [Pause]         │
│ Budget: $20/day  [Edit]                    │
│ Bidding: MAXIMIZE_CONVERSIONS              │
│ Target CPA: not set  [Set]                 │
│                                            │
│ Last 30 days: 0 impressions, 0 clicks      │
│ [Open in Google Ads UI →]                  │
│                                            │
│ Ad Groups (1):                             │
│   • ELM-Search-Mulch-Core  6 keywords     │
│     [View keywords] [View negatives]       │
│                                            │
│ Campaign Negatives (4):                    │
│   bagged, playground, rubber, wholesale-only │
│                                            │
│ Shared Negatives: ELM-Shared-Negatives ✓   │
└────────────────────────────────────────────┘
```

**Activate / Pause buttons:**
- Guardrail-aware: attempting to activate when projected spend > cap → modal: "Activating this campaign would push monthly spend to $X, over cap of $2,000. [Raise cap and activate] [Cancel]"
- All mutations go through `elm-marketing:3300/internal/campaigns/mutate` (new endpoint — expose Phase 03's write methods)

**Budget edit:**
- Inline editor, dollars
- Guardrail check on save — show error if would exceed cap

**Ad group / keyword views:**
- Modal or drawer showing Phase 02b's read results (listAdGroups, listKeywords)
- Read-only in Phase 07 — no keyword editing UI

#### Recommendations (polish)
Core in Phase 05. Polish adds:
- Grouping by campaign (expand/collapse card groups)
- Rule type badges with tooltips ("R1 — Budget winner", "R2 — Unprofitable", etc.)
- History view: toggle "Show decided" → see past approved/rejected/auto_applied/error recs
- Apply result display: for approved-and-applied recs, show what changed + timestamp

#### Conversions (full)
```
┌─── GCLID CAPTURE RATE ─────┬─── UPLOAD STATUS ──────────────┐
│                            │ Uploaded:     342             │
│      62%                   │ Expired:       18             │
│  of orders last 30 days    │ Invalid:        3             │
│     have GCLID             │ Config error:   0             │
│                            │ Pending:        0             │
│  [?] How this is measured  │                               │
│                            │ Last run: 12 min ago          │
│                            │ [Trigger upload now]          │
└────────────────────────────┴───────────────────────────────┘

Recent uploads (last 30 days):
┌────────┬──────────┬─────────┬──────────────────┬─────────────┐
│ Order  │ Value    │ GCLID   │ Status           │ When        │
├────────┼──────────┼─────────┼──────────────────┼─────────────┤
│ #12345 │ $420.00  │ Cj0KC… │ Uploaded         │ 3h ago      │
│ #12344 │ $180.00  │ Cj0KC… │ Expired          │ 4h ago      │
│  ...   │   ...    │   ...   │    ...            │    ...      │
└────────┴──────────┴─────────┴──────────────────┴─────────────┘
```

"Trigger upload now" calls `/internal/conversion-upload` endpoint (add to Phase 06 service).

### 3.3 Real-time updates

For Recommendations and Conversions tabs, use Supabase Realtime:
- New recommendation inserted → card appears without refresh
- New conversion uploaded → row prepends without refresh

Match the pattern from `/admin/orders` rebuild (session 4 memory reference).

### 3.4 Shared components to build / reuse

From `/mnt/skills/public/frontend-design/SKILL.md` + shadcn/ui:
- `MarketingLayout` with tab nav (reuse existing admin shell)
- `KpiTile`, `KpiRow` (from Phase 04)
- `StatusBadge` (success/warning/error color tokens)
- `ConfidenceBadge` (low/med/high, with tooltip explaining threshold)
- `InlineNumberEditor` (blur-to-save with confirm dialog)
- `GuardrailModal` (reusable for any action that might trip guardrails — budget edit, campaign activate, publish_mode switch)
- `ListDetailPanel` (two-panel layout, responsive collapse on mobile)

### 3.5 Error boundaries + loading states

Every server-fetched section wrapped in:
- Suspense boundary with skeleton loader
- Error boundary with "Couldn't load X — [Retry]" fallback
- Empty state with explanatory copy when data is zero/empty

No flashing spinners. No content jumps. Each section's skeleton matches its real layout's dimensions.

### 3.6 Mobile — not this phase

Admin is desktop-first. Responsive collapse to single column at <1024px is fine; full mobile optimization is out of scope.

---

## 4. Tasks (ordered)

### 4.1 Shared layout + navigation

`easternLM/src/app/admin/marketing/layout.tsx`:
```tsx
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <AdminShell>
      <MarketingTabNav />
      {children}
    </AdminShell>
  );
}
```

`MarketingTabNav` — horizontal tab strip, 6 links, active state based on pathname.

### 4.2 Accounts tab

`/admin/marketing/accounts/page.tsx` — server component.

Read `mktg_google_accounts` row, render card. Client sub-components for interactions:
- `<PublishModeSwitcher>` — dropdown + Auto-mode warning modal
- `<BudgetCapEditor>` — inline number, confirm dialog
- `<DisconnectButton>` — red button, confirm modal
- `<SpendVsCapBar>` — progress bar fetched live (MTD aggregation)

API routes (new in Phase 07):
- `PUT /api/marketing/google/accounts/publish-mode` — body `{ brandId, mode }`
- `PUT /api/marketing/google/accounts/budget-cap` — body `{ brandId, capCents }`
- Both audit + call guardrails where applicable

### 4.3 Product Feed tab

`/admin/marketing/feed/page.tsx` — server component list, client subcomponents for filters + sync buttons.

Fetches:
- `mktg_google_products` rows for brand, joined with `products` table for source data
- Display: list with status pills, detail panel on selection

Sync buttons call `elm-marketing` service at `/internal/feed-sync` (extend endpoint to accept optional `productId` filter for per-product sync).

Real-time: Supabase Realtime on `mktg_google_products.last_synced_at` change → update list without refresh.

### 4.4 Campaigns tab

`/admin/marketing/campaigns/page.tsx` — list + detail.

Fetches:
- `mktg_google_campaigns` for the list
- On detail click: client-side fetch to `/api/marketing/google/campaigns/:id/detail` which pulls fresh state from `elm-marketing:3300/internal/campaigns/*` endpoints (listAdGroups, listKeywords, listCampaignNegatives)

Actions:
- Activate/Pause buttons → PUT `/api/marketing/google/campaigns/:id/status` — server-side calls `elm-marketing` endpoint which calls `campaignAgent.updateCampaignStatus`
- Budget edit → PUT `/api/marketing/google/campaigns/:id/budget`
- Target CPA set → PUT `/api/marketing/google/campaigns/:id/target-cpa`

All actions go through `triggeredBy=<admin email>` so guardrail treats as human-approved.

### 4.5 Recommendations polish

Extends Phase 05 UI:
- Grouping: `<GroupedRecommendationList>` with collapse
- History view: tabs "Pending | History"; history query filters by status != 'pending'
- Applied result rendering: parse `apply_result` JSON, format based on rec type

### 4.6 Conversions full

`/admin/marketing/conversions/page.tsx`:
- KPI: capture rate (query orders), upload counts (query `mktg_google_conversions_uploaded`)
- Recent table with real-time
- "Trigger upload now" button → POST `/internal/conversion-upload` on elm-marketing

### 4.7 API routes (easternLM)

All new admin mutation endpoints:
```
PUT  /api/marketing/google/accounts/publish-mode
PUT  /api/marketing/google/accounts/budget-cap
POST /api/marketing/google/feed/sync           (proxies to elm-marketing)
POST /api/marketing/google/feed/sync/:productId (single product)
PUT  /api/marketing/google/campaigns/:id/status
PUT  /api/marketing/google/campaigns/:id/budget
PUT  /api/marketing/google/campaigns/:id/target-cpa
POST /api/marketing/google/conversions/upload  (proxies to elm-marketing)
```

All:
- Require authenticated admin session
- Pass through to `elm-marketing` via service-to-service auth (`X-Internal-Token`)
- Return standardized `{ data, error }` shape
- Audit at easternLM layer IF action is UI-originated (set `triggered_by=<admin email>`)

### 4.8 Internal endpoints to add on elm-marketing

Extend existing:
- `/internal/feed-sync` — accept optional `productId`
- `/internal/campaigns/mutate/status` — wraps `updateCampaignStatus`
- `/internal/campaigns/mutate/budget` — wraps `updateCampaignBudget`
- `/internal/campaigns/mutate/target-cpa` — wraps `updateCampaignTargetCpa`
- `/internal/conversion-upload/trigger` — manually enqueue upload job
- `/internal/accounts/publish-mode` — update `mktg_google_accounts.publish_mode`
- `/internal/accounts/budget-cap` — update `mktg_google_accounts.monthly_budget_cap_cents`

Each takes `brandId` + params + `triggeredBy` (email) + guards on X-Internal-Token.

### 4.9 Tests

Component tests (vitest + @testing-library/react):
- `PublishModeSwitcher`: renders current mode, opens Auto warning modal on switch to auto
- `BudgetCapEditor`: inline edit, validation, confirm dialog
- `GuardrailModal`: renders with proposed change, handles cancel/proceed

API route tests (integration, vitest):
- Each new PUT/POST endpoint: auth required, proxies correctly, handles errors

E2E deferred to Phase 08 (fuller coverage there).

### 4.10 Documentation

Update CLAUDE.md in easternLM:
```markdown
## Phase 07 additions — Marketing admin UI

- 6 sub-tabs under /admin/marketing: Overview, Accounts, Product Feed, Campaigns, Recommendations, Conversions
- All actions go through API routes that proxy to elm-marketing:3300 via X-Internal-Token
- All mutations audit: triggered_by=<admin email> from session
- Auto-mode toggle requires explicit user confirmation with preview of what would be auto-applied
- Budget cap changes take immediate effect; in-flight mutations re-check against new cap
- frontend-design skill consulted for every new component
```

---

## 5. Acceptance criteria

1. ✅ All 6 sub-tabs render, navigable via tab bar, active state correct
2. ✅ Accounts tab: publish_mode switcher works (read_only, suggest, auto), auto requires confirmation modal with preview
3. ✅ Budget cap editor: inline edit, validation (min $100, max $100k), confirm dialog, persists to DB
4. ✅ Disconnect button: modal confirm, calls revoke endpoint, UI updates to "Connect Google" state
5. ✅ Product Feed tab: list of all `mktg_google_products` rows for brand, filters work (status, channel), detail panel renders on selection
6. ✅ "Sync all" button triggers feed-sync job; success toast with summary
7. ✅ "Sync single" button on detail panel triggers per-product sync
8. ✅ Campaigns tab: list of `mktg_google_campaigns`, detail fetches live ad groups/keywords/negatives
9. ✅ Activate/Pause: triggers mutation through campaign agent, respects guardrails, shows error if cap would be exceeded
10. ✅ Budget edit on campaign: modal confirm, guardrail-checked, persists
11. ✅ Target CPA set/edit: works, persists
12. ✅ Recommendations tab: grouped view, history tab, apply_result rendering works
13. ✅ Conversions tab: GCLID capture rate displayed, upload status counts, recent uploads table, manual trigger button works
14. ✅ Real-time on Recommendations and Conversions tabs (Supabase Realtime — new rows appear without refresh)
15. ✅ Every server-fetched section has loading skeleton, empty state, error boundary
16. ✅ frontend-design skill principles evident throughout (non-generic typography, spacing, color hierarchy)
17. ✅ All mutations audit with `triggered_by=<admin email>`
18. ✅ No broken links, no 404s on any tab navigation
19. ✅ Mobile responsive: collapses to single column < 1024px (polish not required)

---

## 6. Scope boundaries — DO NOT DO

- ❌ New agent logic (all agents done in prior phases)
- ❌ New Google API integration
- ❌ Mobile-optimized polish (responsive collapse fine; full mobile optimization is out)
- ❌ Keyword editing UI (read-only in Phase 07; Phase 08+ adds)
- ❌ Ad copy editor
- ❌ Asset group editor
- ❌ A/B testing UI
- ❌ Exporting data to CSV (nice-to-have, not MVP)
- ❌ Multi-brand UI (single-brand layout accommodates future MGG — don't pre-build tabs for second brand)

---

## 7. Risk callouts

1. **frontend-design skill adherence.** The biggest risk in a UI-heavy phase is landing with generic, AI-looking components. Operator must read the skill, ideally twice, and cross-check every new component against its principles. Reviewer will grep for generic patterns (generic card grids, unstyled shadcn defaults).
2. **API route proxy overhead.** Every UI action is a round trip: UI → easternLM API → elm-marketing internal → agent → Google. 3-hop latency can feel sluggish. Add optimistic UI where safe (instant visual feedback, rollback on error).
3. **Publish_mode=auto warning clarity.** If users don't understand what auto-mode does, they'll flip it and blame the optimizer. Modal must show concrete preview: "Right now, 3 recommendations would auto-apply: [list with confidence, impact]. Proceed?"
4. **Supabase Realtime connection count.** Each live tab opens a subscription. 6 tabs × N admins × reconnect attempts → can hit Supabase free-tier limits if Adam has multiple admin sessions open. Low risk at current scale.
5. **Budget cap editor race.** Admin edits cap → confirms → while request in flight, Adam in another tab activates a campaign. Backend: guardrail reads cap at mutation time, so consistency is preserved. Just document.

---

## 8. Orchestration

Session start: `claude --max-turns 30` + paste this file. Largest UI phase; may need 2 sessions.
Resume: `claude --continue`.
Completion: write completion report, push branch, stop.

---

## 9. Review

Reviewer checks all 19 acceptance criteria, plus:
- frontend-design skill evidence (look for non-generic composition)
- Guardrail integration on all UI-triggered mutations
- Audit row completeness (every UI action produces an audit row with correct triggered_by)
- Error boundary + empty state coverage (zero-data scenario works)
- No plaintext tokens ever surfaced to client

Verdict: `PROMOTE` → unblocks Phase 08 · `FIX` → re-run · `ESCALATE`.

---

*Phase 07 · April 16, 2026 · ~30 turn budget · Paste-ready. Heaviest UI phase.*
