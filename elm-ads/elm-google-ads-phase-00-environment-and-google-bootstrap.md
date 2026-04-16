# Phase 00 — Environment & Google Bootstrap

**Role:** You are Claude Code working on the ELM Marketing Engine build. This is Phase 00 of 11.
**Spec:** `elm-google-ads-spec-LOCKED.md` (🔒) — **authoritative**. Read it first.
**SOW:** `elm-google-ads-sow.md` — feature traceability.
**Max turns:** 25 (resume with `--continue` if hit)
**Branch:** `feature/marketing-00` on `easternLM` repo (OAuth endpoints) + create new repo `elm-marketing`
**Reports to:** `PHASE-00-COMPLETION-REPORT.md` + `PHASE-00-PROGRESS.md` (handshake)

---

## 1. Mission

Create the `elm-marketing` service repo scaffold, wire the Google API credentials on the VPS, and run a one-time bootstrap script that programmatically creates two Google Ads conversion actions, a GMC store entity, and an `OmnichannelSettings` resource. Outputs are resource IDs captured as env vars so later phases can reference them.

**You are NOT building any agents, UI, or database tables in this phase.** Those come in 01, 02, etc.

---

## 2. Diagnostic-first (MANDATORY before writing any code)

Before changing anything, perform this pre-work and report findings in your first turn:

1. **Read the spec completely.** `view elm-google-ads-spec-LOCKED.md`. Pay special attention to §0 (locked decisions), §3 (auth), §12 (prereq status).
2. **Read the SOW.** `view elm-google-ads-sow.md`. Pay special attention to §4 (guardrails).
3. **Inspect current easternLM repo structure.** `view /path/to/easternLM` — confirm `feature/marketing-ui` or similar branch exists; if not, branch from `main`.
4. **Verify env var status on VPS.** SSH to `5.161.88.134`, check `printenv | grep -E 'GOOGLE|MKTG|GMC'` (mask output; do not log secrets to the completion report).
5. **Check Cloud Console OAuth client existence.** The spec §12 marks this as Adam-owned. Confirm whether `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` are already set on the VPS. **If they are NOT set, STOP and write a blocker note to `PHASE-00-PROGRESS.md`** — this phase cannot proceed without them.
6. **Report your findings** as the first turn output. Only then begin implementation.

This diagnostic step is not optional. Adam's build discipline requires it for every phase.

---

## 3. Context

### 3.1 Locked decisions driving this phase

| Decision | Implication for Phase 00 |
|---|---|
| Path B (no MCC) | **Do NOT create an MCC.** Use existing `GOOGLE_ADS_CUSTOMER_ID=5409526270` directly. `login_customer_id` stays `undefined` in all API client constructors. |
| Single brand at launch | Seed only one row in `mktg_google_accounts` (Phase 01 creates the table). `brand_id='eastern-lm'`. |
| LIA in scope | GMC store entity `ELM-FROWEIN-01` MUST be created. `OmnichannelSettings` MUST be configured. |
| Primary + Secondary conversions | Two conversion actions, not one. Exact configs below in §5. |

### 3.2 Guardrail G1 — Merchant API v1 only

**Do NOT install or import `googleapis/content` or `@google-cloud/shopping-content` or any Content API for Shopping package.** That API sunsets August 18, 2026.

Use these packages for Merchant API v1:
- `@google-cloud/merchant-accounts` (for `OmnichannelSettings`, `LfpStores`)
- `@google-cloud/merchant-products` (for product offers — Phase 02a will use this)
- `@google-cloud/merchant-inventories` (for local inventory — Phase 02c will use this)

Use this for Google Ads API v21:
- `google-ads-api` (community-maintained, well-supported, TypeScript definitions)

### 3.3 Concrete values (copy into code/config exactly)

