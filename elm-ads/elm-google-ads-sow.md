# Statement of Work — ELM Google Ads + Merchant API Integration

**Project:** `elm-marketing/google-ads`
**Spec:** `elm-google-ads-spec-LOCKED.md` (🔒 April 16, 2026)
**Target delivery:** 10–12 Claude Code sessions across 9 phases (00–08)
**Operator environment:** Claude Code (primary); review prompts run in separate Claude Code sessions

---

## 1. Problem statement

Eastern LM has no paid digital acquisition running. Website traffic is organic or direct. Competitors in Suffolk County landscape supply are buying "mulch delivery" and "topsoil near me" search terms — ELM is invisible on those surfaces. Google Merchant Center exists and is verified but is not pushing product data or driving Shopping/PMax/LIA campaigns.

**Business outcome target (6 months post-launch):**
- ≥ $8k/mo attributed spend driving ≥ 3× ROAS across search + PMax + LIA
- ≥ 60% of online orders traceable to paid click (GCLID captured)
- Agent-generated recommendations reviewed ≥ weekly; ≥ 50% approval rate

---

## 2. In-scope features

| F# | Feature | Success criteria | Phase |
|---|---|---|---|
| F1 | OAuth connection to Google Ads + GMC, per-brand, encrypted refresh tokens | Admin can connect/disconnect; tokens survive restart; revocation clean | 00, 01 |
| F2 | Product feed sync from Supabase `products` → GMC offers | All active bulk products appear as both `online` and `local` offers in GMC; disapprovals surface in UI; ≤4hr staleness | 02a |
| F3 | LIA store entity + OmnichannelSettings configured | `ELM-FROWEIN-01` present in GMC Stores; inventory verification passes; LIA program active | 00, 02c |
| F4 | Campaign creation (Search + PMax) per material category | 5 Search campaigns (Mulch, Topsoil, Gravel, Stone, Sand) + 1 PMax campaign; all launch paused; admin activates in UI | 03 |
| F5 | Local Inventory Ads campaign scaffolding | 1 Local campaign targeting pickup + local surfaces; paused at launch | 02c |
| F6 | Daily performance ingestion + Overview dashboard | `mktg_google_performance` populated daily; admin dashboard shows spend/conv/ROAS trendlines (Recharts) | 04 |
| F7 | Optimizer agent + recommendations queue | Nightly analysis posts recommendations; admin approval UI; approved recs enqueue campaign agent writes | 05 |
| F8 | Offline conversion upload (Stripe orders → Google Ads) | GCLID captured on ≥60% of paid orders; upload job runs every 15min; dedup enforced | 06 |
| F9 | Admin Marketing tab (all 6 sub-tabs functional) | Overview, Accounts, Product Feed, Campaigns, Recommendations, Conversions — all functional | 07 |
| F10 | Playwright E2E coverage | OAuth, feed sync, campaign CRUD, recommendation approval, GCLID capture — all green | 08 |

---

## 3. Out of scope (v1)

- Meta Ads / Facebook Pixel integration
- Microsoft (Bing) Ads
- Google Analytics 4 bi-directional beyond conversion upload
- Product Studio API (generative ad creative)
- Device/time/audience bid adjustments
- Keyword discovery / expansion
- Automated ad copy A/B testing
- Competitor monitoring
- MyGravelGuy brand onboarding (schema supports; build triggered separately)
- MCC layer (deferred — Path B)

---

## 4. Guardrails (hard requirements)

| G# | Guardrail | Enforcement |
|---|---|---|
| G1 | No Content API for Shopping code. Merchant API v1 only. | `CLAUDE.md` ban; code review check in meta-agent review prompts |
| G2 | `publish_mode='suggest'` default; no writes without approved recommendation or explicit UI action | DB check constraint + agent pre-flight gate |
| G3 | Monthly budget cap hard-enforced per brand before any budget-increasing mutation | Pre-mutation check in `googleAdsCampaignAgent`; reject with audit log entry on breach |
| G4 | All agent writes audited to `mktg_agent_actions` | Shared audit table; no exceptions |
| G5 | Refresh tokens encrypted AES-256-GCM; `MKTG_ENCRYPTION_KEY` never in repo | Env var only; rotate protocol documented in Phase 00 |
| G6 | GCLID capture middleware runs on every landing page load; persists to session cookie then `orders.gclid` | Unit test + Playwright E2E in Phase 08 |
| G7 | All `mktg_google_*` tables carry `brand_id` for future MGG onboarding without migration | Schema review in Phase 01 meta-agent review |
| G8 | Price display in feeds/ads must follow ELM copy rules: "per cu. yard" (never "/yd"), "Locally sourced" badge (never "Responsibly sourced"), no founding-year claims | Feed agent title/description templates reviewed in Phase 02a |

---

## 5. Integration touchpoints

| System | Direction | What flows |
|---|---|---|
| Supabase `products` | Read | Product catalog for feed sync |
| Supabase `orders` | Read (post-paid) | Conversion upload source |
| Supabase `orders.gclid` | Write (checkout) | Capture of paid click attribution |
| Supabase `mktg_google_*` | Read + Write | All agent state |
| Google Ads API v21 | Read + Write (guarded) | Campaigns, ad groups, keywords, performance, conversion uploads |
| Merchant API v1 | Read + Write | Products, omnichannel settings, store inventory |
| Google Business Profile | Read (via GMC link) | Location verification for LIA |
| Redis (shared, `elm:` prefix) | Read + Write | BullMQ queues, access token cache |
| VPS cron | Trigger | 5 scheduled jobs (feed, perf, optimize, conversions, token refresh) |

---

## 6. Deliverables by phase

```
Phase 00 → env + OAuth client config, MKTG_ENCRYPTION_KEY, conversion actions created, GMC store + omnichannel settings created, seed mktg_google_accounts row
Phase 01 → All mktg_google_* tables + orders.gclid column + admin OAuth connect/disconnect UI
Phase 02a → googleAdsFeedAgent + BullMQ worker + scheduled sync + disapproval UI
Phase 02b → googleAdsCampaignAgent read path + scheduled campaign mirror pull
Phase 02c → LIA-specific: pickup_method/pickup_sla on local offers, inventory verification, Local campaign scaffold (paused)
Phase 03 → googleAdsCampaignAgent write path + guardrails + Search + PMax campaigns for 5 categories (paused)
Phase 04 → Performance pull cron + Overview dashboard (Recharts)
Phase 05 → googleAdsOptimizerAgent + recommendation engine + approval UI
Phase 06 → GCLID capture middleware + offline conversion upload cron
Phase 07 → Marketing tab polish (all 6 sub-tabs)
Phase 08 → Playwright E2E test suite
```

Each phase produces: working code on `feature/marketing-*` branch, updated `SESSION_LOG.md`, phase completion report, meta-agent review verdict before promotion.

---

## 7. Success criteria (overall)

System is production-ready when:
1. OAuth connect flow works end-to-end for `brand_id='eastern-lm'`
2. Product feed shows ≥ 15 active ELM products in GMC with no disapprovals
3. At least one Search and one PMax campaign launch-ready (admin can click activate)
4. LIA inventory verification passes Google review
5. Daily performance data populating for ≥ 7 consecutive days
6. Optimizer has posted ≥ 1 actionable recommendation
7. GCLID capture rate ≥ 60% on test orders across Chrome, Safari, Firefox
8. All Playwright E2E green
9. Meta-agent review on every phase returns `PROMOTE`

---

*SOW signed off April 16, 2026 for handoff to `build-prompter`.*
