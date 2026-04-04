-- ELM Marketing Engine — Migration 003: updated_at triggers

CREATE OR REPLACE FUNCTION mktg_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to all 12 mktg_* tables
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
    EXECUTE format(
      'DROP TRIGGER IF EXISTS set_updated_at ON %I; CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION mktg_set_updated_at();',
      tbl, tbl
    );
  END LOOP;
END $$;
