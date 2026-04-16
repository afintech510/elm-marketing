# Phase 06 — GCLID Capture & Offline Conversion Upload

**Role:** Claude Code, Phase 06 of 11.
**Spec:** `elm-google-ads-spec-LOCKED.md` (🔒).
**SOW:** `elm-google-ads-sow.md`.
**Depends on:** Phase 00 PROMOTEd (conversion actions created), Phase 01 PROMOTEd (`orders.gclid` column exists). Can run **in parallel with Phase 03, 04, 05** — no shared code paths.
**Max turns:** 25 (resume with `--continue`).
**Branches:** `feature/marketing-06` on both `easternLM` and `elm-marketing`.
**Reports to:** `PHASE-06-COMPLETION-REPORT.md` + `PHASE-06-PROGRESS.md`.

---

## 1. Mission

Close the attribution loop. Every paid click from Google Ads arrives with a `?gclid=` URL param — capture it in session cookie, persist to `orders.gclid` at checkout, and every 15 minutes upload paid orders back to Google Ads as offline conversions tied to the `CONVERSION_ACTION_PURCHASE` created in Phase 00. Without this, Google's Smart Bidding learns from form submits rather than revenue; PMax can't optimize for ROAS with signal; campaign agent's R1/R2/R5 rules have no conversion data to act on.

Two halves: the capture side lives in `easternLM` (middleware + checkout), the upload side lives in `elm-marketing` (worker). Both touch production user flow, so careful.

---

## 2. Diagnostic-first (MANDATORY)

1. Read `elm-google-ads-spec-LOCKED.md` §8 (offline conversions), §4 (`mktg_google_conversions_uploaded` table).
2. Inspect `easternLM/src/middleware.ts` — existing middleware (if any). Understand what runs on every request.
3. Inspect `easternLM` checkout flow — find where `orders` row is created (Stripe webhook handler? checkout API?). The session cookie → `orders.gclid` persistence hooks in there.
4. Verify `orders.gclid` column exists (Phase 01 added it). Query schema.
5. Verify Phase 00 created `CONVERSION_ACTION_PURCHASE` — resource name on VPS env `CONVERSION_ACTION_PURCHASE`. Smoke test: load from env, query Google Ads via Phase 02b's reader → confirm action exists, status ENABLED.
6. Check existing traffic for GCLID param — sample recent `referrer` fields or analytics; estimate baseline capture rate (probably 0% currently).
7. Report findings in turn 1.

---

## 3. Context

### 3.1 GCLID fundamentals

