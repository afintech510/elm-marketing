# ELM Marketing Engine — Google Ads + Merchant API Integration

**Status:** 🔒 **LOCKED** — April 16, 2026 · ready for build-prompter handoff
**Owner:** Adam Larkin
**Target repos:** `elm-marketing` (new service, port 3300) + `easternLM` (admin UI on `feature/marketing-ui`)
**API versions:** Google Ads API v21 (stable) · Merchant API v1 (stable — Content API sunset Aug 18, 2026)

---

## 0. Locked decisions

| # | Decision | Locked value | Notes |
|---|---|---|---|
| D1 | Account structure | **Path B — existing CID, MCC deferred** | `google_customer_id: 5409526270`. MCC migration is non-destructive when MGG lands; `brand_id` stays on all tables per Adam (future MGG migration does not need schema change) |
| D2 | Agent autonomy | **Suggest mode** | `publish_mode='suggest'` default. `auto` toggle stays in schema as future enablement, gated by budget cap |
| D3 | Launch campaigns | **Search + PMax + LIA** | LIA adds Phase 02c and expanded Phase 00 (store entity creation) |
| D4 | GMC account | **Exists: `merchant_id: 5578269156`** | Domain verified + claimed. Misrepresentation flag in review (non-blocking through Phase 01) |
| D5 | GBP linked to GMC | **Yes** | Admin: `adam@easternbuilding.supply`. Store entity NOT yet created in GMC — Phase 00 creates via Merchant API |
| D6 | Monthly budget cap per brand | **$2,000 ELM / $1,000 MGG** | Editable in admin UI per-brand; hard-checked before any budget mutation |
| D7 | Conversion definition | **Primary: paid order. Secondary: quote submit** | Primary = Stripe `succeeded`, value = `order.total_cents/100`, category = Purchase, count = One, window = 30d, attribution = Data-driven. Secondary = quote form submit, category = Submit Lead Form, value = 0 (PMax audience signal only) |

**All prerequisites owned by Adam (out-of-band, parallel to build):**
- ✅ GMC `5578269156` verified
- ✅ GBP verified + linked to GMC
- ✅ Google Ads CID `540-952-6270` linked to GMC
- 🟡 GMC Misrepresentation flag cleared (in Google review; blocks feed going live in Phase 02a only)
- ❌ Google Cloud Console project `elm-marketing` — OAuth 2.0 Web Application client; authorized redirect URI `https://easternlm.com/api/marketing/google/oauth/callback`; enable Google Ads API + Merchant API. (10-min task, parallel)

---

## 1. What this system does

Three things:

1. **Feed sync** — keeps Google Merchant Center product data in sync with Supabase `products` table (price, availability, images, delivery/pickup attributes). One-way: Supabase → GMC.
2. **Campaign management** — creates and manages Google Ads campaigns (Search + PMax at launch), ad groups, keywords, budgets, negative keyword lists. Brand-scoped.
3. **Optimization loop** — nightly job pulls performance data (GAQL), scores campaigns against KPIs, emits recommendations (or auto-applies within guardrails if `publish_mode = 'auto'`).

Conversion signal closes the loop: completed Supabase orders are uploaded back to Google Ads as offline conversions via GCLID match, so PMax and Smart Bidding learn from actual revenue — not just form submits.

---

## 2. Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     easternLM (Next.js app)                      │
│   /admin/marketing → Marketing Tab UI (feed / campaigns / opt)  │
│                                                                   │
│   POST /api/marketing/google/connect     ← OAuth callback         │
│   GET  /api/marketing/google/feed        ← feed status            │
│   POST /api/marketing/google/recommendations/:id/approve          │
└────────────────────────┬────────────────────────────────────────┘
                         │ Supabase (mktg_* tables)
                         │
