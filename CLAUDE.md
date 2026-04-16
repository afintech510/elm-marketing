# ELM Marketing Engine

AI-powered autonomous social media marketing system for Eastern Landscape & Mason Supply.

## Architecture

- **Runtime:** 5 Docker containers (orchestrator + 4 specialist agents)
- **Queue:** BullMQ on shared Redis (`elm:` prefix isolation)
- **Database:** Supabase PostgreSQL (`mktg_*` tables)
- **AI:** Claude Agent SDK with Sonnet 4.6
- **Admin UI:** Lives in the easternLM repo (`feature/marketing-ui` branch)

## Services

| Service | Port | Purpose |
|---------|------|---------|
| orchestrator | 3200 | Express API, WebSocket, intent classification, cron scheduling |
| copy | — | Caption generation, calendar planning, review response drafting |
| image | — | Photo formatting via Sharp for platform specs |
| soc | — | Social media publishing (Meta, GBP), review monitoring |
| intel | — | GA4 analytics, competitor monitoring, weekly reports |

## Conventions

- All Redis keys use `elm:` prefix
- All Supabase tables use `mktg_` prefix
- BullMQ queues: `elm-queue-copy`, `elm-queue-image`, `elm-queue-soc`, `elm-queue-intel`
- Brand-scoped: all crons loop over active brands (multi-brand ready)
- Token budget enforced per-agent per-day via Redis

## Related Repos

- **easternLM** — Main web platform (Next.js), admin UI lives here
- **host-hampton-ops** — Reference architecture (same VPS, same Redis)

## Google Ads / Merchant API — hard rules

- Use Merchant API v1 only. Content API for Shopping is deprecated and sunsets Aug 18, 2026.
  Forbidden packages: `googleapis/content`, `@google-cloud/shopping-content`.
  Required packages: `@google-shopping/accounts`, `@google-shopping/products`, `@google-shopping/inventories`.
- Use Google Ads API v21 via `google-ads-api` npm package.
- Path B: No MCC. `login_customer_id` always `undefined` in client constructors.
- `GOOGLE_ADS_CUSTOMER_ID=5409526270`, `GMC_MERCHANT_ID=5578269156`, `ELM_STORE_CODE=ELM-FROWEIN-01`.
- Refresh tokens: AES-256-GCM via `MKTG_ENCRYPTION_KEY`. Never log decrypted tokens.
- Every mutation writes to `mktg_agent_actions` audit table (once Phase 01 creates it).
- All `mktg_google_*` tables carry `brand_id`. Never hard-code `'eastern-lm'`.
- `publish_mode` default is `'suggest'`. `auto` requires explicit unlock; `read_only` blocks writes.
- ELM copy rules in feeds: "per cu. yard" (never "/yd"), "Locally sourced" badge (never "Responsibly sourced"), no founding-year claims, mulch = double ground.