```
GOOGLE_ADS_CUSTOMER_ID = 5409526270    (ELM's existing CID, digits only, no dashes)
GMC_MERCHANT_ID        = 5578269156    (ELM's GMC, confirmed from screenshot)
ELM_STORE_CODE         = ELM-FROWEIN-01
STORE_ADDRESS          = 110 Frowein Road, Center Moriches, NY 11934, US
STORE_NAME             = Eastern Landscape & Mason Supply
STORE_PHONE            = +16318746244
TARGET_COUNTRY         = US
CONTENT_LANGUAGE       = en
```

### 3.4 Existing infrastructure (confirm, don't recreate)

Review memory and session summaries for existing patterns:
- Larkin Tech infrastructure template (from previous session) — reuse for `elm-marketing` scaffold (Docker, GitHub Actions, nginx)
- Port allocation pattern: prod `3100` (existing easternLM), staging `3101` (existing), `elm-marketing` gets `3300` new
- Nginx reverse proxy pattern
- Cron job setup on VPS

---

## 4. Tasks (ordered)

### 4.1 Create `elm-marketing` repo scaffold

Follow the same pattern as the Larkin Tech infrastructure template. Deliverables:

- `elm-marketing/` on GitHub (private)
- `package.json` with workspaces for future expansion:
  - Node 20+
  - TypeScript strict mode
  - Dependencies: `bullmq`, `ioredis`, `@supabase/supabase-js`, `google-ads-api`, `@google-cloud/merchant-accounts`, `@google-cloud/merchant-products`, `@google-cloud/merchant-inventories`, `pino`, `zod`
  - Dev deps: `typescript`, `tsx`, `vitest`, `@types/node`
- `tsconfig.json` strict mode
- `Dockerfile` — multi-stage build, non-root user, exposes 3300
- `docker-compose.yml` for local dev
- `.github/workflows/staging-deploy.yml` — staging auto-deploy on push (match existing easternLM pattern)
- `.github/workflows/prod-deploy.yml` — manual prod deploy (match existing pattern)
- `nginx/elm-marketing.conf` — reverse proxy on port 3300
- `src/config/env.ts` — zod-validated env loader with all required vars
- `src/index.ts` — minimal startup, logs "elm-marketing service started" — nothing else runs yet
- `.env.example` with all Google-related vars documented (see §6 env vars)
- `README.md` — setup + deploy instructions
- `CLAUDE.md` in repo root — see §4.6 for required content

### 4.2 Generate `MKTG_ENCRYPTION_KEY`

Create `scripts/generate-encryption-key.ts`:
```ts
import { randomBytes } from 'crypto';
console.log(randomBytes(32).toString('base64'));
```

Run locally, capture output, add to VPS env vars (NOT to repo, NOT to .env.example — reference only):
```
MKTG_ENCRYPTION_KEY=<32-byte base64 value generated above>
```

### 4.3 Write the bootstrap script

Create `scripts/google-bootstrap.ts` — idempotent, CLI-runnable, outputs resource IDs to stdout.

**Three operations, in order:**

#### 4.3.1 Create Conversion Action "Website Order"

Using `google-ads-api`:
```ts
const conversionActionPurchase = {
  name: 'Website Order',
  category: 'PURCHASE',              // enums.ConversionActionCategory.PURCHASE
  type: 'UPLOAD_CLICKS',             // enums.ConversionActionType.UPLOAD_CLICKS
  status: 'ENABLED',
  value_settings: {
    default_value: 0,
    default_currency_code: 'USD',
    always_use_default_value: false,  // use per-upload value
  },
  counting_type: 'ONE_PER_CLICK',
  click_through_lookback_window_days: 30,
  view_through_lookback_window_days: 1,
  attribution_model_settings: {
    attribution_model: 'GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN',
    data_driven_model_status: 'AVAILABLE',  // if unavailable, fallback to LAST_CLICK
  },
  include_in_conversions_metric: true,
};
```

Idempotency: before creating, run a GAQL search for existing conversion action with name='Website Order'. If exists, capture the existing resource name; do not recreate.

Output resource name (e.g., `customers/5409526270/conversionActions/123456789`).

#### 4.3.2 Create Conversion Action "Quote Submit"

