-- ELM Marketing Engine — Migration 001: Enums
-- 13 custom enum types for the marketing engine

DO $$ BEGIN
  CREATE TYPE mktg_content_status AS ENUM (
    'idea', 'draft', 'pending_approval', 'approved', 'scheduled', 'published', 'rejected', 'archived'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE mktg_publish_mode AS ENUM ('draft_only', 'live');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE mktg_content_pillar AS ENUM (
    'product_showcase', 'delivery_action', 'seasonal_tips', 'before_after',
    'local_community', 'promotions', 'behind_scenes'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE mktg_platform AS ENUM (
    'instagram_feed', 'instagram_story', 'instagram_reel',
    'facebook_page', 'facebook_story',
    'google_business_profile',
    'nextdoor'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE mktg_task_status AS ENUM (
    'pending', 'in_progress', 'completed', 'failed', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE mktg_task_priority AS ENUM ('urgent', 'high', 'normal', 'low');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE mktg_agent_name AS ENUM (
    'orchestrator', 'copy', 'image', 'soc', 'intel',
    'outbound', 'list', 'paid'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE mktg_asset_type AS ENUM (
    'raw_upload', 'formatted_ig_feed', 'formatted_ig_story',
    'formatted_fb', 'formatted_gbp', 'watermarked'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE mktg_review_platform AS ENUM ('google', 'yelp', 'facebook');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE mktg_review_response_status AS ENUM (
    'pending', 'approved', 'posted', 'skipped'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE mktg_competitor_type AS ENUM (
    'competitor', 'local_landscaper', 'lifestyle', 'community'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE mktg_calendar_status AS ENUM (
    'draft', 'active', 'completed', 'archived'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE mktg_auth_role AS ENUM ('owner', 'approver', 'uploader');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
