# ELM Marketing Engine — AGENTS.md

Autonomous AI marketing agent system for Eastern Landscape & Mason Supply (content generation, photo formatting, social publishing, analytics).

## What this is

A 5-container system where an **orchestrator** receives owner commands (chat / webhooks / cron), classifies intent, runs an approval gate, and dispatches work to four specialist agents over BullMQ. The agents:

| Service | Container | Port | Role |
|---------|-----------|------|------|
| orchestrator | `elm_orchestrator` | 3200 | Express HTTP API + WebSocket, intent classification, approval gate, token-budget enforcement, `node-cron` scheduling |
| copy | `elm_copy` | — | Caption generation, weekly calendar planning, review-response drafting |
| image | `elm_image` | — | Photo formatting (Sharp) to platform specs |
| soc | `elm_soc` | — | Social publishing (Meta, GBP), review monitoring, review solicitation SMS |
| intel | `elm_intel` | — | GA4 analytics, competitor monitoring, weekly reports |

Conventions (from `CLAUDE.md`): Supabase tables are prefixed `mktg_*`; BullMQ queues are `elm-queue-{agent}`; all crons loop over active brands (multi-brand ready); per-agent/per-day token budget enforced via Redis.

The admin UI is **not** in this repo — it lives in the `easternLM` repo (`feature/marketing-ui` branch).

## Stack

- Node 20 (Alpine), TypeScript, ES modules (note `.js` import suffixes in source).
- orchestrator: Express 4, `ws`, `node-cron`, `zod`, BullMQ.
- Queue: BullMQ on shared Redis.
- DB: Supabase (PostgreSQL), service-role key.
- AI: `@anthropic-ai/sdk` (Claude). Models referenced in code: `claude-sonnet-4-6` (chat/responses), `claude-haiku-4-5-20251001` (prompt-injection guard).
- image agent: Sharp.
- Tests: Vitest (orchestrator only).

## Where it runs

- **Host:** single Hetzner VPS, IP `5.161.88.134`, SSH alias `hampton-vps` (user `root`, key `~/.ssh/id_ed25519_headless`). Cloudflare sits in front.
- **Project path on host:** `/opt/elm-marketing`.
- **Proxy:** shared nginx container `hampton_nginx`. Public routes (see `nginx/marketing.conf`):
  - `location /marketing/` → `http://elm_orchestrator:3200/`
  - `location /marketing/ws` → `http://elm_orchestrator:3200/ws` (WebSocket upgrade; orchestrator serves WS at `/ws`)
- **Shared network:** external Docker network referenced in `docker-compose.yml` as service `hampton_net` with real name `hosthampton_hampton_net` (owned by host-hampton-ops). The orchestrator joins both `elm_marketing_net` and `hampton_net`.
- **Shared Redis:** `hampton_redis:6379` on the shared network (set via `REDIS_URL`). BullMQ queue names carry the `elm-queue-` prefix for isolation.

## Run locally

From repo root:

```bash
cp .env.example .env     # then fill in secrets (never commit .env)
docker-compose up --build
```

`REDIS_URL` in `.env.example` points at `hampton_redis:6379`; for local-only runs without the shared network you must either provide your own Redis and override `REDIS_URL` (e.g. `redis://localhost:6379`) or start the shared `hampton_net` Redis. BullMQ falls back to `redis://localhost:6379` if `REDIS_URL` is unset.

Per-service dev (run inside a service dir, e.g. `services/orchestrator`):

```bash
npm install
npm run dev      # tsx watch src/index.ts
npm run build    # tsc -> dist/
npm start        # node dist/index.js
npm test         # vitest run (orchestrator only)
```

Health check once up: `curl http://localhost:3200/health`

## Deploy

There is **no CI/CD and no deploy script** in this repo (no GitHub Actions). Deploy is manual over SSH:

