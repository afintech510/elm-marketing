-- ELM Marketing Engine — Migration 002: Tables
-- 12 tables in FK dependency order

-- 1. mktg_brands — brand configuration and voice rules
CREATE TABLE IF NOT EXISTS mktg_brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  publish_mode mktg_publish_mode NOT NULL DEFAULT 'draft_only',
  voice_rules jsonb NOT NULL DEFAULT '{}',
  content_pillars jsonb NOT NULL DEFAULT '[]',
  platform_accounts jsonb NOT NULL DEFAULT '{}',
  hashtag_sets jsonb NOT NULL DEFAULT '{}',
  posting_schedule jsonb NOT NULL DEFAULT '{}',
  geo_target jsonb NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. mktg_agent_memory — persistent brand context for agent prompts
CREATE TABLE IF NOT EXISTS mktg_agent_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES mktg_brands(id) ON DELETE RESTRICT,
  namespace text NOT NULL,
  key text NOT NULL,
  value jsonb NOT NULL DEFAULT '{}',
  updated_by text NOT NULL DEFAULT 'bootstrap',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(brand_id, namespace, key)
);

-- 3. mktg_device_tokens — auth tokens for photo capture PWA
CREATE TABLE IF NOT EXISTS mktg_device_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES mktg_brands(id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE,
  label text NOT NULL DEFAULT '',
  role mktg_auth_role NOT NULL DEFAULT 'uploader',
  is_active boolean NOT NULL DEFAULT true,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 4. mktg_agent_tasks — task dispatch queue metadata
CREATE TABLE IF NOT EXISTS mktg_agent_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES mktg_brands(id) ON DELETE RESTRICT,
  task_id text NOT NULL UNIQUE,
  assigned_agent mktg_agent_name NOT NULL,
  task_type text NOT NULL,
  status mktg_task_status NOT NULL DEFAULT 'pending',
  priority mktg_task_priority NOT NULL DEFAULT 'normal',
  approval_tier text NOT NULL DEFAULT 'DRAFT_AND_SHOW',
  input jsonb NOT NULL DEFAULT '{}',
  output jsonb,
  token_usage jsonb,
  depends_on text[],
  retry_count integer NOT NULL DEFAULT 0,
  approved_at timestamptz,
  rejected_at timestamptz,
  rejection_reason text,
  deadline timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mktg_agent_tasks_status_priority
  ON mktg_agent_tasks(status, priority);
CREATE INDEX IF NOT EXISTS idx_mktg_agent_tasks_brand_agent_status
  ON mktg_agent_tasks(brand_id, assigned_agent, status);

-- 5. mktg_content_calendar — weekly content plans
CREATE TABLE IF NOT EXISTS mktg_content_calendar (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES mktg_brands(id) ON DELETE RESTRICT,
  week_start date NOT NULL,
  plan jsonb NOT NULL DEFAULT '{}',
  pillar_counts jsonb NOT NULL DEFAULT '{}',
  status mktg_calendar_status NOT NULL DEFAULT 'draft',
  rotation_warning boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(brand_id, week_start)
);

-- 6. mktg_content_library — generated content before approval
CREATE TABLE IF NOT EXISTS mktg_content_library (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES mktg_brands(id) ON DELETE RESTRICT,
  calendar_id uuid REFERENCES mktg_content_calendar(id) ON DELETE SET NULL,
  content_type text NOT NULL DEFAULT 'social_post',
  pillar mktg_content_pillar NOT NULL,
  platform mktg_platform NOT NULL,
  body text NOT NULL DEFAULT '',
  hashtags text[] NOT NULL DEFAULT '{}',
  cta_url text,
  image_asset_ids uuid[] NOT NULL DEFAULT '{}',
  status mktg_content_status NOT NULL DEFAULT 'draft',
  scheduled_for timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mktg_content_library_brand_status
  ON mktg_content_library(brand_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mktg_content_library_calendar
  ON mktg_content_library(calendar_id);

-- 7. mktg_social_posts — published posts + engagement
CREATE TABLE IF NOT EXISTS mktg_social_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES mktg_brands(id) ON DELETE RESTRICT,
  content_id uuid NOT NULL REFERENCES mktg_content_library(id) ON DELETE CASCADE,
  platform mktg_platform NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  platform_post_id text,
  status text NOT NULL DEFAULT 'scheduled',
  published_at timestamptz,
  scheduled_for timestamptz,
  engagement jsonb NOT NULL DEFAULT '{}',
  engagement_fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mktg_social_posts_scheduled
  ON mktg_social_posts(scheduled_for, status);
CREATE INDEX IF NOT EXISTS idx_mktg_social_posts_brand_platform
  ON mktg_social_posts(brand_id, platform, published_at DESC);

-- 8. mktg_image_assets — photo uploads + formatted versions
CREATE TABLE IF NOT EXISTS mktg_image_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES mktg_brands(id) ON DELETE RESTRICT,
  asset_type mktg_asset_type NOT NULL DEFAULT 'raw_upload',
  storage_path text NOT NULL,
  original_asset_id uuid REFERENCES mktg_image_assets(id) ON DELETE SET NULL,
  dimensions jsonb,
  file_size_bytes integer,
  tags text[] NOT NULL DEFAULT '{}',
  original_filename text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mktg_image_assets_brand_type
  ON mktg_image_assets(brand_id, asset_type);
CREATE INDEX IF NOT EXISTS idx_mktg_image_assets_tags
  ON mktg_image_assets USING GIN(tags);

-- 9. mktg_reviews — Google/Yelp reviews + response drafts
CREATE TABLE IF NOT EXISTS mktg_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES mktg_brands(id) ON DELETE RESTRICT,
  platform mktg_review_platform NOT NULL,
  platform_review_id text,
  rating integer,
  review_text text,
  reviewer_name text,
  reviewed_at timestamptz,
  response_draft text,
  response_status mktg_review_response_status NOT NULL DEFAULT 'pending',
  response_posted_at timestamptz,
  order_id uuid,
  solicitation_sent boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mktg_reviews_brand_response
  ON mktg_reviews(brand_id, response_status);

-- 10. mktg_competitor_accounts — monitored accounts
CREATE TABLE IF NOT EXISTS mktg_competitor_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES mktg_brands(id) ON DELETE RESTRICT,
  platform text NOT NULL,
  account_handle text NOT NULL,
  display_name text,
  account_type mktg_competitor_type NOT NULL DEFAULT 'competitor',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 11. mktg_competitor_snapshots — engagement history
CREATE TABLE IF NOT EXISTS mktg_competitor_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES mktg_competitor_accounts(id) ON DELETE CASCADE,
  snapshot_date date NOT NULL,
  follower_count integer,
  avg_engagement numeric,
  top_content_types jsonb,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, snapshot_date)
);

-- 12. mktg_analytics_snapshots — weekly reports + competitor digests
CREATE TABLE IF NOT EXISTS mktg_analytics_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES mktg_brands(id) ON DELETE RESTRICT,
  snapshot_type text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mktg_analytics_snapshots_brand_type
  ON mktg_analytics_snapshots(brand_id, snapshot_type, period_start);