- Google Click Identifier — a token like `Cj0KCQiAhs79BRD0ARIsAC6XpaU...`
- Appended to landing page URL when user clicks a Google Ads ad
- Lives 90 days default (Google's click-through-lookback-window on conversion action from Phase 00)
- Must be captured on first landing and persisted through the entire purchase journey, even across sessions and days
- Uploaded with conversion data via `ConversionUploadService.uploadClickConversions`

### 3.2 Capture strategy — cookie-first

```
User lands on any easternlm.com page with ?gclid=<token>
  ↓
Middleware reads query param, sets secure HttpOnly cookie:
  Name: elm_gclid
  Value: <token>
  Expires: 90 days
  SameSite: Lax
  Secure: true (prod)
  HttpOnly: true
  Path: /
  ↓
Middleware strips ?gclid= from URL (redirects to clean URL, preserves other params)
  ↓
All subsequent pageviews: cookie available
  ↓
At checkout, cart data (server-side) reads cookie → writes to orders.gclid
  ↓
Webhook confirms payment, orders.status='paid' → eligible for upload
  ↓
Every 15 min: upload worker picks up paid orders with gclid, uploads to Google Ads
```

**Why middleware + cookie vs localStorage:** server-side visibility in checkout API. localStorage can't be read by Next.js server components or API routes.

**Why strip `?gclid=` from URL:** cleanliness + avoids double-capture if user shares link. Capture once in cookie, discard from URL.

### 3.3 Cookie TTL choice — 90 days

Google's default click-through-lookback-window is 30 days for the default conversion action. Phase 00 created `Website Order` with `click_through_lookback_window_days=30`. Cookie at 90 days gives us headroom: user clicks ad day 1, converts day 25 — we still have the GCLID. Beyond 30 days, Google rejects the conversion as out-of-window.

Future: extend conversion window to 90 days (requires conversion action update) if ELM discovers long purchase cycles in the data.

### 3.4 The upload cron — 15 minutes

**Why 15 min, not realtime:** batching amortizes API ops cost. Google Ads dedupes on (gclid + conversion_action + timestamp), so multiple uploads of the same event are safe — but expensive. Every 15 min runs 4 upload jobs per hour = 96/day, each uploading 1-N orders.

```
Every 15 minutes:
  SELECT orders
    WHERE status IN ('paid', 'completed', 'fulfilled')  -- whatever post-payment status is used
      AND gclid IS NOT NULL
      AND paid_at IS NOT NULL
      AND paid_at >= NOW() - INTERVAL '30 days'  -- respect conversion window
      AND id NOT IN (SELECT order_id FROM mktg_google_conversions_uploaded WHERE upload_status='success')
    LIMIT 500

  For each batch: call ConversionUploadService.uploadClickConversions with all N
  For each result:
    If success: INSERT mktg_google_conversions_uploaded (order_id, gclid, conversion_action_resource, uploaded_at, upload_status='success')
    If failure: INSERT with upload_status='failed', error_message=<reason>
```

### 3.5 Conversion payload shape

```ts
const conversion = {
  conversionAction: env.CONVERSION_ACTION_PURCHASE,  // 'customers/5409526270/conversionActions/N'
  conversionDateTime: toGoogleDateTime(order.paid_at),  // 'YYYY-MM-DD HH:MM:SS+00:00'
  conversionValue: order.total_cents / 100,  // float, dollars
  currencyCode: 'USD',
  gclid: order.gclid,
  orderId: order.id,  // optional but useful for dedup
  userIdentifiers: [],  // enhanced conversions — skip for v1, add in v2
};
```

Upload via:
```ts
await conversionUploadService.uploadClickConversions({
  customerId: env.GOOGLE_ADS_CUSTOMER_ID,
  conversions: [conversion1, conversion2, ...],
  partialFailure: true,  // don't fail the batch if one conversion errors
  validateOnly: false,
});
```

### 3.6 Dedup semantics

Two layers:

1. **Database dedup:** `mktg_google_conversions_uploaded.order_id` UNIQUE. Only one row per order regardless of attempts.
2. **Google-side dedup:** using `orderId` field in conversion upload. Google dedupes on (orderId + conversion_action). Resubmitting same orderId is safe — Google silently accepts as duplicate.

The worker re-queries `WHERE id NOT IN (SELECT order_id ...)` each run, so it naturally skips already-uploaded. But if the worker crashes mid-batch after uploading to Google but before inserting to DB, next run will re-upload — safe due to Google-side dedup.

### 3.7 Failure modes

| Error | Handling |
|---|---|
| GCLID expired (>90 days) | Google returns `NO_RECENT_CLICK`. Mark `upload_status='expired'`. Don't retry. |
| Invalid GCLID format | Google returns `INVALID_ARGUMENT`. Mark `upload_status='invalid_gclid'`. Don't retry. |
| Conversion action disabled | Mark all conversions in batch `upload_status='config_error'`. Alert. |
| Network error / 5xx | BullMQ retry with exponential backoff (5 attempts, up to 30 min). |
| Auth failure | Same as other phases — audit + alert, no retry storm. |

---

## 4. Tasks (ordered)

### 4.1 easternLM middleware — GCLID capture

`easternLM/src/middleware.ts` (extend existing if present; create otherwise):

```ts
import { NextRequest, NextResponse } from 'next/server';

export function middleware(request: NextRequest) {
  const gclid = request.nextUrl.searchParams.get('gclid');

  if (gclid) {
    // Clone URL, strip gclid, preserve other params
    const cleanUrl = request.nextUrl.clone();
    cleanUrl.searchParams.delete('gclid');

    const response = NextResponse.redirect(cleanUrl);
    response.cookies.set('elm_gclid', gclid, {
      maxAge: 60 * 60 * 24 * 90,  // 90 days
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    });
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
```

**Careful:** existing middleware may already be present (auth, admin guards). Merge logic, don't overwrite.

### 4.2 Checkout persistence — read cookie, write to order

Identify the code path that creates an `orders` row. Likely candidates:
- `easternLM/src/app/api/checkout/create/route.ts` (if exists)
- Stripe webhook handler at `/api/webhooks/stripe/route.ts` — where payment_intent.succeeded creates/updates order

In that handler, read the cookie and write to `orders.gclid`:

```ts
import { cookies } from 'next/headers';

const cookieStore = await cookies();
const gclid = cookieStore.get('elm_gclid')?.value;

// At order creation or update:
await supabase.from('orders').insert({
  // ... other fields ...
  gclid: gclid ?? null,
});
```

**Watch for:** if order is created BEFORE payment success (e.g., pending order then webhook), ensure GCLID is persisted on the pending order, not just on paid. Post-payment webhook may not have cookie context (server-to-server from Stripe).

**Design:** set GCLID on the INITIAL order insert (checkout API, which has request context and cookie). Webhook UPDATEs order.status='paid' but preserves gclid already in row.

Test: walk through checkout with `?gclid=TEST123` in URL → complete order → check `orders.gclid` column has `TEST123`.

### 4.3 Upload worker

`elm-marketing/src/workers/google-conversion-upload.worker.ts`:

```ts
new Worker('google-conversion-upload', async (job) => {
  const { brandId } = job.data;

  // Query batch of paid orders not yet uploaded
  const { data: orders } = await supabase
    .from('orders')
    .select('id, gclid, total_cents, paid_at')
    .eq('status', 'paid')  // adjust if schema uses different terminal status
    .not('gclid', 'is', null)
    .gte('paid_at', new Date(Date.now() - 30 * 86400_000).toISOString())
    .not('id', 'in', `(SELECT order_id FROM mktg_google_conversions_uploaded WHERE upload_status='success')`)
    .limit(500);

  if (!orders || orders.length === 0) {
    return { uploaded: 0, skipped: 0 };
  }

  const account = await getBrandAccount(brandId);
  const customer = await getGoogleAdsClient(brandId);

  const conversions = orders.map(o => ({
    conversionAction: account.conversion_action_purchase,
    conversionDateTime: toGoogleDateTime(o.paid_at),
    conversionValue: o.total_cents / 100,
    currencyCode: 'USD',
    gclid: o.gclid,
    orderId: o.id,
  }));

  const [response] = await customer.conversionUploads.uploadClickConversions({
    customerId: account.google_customer_id,
    conversions,
    partialFailure: true,
    validateOnly: false,
  });

  // Process per-conversion results
  const partialErrors = parsePartialFailure(response.partial_failure_error);
  let uploaded = 0, failed = 0;

  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    const err = partialErrors.get(i);

    if (!err) {
      await supabase.from('mktg_google_conversions_uploaded').insert({
        brand_id: brandId,
        order_id: order.id,
        gclid: order.gclid,
        conversion_action_resource: account.conversion_action_purchase,
        upload_status: 'success',
      });
      uploaded++;
    } else {
      const status = classifyError(err);  // 'expired' | 'invalid_gclid' | 'config_error' | 'transient'
      await supabase.from('mktg_google_conversions_uploaded').insert({
        brand_id: brandId,
        order_id: order.id,
        gclid: order.gclid,
        conversion_action_resource: account.conversion_action_purchase,
        upload_status: status,
        error_message: err.message,
      });
      failed++;
    }
  }

  await writeAuditAction({
    brandId,
    agentName: 'conversionUploader',
    action: 'upload_conversions',
    status: 'success',
    result: { uploaded, failed, totalProcessed: orders.length },
  });

  return { uploaded, failed };
}, { connection, concurrency: 1 });
```

### 4.4 Cron trigger

`src/cron/trigger-conversion-upload.ts`:
```ts
await conversionUploadQueue.add('upload', { brandId: 'eastern-lm' });
process.exit(0);
```

Crontab:
```
*/15 * * * * /usr/bin/node /app/dist/cron/trigger-conversion-upload.js
```

### 4.5 Admin UI — Conversions tab stub

`easternLM/src/app/admin/marketing/conversions/page.tsx` — minimal for Phase 06, full polish in Phase 07.

Read `/mnt/skills/public/frontend-design/SKILL.md` first.

Content:
- GCLID capture rate: `SELECT COUNT(*) FROM orders WHERE created_at > NOW() - INTERVAL '30 days'` vs. `WHERE gclid IS NOT NULL`. Display as "% of orders with GCLID" — this is the funnel health metric.
- Upload status summary: counts by `upload_status` from `mktg_google_conversions_uploaded` last 30 days
- Recent uploads table (last 20): order_id (link to admin order), gclid (truncated), value, upload_status, error_message if failed
- "Last upload run" timestamp

No manual trigger button in Phase 06 (Phase 07 adds).

### 4.6 Enhanced conversions (deferred note)

Phase 06 does NOT implement enhanced conversions (hashed email/phone upload alongside GCLID). Document as a v2 enhancement. Enhanced conversions improve match rate for users who clear cookies / switch devices, but add compliance/PII handling complexity. Call out in completion report as "recommended v2 work."

### 4.7 Tests

Unit (vitest):
- Middleware sets cookie on `?gclid=X` request; strips param from URL
- Middleware no-ops when no gclid param present
- Checkout persistence reads cookie and inserts to `orders.gclid`
- `toGoogleDateTime` formats correctly (timezone handling)
- Error classifier maps Google error codes to expected status strings

Integration (vitest, against staging):
- Create synthetic paid order with test `gclid` → run worker → assert `mktg_google_conversions_uploaded` row created
- Create order with expired `gclid` (> 90 days old) → run worker → row created with `upload_status='expired'`
- Run worker twice on same paid orders → second run is no-op (dedup works)

E2E (Playwright, stub for Phase 08):
- Navigate to `easternlm.com/?gclid=TESTGCLID123` → check cookie set, URL cleaned
- Complete checkout → check `orders.gclid` populated

### 4.8 CLAUDE.md additions

```markdown
## Phase 06 additions

- GCLID capture: middleware sets HttpOnly cookie `elm_gclid`, 90-day TTL, strips param from URL.
- Checkout persistence: cookie read → orders.gclid at order creation (NOT at webhook stage).
- Upload worker runs every 15 minutes. Queries paid orders with GCLID, not-yet-uploaded, paid within 30 days.
- Conversion action resource name stored on mktg_google_accounts.conversion_action_purchase.
- Conversions use orderId for Google-side dedup; DB uses UNIQUE(order_id) for DB-side dedup.
- Upload status taxonomy: success | expired | invalid_gclid | config_error | transient.
- No enhanced conversions in v1 (PII hashed uploads); deferred to v2.
- GCLID capture rate is the key funnel health metric — display on admin Conversions tab.
```

---

## 5. Acceptance criteria

1. ✅ Middleware captures `?gclid=` → sets `elm_gclid` cookie (HttpOnly, Secure in prod, 90-day TTL)
2. ✅ Middleware strips `?gclid=` from URL via 302 redirect, preserves other query params
3. ✅ Existing middleware functionality preserved (no regressions on auth, admin guards, etc.)
4. ✅ Checkout flow: cookie `elm_gclid` present → `orders.gclid` populated on order insert
5. ✅ Test order with gclid completes full flow: cookie → order → eventual upload after payment
6. ✅ Upload worker runs on 15-min cron, queries correct orders
7. ✅ Successful upload: `mktg_google_conversions_uploaded` row inserted with `upload_status='success'`
8. ✅ Idempotency: re-running worker on same paid orders → no duplicate uploads, no duplicate DB rows
9. ✅ Expired GCLID: `upload_status='expired'`, error classified correctly
10. ✅ Invalid GCLID: `upload_status='invalid_gclid'`
11. ✅ Admin Conversions tab displays GCLID capture rate, upload status counts, recent uploads list
12. ✅ GCLID capture rate calculation correct (matches manual query)
13. ✅ Conversion action resource name loaded from env/DB (not hardcoded)
14. ✅ Every worker run writes `mktg_agent_actions` audit row
15. ✅ No plaintext access/refresh tokens in logs
16. ✅ Completion report documents: known testing method (how to generate a real GCLID for end-to-end verification)

---

## 6. Scope boundaries — DO NOT DO

- ❌ Enhanced conversions (hashed email/phone upload) — v2
- ❌ Offline conversion adjustments / refunds — v2
- ❌ Lead-form conversions (Quote Submit) upload — not in SOW v1
- ❌ Cross-device attribution beyond GCLID
- ❌ Admin UI manual trigger button (Phase 07)
- ❌ GCLID override / manual entry (Phase 07)
- ❌ Date range picker on Conversions tab (Phase 07)
- ❌ GA4 integration

---

## 7. Risk callouts

1. **Cookie consent / GDPR.** NY is not subject to GDPR, and ELM has no international traffic currently, so this is a minor concern. But as a best practice, `elm_gclid` is a first-party analytics cookie; compliance-friendly. No consent banner change needed for Phase 06.
2. **Middleware regressions.** If existing middleware exists, merging GCLID logic is where 99% of bugs will happen. Operator must carefully preserve every existing branch.
3. **Cookie path in staging vs prod.** Staging may be on a subdomain like `staging.easternlm.com`. Cookie `path: /` on staging doesn't share with prod. Not a real issue since they're separate environments, but test both.
4. **Stripe webhook context.** Webhooks are server-to-server — NO cookie context. GCLID must be persisted on initial order creation (request-context-available), not waited for in the webhook. Confirm this in diagnostic step.
5. **Order status terminal values.** Spec references `status='paid'`. Actual schema may use `completed`, `fulfilled`, `succeeded`. Diagnose and match what the codebase uses; don't assume.
6. **Test GCLID generation.** Google provides `test_gclids` via their conversion upload docs — use these for integration tests. Real GCLIDs can only be generated by real clicks on real ads.
7. **Upload rate vs. daily quota.** 500 conversions/run × 96 runs/day = 48,000 max ops on this worker alone. Basic Access token limit is 15,000/day. In practice we'll never hit 500/run (ELM doesn't have that volume), but put a sanity cap: if a single run would exceed 15K/day estimate, split into sub-batches across future cron runs.

---

## 8. Orchestration

Session start: `claude --max-turns 25` + paste this file.
Resume: `claude --continue`.
Completion: write completion report, push branches, stop.

Can run fully in parallel with Phases 03, 04, 05 — no shared code paths.

---

## 9. Review

Reviewer checks all 16 acceptance criteria, plus:
- Middleware regression check (every existing path still works)
- Cookie properties correct (HttpOnly, Secure in prod, SameSite=Lax, 90-day)
- GCLID never logged in plain text
- Upload idempotency verified
- `conversion_action_purchase` sourced from DB/env, not hardcoded

Verdict: `PROMOTE` → unblocks Phase 07 · `FIX` → re-run · `ESCALATE`.

---

*Phase 06 · April 16, 2026 · ~25 turn budget · Paste-ready.*