┌────────────────────────┴────────────────────────────────────────┐
│             elm-marketing service (new repo)                     │
│             Hetzner VPS · port 3300 (new allocation)              │
│                                                                   │
│  BullMQ Queues (Redis, elm: prefix)                               │
│   ├─ google-feed-sync           (every 4hr cron → enqueue)       │
│   ├─ google-performance-pull    (daily 5am cron → enqueue)       │
│   ├─ google-optimize            (daily 6am cron → enqueue)       │
│   ├─ google-conversion-upload   (every 15min cron → enqueue)     │
│   └─ google-token-refresh       (every 12hr cron)                │
│                                                                   │
│  Agents (Claude Agent SDK v0.2.71)                                │
│   ├─ googleAdsFeedAgent         ← Merchant API v1 writes         │
│   ├─ googleAdsCampaignAgent     ← Google Ads API writes          │
│   └─ googleAdsOptimizerAgent    ← GAQL reads + recommendation gen│
└────────────────────────┬────────────────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              │                     │
      ┌───────▼────────┐   ┌────────▼────────┐
      │  Google Ads    │   │  Merchant API   │
      │  API v21       │   │  v1             │
      │  (MCC + CIDs)  │   │  (GMC)          │
      └────────────────┘   └─────────────────┘
```

**Key choice: separate service, not in-process.** The `elm-marketing` repo is already spec'd for the 8-agent system. Google Ads/Merchant workers live there, not in `easternLM`. Reason: campaign/feed jobs need BullMQ workers that run outside the Next.js request lifecycle, and credential isolation is cleaner.

**Single Supabase project, `mktg_` prefix.** Matches existing Host Hampton pattern noted in memory. No separate DB.

---

## 3. Auth architecture

### 3.1 Credentials (one-time setup — Phase 00)

| Item | Where | Value / How obtained |
|---|---|---|
| Developer token | env var `GOOGLE_ADS_DEVELOPER_TOKEN` on VPS | Existing: `ATXQta_xxxxx` (Basic Access, 15K ops/day) |
| Google Ads customer ID | env var `GOOGLE_ADS_CUSTOMER_ID` | **`5409526270`** (ELM's existing CID, Path B) |
| `login_customer_id` | Not set (Path B — no MCC) | Set to `null`; swap to MCC ID when MGG lands |
| Merchant Center ID | env var `GMC_MERCHANT_ID` | **`5578269156`** (ELM's GMC, already verified) |
| LIA store code | Config constant `ELM_STORE_CODE` | **`ELM-FROWEIN-01`** (Phase 00 creates store entity via Merchant API) |
| OAuth client | env vars `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET` | Adam creates in Cloud Console project `elm-marketing` |
| Per-brand refresh token | `mktg_google_accounts.refresh_token_encrypted` | Admin UI OAuth flow, AES-256-GCM encrypted |
| Encryption key | env var `MKTG_ENCRYPTION_KEY` | 32 bytes, base64 — generated in Phase 00 setup |
| Conversion actions | Created via Google Ads API in Phase 00 | Primary: "Website Order" · Secondary: "Quote Submit" |

### 3.2 OAuth flow (Admin UI)

```
/admin/marketing/connect/google
  → redirect to accounts.google.com/o/oauth2/v2/auth
      scopes: adwords + content (Merchant API)
      access_type=offline, prompt=consent  (forces refresh token)
  → callback /api/marketing/google/oauth/callback
      ↓
    Exchange code → { access_token, refresh_token }
    Encrypt refresh_token with MKTG_ENCRYPTION_KEY
    INSERT mktg_google_accounts (brand_id, customer_id, merchant_id, refresh_token_encrypted)
  → redirect /admin/marketing with success toast