```ts
const conversionActionLead = {
  name: 'Quote Submit',
  category: 'SUBMIT_LEAD_FORM',
  type: 'UPLOAD_CLICKS',
  status: 'ENABLED',
  value_settings: {
    default_value: 0,
    default_currency_code: 'USD',
    always_use_default_value: true,  // leads have no revenue
  },
  counting_type: 'ONE_PER_CLICK',
  click_through_lookback_window_days: 30,
  include_in_conversions_metric: false,  // PMax audience signal only, not primary
};
```

Same idempotency pattern.

#### 4.3.3 Create GMC Store Entity + OmnichannelSettings

Using `@google-cloud/merchant-accounts`:

**Step A — Create LFP Store** (Local Feed Partner store, represents your physical location):
```ts
const store = {
  storeCode: 'ELM-FROWEIN-01',
  storeName: 'Eastern Landscape & Mason Supply',
  storeAddress: '110 Frowein Road, Center Moriches, NY 11934, US',
  phoneNumber: '+16318746244',
  websiteUri: 'https://easternlm.com',
  gcidCategory: ['gcid:landscape_supply_store'],
  placeId: null,  // optional; GMC will geocode from address
};
// Call: accountsClient.createLfpStore({ parent: `accounts/${GMC_MERCHANT_ID}`, lfpStore: store })
```

**Step B — Create/Update OmnichannelSettings for US:**
```ts
const omnichannelSettings = {
  regionCode: 'US',
  lsfType: 'GHLSF_FULL',       // Google-hosted local store front, full LIA
  inStock: { uri: 'https://easternlm.com/shop' },  // where in-stock info lives
  pickup: { uri: 'https://easternlm.com/delivery' },  // pickup info page
};
// Call: accountsClient.createOmnichannelSetting({ parent: `accounts/${GMC_MERCHANT_ID}`, omnichannelSetting: ... })
```

Idempotency: if either already exists, report current state and skip create.

**Output:**
- Store code: `ELM-FROWEIN-01`
- OmnichannelSettings resource name: `accounts/5578269156/omnichannelSettings/US`

### 4.4 Capture outputs, update VPS env

The bootstrap script prints a summary block at the end:
```
✅ Phase 00 bootstrap complete.

Add these to VPS env:
  CONVERSION_ACTION_PURCHASE=customers/5409526270/conversionActions/<N>
  CONVERSION_ACTION_LEAD=customers/5409526270/conversionActions/<M>

Already confirmed existing:
  GMC_STORE_CODE=ELM-FROWEIN-01
  GMC_OMNICHANNEL_REGION=US
```

Also write the bootstrap result to `elm-marketing/docs/phase-00-bootstrap-result.json` committed to the repo (no secrets, just resource names + timestamps). This serves as Phase 01's seed data source.

### 4.5 Create OAuth flow stubs in easternLM

Create **stub files only** — full OAuth flow is Phase 01. These are placeholders so Phase 01 has a branch to build on.

Files:
- `easternLM/src/app/api/marketing/google/oauth/start/route.ts` — returns 501 Not Implemented with a JSON body noting "Phase 01 will implement"
- `easternLM/src/app/api/marketing/google/oauth/callback/route.ts` — returns 501 Not Implemented
- `easternLM/src/app/admin/marketing/page.tsx` — renders "Marketing — Phase 00 placeholder"

Commit these to `feature/marketing-01` branch on easternLM, not `feature/marketing-00`. Reason: Phase 01 will extend them, Phase 00 only scaffolds.

### 4.6 CLAUDE.md additions

In both `elm-marketing/CLAUDE.md` (new) and `easternLM/CLAUDE.md` (append a new section), add:

