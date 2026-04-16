# BUILDPLAN — ELM Google Ads + Merchant API Integration

**Spec:** `elm-google-ads-spec-LOCKED.md` (🔒 April 16, 2026)
**SOW:** `elm-google-ads-sow.md`
**Operator:** Claude Code
**Progress tracker:** `elm-google-ads-progress.md` (update after every phase)

---

## How to use this document

1. Work phases in dependency order (see §3). Parallelizable phases noted with ∥.
2. For each phase: paste the phase operator prompt into a **fresh Claude Code session**, run with the recommended `--max-turns`, resume with `--continue` if it hits the limit.
3. After builder completes: paste the matching review prompt (`elm-google-ads-review-phase-NN.md`) into a **separate** Claude Code session. The reviewer reads the spec fresh, inspects actual code, returns a verdict.
4. Review verdicts: **PROMOTE** → advance to next phase · **FIX** → re-run builder with feedback · **ESCALATE** → human decides.
5. Update `elm-google-ads-progress.md` after every phase transition.

---

## §1. Master phase table

| # | Phase name | Scope | Max turns | Parallel with | Review |
|---|---|---|---|---|---|
| 00 | environment-and-google-bootstrap | Repo scaffold, env vars, OAuth flow stubs, programmatic creation of conversion actions + GMC store entity + `OmnichannelSettings` + seed DB row | 25 | — | Yes |
| 01 | schema-and-oauth-connect | All `mktg_google_*` tables, `orders.gclid` column, admin OAuth connect/disconnect UI, Redis access-token cache | 25 | — | Yes |
| 02a | feed-agent-merchant-api | `googleAdsFeedAgent` + BullMQ worker + scheduled Supabase→GMC product sync (both `online` + `local` channels) + disapproval surfacing | 35 | 02b | Yes |
| 02b | campaign-agent-read-path | `googleAdsCampaignAgent` read-only — list campaigns/ad groups/keywords from Google Ads, mirror to `mktg_google_campaigns`, scheduled sync | 30 | 02a | Yes |
| 02c | lia-local-campaign-config | LIA-specific attributes (`pickup_method`, `pickup_sla`) on `local` offers, inventory verification, Local campaign scaffold (paused) | 25 | — (after 02a) | Yes |
| 03 | campaign-agent-write-path-and-guardrails | Write mutations for campaigns/ad groups/keywords, `publish_mode` + `monthly_budget_cap_cents` enforcement, `mktg_agent_actions` audit writes, launch paused Search + PMax for 5 categories | 30 | 04 | Yes |
| 04 | performance-pull-and-overview-ui | Daily GAQL pull into `mktg_google_performance`, Recharts Overview dashboard (spend / conversions / ROAS / top campaigns) | 25 | 03, 06 | Yes |
| 05 | optimizer-agent-and-recommendations | `googleAdsOptimizerAgent` with rule engine + confidence scoring, `mktg_google_recommendations` writes, approval UI, approved → enqueue campaign agent | 40 | 06 | Yes |
| 06 | gclid-capture-and-conversion-upload | GCLID middleware in easternLM, session→order persistence, 15-min cron upload of paid orders to Google Ads, dedup table | 25 | 03, 04, 05 | Yes |
| 07 | marketing-tab-ui-polish | Marketing tab + 6 sub-tabs (Overview, Accounts, Feed, Campaigns, Recommendations, Conversions) — full interactivity, per-brand budget editor, publish_mode toggle | 30 | — | Yes |
| 08 | playwright-e2e-coverage | E2E suite: OAuth connect, feed sync happy path, campaign CRUD, recommendation approve→apply, GCLID capture cross-browser | 20 | — | Yes |

**Total: ~280 turn-budget across 11 phases ≈ 10–12 Claude Code sessions.**

---

## §2. Execution protocol

### Starting a phase
```bash
# Fresh session, paste the operator prompt as first message
claude --max-turns 25
# (paste elm-google-ads-phase-00-environment-and-google-bootstrap.md)
```

### Resuming a phase (hit turn limit)
The operator prompt itself instructs Claude Code to write a `PHASE-NN-PROGRESS.md` handshake file before exiting. Resume:
```bash
claude --continue
# Agent reads PHASE-NN-PROGRESS.md, picks up where it left off
```

### Reviewing a phase
```bash
# In a SEPARATE Claude Code session
claude --max-turns 15
# (paste elm-google-ads-review-phase-NN.md)
# Reviewer outputs verdict JSON → PROMOTE | FIX | ESCALATE
```

