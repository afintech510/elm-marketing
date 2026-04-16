# Phase 08 — Playwright E2E Coverage

**Role:** Claude Code, Phase 08 of 11 (final phase).
**Spec:** `elm-google-ads-spec-LOCKED.md` (🔒).
**SOW:** `elm-google-ads-sow.md`.
**Depends on:** Phase 07 PROMOTEd. Final phase.
**Max turns:** 20 (resume with `--continue`).
**Branch:** `feature/marketing-08` on `easternLM`.
**Reports to:** `PHASE-08-COMPLETION-REPORT.md` + `PHASE-08-PROGRESS.md`.

---

## 1. Mission

Extend the existing Playwright E2E suite (from session 4 memory: 12 tests passing, 4 skipped auth-required) with comprehensive Marketing-tab coverage. 5 new spec files, each exercising a critical user journey end-to-end against staging. After this phase: full green E2E run is the final PROMOTE gate before Adam goes live with real Google Ads spend.

---

## 2. Diagnostic-first (MANDATORY)

1. Inspect existing Playwright setup at `easternLM/e2e/` — config, fixtures, auth setup, staging URL, base auth pattern.
2. Read current test patterns — understand existing `test.describe` conventions, fixture usage, `beforeAll`/`beforeEach` setup.
3. Verify staging deployment has all Phase 00-07 functionality live: OAuth connected, feed synced, campaigns created (paused), optimizer has run at least once, GCLID capture active.
4. Check if staging has a test `gclid` fixture — Google's test GCLIDs documented in conversion upload docs; may need to seed.
5. Inventory `/admin/marketing/*` routes and elements to test; get selectors from Phase 07 implementation.
6. Read `elm-google-ads-spec-LOCKED.md` SOW §7 (success criteria — these map 1:1 to the tests we're writing).
7. Report findings in turn 1.

---

## 3. Context

### 3.1 Test architecture

Five spec files in `easternLM/e2e/marketing/`:

```
e2e/marketing/
├── fixtures.ts                    — auth, DB cleanup, test GCLID seeding
├── oauth.spec.ts                  — connect/disconnect flow
├── feed.spec.ts                   — product feed sync happy path
├── campaigns.spec.ts              — campaign CRUD
├── recommendations.spec.ts        — approve → apply
└── gclid.spec.ts                  — capture + upload
```

### 3.2 Fixtures

`fixtures.ts`:
```ts
import { test as base } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

type Fixtures = {
  adminAuth: { email: string };
  testDbClient: SupabaseClient;
  testGclid: string;
};

export const test = base.extend<Fixtures>({
  adminAuth: async ({ page }, use) => {
    // Navigate to admin login, enter credentials from STAGING_ADMIN_EMAIL/PASSWORD env
    await page.goto(`${STAGING_URL}/admin/login`);
    await page.fill('[name="email"]', env.STAGING_ADMIN_EMAIL);
    await page.fill('[name="password"]', env.STAGING_ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/admin/);
    await use({ email: env.STAGING_ADMIN_EMAIL });
  },
  testDbClient: async ({}, use) => {
    const client = createClient(env.STAGING_SUPABASE_URL, env.STAGING_SUPABASE_SERVICE_ROLE);
    await use(client);
  },
  testGclid: async ({}, use) => {
    // Google's documented test GCLID for staging
    await use('TeSTER-GCLID-SANDBOX-VALUE');
  },
});
```

Env vars required (documented in `e2e/README.md`):
- `STAGING_URL=https://staging.easternlm.com`
- `STAGING_ADMIN_EMAIL`, `STAGING_ADMIN_PASSWORD`
- `STAGING_SUPABASE_URL`, `STAGING_SUPABASE_SERVICE_ROLE`

### 3.3 Test scope rules

**Hit staging, never production.** Every test file asserts `STAGING_URL.includes('staging')` in `beforeAll`, fails fast if pointed at prod.

**Clean up after yourself.** Each test resets DB state it touched via service-role client. Idempotent re-runs.

**Read-only where possible.** OAuth/feed/campaign creation is intentionally tricky to do in tests — mock the Google side, or use existing staging state.

**Assert meaningful outcomes, not implementation details.** Test "recommendation approved → campaign budget updated in DB," not "button turned green."

### 3.4 What NOT to E2E test

- Actual Google Ads mutation → too expensive (real $ if mis-configured)
- Actual Merchant API writes to a real GMC → staging GMC must exist; if not, skip
- Timing-dependent things (cron jobs firing exactly at 5 AM) → test the logic, not the schedule
- 3rd-party availability (Google outages) → mock at API boundary where possible

---

## 4. Tasks (ordered)

### 4.1 fixtures.ts

Build per §3.2. Tests compose these fixtures.

### 4.2 oauth.spec.ts

Scenarios:

```ts
test('Marketing tab shows Connect button when disconnected', async ({ page, adminAuth, testDbClient }) => {
  // Arrange: mark DB as disconnected
  await testDbClient.from('mktg_google_accounts').update({ revoked_at: new Date().toISOString() }).eq('brand_id', 'eastern-lm');
  // Act
  await page.goto(`${STAGING_URL}/admin/marketing/accounts`);
  // Assert
  await expect(page.getByRole('button', { name: /connect google/i })).toBeVisible();
});

test('Marketing tab shows connected state when account active', async ({ page, adminAuth, testDbClient }) => {
  await testDbClient.from('mktg_google_accounts').update({
    revoked_at: null,
    connected_by_email: 'test@example.com',
    connected_at: new Date().toISOString(),
  }).eq('brand_id', 'eastern-lm');
  await page.goto(`${STAGING_URL}/admin/marketing/accounts`);
  await expect(page.getByText('test@example.com')).toBeVisible();
  await expect(page.getByRole('button', { name: /disconnect/i })).toBeVisible();
});

test('Disconnect flow: confirm → account marked revoked', async ({ page, adminAuth, testDbClient }) => {
  // Start connected
  await ensureConnected(testDbClient);
  await page.goto(`${STAGING_URL}/admin/marketing/accounts`);
  await page.getByRole('button', { name: /disconnect/i }).click();
  await page.getByRole('button', { name: /^disconnect$/i }).click();  // confirm modal

  await expect(page.getByRole('button', { name: /connect google/i })).toBeVisible();

  const { data } = await testDbClient.from('mktg_google_accounts').select('revoked_at').eq('brand_id', 'eastern-lm').single();
  expect(data?.revoked_at).not.toBeNull();
});

test('Publish mode switcher: auto requires confirmation modal', async ({ page, adminAuth, testDbClient }) => {
  await ensureConnected(testDbClient);
  await page.goto(`${STAGING_URL}/admin/marketing/accounts`);
  await page.getByLabel(/publish mode/i).click();
  await page.getByRole('option', { name: /auto/i }).click();
  await expect(page.getByText(/auto mode allows optimizer/i)).toBeVisible();  // warning modal copy
  await page.getByRole('button', { name: /cancel/i }).click();
  // Assert mode unchanged
  const { data } = await testDbClient.from('mktg_google_accounts').select('publish_mode').eq('brand_id', 'eastern-lm').single();
  expect(data?.publish_mode).not.toBe('auto');
});

test('Budget cap editor: validates min/max, persists valid value', async ({ page, adminAuth, testDbClient }) => {
  await ensureConnected(testDbClient);
  await page.goto(`${STAGING_URL}/admin/marketing/accounts`);
  await page.getByLabel(/monthly budget cap/i).click();
  await page.fill('[name="budget-cap"]', '50');  // below min
  await page.blur('[name="budget-cap"]');
  await expect(page.getByText(/minimum.*100/i)).toBeVisible();

  await page.fill('[name="budget-cap"]', '2500');
  await page.blur('[name="budget-cap"]');
  await page.getByRole('button', { name: /confirm/i }).click();

  const { data } = await testDbClient.from('mktg_google_accounts').select('monthly_budget_cap_cents').eq('brand_id', 'eastern-lm').single();
  expect(data?.monthly_budget_cap_cents).toBe(250000);
});
```

### 4.3 feed.spec.ts

Scenarios:

```ts
test('Product Feed tab: renders all mapped products', async ({ page, adminAuth, testDbClient }) => {
  // Seed: at least 1 row per channel in mktg_google_products
  await seedTestProduct(testDbClient, { offerId: 'test-mulch-online', channel: 'online', status: 'approved' });
  await seedTestProduct(testDbClient, { offerId: 'test-mulch-local', channel: 'local', status: 'disapproved', reason: 'TEST: Policy violation' });

  await page.goto(`${STAGING_URL}/admin/marketing/feed`);
  await expect(page.getByText('test-mulch-online')).toBeVisible();
  await expect(page.getByText('test-mulch-local')).toBeVisible();
  await expect(page.getByText(/disapproved/i)).toBeVisible();
});

test('Product Feed: filter by status narrows list', async ({ page, adminAuth, testDbClient }) => {
  await seedTestProduct(testDbClient, { offerId: 'ok-1', status: 'approved' });
  await seedTestProduct(testDbClient, { offerId: 'bad-1', status: 'disapproved' });

  await page.goto(`${STAGING_URL}/admin/marketing/feed`);
  await page.getByLabel(/disapproved/i).check();
  await expect(page.getByText('ok-1')).not.toBeVisible();
  await expect(page.getByText('bad-1')).toBeVisible();
});

test('Product Feed: detail panel shows source product + disapproval reason', async ({ page, adminAuth, testDbClient }) => {
  await seedTestProduct(testDbClient, { offerId: 'natural-mulch-local', channel: 'local', status: 'disapproved', reason: 'Misrepresentation — Policy' });
  await page.goto(`${STAGING_URL}/admin/marketing/feed`);
  await page.getByText('natural-mulch-local').click();
  await expect(page.getByText(/Misrepresentation/)).toBeVisible();
});

test('Sync all button: triggers job, shows result toast', async ({ page, adminAuth }) => {
  await page.goto(`${STAGING_URL}/admin/marketing/feed`);

  // Intercept the internal POST to elm-marketing
  await page.route(/\/api\/marketing\/google\/feed\/sync/, route => {
    route.fulfill({ status: 200, body: JSON.stringify({ jobId: 'test-job-123' }) });
  });

  await page.getByRole('button', { name: /sync all now/i }).click();
  await expect(page.getByText(/sync queued|syncing/i)).toBeVisible();
});
```

### 4.4 campaigns.spec.ts

Scenarios:

```ts
test('Campaigns tab: list shows all campaigns from DB', async ({ page, adminAuth, testDbClient }) => {
  // Seed campaigns (don't create in real Google Ads)
  await seedCampaign(testDbClient, { name: 'ELM-Search-Mulch', status: 'PAUSED', type: 'SEARCH', budgetCentsDaily: 2000 });
  await seedCampaign(testDbClient, { name: 'ELM-PMax-All-Products', status: 'PAUSED', type: 'PERFORMANCE_MAX', budgetCentsDaily: 5000 });

  await page.goto(`${STAGING_URL}/admin/marketing/campaigns`);
  await expect(page.getByText('ELM-Search-Mulch')).toBeVisible();
  await expect(page.getByText('ELM-PMax-All-Products')).toBeVisible();
});

test('Activate button: respects guardrail when cap exceeded', async ({ page, adminAuth, testDbClient }) => {
  // Set cap low, seed campaign budget that would exceed
  await testDbClient.from('mktg_google_accounts').update({ monthly_budget_cap_cents: 10000 }).eq('brand_id', 'eastern-lm'); // $100/mo cap
  await seedCampaign(testDbClient, { name: 'TEST-Big-Budget', status: 'PAUSED', budgetCentsDaily: 5000 }); // $150/mo

  await page.goto(`${STAGING_URL}/admin/marketing/campaigns`);
  await page.getByText('TEST-Big-Budget').click();
  await page.getByRole('button', { name: /activate/i }).click();

  await expect(page.getByText(/would push monthly spend|exceed.*cap/i)).toBeVisible();
});

test('Budget edit: inline editor, confirm, persists', async ({ page, adminAuth, testDbClient }) => {
  await testDbClient.from('mktg_google_accounts').update({ monthly_budget_cap_cents: 200000 }).eq('brand_id', 'eastern-lm');
  await seedCampaign(testDbClient, { name: 'TEST-Campaign', status: 'PAUSED', budgetCentsDaily: 2000, googleCampaignId: 'TESTID-123' });

  await page.goto(`${STAGING_URL}/admin/marketing/campaigns`);
  await page.getByText('TEST-Campaign').click();
  // Mock the internal mutate call
  await page.route(/\/api\/marketing\/google\/campaigns\/.*\/budget/, route => {
    route.fulfill({ status: 200, body: JSON.stringify({ success: true }) });
  });
  await page.getByRole('button', { name: /edit.*budget/i }).click();
  await page.fill('[name="budget"]', '30');
  await page.getByRole('button', { name: /confirm/i }).click();
  await expect(page.getByText(/budget updated|saved/i)).toBeVisible();
});
```

### 4.5 recommendations.spec.ts

Scenarios:

```ts
test('Recommendations tab: renders pending list', async ({ page, adminAuth, testDbClient }) => {
  await seedRecommendation(testDbClient, {
    type: 'BUDGET_INCREASE',
    reason: 'ROAS 4.3× with 45% impression share lost',
    confidence: 0.9,
    status: 'pending',
  });
  await page.goto(`${STAGING_URL}/admin/marketing/recommendations`);
  await expect(page.getByText(/ROAS 4.3/)).toBeVisible();
  await expect(page.getByRole('button', { name: /approve/i })).toBeVisible();
});

test('Approve flow: updates status, enqueues apply, reflects in UI', async ({ page, adminAuth, testDbClient }) => {
  const rec = await seedRecommendation(testDbClient, {
    type: 'ADD_NEGATIVE_KEYWORD',
    proposedChange: { keyword: 'test-negative' },
    confidence: 0.85,
    status: 'pending',
  });

  // Mock the apply call
  await page.route(/\/api\/marketing\/google\/recommendations\/.*\/approve/, route => {
    route.fulfill({ status: 200, body: JSON.stringify({ queued: true }) });
  });

  await page.goto(`${STAGING_URL}/admin/marketing/recommendations`);
  await page.getByRole('button', { name: /approve/i }).first().click();
  await expect(page.getByText(/approved|queued/i)).toBeVisible();

  const { data } = await testDbClient.from('mktg_google_recommendations').select('status, decided_by').eq('id', rec.id).single();
  expect(data?.status).toBe('approved');
  expect(data?.decided_by).toBe(env.STAGING_ADMIN_EMAIL);
});

test('Reject flow: marks rejected, no mutation', async ({ page, adminAuth, testDbClient }) => {
  const rec = await seedRecommendation(testDbClient, {
    type: 'PAUSE_CAMPAIGN',
    confidence: 0.6,
    status: 'pending',
  });
  await page.goto(`${STAGING_URL}/admin/marketing/recommendations`);
  await page.getByRole('button', { name: /reject/i }).first().click();
  await page.fill('[name="reject-reason"]', 'Testing');
  await page.getByRole('button', { name: /confirm reject/i }).click();

  const { data } = await testDbClient.from('mktg_google_recommendations').select('status').eq('id', rec.id).single();
  expect(data?.status).toBe('rejected');
});

test('History tab shows decided recommendations', async ({ page, adminAuth, testDbClient }) => {
  await seedRecommendation(testDbClient, { status: 'approved', type: 'BUDGET_INCREASE' });
  await seedRecommendation(testDbClient, { status: 'rejected', type: 'PAUSE_CAMPAIGN' });
  await page.goto(`${STAGING_URL}/admin/marketing/recommendations`);
  await page.getByRole('tab', { name: /history/i }).click();
  await expect(page.getByText(/approved/i)).toBeVisible();
  await expect(page.getByText(/rejected/i)).toBeVisible();
});
```

### 4.6 gclid.spec.ts

Scenarios:

```ts
test('Landing with ?gclid= sets cookie + strips param', async ({ page, testGclid }) => {
  await page.goto(`${STAGING_URL}/?gclid=${testGclid}`);
  // URL should be cleaned
  await expect(page).toHaveURL(new RegExp(`^${STAGING_URL}/$`));
  // Cookie should be set
  const cookies = await page.context().cookies();
  const gclidCookie = cookies.find(c => c.name === 'elm_gclid');
  expect(gclidCookie?.value).toBe(testGclid);
  expect(gclidCookie?.httpOnly).toBe(true);
});

test('Cookie persists across pages', async ({ page, testGclid }) => {
  await page.goto(`${STAGING_URL}/?gclid=${testGclid}`);
  await page.goto(`${STAGING_URL}/shop`);
  const cookies = await page.context().cookies();
  expect(cookies.find(c => c.name === 'elm_gclid')?.value).toBe(testGclid);
});

test('Cookie preserved when other query params present', async ({ page, testGclid }) => {
  await page.goto(`${STAGING_URL}/shop?utm_source=google&gclid=${testGclid}&foo=bar`);
  // gclid stripped, others remain
  await expect(page).toHaveURL(/utm_source=google/);
  await expect(page).toHaveURL(/foo=bar/);
  await expect(page).not.toHaveURL(/gclid=/);
});

test('Conversions tab shows GCLID capture rate', async ({ page, adminAuth, testDbClient }) => {
  // Seed some orders with/without gclid
  await seedOrders(testDbClient, { withGclid: 10, withoutGclid: 5 });
  await page.goto(`${STAGING_URL}/admin/marketing/conversions`);
  await expect(page.getByText(/67%/)).toBeVisible();  // 10/(10+5)
});

test('Conversions tab: manual trigger upload', async ({ page, adminAuth }) => {
  await page.route(/\/api\/marketing\/google\/conversions\/upload/, route => {
    route.fulfill({ status: 200, body: JSON.stringify({ jobId: 'conv-test-123' }) });
  });
  await page.goto(`${STAGING_URL}/admin/marketing/conversions`);
  await page.getByRole('button', { name: /trigger upload/i }).click();
  await expect(page.getByText(/queued|triggered/i)).toBeVisible();
});
```

### 4.7 CI integration

Update `easternLM/.github/workflows/` to include marketing E2E as a gate on any marketing-related PR. Match existing Playwright workflow pattern.

Add to `package.json` scripts:
```json
{
  "test:e2e:marketing": "playwright test e2e/marketing/",
  "test:e2e:all": "playwright test"
}
```

### 4.8 README.md for E2E

`e2e/README.md` — document:
- Required env vars
- How to run full suite vs. marketing-only
- Where fixtures live
- Which tests mock vs. hit real services
- Known flakiness or skip conditions

### 4.9 Completion report

Document:
- Final test count (existing + new)
- Known flakes or skip reasons
- Running time on staging
- Coverage gaps explicitly NOT covered (real Google Ads mutations, real Merchant API writes, timing-dependent cron behavior)

---

## 5. Acceptance criteria

1. ✅ 5 new spec files created in `e2e/marketing/`
2. ✅ All new tests pass against staging
3. ✅ Tests assert `STAGING_URL.includes('staging')` in `beforeAll`, fail fast if pointed at prod
4. ✅ Each test cleans up DB state it creates (idempotent re-run)
5. ✅ OAuth tests cover: disconnected state, connected state, disconnect flow, publish_mode auto warning, budget cap editor
6. ✅ Feed tests cover: list render, filter, detail panel, manual sync trigger
7. ✅ Campaigns tests cover: list render, activate guardrail, budget edit flow
8. ✅ Recommendations tests cover: pending list, approve flow + DB side effect, reject flow, history tab
9. ✅ GCLID tests cover: cookie set + URL strip, cross-page persistence, coexistence with other params, capture rate display, manual upload trigger
10. ✅ CI config updated to run marketing E2E on marketing-related PRs
11. ✅ `e2e/README.md` documents env vars, run commands, coverage gaps
12. ✅ All tests complete within 10 minutes total
13. ✅ Completion report includes coverage gap list (things NOT tested, with rationale)
14. ✅ Existing non-marketing tests still pass — no regressions

---

## 6. Scope boundaries — DO NOT DO

- ❌ Test real Google Ads mutations (expensive, risky)
- ❌ Test real Merchant API writes
- ❌ Test cron scheduling (test the logic, not the schedule)
- ❌ Visual regression testing (separate concern)
- ❌ Performance testing (separate concern)
- ❌ Mobile viewport testing beyond basic responsive check
- ❌ Accessibility testing (separate concern; valid but out of this phase's scope)

---

## 7. Risk callouts

1. **Mocking vs. real integration.** Mocking too aggressively gives false confidence. These tests mock the internal easternLM → elm-marketing → Google hops, but exercise the real admin UI → easternLM API path. Reviewer checks that we're not mocking things we should be asserting.
2. **Flaky real-time subscriptions.** Supabase Realtime subscriptions can take 1-2 seconds to propagate. Tests for realtime-updated UI need generous waits or direct DB query fallbacks.
3. **Test auth session reuse.** Playwright's `storageState` lets us skip login on every test. Use it. Saves 15+ seconds per test across the suite.
4. **Test data isolation.** If multiple CI runs hit the same staging DB simultaneously, tests can step on each other. Namespace seed data with test run ID (e.g., `TEST-${runId}-campaign`).
5. **Env var leakage.** Never log `STAGING_ADMIN_PASSWORD` or similar. If CI logs env vars, a curious observer could access staging. Gate logging appropriately.

---

## 8. Orchestration

Session start: `claude --max-turns 20` + paste this file.
Resume: `claude --continue`.
Completion: write completion report, push branch, stop.

After PROMOTE: this is the final phase. Adam runs the full E2E suite, reviews completion report, and flips `publish_mode` to proceed with first real campaign activation.

---

## 9. Review

Reviewer checks all 14 acceptance criteria, plus:
- No tests against production (verify `STAGING_URL` assertions)
- Test data cleanup is complete
- Mocking is judicious (not over-mocked)
- Run time < 10 minutes
- Existing non-marketing tests still pass
- Coverage gap list is honest and complete

Verdict: `PROMOTE` → build complete, Marketing Engine ready for go-live · `FIX` → re-run · `ESCALATE` → Adam decides.

After PROMOTE: update `elm-google-ads-progress.md` with all 11 phases ✅ and check go-live checklist items complete.

---

*Phase 08 · April 16, 2026 · ~20 turn budget · Paste-ready. Final phase.*