```markdown
## Google Ads / Merchant API — hard rules

- Use Merchant API v1 only. Content API for Shopping is deprecated and sunsets Aug 18, 2026.
  Forbidden packages: `googleapis/content`, `@google-cloud/shopping-content`.
  Required packages: `@google-cloud/merchant-accounts`, `@google-cloud/merchant-products`, `@google-cloud/merchant-inventories`.
- Use Google Ads API v21 via `google-ads-api` npm package.
- Path B: No MCC. `login_customer_id` always `undefined` in client constructors.
- `GOOGLE_ADS_CUSTOMER_ID=5409526270`, `GMC_MERCHANT_ID=5578269156`, `ELM_STORE_CODE=ELM-FROWEIN-01`.
- Refresh tokens: AES-256-GCM via `MKTG_ENCRYPTION_KEY`. Never log decrypted tokens.
- Every mutation writes to `mktg_agent_actions` audit table (once Phase 01 creates it).
- All `mktg_google_*` tables carry `brand_id`. Never hard-code `'eastern-lm'`.
- `publish_mode` default is `'suggest'`. `auto` requires explicit unlock; `read_only` blocks writes.
- ELM copy rules in feeds: "per cu. yard" (never "/yd"), "Locally sourced" badge (never "Responsibly sourced"), no founding-year claims, mulch = double ground.
```

### 4.7 Update deployment infrastructure

- Add nginx vhost for port 3300 (elm-marketing) on VPS — but upstream is empty for now (service not running)
- DNS: no new records yet (api.easternlm.com/marketing handled by existing nginx config routing /marketing/ path — confirm vs. separate subdomain — consult CLAUDE.md pattern)
- GitHub Actions: create staging deploy + prod deploy workflows, but do NOT auto-deploy on this phase's merge (service is empty — would error)

### 4.8 Write handshake + completion files

**`PHASE-00-PROGRESS.md`** — written incrementally during work, so `--continue` can resume:
```markdown
## Task checklist
- [x] 4.1 Scaffold elm-marketing repo
- [x] 4.2 Generate MKTG_ENCRYPTION_KEY
- [ ] 4.3 Bootstrap script — conversion actions
- ...
```

**`PHASE-00-COMPLETION-REPORT.md`** — written on success:
```markdown
# Phase 00 Completion Report

## Tasks completed
[list all 4.X tasks with ✅]

## Files created / modified
[list]

## Resource IDs created (for env var updates)
CONVERSION_ACTION_PURCHASE=...
CONVERSION_ACTION_LEAD=...
GMC_STORE_CODE=ELM-FROWEIN-01
GMC_OMNICHANNEL_REGION=US

## Acceptance criteria verification
[show each from §5 passing]

## Known issues / caveats
[anything the reviewer should know]

## Ready for Phase 01
Yes / No + rationale
```

---

## 5. Acceptance criteria

Each must be independently verified and included in the completion report:

1. ✅ `elm-marketing` repo exists on GitHub, clones cleanly, `npm install` succeeds, `npm run build` succeeds, `npm run dev` starts without errors
2. ✅ `.env.example` documents all required vars (see §6 below)
3. ✅ `MKTG_ENCRYPTION_KEY` is set on VPS (not in repo); `printenv MKTG_ENCRYPTION_KEY` returns a 44-char base64 string
4. ✅ `scripts/google-bootstrap.ts` runs end-to-end successfully; running it a second time is idempotent (reports "already exists, skipping")
5. ✅ Two conversion actions exist in Google Ads (verify via Google Ads UI Goals → Conversions): `Website Order` + `Quote Submit`
6. ✅ GMC store entity `ELM-FROWEIN-01` visible in GMC Stores tab with correct address
7. ✅ `OmnichannelSettings` for region=US exists in GMC (verify via Merchant API: `omnichannelSettings.get`)
8. ✅ OAuth stub endpoints return 501 Not Implemented with valid JSON body
9. ✅ `CLAUDE.md` updated in both repos with the §4.6 hard rules
10. ✅ Nginx config for port 3300 added to VPS (upstream can be empty)
11. ✅ `phase-00-bootstrap-result.json` committed with resource names (no secrets)
12. ✅ No Content API imports anywhere in code (`grep -r "shopping-content\|googleapis/content"` returns empty)

---

## 6. Required environment variables (documented in .env.example)