### Phase completion criteria
A phase is complete only when:
1. Builder reports all tasks ✅ in its completion summary
2. Phase's own acceptance criteria pass (operator runs these itself)
3. Meta-agent review returns `PROMOTE`
4. `elm-google-ads-progress.md` updated

---

## §3. Dependency graph

```
                            ┌─→ 02a ──┬─→ 02c
                            │         │
00 ──→ 01 ──┬───────────────┤         │
            │               │         │
            │               └─→ 02b ──┴─→ 03 ──┐
            │                     │            │
            │                     └─→ 04 ──────┼─→ 05
            │                                  │
            └─────────────────→ 06 ────────────┤
                                               │
                                               └─→ 07 ──→ 08
```

**Serial-only phases:** 00, 01, 02c, 07, 08
**Parallelizable pairs:**
- 02a ∥ 02b (different Google APIs, different tables)
- 03 ∥ 04 (writes vs reads; separate endpoints)
- 06 ∥ {03, 04, 05} (only depends on 00+01)

To run phases in parallel: use separate Claude Code sessions on separate git branches (`feature/marketing-02a`, `feature/marketing-02b`). Merge only after both pass review.

---

## §4. Phase-level deliverables

### Phase 00 — environment-and-google-bootstrap
**Outputs:**
- New repo `elm-marketing` scaffolded (port 3300, Dockerfile, GitHub Actions, nginx config)
- `.env.example` with all Google-related vars documented
- `MKTG_ENCRYPTION_KEY` generation script
- Bootstrap CLI script `scripts/google-bootstrap.ts`:
  - Creates 2 conversion actions via Google Ads API (`Website Order` + `Quote Submit`)
  - Creates LIA store entity via Merchant API (`ELM-FROWEIN-01`)
  - Creates `OmnichannelSettings` for US
  - Writes resource names to stdout for env var capture
- Seed SQL: row in `mktg_google_accounts` for `brand_id='eastern-lm'` (run after Phase 01 creates the table)
- Updated `CLAUDE.md` in both repos with Google API guardrails (Merchant API v1 only, etc.)

### Phase 01 — schema-and-oauth-connect
**Outputs:**
- 6 Supabase migrations creating `mktg_google_*` tables + indexes + RLS
- Migration adding `orders.gclid` column
- `elm-marketing/src/auth/google.ts`: `getGoogleAdsClient(brandId)`, `getMerchantClient(brandId)`, token refresh utility
- `easternLM/src/app/admin/marketing/connect/page.tsx`: OAuth start page
- `easternLM/src/app/api/marketing/google/oauth/callback/route.ts`: OAuth callback handler
- Encryption utility in both repos

### Phase 02a — feed-agent-merchant-api
**Outputs:**
- `elm-marketing/src/agents/googleAdsFeedAgent.ts`: orchestrator
- `elm-marketing/src/workers/google-feed-sync.ts`: BullMQ worker
- `elm-marketing/src/google/merchant-feed.ts`: Merchant API v1 wrapper (products insert/update/delete)
- Cron definition for every-4hr sync
- Per-product sync status updates to `mktg_google_products`

### Phase 02b — campaign-agent-read-path
**Outputs:**
- `elm-marketing/src/agents/googleAdsCampaignAgent.ts`: orchestrator (read methods only)
- `elm-marketing/src/workers/google-campaign-sync.ts`: BullMQ worker
- `elm-marketing/src/google/ads-campaigns.ts`: Google Ads API wrapper (read path: list, get, GAQL)
- Cron definition for daily campaign state pull

### Phase 02c — lia-local-campaign-config
**Outputs:**
- Extended feed agent: `pickup_method='buy'` + `pickup_sla='same day'` on `channel='local'` offers
- Inventory verification submission via Merchant API
- Paused Local campaign created in Google Ads

### Phase 03 — campaign-agent-write-path-and-guardrails
**Outputs:**
- Extended campaign agent with write methods (create, update, pause, delete)
- `publish_mode` + `monthly_budget_cap_cents` pre-flight checks
- `mktg_agent_actions` audit writes on every mutation
- Launch script: creates 5 paused Search campaigns (Mulch, Topsoil, Gravel, Stone, Sand) + 1 paused PMax campaign

### Phase 04 — performance-pull-and-overview-ui
**Outputs:**
- `elm-marketing/src/workers/google-performance-pull.ts`: GAQL pull, populate `mktg_google_performance`
- `easternLM/src/app/admin/marketing/page.tsx`: Overview tab with Recharts