```bash
ssh hampton-vps
cd /opt/elm-marketing
git pull
docker-compose up -d --build
docker-compose ps
curl -s http://localhost:3200/health
```

nginx route blocks (`nginx/marketing.conf`) are applied to the shared `hampton_nginx` server config separately — they are not auto-installed by compose.

## Database

- **Supabase project ref:** `qnwevkgrhdrjqvvabcit` (URL `https://qnwevkgrhdrjqvvabcit.supabase.co`). Shared with the `easternLM` project; this system owns only the `mktg_*` tables.
- **Migrations:** `db/migrations/`, applied in order:
  - `001_enums.sql`
  - `002_tables.sql`
  - `003_triggers.sql`
  - `004_rls.sql`
  - `005_seed_brand.sql` (seeds brand slug `eastern-lm`, publish mode `draft_only`)
  - `006_seed_memory.sql`
- **How to apply:** there is no migration runner in the repo. Run each file in order against the Supabase project (Supabase SQL editor, or `psql`/`supabase db` with the project connection string). They use `CREATE TABLE IF NOT EXISTS`, so re-running is generally safe.
- **Key `mktg_*` tables** (12 total, see `002_tables.sql`):
  - `mktg_brands` — brand config: voice rules, content pillars, platform accounts, posting schedule, `publish_mode`.
  - `mktg_agent_memory` — persistent per-brand context injected into agent prompts.
  - `mktg_agent_tasks` — task dispatch metadata (mirrors BullMQ jobs; keyed by `task_id`).
  - `mktg_content_calendar` — weekly plans (`week_start`, pillar counts).
  - `mktg_content_library` — generated content pre/post approval (`status` drives the approval flow).
  - `mktg_social_posts` — published posts + engagement (`idempotency_key` unique).
  - `mktg_image_assets` — raw + formatted photos.
  - `mktg_reviews` — reviews + response drafts.
  - `mktg_competitor_accounts`, `mktg_competitor_snapshots` — competitor monitoring.
  - `mktg_analytics_snapshots` — weekly reports / digests.
  - `mktg_device_tokens` — auth tokens for the photo-capture PWA.

## Environment & secrets

Secrets live in `/opt/elm-marketing/.env` on the host (git-ignored; `.env.example` is the template). Every service loads it via `env_file: .env` in `docker-compose.yml`. **Never commit `.env` or print secret values.**

Required at orchestrator startup (process exits if missing): `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.

Full variable **names** (`.env.example`):

- `ANTHROPIC_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `REDIS_URL`
- `META_ACCESS_TOKEN`
- `META_PAGE_ID`
- `META_IG_ACCOUNT_ID`
- `GOOGLE_GBP_SERVICE_ACCOUNT_JSON`
- `GOOGLE_GA4_SERVICE_ACCOUNT_JSON`
- `GA4_PROPERTY_ID`
- `RINGCENTRAL_JWT_TOKEN`
- `RINGCENTRAL_SMS_FROM`
- `MARKETING_ADMIN_PASSWORD` (Bearer token for `/api/*`; if unset, auth is disabled — dev only)
- `DELIVERY_WEBHOOK_SECRET` (checked via `X-Webhook-Secret` header on the delivery webhook)
- `DAILY_TOKEN_BUDGET_CENTS`
- `PORT` (3200)
- `NODE_ENV`

## Cron / scheduled jobs

`node-cron` schedules are registered in `services/orchestrator/src/crons.ts`, all in `America/New_York`, each looping over active brands. Non-critical jobs are skipped when the daily token budget is over 80%.

