# Phase 02a — Feed Agent (Merchant API)

**Role:** Claude Code, Phase 02a of 11.
**Spec:** `elm-google-ads-spec-LOCKED.md` (🔒).
**SOW:** `elm-google-ads-sow.md`.
**Depends on:** Phase 01 PROMOTEd. Can run in **parallel with Phase 02b** on branch `feature/marketing-02a`.
**Max turns:** 35 (resume with `--continue`).
**Branch:** `feature/marketing-02a` on `elm-marketing`.
**Reports to:** `PHASE-02A-COMPLETION-REPORT.md` + `PHASE-02A-PROGRESS.md`.

---

## 1. Mission

Build `googleAdsFeedAgent` — the first agent in the marketing engine that writes to a Google API. It keeps Google Merchant Center in sync with Supabase's `products` table. Every active bulk product becomes a GMC offer; every update in Supabase propagates to GMC within ≤4 hours via scheduled sync, and immediately on manual trigger.

**The hard constraint:** every product feeds both a `channel='online'` offer AND a `channel='local'` offer, per March 2026 multi-channel split rule. Same product ID, different offer IDs in GMC.

This phase is feed-only. **No campaign creation, no performance queries, no LIA-specific attributes yet** (those come in 02c).

---

## 2. Diagnostic-first (MANDATORY)

1. Read `elm-google-ads-spec-LOCKED.md` §5 (feed strategy) completely — every sub-section. §5.1 is the offer payload spec, §5.2 is the online/local split, §5.3 is filters.
2. Inspect `easternLM` `products` table schema live — confirm columns exist: `id`, `name`, `slug`, `category_id`, `delivery_type`, `material_class`, `price_per_unit_cents`, `unit`, `unit_display`, `description`, `images`, `is_active`, `is_taxable`, `recommended_uses`, `pairs_well_with`. Note any drift from spec.
3. Inspect `categories` table — confirm badge rules fields available (from memory: Mulch → "Processed locally"; soil/LI gravel/sand → "Locally sourced"; crushed/decorative stone → no badge). Determine how current schema represents this. May need a `feed_badge` column on `categories` or hardcoded mapping.
4. Query live product catalog — count active bulk products. Sample 3 and note current image URLs, descriptions. Confirm no placeholder images on products expected to feed (§5.3 filter: skip products with placeholder images).
5. Verify Phase 01 seed row populated: `mktg_google_accounts` has connected account for `brand_id='eastern-lm'` with valid `refresh_token_encrypted`, `merchant_id='5578269156'`.
6. Check Merchant API disapproval status on GMC — Adam flagged Misrepresentation in review. If still flagged on run day, feed sync will show uploads succeeding but products in "disapproved" state. Note this in progress report; it's not a builder bug.
7. Report findings in turn 1 before implementation.

---

## 3. Context

### 3.1 Product filter (§5.3 of spec — what gets fed vs skipped)

**Feeds GMC:**
- `is_active = true`
- `delivery_type = 'bulk'`
- Has at least one real image (not placeholder URL — define placeholder detection: `images[0]` contains `'placeholder'` or is a Supabase default)

