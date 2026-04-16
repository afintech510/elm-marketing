# Phase 01 — Schema & OAuth Connect

**Role:** Claude Code, Phase 01 of 11.
**Spec:** `elm-google-ads-spec-LOCKED.md` (🔒) — authoritative.
**SOW:** `elm-google-ads-sow.md`.
**Depends on:** Phase 00 PROMOTEd (conversion action resource names + store code captured as env vars; `CONVERSION_ACTION_PURCHASE`, `CONVERSION_ACTION_LEAD`, `MKTG_ENCRYPTION_KEY`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` all set on VPS).
**Max turns:** 25 (resume with `--continue`).
**Branches:** `feature/marketing-01` on both `easternLM` and `elm-marketing`.
**Reports to:** `PHASE-01-COMPLETION-REPORT.md` + `PHASE-01-PROGRESS.md`.

---

## 1. Mission

Create all `mktg_google_*` Supabase tables, add `orders.gclid` column, build the admin-facing OAuth connect/disconnect flow end-to-end, and implement the shared authenticated client helpers (`getGoogleAdsClient(brandId)`, `getMerchantClient(brandId)`). After this phase, an admin user can click "Connect Google" in the admin UI, complete the Google OAuth consent screen, and land back on easternlm.com with credentials stored encrypted. No API calls happen yet — Phase 02 agents read these credentials.

---

## 2. Diagnostic-first (MANDATORY before writing any code)

1. Read `elm-google-ads-spec-LOCKED.md` §3 (auth), §4 (schema), §12 (prereq status). Confirm values: `google_customer_id=5409526270`, `merchant_id=5578269156`, `store_code=ELM-FROWEIN-01`.
2. Read Phase 00 completion report: capture exact resource names for `CONVERSION_ACTION_PURCHASE` and `CONVERSION_ACTION_LEAD`. These go into the seed row.
3. Inspect easternLM Supabase migration directory structure — confirm migration naming convention used by existing `mktg_*` tables (from Host Hampton pattern referenced in memory).
4. Verify Phase 00's OAuth stub endpoints exist at `easternLM/src/app/api/marketing/google/oauth/{start,callback}/route.ts` — if not, this phase creates them (Phase 00 placeholder cleanup).
5. Verify env vars on VPS: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `MKTG_ENCRYPTION_KEY`, `CONVERSION_ACTION_PURCHASE`, `CONVERSION_ACTION_LEAD`. If any missing, STOP and report blocker.
6. Report findings in turn 1 output before any code changes.

---

## 3. Context

### 3.1 Key architectural choices locked from spec

- **`brand_id` column on every table** — kept per Adam's decision for future MyGravelGuy onboarding without migration
- **RLS: service role only** — no anon access to any `mktg_google_*` table; admin UI queries go through Next.js API routes with session-guard middleware
- **Encryption: AES-256-GCM** via `MKTG_ENCRYPTION_KEY` — NIST-standard symmetric, separate IV per record, auth tag stored with ciphertext
- **Access token cache in Redis** — 50-min TTL (Google tokens are 60-min). Key format: `elm:google:access_token:{brand_id}`
- **Scope requests:** `https://www.googleapis.com/auth/adwords` + `https://www.googleapis.com/auth/content`

### 3.2 OAuth flow design (§3.2 of spec)

```
Admin clicks "Connect Google" on /admin/marketing/accounts
  ↓
GET /api/marketing/google/oauth/start?brand_id=eastern-lm
  → generates state (CSRF token, stored in session or signed JWT)
  → redirects to accounts.google.com/o/oauth2/v2/auth with:
      client_id, redirect_uri, response_type=code,
      scope=adwords+content,
      access_type=offline, prompt=consent (force refresh token)
      state=<csrf>
  ↓
User authenticates with Google, approves scopes
  ↓
GET /api/marketing/google/oauth/callback?code=<authz>&state=<csrf>
  → verifies state matches
  → exchanges code → {access_token, refresh_token, expires_in}
  → encrypts refresh_token with MKTG_ENCRYPTION_KEY
  → UPSERT mktg_google_accounts
      brand_id = 'eastern-lm'
      google_customer_id = '5409526270'
      merchant_id = '5578269156'
      store_code = 'ELM-FROWEIN-01'
      refresh_token_encrypted = <encrypted>
      connected_by_email = <from id_token claim>
      conversion_action_purchase = <from env>
      conversion_action_lead = <from env>
      monthly_budget_cap_cents = 200000  (default $2000)
      publish_mode = 'suggest'
  → redirects /admin/marketing/accounts?success=1
```

### 3.3 Disconnect flow

```
Admin clicks "Disconnect" button
  → POST /api/marketing/google/oauth/revoke?brand_id=<...>
  → calls https://oauth2.googleapis.com/revoke with current access token
  → UPDATE mktg_google_accounts SET revoked_at=now()
     (do NOT DELETE — preserve history; future reconnect overwrites)
  → clears Redis access token cache
```

---

## 4. Tasks (ordered)

### 4.1 Supabase migrations — create all `mktg_google_*` tables

Create one migration file per table (easier to review, matches existing pattern). File naming: `YYYYMMDDHHMMSS_mktg_google_<table>.sql`. Use timestamps matching the spec's §4 schema **exactly as written** — do not drift column names, types, or check constraints.

Migrations to create (all DDL exactly as spec §4):
1. `mktg_google_accounts`
2. `mktg_google_products` (with March-2026 multi-channel UNIQUE constraint)
3. `mktg_google_campaigns`
4. `mktg_google_performance` (with index on `brand_id, date DESC`)
5. `mktg_google_recommendations` (with index on `brand_id, status, created_at DESC`)
6. `mktg_google_conversions_uploaded`
7. `mktg_agent_actions` — shared audit table. Schema:
   ```sql
   CREATE TABLE mktg_agent_actions (
     id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     brand_id           text NOT NULL,
     agent_name         text NOT NULL,
     action             text NOT NULL,         -- e.g. 'create_campaign', 'update_budget'
     target_resource    text,                  -- resource name of mutated entity
     payload            jsonb NOT NULL,        -- input args
     result             jsonb,                 -- return value or error
     status             text NOT NULL CHECK (status IN ('pending','success','error','rejected_by_guardrail')),
     triggered_by       text,                  -- user email | 'system' | 'recommendation:<id>'
     created_at         timestamptz NOT NULL DEFAULT now()
   );
   CREATE INDEX ON mktg_agent_actions (brand_id, created_at DESC);
   ```
8. **ALTER TABLE** `orders` ADD COLUMN `gclid text` — idempotent guard (`IF NOT EXISTS`)

### 4.2 RLS policies

For every `mktg_google_*` + `mktg_agent_actions` table:
```sql
ALTER TABLE mktg_google_accounts ENABLE ROW LEVEL SECURITY;
-- No policies = service role only. Anon + authenticated users cannot read.
```
Admin UI reads via Next.js API routes using the service-role client.

### 4.3 Seed row

Separate migration: `YYYYMMDDHHMMSS_seed_mktg_google_accounts_elm.sql`:
```sql
INSERT INTO mktg_google_accounts (
  brand_id, google_customer_id, merchant_id, store_code,
  refresh_token_encrypted, publish_mode, monthly_budget_cap_cents,
  conversion_action_purchase, conversion_action_lead
) VALUES (
  'eastern-lm', '5409526270', '5578269156', 'ELM-FROWEIN-01',
  '',  -- placeholder; populated by first OAuth connect
  'suggest', 200000,
  '<CONVERSION_ACTION_PURCHASE from Phase 00>',
  '<CONVERSION_ACTION_LEAD from Phase 00>'
)
ON CONFLICT (brand_id) DO UPDATE SET
  google_customer_id = EXCLUDED.google_customer_id,
  merchant_id = EXCLUDED.merchant_id,
  store_code = EXCLUDED.store_code,
  conversion_action_purchase = EXCLUDED.conversion_action_purchase,
  conversion_action_lead = EXCLUDED.conversion_action_lead;
```

Operator fetches the `CONVERSION_ACTION_*` values from the VPS env or from Phase 00's `phase-00-bootstrap-result.json`. Do NOT hardcode a real resource name in a template.

### 4.4 Encryption utility (`elm-marketing/src/crypto/refresh-token.ts`)

AES-256-GCM, library: `node:crypto`:
```ts
export function encryptRefreshToken(plaintext: string): string {
  const key = Buffer.from(env.MKTG_ENCRYPTION_KEY, 'base64');
  if (key.length !== 32) throw new Error('MKTG_ENCRYPTION_KEY must be 32 bytes base64-encoded');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: base64(iv || authTag || ciphertext)
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

export function decryptRefreshToken(encoded: string): string {
  const buf = Buffer.from(encoded, 'base64');
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const key = Buffer.from(env.MKTG_ENCRYPTION_KEY, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
```

Port this same module into `easternLM/src/lib/marketing/crypto.ts` — the OAuth callback needs it.

Unit tests (`vitest`):
- Round-trip encrypt/decrypt yields same plaintext
- Ciphertext differs on two encryptions of same plaintext (IV randomness)
- Tampered ciphertext throws on decrypt (auth tag verification)
- Wrong key throws on decrypt

### 4.5 Shared Google client helpers (`elm-marketing/src/auth/google.ts`)

```ts
import { GoogleAdsApi } from 'google-ads-api';
import { AccountsServiceClient } from '@google-cloud/merchant-accounts';
import Redis from 'ioredis';

const redis = new Redis(env.REDIS_URL, { keyPrefix: 'elm:' });

async function getBrandAccount(brandId: string): Promise<BrandAccount> {
  const { data, error } = await supabase
    .from('mktg_google_accounts')
    .select('*')
    .eq('brand_id', brandId)
    .is('revoked_at', null)
    .single();
  if (error || !data) throw new Error(`No connected Google account for brand ${brandId}`);
  return data;
}

async function getAccessToken(brandId: string): Promise<string> {
  const cached = await redis.get(`google:access_token:${brandId}`);
  if (cached) return cached;

  const account = await getBrandAccount(brandId);
  const refreshToken = decryptRefreshToken(account.refresh_token_encrypted);

  // Exchange refresh → access via Google OAuth token endpoint
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!tokenRes.ok) throw new Error(`Token refresh failed: ${await tokenRes.text()}`);
  const { access_token, expires_in } = await tokenRes.json();

  // Cache with 50-min TTL (Google returns ~3600s; buffer 10min)
  await redis.set(`google:access_token:${brandId}`, access_token, 'EX', 3000);
  return access_token;
}

export async function getGoogleAdsClient(brandId: string) {
  const account = await getBrandAccount(brandId);
  const client = new GoogleAdsApi({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    developer_token: env.GOOGLE_ADS_DEVELOPER_TOKEN,
  });
  return client.Customer({
    customer_id: account.google_customer_id,
    // login_customer_id: undefined — Path B, no MCC
    refresh_token: decryptRefreshToken(account.refresh_token_encrypted),
  });
}

export async function getMerchantAccountsClient(brandId: string) {
  const accessToken = await getAccessToken(brandId);
  return new AccountsServiceClient({
    authClient: /* construct with access token */,
  });
}
// Similar helpers for MerchantProductsClient, MerchantInventoriesClient
```

### 4.6 OAuth start endpoint (`easternLM/src/app/api/marketing/google/oauth/start/route.ts`)

- Auth guard: require authenticated admin session (use existing admin-session middleware)
- Extract `brand_id` from query (default `'eastern-lm'`)
- Generate CSRF state: sign `{brand_id, nonce, timestamp}` with `MKTG_ENCRYPTION_KEY` (HMAC-SHA256)
- Build Google OAuth URL with scopes `adwords content`, `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`
- 302 redirect

### 4.7 OAuth callback endpoint (`easternLM/src/app/api/marketing/google/oauth/callback/route.ts`)

- Verify `state` HMAC; reject on mismatch (show error page, don't silently fail)
- Extract `code` from query; 400 on missing
- Exchange code → tokens via Google OAuth token endpoint
- Extract `email` from `id_token` claim (decode JWT; or request `openid email` scope and call userinfo endpoint)
- Encrypt `refresh_token`
- `UPSERT` into `mktg_google_accounts` — updates `refresh_token_encrypted`, `connected_by_email`, `connected_at`, clears `revoked_at`
- Invalidate Redis access token cache: `DEL elm:google:access_token:{brand_id}`
- 302 redirect to `/admin/marketing/accounts?success=1`
- On any error: log full context, 302 to `/admin/marketing/accounts?error=<code>`

### 4.8 Disconnect endpoint (`easternLM/src/app/api/marketing/google/oauth/revoke/route.ts`)

- Auth guard: admin only
- Get current access token for brand, call `https://oauth2.googleapis.com/revoke?token=<access>`
- `UPDATE mktg_google_accounts SET revoked_at=now() WHERE brand_id=?`
- Clear Redis cache

### 4.9 Admin Marketing → Accounts tab (`easternLM/src/app/admin/marketing/accounts/page.tsx`)

**Minimal UI — Phase 07 polishes.** This phase needs functional, not pretty.

Read `/mnt/skills/public/frontend-design/SKILL.md` before writing any UI code, and follow its principles for the components. Still minimal — but avoid generic AI-looking output.

- Server component reads `mktg_google_accounts` row for `brand_id='eastern-lm'`
- If no row or `revoked_at IS NOT NULL` → "Connect Google" button linking to `/api/marketing/google/oauth/start?brand_id=eastern-lm`
- If connected → show: connected email, connected date, `publish_mode` (read-only display for now, editor in Phase 07), monthly budget cap, "Disconnect" button
- Success/error toast on query params

### 4.10 Tests

Unit (vitest, `elm-marketing`):
- Encryption round-trip + tamper/wrong-key rejection (from §4.4)
- `getAccessToken` returns cached value on second call
- `getBrandAccount` throws on missing or revoked account

Integration (optional, vitest):
- Full encryption → DB insert → decrypt → match roundtrip

E2E (Playwright, added to `easternLM/e2e/marketing-oauth.spec.ts` stub — full coverage is Phase 08):
- Stub only: visit `/admin/marketing/accounts`, assert "Connect Google" button present

### 4.11 Guardrail compliance notes for review

- **G5 (encryption):** No plaintext refresh tokens logged anywhere. Add eslint/grep check in CI: forbid `console.log.*refresh_token`
- **G7 (brand_id):** All queries parameterize `brand_id` — no hardcoded `'eastern-lm'` in helper functions (hardcoding in Phase 00 seed is OK)
- **G4 (audit):** OAuth connect/disconnect events write to `mktg_agent_actions` with `agent_name='oauth'`, `action='connect' | 'disconnect'`, `triggered_by=<admin email>`

### 4.12 Update CLAUDE.md in both repos

Append:
```markdown
## Phase 01 additions

- `mktg_google_*` tables are service-role only (RLS). Admin UI queries via API routes.
- `brand_id` is ALWAYS a function parameter, never a hardcoded string (except in Phase 00 seed migration).
- Access tokens cached in Redis under `elm:google:access_token:{brand_id}` with 50-min TTL.
- Refresh tokens: encrypt/decrypt via `MKTG_ENCRYPTION_KEY` ONLY. Never log decrypted values.
- OAuth flow: `start` endpoint signs state with HMAC-SHA256; `callback` verifies before anything else.
- Disconnect is soft: sets `revoked_at`, does not DELETE. Preserves history; future reconnect UPSERTs.
```

---

## 5. Acceptance criteria

1. ✅ All 7 `mktg_*` migrations apply cleanly to staging Supabase; rollback scripts exist
2. ✅ `orders.gclid` column present on `orders` table
3. ✅ RLS enabled on all new tables, verified by attempting anon read → access denied
4. ✅ Seed row in `mktg_google_accounts` exists for `brand_id='eastern-lm'` with correct `google_customer_id`, `merchant_id`, `store_code`, `conversion_action_purchase`, `conversion_action_lead`
5. ✅ Encryption unit tests pass (round-trip, tamper detection, wrong-key rejection)
6. ✅ OAuth connect flow works end-to-end on staging: click connect → Google consent → redirected back → `refresh_token_encrypted` populated in DB, `connected_at` set, `connected_by_email` captured
7. ✅ Access token cache hits second call (verify via Redis inspection)
8. ✅ `getGoogleAdsClient('eastern-lm')` returns a functional client (smoke test: call `customer.query('SELECT customer.id FROM customer LIMIT 1')` — returns the CID)
9. ✅ `getMerchantAccountsClient('eastern-lm')` returns functional client (smoke test: call `omnichannelSettings.get` on existing Phase 00 settings — returns the record)
10. ✅ Disconnect flow: row marked `revoked_at`, Redis cache cleared, "Connect" button reappears in UI
11. ✅ `mktg_agent_actions` audit rows created for connect + disconnect events
12. ✅ No plaintext `refresh_token` in any log file, code file, or database column (grep check part of CI)

---

## 6. Scope boundaries — DO NOT DO

- ❌ Any Merchant API product writes (Phase 02a)
- ❌ Any Google Ads campaign reads or writes (Phase 02b, 03)
- ❌ GCLID capture middleware (Phase 06)
- ❌ Any BullMQ worker, queue, or cron job (Phase 02+)
- ❌ Polished Marketing tab UI — only the Accounts sub-tab, minimal (Phase 07)
- ❌ Recommendations table population (Phase 05)
- ❌ Multiple brands — only `brand_id='eastern-lm'` exists for now

---

## 7. Orchestration

Session start: `claude --max-turns 25` + paste this file.
Resume: `claude --continue` — agent reads `PHASE-01-PROGRESS.md`.
Completion: write `PHASE-01-COMPLETION-REPORT.md`, push both branches, stop. Wait for review.

---

## 8. Review

Reviewer checks (all §5 acceptance + these guardrails):
- G1: no Content API imports (`grep -r "shopping-content|googleapis/content"` → empty)
- G4: audit writes present on connect/disconnect
- G5: encryption correctness + no plaintext leaks
- G7: `brand_id` parameterization
- Spec §4 schema: column types, constraints, indexes match exactly

Verdict: `PROMOTE` → unblocks 02a, 02b, 06 in parallel · `FIX` → re-run · `ESCALATE` → Adam decides.

---

*Phase 01 · April 16, 2026 · ~25 turn budget · Paste-ready.*