```

**One brand = one refresh token.** When we add MyGravelGuy, it re-runs the connect flow and writes a second row. The `brand_id` foreign key on every downstream table scopes all reads/writes.

### 3.3 Per-request auth

Every API call grabs a fresh access token from refresh token (cached 50min in Redis):

```ts
// elm-marketing/src/auth/google.ts
export async function getGoogleAdsClient(brandId: string): Promise<GoogleAdsApi> {
  const account = await getBrandAccount(brandId);
  const accessToken = await getAccessToken(brandId); // refreshes if expired
  return new GoogleAdsApi({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    developer_token: env.GOOGLE_ADS_DEVELOPER_TOKEN,
  }).Customer({
    customer_id: account.google_customer_id,
    // login_customer_id: undefined — Path B, no MCC layer
    // When MCC lands: login_customer_id = env.GOOGLE_ADS_MCC_CUSTOMER_ID
    refresh_token: decrypt(account.refresh_token_encrypted),
  });
}
```

**Libraries:** `google-ads-api` (Node.js, maintained, supports v21) · `@google-cloud/merchant-products` + `@google-cloud/merchant-accounts` + `@google-cloud/merchant-inventories` (Merchant API v1 modular clients)

---

## 4. Database schema (new mktg_* tables)

```sql
-- Per-brand Google credential + account linkage
CREATE TABLE mktg_google_accounts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id                 text NOT NULL,              -- 'eastern-lm' | 'mygravelguy' (brand_id kept per Adam)
  google_customer_id       text NOT NULL,              -- '5409526270' at launch
  merchant_id              text NOT NULL,              -- '5578269156' at launch
  store_code               text,                       -- 'ELM-FROWEIN-01' (LIA)
  refresh_token_encrypted  text NOT NULL,
  connected_by_email       text,
  publish_mode             text NOT NULL DEFAULT 'suggest'
                           CHECK (publish_mode IN ('read_only','suggest','auto')),
  monthly_budget_cap_cents integer NOT NULL,           -- ELM default: 200000 ($2000)
  conversion_action_purchase text,                     -- resource name from Phase 00 creation
  conversion_action_lead     text,                     -- resource name from Phase 00 creation
  connected_at             timestamptz NOT NULL DEFAULT now(),
  revoked_at               timestamptz,
  UNIQUE (brand_id)
);
-- Seed row inserted in Phase 00 migration:
-- brand_id='eastern-lm', google_customer_id='5409526270', merchant_id='5578269156',
-- store_code='ELM-FROWEIN-01', monthly_budget_cap_cents=200000, publish_mode='suggest'

-- Supabase product → GMC offer mapping (may have 2 rows per product: online + local)
CREATE TABLE mktg_google_products (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id           text NOT NULL,
  product_id         uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  gmc_offer_id       text NOT NULL,                   -- required per March 2026 multi-channel split
  channel            text NOT NULL CHECK (channel IN ('online','local')),
  content_language   text NOT NULL DEFAULT 'en',
  feed_label         text NOT NULL DEFAULT 'US',
  last_synced_at     timestamptz,
  last_sync_status   text,                            -- 'approved' | 'pending' | 'disapproved'
  disapproval_reason text,
  UNIQUE (brand_id, gmc_offer_id, channel)
);

-- Campaign state mirror (source of truth = Google; this table is cache + metadata)
CREATE TABLE mktg_google_campaigns (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id            text NOT NULL,
  google_campaign_id  text NOT NULL,
  name                text NOT NULL,
  type                text NOT NULL,                  -- 'SEARCH' | 'PERFORMANCE_MAX' | 'SHOPPING' | 'LOCAL'
  status              text NOT NULL,                  -- 'ENABLED' | 'PAUSED' | 'REMOVED'
  budget_cents_daily  integer,
  bidding_strategy    text,                           -- 'MAXIMIZE_CONVERSIONS' | 'TARGET_CPA' | etc.
  target_cpa_cents    integer,
  created_by_agent    boolean DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_synced_at      timestamptz,
  UNIQUE (brand_id, google_campaign_id)
);

-- Daily performance snapshot (append-only, analytics-friendly)
CREATE TABLE mktg_google_performance (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id           text NOT NULL,
  google_campaign_id text NOT NULL,
  date               date NOT NULL,
  impressions        bigint NOT NULL DEFAULT 0,
  clicks             bigint NOT NULL DEFAULT 0,
  cost_micros        bigint NOT NULL DEFAULT 0,       -- Google reports in micros
  conversions        numeric(10,2) NOT NULL DEFAULT 0,
  conversion_value_micros bigint NOT NULL DEFAULT 0,
  ctr                numeric(6,4),
  avg_cpc_micros     bigint,
  roas               numeric(8,2),                    -- computed: conv_value / cost
  pulled_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_id, google_campaign_id, date)
);
CREATE INDEX ON mktg_google_performance (brand_id, date DESC);