```bash
# Google Ads API
GOOGLE_ADS_DEVELOPER_TOKEN=         # Existing: ATXQta_xxxxx (Basic Access)
GOOGLE_ADS_CUSTOMER_ID=5409526270    # ELM's CID (Path B, no dashes)
# GOOGLE_ADS_LOGIN_CUSTOMER_ID=      # Unused at launch (Path B). Set when MCC lands.

# Merchant API
GMC_MERCHANT_ID=5578269156           # ELM's GMC

# LIA
ELM_STORE_CODE=ELM-FROWEIN-01

# OAuth (created by Adam in Cloud Console — this phase cannot proceed without these)
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=

# Encryption (generated by scripts/generate-encryption-key.ts)
MKTG_ENCRYPTION_KEY=

# Conversion actions (populated by Phase 00 bootstrap script output)
CONVERSION_ACTION_PURCHASE=          # customers/<CID>/conversionActions/<N>
CONVERSION_ACTION_LEAD=              # customers/<CID>/conversionActions/<M>

# Infra (matches existing easternLM patterns)
NEXT_PUBLIC_SUPABASE_URL=            # same as easternLM
SUPABASE_SERVICE_ROLE_KEY=           # same as easternLM (elm-marketing needs service role)
REDIS_URL=                           # shared Redis, prefix all keys with 'elm:'

# Service config
PORT=3300
NODE_ENV=production
LOG_LEVEL=info
```

---

## 7. Scope boundaries — DO NOT DO

This phase does NOT include:
- ❌ Creating any `mktg_google_*` database tables (Phase 01)
- ❌ Implementing the actual OAuth flow (stubs only; Phase 01 builds it)
- ❌ Writing any agent code (`googleAdsFeedAgent`, `googleAdsCampaignAgent`, etc.) — Phases 02+
- ❌ Creating any Google Ads campaigns (Phase 03)
- ❌ Pushing any products to GMC (Phase 02a)
- ❌ UI work beyond the "Phase 00 placeholder" page
- ❌ Cron job definitions (Phase 02+ adds these)
- ❌ Generating MCC (explicit Path B — deferred)
- ❌ Clearing the GMC Misrepresentation flag (Adam-owned, content-side)

If you find yourself tempted to do any of the above, stop and add to `PHASE-00-PROGRESS.md` as a "deferred to Phase NN" note.

---

## 8. Claude Code orchestration

### Session start
```
claude --max-turns 25
# Paste this entire file as first message.
```

### Resume if limit hit
```
claude --continue
# Agent reads PHASE-00-PROGRESS.md, picks up from last unchecked task.
```

### Completion
- Write `PHASE-00-COMPLETION-REPORT.md` with all §5 acceptance criteria checked off
- Commit and push `feature/marketing-00` branch on easternLM
- Push `elm-marketing` repo with all files
- STOP. Do not start Phase 01 — wait for meta-agent review.

### If blocked (missing OAuth credentials from Adam)
Write to `PHASE-00-PROGRESS.md`:
```markdown
## 🛑 BLOCKED
Cannot proceed — GOOGLE_OAUTH_CLIENT_ID and/or GOOGLE_OAUTH_CLIENT_SECRET not set in VPS env.
Adam must create OAuth 2.0 Web Application client in Google Cloud Console project 'elm-marketing',
set redirect URI to https://easternlm.com/api/marketing/google/oauth/callback,
and export the credentials to VPS env.
```
Exit cleanly. Do not attempt to continue without these.

---

## 9. Review

After completion, Adam runs the review prompt `elm-google-ads-review-phase-00.md` in a separate session. Reviewer will check:
- Spec compliance (§12 Prerequisites status)
- Guardrail G1 (no Content API)
- Guardrail G5 (encryption key not in repo)
- Guardrail G7 (brand_id handling correct for future MGG onboarding)
- All 12 acceptance criteria independently

Verdict options: `PROMOTE` → Phase 01 unblocked · `FIX` → operator re-runs with fix instructions · `ESCALATE` → Adam decides.

---

*Phase 00 operator prompt · Generated April 16, 2026 · ~25 turn budget · Self-contained and paste-ready.*
