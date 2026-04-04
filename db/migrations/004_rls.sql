-- ELM Marketing Engine — Migration 004: Row Level Security
-- Deny-all for anon and authenticated roles. Service role bypasses automatically.

DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'mktg_brands',
      'mktg_agent_memory',
      'mktg_device_tokens',
      'mktg_agent_tasks',
      'mktg_content_calendar',
      'mktg_content_library',
      'mktg_social_posts',
      'mktg_image_assets',
      'mktg_reviews',
      'mktg_competitor_accounts',
      'mktg_competitor_snapshots',
      'mktg_analytics_snapshots'
    ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', tbl);
  END LOOP;
END $$;

-- No policies = deny all for non-service-role access
-- The service role key (used by agents) bypasses RLS automatically