-- Agent-generated optimization recommendations (suggest/auto mode writes here)
CREATE TABLE mktg_google_recommendations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id           text NOT NULL,
  google_campaign_id text,
  type               text NOT NULL,                   -- 'BUDGET_INCREASE' | 'PAUSE_CAMPAIGN' | 'ADD_NEGATIVE_KEYWORD' | 'ADJUST_TARGET_CPA' | ...
  reason             text NOT NULL,                   -- agent's natural-language justification
  proposed_change    jsonb NOT NULL,                  -- {field: 'budget_cents_daily', from: 5000, to: 7500}
  estimated_impact   jsonb,                           -- {metric: 'conversions', delta: '+12%'}
  status             text NOT NULL DEFAULT 'pending'  -- 'pending' | 'approved' | 'rejected' | 'auto_applied' | 'expired'
                     CHECK (status IN ('pending','approved','rejected','auto_applied','expired')),
  created_by_agent   text NOT NULL,                   -- 'googleAdsOptimizerAgent'
  created_at         timestamptz NOT NULL DEFAULT now(),
  decided_at         timestamptz,
  decided_by         text,                            -- user email if human, 'system' if auto
  applied_at         timestamptz,
  apply_result       jsonb
);
CREATE INDEX ON mktg_google_recommendations (brand_id, status, created_at DESC);

-- Offline conversion upload tracking (prevent double-upload)
CREATE TABLE mktg_google_conversions_uploaded (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id           text NOT NULL,
  order_id           uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  gclid              text,
  conversion_action_resource text,
  uploaded_at        timestamptz NOT NULL DEFAULT now(),
  upload_status      text NOT NULL,                   -- 'success' | 'failed' | 'no_gclid'
  error_message      text,
  UNIQUE (order_id)
);