| Cron | Schedule | Task → agent | Critical |
|------|----------|--------------|----------|
| Weekly calendar | `0 5 * * 1` (Mon 5:00 AM) | `generate_weekly_calendar` → copy | yes |
| Check reviews | `0 6 * * *` (daily 6:00 AM) | `check_new_reviews` → soc | no |
| Publish posts | `0 7,10,14 * * *` (7 AM, 10 AM, 2 PM) | `publish_scheduled_posts` → soc | yes |
| Weekly analytics | `0 16 * * 5` (Fri 4:00 PM) | `weekly_analytics_report` → intel | no |
| Fetch engagement | `0 20 * * *` (daily 8:00 PM) | `fetch_post_engagement` → soc | no |
| Auto-archive stale content | `0 23 * * *` (daily 11:00 PM) | inline: archive `pending_approval` content older than 14 days | — |
| Daily spend check | `0 0 * * *` (midnight) | inline: log daily spend / Meta-token placeholder | — |

**BullMQ queue names:** `elm-queue-copy`, `elm-queue-image`, `elm-queue-soc`, `elm-queue-intel`. Jobs use `attempts: 3`, exponential backoff (5 s), `jobId = task_id` for idempotency.

## Day-to-day cheat sheet

```bash
# SSH in
ssh hampton-vps && cd /opt/elm-marketing

# Status + health
docker-compose ps
curl -s http://localhost:3200/health

# Logs (orchestrator, follow)
docker-compose logs -f orchestrator

# Rebuild + restart after a pull
git pull && docker-compose up -d --build

# Restart a single agent
docker-compose restart soc

# Inspect a queue's depth in shared Redis (note BullMQ keys are colon-namespaced)
docker exec -it hampton_redis redis-cli keys 'bull:elm-queue-*'

# Run orchestrator tests locally
cd services/orchestrator && npm test
```

## Key files

- `docker-compose.yml` — 5 services, container names, ports, networks, healthchecks.
- `nginx/marketing.conf` — `/marketing/` and `/marketing/ws` proxy blocks (apply to shared `hampton_nginx`).
- `.env.example` — env var template.
- `services/orchestrator/src/index.ts` — HTTP/WS server, all `/api/*` endpoints, `/health`, delivery webhook, startup.
- `services/orchestrator/src/crons.ts` — scheduled jobs.
- `services/orchestrator/src/queues.ts` — BullMQ queue setup + `dispatchTask`.
- `services/orchestrator/src/{router,intentClassifier,approvalGate,budget,brandContext,memoryManager,websocket}.ts` — core pipeline.
- `services/{copy,image,soc,intel}/src/` — specialist agent workers.
- `db/migrations/001_*.sql … 006_*.sql` — schema, RLS, triggers, seeds.

## Gotchas / operational rules

- **Shared infra:** `hampton_redis` and the `hampton_nginx`/`hampton_net` (`hosthampton_hampton_net`) network are owned by host-hampton-ops. Don't restart or reconfigure them from here; this project only attaches to them.
- **Supabase ref `qnwevkgrhdrjqvvabcit` is shared with easternLM.** Stay within `mktg_*` tables; never drop/alter non-prefixed tables.
- **No CI:** every deploy is a manual `git pull && docker-compose up -d --build` on the VPS.
- **No migration runner:** apply `db/migrations/*.sql` by hand, in numeric order.
- **Auth:** `/api/*` requires `Authorization: Bearer <MARKETING_ADMIN_PASSWORD>`. If `MARKETING_ADMIN_PASSWORD` is empty, auth is bypassed — never deploy that way. `/health` is unauthenticated. The delivery webhook uses `X-Webhook-Secret`.
- **WebSocket path mismatch is intentional:** clients connect to `/marketing/ws`; nginx rewrites to the orchestrator's `/ws`.
- **Default brand slug is `eastern-lm`** (the chat API defaults `brand_slug` to it). Brand `publish_mode` (`draft_only` vs `live`) controls whether approved content becomes `approved` or `scheduled`.
- **Token budget:** non-critical crons self-skip above 80% of `DAILY_TOKEN_BUDGET_CENTS`; owner-initiated commands are blocked once the daily budget is exhausted.
- **Secrets:** only ever live in `/opt/elm-marketing/.env`. Don't echo them in logs, commits, or this file.
