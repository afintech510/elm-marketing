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