-- Pre-existing orders table needs one column added:
ALTER TABLE orders ADD COLUMN IF NOT EXISTS gclid text;
-- Captured from ?gclid= URL param on landing, stored in checkout session
```

RLS: same pattern as existing mktg tables — service role only, no anon access. Admin UI queries through Next.js API routes with session guard.

---

## 5. Product feed strategy (the hard part)

Bulk materials sold by cubic yard with local delivery are not a standard Shopping SKU. Here's the design:

### 5.1 What gets fed to GMC

**Every `products` row with `is_active = true` and `delivery_type = 'bulk'` becomes a GMC offer:**

```json
{
  "offerId": "elm-mulch-natural-li",
  "title": "Natural Long Island Mulch — Delivered by the Cubic Yard",
  "description": "Locally processed double-ground natural mulch. Delivered anywhere in Suffolk County...",
  "link": "https://easternlm.com/shop/natural-li-mulch",
  "imageLink": "https://easternlm.com/products/natural-li-mulch.jpg",
  "contentLanguage": "en",
  "feedLabel": "US",
  "channel": "online",                              // or 'local' for LIA
  "availability": "in_stock",
  "condition": "new",
  "price": { "amountMicros": "45000000", "currencyCode": "USD" },  // $45.00/cu yd
  "unitPricingMeasure": { "value": 1, "unit": "cbm" },  // cbm = cubic meter; closest GMC unit
  "unitPricingBaseMeasure": { "value": 1, "unit": "cbm" },
  "shipping": [{
    "country": "US",
    "region": "NY",
    "service": "Dump Truck Delivery",
    "price": { "amountMicros": "0", "currencyCode": "USD" }  // delivery calculated at checkout
  }],
  "brand": "Eastern Landscape & Mason Supply",
  "gtin": null,                                     // bulk materials have no GTIN
  "identifierExists": false,
  "productTypes": ["Landscape Materials > Mulch > Natural"],
  "googleProductCategory": "Home & Garden > Lawn & Garden > Gardening > Mulch"
}
```

**Known limitation: GMC doesn't have a "cubic yard" unit.** Closest is `cbm` (cubic meter). Options: (a) fudge to cbm (1 cu yd ≈ 0.76 cbm), (b) omit unit pricing entirely and rely on the product title "per cubic yard" text. I recommend (b) — accurate unit pricing is optional; misleading unit pricing breaks trust. Product title carries the "per cu. yard" per your enforced copy rules.

### 5.2 Local vs online product IDs

Per March 2026 rule, if pickup at yard and online delivery differ in price/availability, we need separate GMC offer IDs:

- `elm-mulch-natural-li-online` → delivered, `channel: online`
- `elm-mulch-natural-li-local` → pickup at 110 Frowein Rd, `channel: local`

For Eastern LM these are the same price (same mulch), so we could use a single multi-channel offer. BUT: pickup has 5% Pro discount for contractors (per your memory) — that's a price delta, which triggers the split requirement. **Schema supports both; default to split** to stay safe.

### 5.3 Products that should NOT be fed

- Anything `delivery_type = 'non-bulk'` with placeholder images
- Triple ground mulch (20yd minimum, by request only — not a standard product per your rules)
- Anything `is_active = false`
- Anything without an approved image

Feed agent filters these in the sync query, doesn't even attempt an upload.

### 5.4 Alternative: Website-reported Autofeeds

Google StoreBot can crawl the site to auto-populate in-store inventory instead of API pushes. This is simpler but crawl-rate-limited. Recommendation: use API feed as source of truth (deterministic, instant updates on price/availability changes), not autofeed.

---

## 6. Campaign strategy (Phase 01 scope depends on D3)

### 6.1 If Search + PMax (recommended default)

**Search campaigns — one per material category:**
- `ELM-Search-Mulch` → keywords: "mulch delivery long island", "mulch near me suffolk county", "natural mulch delivered", "black mulch long island"
- `ELM-Search-Topsoil` → "topsoil delivery", "screened topsoil long island", "topsoil near me"
- `ELM-Search-Gravel` → "gravel delivery long island", "pea gravel suffolk county", "rca delivered"
- `ELM-Search-Stone` → "bluestone delivery", "crushed bluestone long island", "decorative stone delivered"
- `ELM-Search-Sand` → "mason sand delivery", "concrete sand near me"

Shared negative keyword list: `bagged, pickup-only, free, wholesale, commercial-only, playground-safe-certified`

Bidding: **Maximize Conversions with Target CPA**. Initial TCPA = avg order value × 0.15. So if AOV = $400, TCPA = $60.

**Performance Max — one campaign, all products:**
- `ELM-PMax-All-Products` → fed by GMC feed, Google picks surfaces (Search, YouTube, Display, Gmail, Maps)
- Asset groups: one per material category for creative relevance
- Geographic targeting: 50-mile radius around Center Moriches
- Exclusions: brand name (to not cannibalize direct search)

### 6.2 If PMax only (simpler)

Skip Search. Single PMax campaign driven entirely by feed + asset groups. Faster to launch but less keyword control — you can't block specific search terms.

### 6.3 If Search + PMax + LIA (fullest)

Adds Local Inventory Ads which requires:
- GBP verified and linked (Adam: is this done?)
- Physical store entity in GMC with store code
- Pickup offered (you do — yard pickup)
- Pickup method attribute on local offers

LIA adds pickup to the Google Maps + "near me" surfaces. Worth it but adds ~2 weeks to launch.

---

## 7. Agent decomposition

Three specialized agents slot into the 8-agent framework. Each runs in its own BullMQ worker process.

### 7.1 `googleAdsFeedAgent`

**Job:** keep GMC product data in sync with Supabase.

**Triggers:**
- Cron every 4 hours (full sync)
- Webhook on `products` table change via Supabase Realtime (incremental)
- Manual "Sync now" button in admin UI

**Inputs:** `brand_id`
**Output:** row updates to `mktg_google_products` + GMC offer writes

**Core flow:**
```
1. SELECT products WHERE is_active AND delivery_type='bulk' AND brand_id = ?
2. For each product:
   - Build GMC offer payload (title, price, availability, images, shipping)
   - If channel='online' + 'local' both needed → build 2 payloads
   - Lookup existing mktg_google_products row
   - If exists: Merchant API products.update (partial patch)
   - If not: Merchant API products.insert
   - Update mktg_google_products with status + timestamp
