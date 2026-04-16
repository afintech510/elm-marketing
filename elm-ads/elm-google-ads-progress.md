# ELM Google Ads Build Progress Tracker

Update this file after every phase transition. Copy to `elm-marketing/docs/` once repo exists.

---

## Phase status

| # | Phase | Status | Started | Completed | Reviewer verdict | Branch | Notes |
|---|---|---|---|---|---|---|---|
| 00 | environment-and-google-bootstrap | ⏳ Ready | — | — | — | `feature/marketing-00` | Blocks: OAuth client creation in Cloud Console (Adam) |
| 01 | schema-and-oauth-connect | ⏳ Blocked by 00 | — | — | — | `feature/marketing-01` | — |
| 02a | feed-agent-merchant-api | ⏳ Blocked by 01 | — | — | — | `feature/marketing-02a` | Can run ∥ with 02b |
| 02b | campaign-agent-read-path | ⏳ Blocked by 01 | — | — | — | `feature/marketing-02b` | Can run ∥ with 02a |
| 02c | lia-local-campaign-config | ⏳ Blocked by 02a | — | — | — | `feature/marketing-02c` | Also requires: Misrepresentation cleared |
| 03 | campaign-agent-write-path-and-guardrails | ⏳ Blocked by 02b | — | — | — | `feature/marketing-03` | Can run ∥ with 04 |
| 04 | performance-pull-and-overview-ui | ⏳ Blocked by 02b | — | — | — | `feature/marketing-04` | Can run ∥ with 03 and 06 |
| 05 | optimizer-agent-and-recommendations | ⏳ Blocked by 03, 04 | — | — | — | `feature/marketing-05` | — |
| 06 | gclid-capture-and-conversion-upload | ⏳ Blocked by 00, 01 | — | — | — | `feature/marketing-06` | Can run ∥ with 03, 04, 05 |
| 07 | marketing-tab-ui-polish | ⏳ Blocked by 03, 04, 05 | — | — | — | `feature/marketing-07` | — |
| 08 | playwright-e2e-coverage | ⏳ Blocked by 07 | — | — | — | `feature/marketing-08` | — |

**Status legend:** ⏳ Ready / Blocked · 🔨 In progress · 👀 Under review · ✅ PROMOTE · ❌ FIX (cycle count) · ⚠️ ESCALATE

---

## External prerequisites (Adam-owned)

| Item | Status | Blocks |
|---|---|---|
| GMC `5578269156` exists + verified | ✅ Done | — |
| GBP linked to GMC | ✅ Done | — |
| Google Ads CID `5409526270` linked to GMC | ✅ Done | — |
| Developer token `ATXQta_xxxxx` (Basic Access) | ✅ Done | — |
| GMC Misrepresentation flag cleared | 🟡 In Google review | 02a going live, 02c |
| Google Cloud Console OAuth 2.0 client | ❌ Not started | 00 |
| `GOOGLE_OAUTH_CLIENT_ID` + `_SECRET` in VPS env | ❌ Not set | 00 |

---

## Review cycles per phase

Track FIX cycle count — if any phase hits 3 FIX cycles, escalate to Adam for pattern analysis.

| Phase | Cycle 1 | Cycle 2 | Cycle 3 |
|---|---|---|---|
| 00 | — | — | — |
| 01 | — | — | — |
| 02a | — | — | — |
| ... | — | — | — |

---

## Go-live checklist (post Phase 08)

- [ ] All 11 phases `✅ PROMOTE`
- [ ] Playwright E2E green across Chrome + Firefox + WebKit
- [ ] `elm-marketing` container deployed to VPS (port 3300)
- [ ] All 5 cron jobs running + logging
- [ ] Admin UI Marketing tab live on easternlm.com/admin/marketing
- [ ] OAuth connect flow tested with real `adam@easternbuilding.supply` account
- [ ] At least 1 Search + 1 PMax campaign created (still paused)
- [ ] LIA inventory verification passed by Google
- [ ] First GCLID captured on test order
- [ ] First offline conversion uploaded + visible in Google Ads
- [ ] Adam clicks "Activate" on first campaign → real spend begins

---

*Tracker created April 16, 2026. Update on every phase transition.*