### Phase 05 — optimizer-agent-and-recommendations
**Outputs:**
- `elm-marketing/src/agents/googleAdsOptimizerAgent.ts`: rule engine + confidence scoring
- `elm-marketing/src/workers/google-optimize.ts`: BullMQ worker, daily 6am trigger
- `easternLM/src/app/admin/marketing/recommendations/page.tsx`: approval UI
- API routes: approve/reject endpoints, approval triggers campaign agent

### Phase 06 — gclid-capture-and-conversion-upload
**Outputs:**
- `easternLM/src/middleware.ts`: capture `?gclid=` → session cookie
- Checkout modification: persist cookie to `orders.gclid`
- `elm-marketing/src/workers/google-conversion-upload.ts`: 15-min cron, uploads paid orders
- `mktg_google_conversions_uploaded` dedup table enforcement

### Phase 07 — marketing-tab-ui-polish
**Outputs:**
- Marketing tab shell with 6 sub-tabs
- Accounts tab: connect/disconnect, publish_mode toggle, budget cap editor
- Product Feed tab: per-product sync status, manual sync button, disapproval details
- Campaigns tab: list with inline budget/status edits, "New campaign" wizard
- Recommendations tab: pending list, approve/reject, history
- Conversions tab: upload status, GCLID capture rate

### Phase 08 — playwright-e2e-coverage
**Outputs:**
- `e2e/marketing-oauth.spec.ts`
- `e2e/marketing-feed.spec.ts`
- `e2e/marketing-campaigns.spec.ts`
- `e2e/marketing-recommendations.spec.ts`
- `e2e/marketing-gclid.spec.ts`

---

## §5. Guardrails enforced in every phase

From SOW §4, repeated here for operator-prompt reference:

| G# | Guardrail |
|---|---|
| G1 | Merchant API v1 only. No Content API for Shopping imports |
| G2 | `publish_mode='suggest'` default; no auto-writes without approved recommendation |
| G3 | `monthly_budget_cap_cents` hard-checked before any budget-increasing mutation |
| G4 | All agent writes audited to `mktg_agent_actions` |
| G5 | Refresh tokens AES-256-GCM encrypted with `MKTG_ENCRYPTION_KEY` (env-only) |
| G6 | GCLID capture middleware on every landing page |
| G7 | All `mktg_google_*` tables carry `brand_id` |
| G8 | ELM copy rules: "per cu. yard", "Locally sourced" (not "Responsibly sourced"), no founding-year claims, mulch = double ground |

Each phase's operator prompt lists the guardrails relevant to its scope. Reviewer checks all 8 regardless.

---

## §6. Meta-agent review cycle

After every phase:

1. Builder writes `PHASE-NN-COMPLETION-REPORT.md` with tasks completed, files changed, acceptance criteria verified
2. Run review prompt in separate session
3. Reviewer reads: spec, SOW, completion report, actual code on disk
4. Reviewer produces verdict JSON:
```json
{
  "phase": "02a",
  "verdict": "PROMOTE" | "FIX" | "ESCALATE",
  "acceptance_criteria_passed": [ /* list */ ],
  "acceptance_criteria_failed": [ /* list, empty on PROMOTE */ ],
  "spec_violations": [ /* paths + descriptions */ ],
  "fix_instructions": "/* only on FIX */",
  "escalation_question": "/* only on ESCALATE */"
}
```
5. **PROMOTE** → advance; **FIX** → paste fix_instructions back to builder; **ESCALATE** → Adam decides

---

## §7. Environment provisions for every phase

Every operator prompt assumes the following exist or were created in Phase 00:

```
# VPS env vars (set by Adam or Phase 00)
GOOGLE_ADS_DEVELOPER_TOKEN=ATXQta_xxxxx
GOOGLE_ADS_CUSTOMER_ID=5409526270
GMC_MERCHANT_ID=5578269156
ELM_STORE_CODE=ELM-FROWEIN-01
GOOGLE_OAUTH_CLIENT_ID=<from Cloud Console>
GOOGLE_OAUTH_CLIENT_SECRET=<from Cloud Console>
MKTG_ENCRYPTION_KEY=<generated in Phase 00>

# Infra
Hetzner VPS 5.161.88.134
Ports: easternlm-prod=3100, staging=3101, elm-marketing=3300 (new)
Redis shared, key prefix 'elm:'
Supabase: existing project, new mktg_google_* tables
```

---

*BUILDPLAN generated April 16, 2026 · 11 phases, 280 turn-budget · ready for Phase 00.*