3. Log summary: N synced, M errors, list of disapprovals
```

**Error handling:** Disapprovals go to `mktg_google_products.disapproval_reason` and surface in admin UI feed status panel. Not a recommendation — needs human to fix source data.

### 7.2 `googleAdsCampaignAgent`

**Job:** create/modify campaigns, ad groups, keywords, ads on command from admin UI or optimizer.

**Triggers:**
- Admin UI action (create campaign, pause campaign, adjust budget)
- Approved recommendation from optimizer agent

**Inputs:** `brand_id`, operation intent (create/update/pause/delete), entity details

**Core flow:**
```
1. Load brand credentials
2. Verify publish_mode permits writes:
   - read_only → reject
   - suggest → allowed only if human-approved recommendation
   - auto → allowed within budget_cap
3. Execute Google Ads API mutation via google-ads-api client
4. Mirror result to mktg_google_campaigns table
5. Return success + entity ID to caller
```

**Guardrails:**
- Hard budget cap check before any budget-increasing mutation
- No destructive ops (delete) without explicit UI confirmation
- All writes logged to `mktg_agent_actions` audit table (shared across marketing agents)

### 7.3 `googleAdsOptimizerAgent`

**Job:** analyze performance, emit recommendations.

**Triggers:** cron daily 6 AM (after performance pull at 5 AM completes)

**Inputs:** `brand_id`, date range (default: trailing 7 days vs prior 7 days)

**Core flow:**
```
1. Query mktg_google_performance for trend analysis per campaign:
   - ROAS up/down
   - CPA vs target
   - Impression share lost to budget vs rank
   - Search term report → high-spend zero-conversion terms
2. Apply rules:
   - Campaign with ROAS > 4× and impression share < 60% due to budget → PROPOSE budget +20%
   - Campaign with CPA > 2× target for 7 days → PROPOSE pause or TCPA adjust
   - Search term with >$20 spend, 0 conversions, 14 days → PROPOSE add as negative
   - Campaign with 0 impressions 7 days → PROPOSE increase TCPA or check disapprovals
3. Where publish_mode = 'suggest': INSERT into mktg_google_recommendations
4. Where publish_mode = 'auto' AND confidence > 0.8 AND within budget cap:
     → enqueue googleAdsCampaignAgent with approved change
     → INSERT recommendation row with status='auto_applied'
5. Email summary to admin (count of suggestions pending)
```

**Confidence scoring:** heuristic based on data volume (impressions, days of data). Rules with <14 days data or <100 impressions get confidence <0.5 → never auto-applied regardless of mode.

---

## 8. Closing the loop — offline conversions

Without this, Google's Smart Bidding optimizes for form fills, not revenue. Adds real conversion value back to Google.

### 8.1 GCLID capture (easternLM repo)

- Middleware reads `?gclid=` from landing URL → writes to session cookie
- Checkout flow reads cookie → stores on `orders.gclid` at order creation
- Already a column on orders; need the capture code

### 8.2 Conversion upload (elm-marketing repo)

Cron every 15 minutes, job `google-conversion-upload`:
```
1. SELECT orders WHERE status='paid' AND gclid IS NOT NULL
                     AND id NOT IN (SELECT order_id FROM mktg_google_conversions_uploaded)
2. For each: upload to Google Ads via ConversionUploadService.uploadClickConversions
   - conversion_action = "Website Order" (created in Phase 00)
   - conversion_date_time = order.paid_at
   - conversion_value = order.total_cents / 100
   - currency_code = "USD"