**Does NOT feed GMC (filter in SELECT query, don't even attempt):**
- Triple-ground mulch (20yd minimum, by-request only — per Adam's enforced business rules)
- `is_active = false`
- Any product missing images
- Non-bulk products (v1 scope; may add later)

### 3.2 Offer ID convention

```
{brand}-{slug}-{channel}
e.g., elm-natural-li-mulch-online
       elm-natural-li-mulch-local
       elm-hamptons-chocolate-brown-online
       elm-hamptons-chocolate-brown-local
```

Stable, predictable, idempotent. Stored in `mktg_google_products.gmc_offer_id`.

### 3.3 Offer payload (§5.1 of spec — exact structure)

For each product → build TWO offers:

```ts
// channel='online' offer
{
  offerId: 'elm-natural-li-mulch-online',
  contentLanguage: 'en',
  feedLabel: 'US',
  channel: 'online',
  title: 'Natural Long Island Mulch — Delivered by the Cubic Yard',
  description: buildDescription(product),  // §5.1 template; respects copy rules
  link: `https://easternlm.com/shop/${product.slug}`,
  imageLink: product.images[0],
  additionalImageLinks: product.images.slice(1, 10),
  availability: 'in_stock',
  condition: 'new',
  price: {
    amountMicros: String(product.price_per_unit_cents * 10000),
    currencyCode: 'USD',
  },
  // NO unitPricingMeasure — GMC has no cubic yard unit; title carries "per cubic yard"
  shipping: [{
    country: 'US',
    region: 'NY',
    service: 'Dump Truck Delivery',
    price: { amountMicros: '0', currencyCode: 'USD' },  // delivery calc at checkout
  }],
  brand: 'Eastern Landscape & Mason Supply',
  identifierExists: false,  // bulk has no GTIN/MPN
  productTypes: [buildProductType(product)],  // e.g. 'Landscape Materials > Mulch > Natural'
  googleProductCategory: getGoogleCategory(product.category),
  shippingLabel: product.material_class === 'mulch' ? 'Mulch' : 'Material',
}

// channel='local' offer — same as above EXCEPT:
{
  ...onlineOffer,
  offerId: 'elm-natural-li-mulch-local',
  channel: 'local',
  // Phase 02c will add: pickup_method, pickup_sla
}
```

### 3.4 Copy rules — ENFORCE IN CODE

From spec §13 risks + Adam's locked business rules:

| Rule | Enforcement |
|---|---|
| "per cu. yard" (never "/yd") | Title template includes literal `"by the Cubic Yard"` |
| "cu yds" for units | Never used in feed (no unit pricing); still enforce in description |
| "Locally sourced" / "Processed locally" per badge rules | Description builder uses category badge lookup |
| Never "Responsibly sourced" | Forbidden string check in description builder tests |
| No founding-year claims | Forbidden regex check: `/\d+\s*(years?|yrs?)\s+(in business|serving)/i` |
| Mulch = double ground, not triple | Hardcoded in mulch description template |
| Natural LI mulch copy | Reference: spec § (Adam's memory rules) |
| Bluestone origin story | "From the mountains of upstate NY" in description |
| Concrete sand chicken coops reference | In description |
| Mason sand paver/pool/playground/volleyball reference | In description |

**Implementation:** centralize in `src/agents/feed/description-builder.ts`. Every rule is a pure function. Write vitest unit tests that attempt to feed forbidden strings and assert they're stripped or replaced.

### 3.5 Sync loop contract

```
Trigger (cron every 4hr | Realtime event | manual UI button)
  ↓
Enqueue BullMQ job { brandId: 'eastern-lm' } to queue 'google-feed-sync'
  ↓
Worker picks up, runs googleAdsFeedAgent.sync(brandId):
  1. Load all active bulk products via Supabase query (filter §3.1)
  2. Load existing mktg_google_products rows for this brand
  3. For each product, for each channel in ['online', 'local']:
     a. Build offer payload
     b. If row exists in mktg_google_products:
          → Call merchant.products.update (partial patch)
          → UPDATE mktg_google_products SET last_synced_at, last_sync_status
        Else:
          → Call merchant.products.insert
          → INSERT mktg_google_products row
  4. For each mktg_google_products row NOT in current product set (deleted/deactivated):
       → Call merchant.products.delete
       → DELETE mktg_google_products row
  5. After all writes: fetch product statuses in bulk (productStatuses.list)
     → UPDATE mktg_google_products with last_sync_status, disapproval_reason
  6. Write mktg_agent_actions audit row: agent='googleAdsFeedAgent', action='sync',
     payload={count: N, inserted: M, updated: K, deleted: D, disapproved: X}
  7. Return summary
```

### 3.6 Triggers

Three entry points:

**A. Cron every 4 hours** — `0 */4 * * *`:
```
/usr/bin/node /app/dist/cron/trigger-feed-sync.js
```
Script enqueues the job and exits. Worker lives in the long-running `elm-marketing` service.

**B. Supabase Realtime on `products` table** — optional, can be added later. For Phase 02a: skip real-time; scheduled + manual is enough.

**C. Manual trigger** — POST endpoint `elm-marketing:3300/internal/feed-sync` (protected by service-to-service auth header `X-Internal-Token`, value = `INTERNAL_SERVICE_TOKEN` env var). easternLM admin UI calls this from the "Sync now" button — Phase 07 wires the button; Phase 02a just exposes the endpoint.

### 3.7 BullMQ setup (first use in `elm-marketing`)

```
Queue name: 'google-feed-sync'
Redis key prefix: 'elm:' (already set in shared Redis client)
Concurrency: 1 (serial per brand — avoids rate limit collisions)
Attempts: 3 with exponential backoff (starting 30s, max 5m)
Retry only on transient errors (429, 5xx)
Non-retryable: 401 (auth — page to admin), 403 (scope missing — page to admin), 400 (payload error — log + fail)
Job TTL: 1hr (no reason to retry older than that; next cron handles it)
```

---

## 4. Tasks (ordered)

### 4.1 BullMQ infrastructure scaffold

First time BullMQ is used in this repo. Create:
- `src/queue/redis.ts` — shared ioredis instance (reuse existing from Phase 01)
- `src/queue/queues.ts` — BullMQ queue definitions; export `googleFeedSyncQueue`
- `src/queue/workers/base.ts` — helper to standardize worker error handling + audit logging
- `src/workers/google-feed-sync.worker.ts` — actual worker process
- Update `src/index.ts` — starts the worker on service boot

Worker runs in the same container as the main service (not separate container). Docker healthcheck stays on the HTTP port.

### 4.2 Merchant API v1 client wrapper

`src/google/merchant-products.ts`:
```ts
export class MerchantProductsClient {
  constructor(private brandId: string) {}

  async insert(offer: Offer): Promise<InsertResult>
  async update(offerId: string, patch: Partial<Offer>): Promise<UpdateResult>
  async delete(offerId: string): Promise<void>
  async listStatuses(offerIds: string[]): Promise<ProductStatus[]>
}
```

Use `@google-cloud/merchant-products` package. Authenticate via `getAccessToken(brandId)` from Phase 01's `src/auth/google.ts`.

**Error handling:** Map Google API errors to typed errors the agent can branch on:
- `MerchantApiAuthError` (401) — refresh token invalid; alert + skip
- `MerchantApiScopeError` (403) — reconnect needed; alert + skip
- `MerchantApiPayloadError` (400) — log full payload + response; mark product as `last_sync_status='invalid'`
- `MerchantApiRateLimitError` (429) — trigger BullMQ retry
- `MerchantApiServerError` (5xx) — trigger BullMQ retry

### 4.3 Description builder + copy-rule enforcer

`src/agents/feed/description-builder.ts`:
```ts
export function buildDescription(product: Product, category: Category): string {
  const badge = getCategoryBadge(category.slug);   // 'Locally sourced' | 'Processed locally' | null
  const recommended = product.recommended_uses.join(', ');
  const pairs = product.pairs_well_with?.length
    ? ` Pairs well with: ${product.pairs_well_with.join(', ')}.`
    : '';

  let desc = [
    product.description,                            // source of truth
    badge ? `${badge}.` : '',
    recommended ? `Recommended for: ${recommended}.` : '',
    pairs,
    'Delivered by dump truck throughout Suffolk County. Sold by the cubic yard.',
  ].filter(Boolean).join(' ');

  return stripForbiddenPhrases(desc);
}

function stripForbiddenPhrases(text: string): string {
  // Hard rules from §3.4
  text = text.replace(/responsibly\s+sourced/gi, 'Locally sourced');
  text = text.replace(/\d+\s*\+?\s*(years?|yrs?)\s+(in business|serving|of service|experience)/gi, 'Family-owned');
  text = text.replace(/triple[-\s]ground/gi, 'double-ground');
  text = text.replace(/\/yd\b/g, ' per cu. yard');
  return text.trim();
}
```

Tests assert these transformations. Also test per-category outputs match Adam's copy rules (bluestone mentions upstate NY, concrete sand mentions chicken coops, etc.).

### 4.4 Offer builder

`src/agents/feed/offer-builder.ts`:
```ts
export function buildOffers(product: Product, category: Category, channel: 'online' | 'local'): Offer {
  // All the logic from §3.3 of this prompt + §5.1 of spec
  // Returns single offer object
}
```

Include `googleProductCategory` lookup — use Google's taxonomy:
- Mulch → `Home & Garden > Lawn & Garden > Gardening > Mulch` (ID 2962)
- Topsoil → `Home & Garden > Lawn & Garden > Gardening > Soils` (ID 2988)
- Gravel/stone → `Business & Industrial > Construction > Building Materials > Aggregates` (ID 500116)
- Sand → same as aggregates

Hardcode the mapping in `src/agents/feed/google-taxonomy.ts` — don't fetch at runtime.

### 4.5 Agent orchestrator

`src/agents/googleAdsFeedAgent.ts`:
```ts
export class GoogleAdsFeedAgent {
  async sync(brandId: string): Promise<SyncSummary> {
    // Full loop from §3.5
    // Returns counts + list of disapprovals for audit
  }
}
```

**Batching:** Merchant API supports batch via `productsBatch.batch()`. For Phase 02a, start with one-at-a-time for simplicity; log timing; if sync takes >5 min for 20 products, switch to batch in follow-up. Don't optimize prematurely — you're syncing maybe 15–25 products.

**Idempotency:** Full sync replays safely. If you run it twice in a row, second run should report `0 inserted, 0 updated, 0 deleted, N no-op` (or minor updates on `last_synced_at` only).

### 4.6 Worker wiring

`src/workers/google-feed-sync.worker.ts`:
```ts
new Worker('google-feed-sync', async (job) => {
  const { brandId } = job.data;
  const agent = new GoogleAdsFeedAgent();
  const summary = await agent.sync(brandId);
  return summary;
}, { connection, concurrency: 1 });
```

Audit write happens inside agent — worker just returns.

### 4.7 Cron trigger

`src/cron/trigger-feed-sync.ts`:
```ts
// Minimal script — enqueues job and exits
await googleFeedSyncQueue.add('sync', { brandId: 'eastern-lm' }, {
  removeOnComplete: 100,   // keep last 100 for debug
  removeOnFail: 500,
});
process.exit(0);
```

Add to VPS crontab (in elm-marketing container or host):
```
0 */4 * * * /usr/bin/node /app/dist/cron/trigger-feed-sync.js
```

### 4.8 Manual sync endpoint

`src/routes/internal/feed-sync.ts`:
```ts
// POST /internal/feed-sync
// Requires X-Internal-Token header matching INTERNAL_SERVICE_TOKEN env
app.post('/internal/feed-sync', requireInternalToken, async (req, res) => {
  const { brandId } = req.body;
  const job = await googleFeedSyncQueue.add('manual-sync', { brandId });
  res.json({ jobId: job.id });
});
```

### 4.9 Disapproval surfacing (data only — UI in Phase 07)

When `productStatuses.list` returns disapprovals, parse the `issues[]` array. Extract:
- Top-level `destinationStatuses[].destination` (e.g., `'FreeListings'`, `'Shopping'`)
- `issues[].code`, `issues[].description`, `issues[].attribute`

Store in `mktg_google_products`:
- `last_sync_status`: `'approved' | 'pending' | 'disapproved'`
- `disapproval_reason`: JSON-stringified issue summary

Phase 07 renders this. Phase 02a just records it accurately.

### 4.10 Observability

- Structured logs (pino): log level `info` for sync summaries, `warn` on disapprovals, `error` on auth/scope errors
- Log lines MUST NOT include: refresh tokens (never), access tokens (never), full product payloads (sample only)
- Prometheus metrics (if easy): `google_feed_sync_total{result=success|error}`, `google_feed_products_synced_count`, `google_feed_disapprovals_count`. If metrics harness doesn't exist in `elm-marketing` yet, skip — Phase 04 may add observability.

### 4.11 Tests

Unit (vitest):
- Description builder: every copy rule from §3.4 has a test asserting forbidden strings are stripped
- Offer builder: online + local offers generated correctly, offer IDs match convention, `googleProductCategory` set correctly for each material class
- Taxonomy lookup returns correct category ID for each known slug
- Agent skips products with placeholder images
- Agent skips products where `is_active=false`
- Agent queries only `delivery_type='bulk'`

Integration (vitest, against staging Merchant API):
- Seed 2 test products in staging Supabase → run agent → assert 4 offers in GMC (2 products × 2 channels)
- Run agent again → assert 0 inserts, 0 deletes (idempotent)
- Deactivate 1 product → run agent → assert 2 offers removed from GMC (both channels)

E2E deferred to Phase 08.

### 4.12 CLAUDE.md additions

```markdown
## Phase 02a additions

- Feed sync is the ONLY job writing to Merchant API in this phase. Do not add Google Ads writes here.
- Every product → 2 offers (online + local). Never single-channel unless D1 changes.
- Offer ID: `{brand}-{slug}-{channel}`. Stable across runs.
- Copy rules enforced in description-builder.ts. Add new rules there, never inline.
- Disapprovals stored in mktg_google_products.disapproval_reason. Rendering is Phase 07's job.
- BullMQ queue name: 'google-feed-sync'. Concurrency 1. Serial per brand.
- Full sync is idempotent. Running twice is safe and should be effectively a no-op the second time.
```

---

## 5. Acceptance criteria

1. ✅ Agent syncs all active bulk products from staging → GMC; counts match expected (15–25 products → 30–50 offers)
2. ✅ Offer IDs follow `{brand}-{slug}-{channel}` convention consistently
3. ✅ Each product has both `channel='online'` and `channel='local'` offers in GMC
4. ✅ `mktg_google_products` table populated with one row per (product, channel); `last_synced_at` recent
5. ✅ Running sync twice in a row on unchanged data → 0 inserts, 0 deletes; `last_synced_at` updated (no-op equivalent)
6. ✅ Deactivating a product and re-running sync → both channel offers removed from GMC; rows deleted from `mktg_google_products`
7. ✅ Disapproved products get `last_sync_status='disapproved'` with `disapproval_reason` populated (test by intentionally passing a bad field, verify error capture)
8. ✅ Copy rules: unit tests for every rule in §3.4 pass; grep check on live feed descriptions for forbidden strings returns empty
9. ✅ BullMQ worker runs, survives restart, picks up pending jobs from queue after restart
10. ✅ Cron triggers sync every 4 hours (verify by observing job history in Redis + `mktg_agent_actions` row)
11. ✅ Manual endpoint responds 401 without token, 202 with valid token + jobId returned
12. ✅ No Content API imports (grep -r check)
13. ✅ No plaintext access/refresh tokens in logs (grep check on rotated logs)
14. ✅ Full audit row in `mktg_agent_actions` for every sync run with counts
15. ✅ Agent handles auth errors gracefully: invalid refresh token → sets row `last_sync_status='auth_error'`, writes audit row with status='error', exits without retry storm

---

## 6. Scope boundaries — DO NOT DO

- ❌ LIA-specific attributes (`pickup_method`, `pickup_sla`) — Phase 02c adds these
- ❌ Any Google Ads campaigns, ad groups, or keywords — Phase 02b/03
- ❌ Performance data queries — Phase 04
- ❌ Recommendations — Phase 05
- ❌ Supabase Realtime triggers (can add later)
- ❌ UI for viewing sync status or disapprovals — Phase 07
- ❌ Multiple brand syncs — only `brand_id='eastern-lm'` exists yet
- ❌ Optimization (batch calls, parallel channels) unless a single-product sync takes >30s — don't premature-optimize

---

## 7. Risk callouts

The Misrepresentation flag on GMC is under Google review at build time (per progress tracker). If still active:
- Products WILL upload successfully (Merchant API accepts the insert)
- Products WILL be marked `disapproved` in product status with reason related to account-level policy
- This is NOT a bug in the feed agent. Document in completion report and surface in admin UI once Phase 07 exists.

---

## 8. Orchestration

Session start: `claude --max-turns 35` + paste this file.
Resume: `claude --continue`.
Completion: write completion report, push branch, stop.

If Phase 02b is running in parallel on `feature/marketing-02b`, no merge conflicts expected — 02a only touches `src/agents/feed/`, `src/google/merchant-*`, `src/workers/google-feed-*`, and the queue scaffolding (new files). If conflicts appear, coordinate with 02b author before merging.

---

## 9. Review

Reviewer checks all 15 acceptance criteria. Special attention:
- G1 (no Content API), G4 (audit writes), G5 (no plaintext tokens in logs), G7 (brand_id parameterization), G8 (copy rules)
- Spec §5.1 offer payload structure adherence
- Spec §5.3 filter logic adherence
- Idempotency of full sync

Verdict: `PROMOTE` → unblocks 02c · `FIX` → re-run with fix instructions · `ESCALATE` → Adam decides (likely if Google quota or RMF concerns surface).

---

*Phase 02a · April 16, 2026 · ~35 turn budget · Paste-ready.*