3. INSERT mktg_google_conversions_uploaded on success
```

**Why 15min, not realtime:** Google dedupes on GCLID + conversion_action + timestamp; small batch is efficient and safe.

---

## 9. Admin UI — Marketing tab (easternLM repo)

Route: `/admin/marketing` (gated by admin role)

**Tabs inside:**
1. **Overview** — spend this month, conversions, ROAS, top campaigns (Recharts, matching existing analytics patterns)
2. **Accounts** — connect/disconnect Google, per-brand publish_mode toggle, monthly cap editor
3. **Product Feed** — sync status per product (approved / pending / disapproved), last synced, manual "Sync now" button, disapproval details
4. **Campaigns** — list of campaigns with inline budget/status edits, "New campaign" wizard
5. **Recommendations** — pending optimizer suggestions with Approve / Reject buttons, history of applied changes
6. **Conversions** — upload status, GCLID capture rate (% of orders with GCLID vs without)

Component pattern: matches existing admin layout (shadcn/ui, same two-panel list+detail pattern as Admin Orders rebuild from session 4).

---

## 10. Cron jobs (VPS)

Add to existing crontab:
```
*/15 * * * *  elm-marketing  google-conversion-upload
0 */4 * * *   elm-marketing  google-feed-sync
5 5 * * *     elm-marketing  google-performance-pull
0 6 * * *     elm-marketing  google-optimize
0 */12 * * *  elm-marketing  google-token-refresh
```

Matches existing pattern (RingCentral token renewal, Supabase keepalive, follow-up sequences).

---

## 11. Phased build plan (handoff to build-prompter)

This spec is LOCKED. `build-prompter` generates operator prompts for each phase.

| Phase | Scope | Est. turns | Dependencies |
|---|---|---|---|
| 00 | **Foundation & Google plumbing** — env vars, encrypted cred storage, OAuth flow, Phase 00 API bootstrap (creates conversion actions "Website Order" + "Quote Submit" via Google Ads API, creates GMC store entity `ELM-FROWEIN-01` via Merchant API `accounts.omnichannelSettings` + `accounts.lfpStores`, seeds `mktg_google_accounts` row) | 20 | OAuth client created in Cloud Console (Adam) |
| 01 | **Schema + OAuth UI** — all `mktg_google_*` tables, RLS, `orders.gclid` ALTER TABLE, admin OAuth connect/disconnect flow | 20 | Phase 00 |
| 02a | **`googleAdsFeedAgent`** — Merchant API v1 product sync, emits both `channel='online'` and `channel='local'` offers per product, disapproval reporting | 30 | Phase 01, Misrepresentation cleared |
| 02b | **`googleAdsCampaignAgent` read path** — list/read campaigns, ad groups, keywords, populate `mktg_google_campaigns` on schedule, BullMQ worker scaffolding | 25 | Phase 01 (parallel with 02a) |
| 02c | **LIA configuration + Local campaign scaffolding** — `OmnichannelSettings` fully configured per Merchant API v1 patterns, LIA-specific feed attributes (`pickup_method`, `pickup_sla`) on local offers, inventory verification submission, Local Inventory ad campaign create (paused) | 20 | Phase 02a (uses local channel offers) |
| 03 | **`googleAdsCampaignAgent` write path** — create/update/pause mutations, publish_mode guardrail enforcement, monthly_budget_cap check, `mktg_agent_actions` audit table writes, launch Search + PMax campaigns for each material category (paused until admin approves) | 25 | Phase 02b |
| 04 | **Performance ingestion + Overview UI** — daily 5am GAQL pull into `mktg_google_performance`, Recharts dashboards (spend, conversions, ROAS, top campaigns) in admin Marketing tab Overview | 20 | Phase 02b |
| 05 | **`googleAdsOptimizerAgent` + recommendations queue** — nightly analysis, rule engine, confidence scoring, `mktg_google_recommendations` population, approval UI with Approve/Reject, approved recs enqueue back to campaign agent | 35 | Phase 04, Phase 03 |
| 06 | **Offline conversion upload** — GCLID middleware capture in easternLM, cookie persistence through checkout, 15-min cron upload to Google Ads via `ConversionUploadService`, dedup via `mktg_google_conversions_uploaded` | 20 | Phase 00 (conversion actions), Phase 01 (GCLID column) |
| 07 | **Admin UI polish** — all Marketing tab tabs functional (Overview / Accounts / Feed / Campaigns / Recommendations / Conversions), per-brand budget cap editor, publish_mode toggle, manual sync buttons | 25 | Phases 03, 04, 05 |
| 08 | **Playwright E2E + documentation** — OAuth connect flow test, feed sync happy path, campaign create/pause, recommendation approve-then-apply, GCLID capture end-to-end | 15 | Phase 07 |

**Estimated total: 10–12 Claude Code sessions** for phases 00–08.

**Parallelism:**
- Phases 02a and 02b run in parallel (different APIs, different tables)
- Phase 02c depends on 02a (needs local offers to exist)
- Phase 04 runs parallel with 03 (04 reads, 03 writes — separate endpoints)
- Phase 06 runs parallel with 03/04/05 (only depends on 00+01)

---

## 12. Prerequisites status (as of lock date)

**Completed / confirmed:**
- ✅ Google Merchant Center account `5578269156` — domain `easternlm.com` verified + claimed
- ✅ Google Business Profile verified + linked to GMC (admin: `adam@easternbuilding.supply`)
- ✅ Google Ads CID `540-952-6270` exists + linked to GMC
- ✅ Developer token `ATXQta_xxxxx` (Basic Access, 15K ops/day)

**In progress (non-blocking through Phase 01, blocks Phase 02a going live):**
- 🟡 GMC Misrepresentation flag — under Google review. Likely root cause: missing `/returns`, `/terms`, `/privacy` pages linked from footer. Fix content deployed during Phase 01 window. Re-request review when ready

**Adam must complete before Phase 00 operator prompt runs:**
- ❌ Google Cloud Console project `elm-marketing` — enable Google Ads API + Merchant API
- ❌ OAuth 2.0 Web Application client in that project — authorized redirect URI `https://easternlm.com/api/marketing/google/oauth/callback`
- ❌ Store `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET` in VPS env vars

**Created programmatically by Phase 00 operator prompt:**
- GMC physical store entity `ELM-FROWEIN-01` (via Merchant API `accounts.lfpStores.create`)
- `OmnichannelSettings` for US/LIA program (via Merchant API `accounts.omnichannelSettings.create`)
- Conversion action "Website Order" (Purchase, order total, data-driven attribution, 30d window)
- Conversion action "Quote Submit" (Submit Lead Form, $0 value, PMax audience signal only)
- `MKTG_ENCRYPTION_KEY` generated + stored
- Seed row in `mktg_google_accounts` for `brand_id='eastern-lm'`

**Deferred (post-launch, separate prompt):**
- MCC creation + CID migration (triggered when MyGravelGuy goes live)
- GoDaddy Partner MCA cleanup (harmless, ignore)
- Google Pay / BNPL badge configuration in GMC (CTR uplift, v2)
- Standard Access token upgrade (when 15K ops/day becomes a ceiling)

---

## 13. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Basic Access 15K ops/day exceeded as MCC grows | Medium (12 months out) | Monitor daily op count in agent logs; apply for Standard Access proactively |
| Agent auto-pauses a winning campaign on bad data | Low in suggest, medium in auto | Confidence threshold + 14-day min data window + hard budget cap |
| Refresh token revoked by user re-auth elsewhere | Medium | Connect-flow runs idempotently; admin UI surface "reconnect" state on 401 |
| GMC disapprovals block feed | High (first sync) | Feed agent surfaces per-offer status; admin UI shows disapproval reasons with links to GMC diagnostics |
| Content API dependencies creep in | High if using old tutorials | Explicit ban in CLAUDE.md: "Merchant API v1 only. Content API is sunset." |
| GCLID capture rate too low to train Smart Bidding | Medium | Fallback: upload enhanced conversions (hashed email/phone) alongside GCLID conversions |
| Cost overrun in auto mode | Medium | Hard monthly_budget_cap_cents check before every budget mutation; alert at 75% |

---

## 14. Not in scope (v1)

- Meta Ads / Facebook Pixel integration (separate agent, later)
- Microsoft Ads (Bing)
- Google Analytics 4 integration beyond conversion upload
- Automated ad copy generation (creative AI) — Product Studio API integration is a v2 feature
- Bid adjustments by device, time-of-day, audience segment (optimizer v2)
- Keyword planner / new keyword discovery (optimizer v2)
- Competitor ad monitoring
- Ad copy A/B testing framework

---

*🔒 Spec LOCKED April 16, 2026 — ready for build-prompter handoff. Companion SOW: `elm-google-ads-sow.md`.*
