-- ELM Marketing Engine — Migration 006: Seed agent memory + competitor accounts

-- Helper: get brand_id for Eastern LM
DO $$
DECLARE
  v_brand_id uuid;
BEGIN
  SELECT id INTO v_brand_id FROM mktg_brands WHERE slug = 'eastern-lm';

  -- ═══ NAMESPACE: brand ═══

  INSERT INTO mktg_agent_memory (brand_id, namespace, key, value, updated_by) VALUES
  (v_brand_id, 'brand', 'voice_rules', '{
    "always_use": ["family-owned", "per cu. yard", "cu yds", "Add to Order", "double ground", "Locally sourced", "(631) 874-6244"],
    "never_use": ["/yd", "cart", "Add to Cart", "established in", "founding year", "triple ground standard", "responsibly sourced", "BNPL surcharge"],
    "tone": "Professional but approachable. Knowledgeable about materials. Local pride. Suffolk County community voice. Never corporate or pushy.",
    "location_reference": "110 Frowein Road, Center Moriches, NY 11934",
    "service_area": "Suffolk County — Patchogue to Southampton, 65 towns",
    "mulch_note": "Mulch is double ground standard. Triple ground (black and natural only) available by request, 20-yard minimum — never listed as standard.",
    "cta_patterns": {
      "instagram": "Link in bio or DM for pricing",
      "facebook": "Shop now at easternlm.com or call (631) 874-6244",
      "gbp": "Visit easternlm.com/shop or call (631) 874-6244"
    }
  }'::jsonb, 'bootstrap'),

  (v_brand_id, 'brand', 'products_bulk', '{
    "materials": [
      {"name": "Screened Topsoil", "slug": "screened-topsoil", "category": "soil"},
      {"name": "50/50 Premium Compost", "slug": "premium-compost", "category": "soil"},
      {"name": "Ultimate Jet Black Mulch", "slug": "jet-black-mulch", "category": "mulch"},
      {"name": "Natural LI Mulch", "slug": "natural-li-mulch", "category": "mulch"},
      {"name": "Hamptons Chocolate Brown Mulch", "slug": "chocolate-brown-mulch", "category": "mulch"},
      {"name": "Red Mulch", "slug": "red-mulch", "category": "mulch"},
      {"name": "RCA #1 (Recycled Concrete)", "slug": "rca-1", "category": "gravel"},
      {"name": "RCA #2 (Recycled Concrete)", "slug": "rca-2", "category": "gravel"},
      {"name": "LI Pea Gravel 3/8\"", "slug": "pea-gravel", "category": "gravel"},
      {"name": "LI Natural Gravel 3/4\"", "slug": "natural-gravel", "category": "gravel"},
      {"name": "Crushed Bluestone", "slug": "crushed-bluestone", "category": "stone"},
      {"name": "Crushed Whitestone", "slug": "crushed-whitestone", "category": "stone"},
      {"name": "Pocono River Rock", "slug": "pocono-river-rock", "category": "stone"},
      {"name": "Crushed Burgundy", "slug": "crushed-burgundy", "category": "stone"},
      {"name": "LI Concrete Sand", "slug": "concrete-sand", "category": "sand"},
      {"name": "LI Screened Mason Sand", "slug": "mason-sand", "category": "sand"}
    ]
  }'::jsonb, 'bootstrap'),

  (v_brand_id, 'brand', 'products_popular_nonbulk', '{
    "materials": [
      "Cambridge Pavingstones (various styles)",
      "Belgard Pavers",
      "Nicolock Pavers",
      "Natural Flagstone",
      "Thermal Bluestone Pavers",
      "Retaining Wall Blocks (Cambridge, Belgard)",
      "Landscape Fabric (rolls)",
      "Drainage Pipe (corrugated + solid)",
      "Edging (steel, aluminum, plastic)",
      "Lawn Seed & Fertilizer"
    ]
  }'::jsonb, 'bootstrap'),

  (v_brand_id, 'brand', 'services', '{
    "offerings": [
      {"name": "Landscaping", "description": "Full-service landscape design and installation — plantings, grading, drainage, irrigation"},
      {"name": "Masonry", "description": "Patios, walkways, retaining walls, outdoor kitchens, fire pits — Cambridge, Belgard, natural stone"},
      {"name": "Driveway Installation", "description": "Belgium block, paver, and gravel driveways — excavation to finish"},
      {"name": "Property Maintenance", "description": "Seasonal cleanups, mulch refreshing, lawn care, snow plowing"}
    ]
  }'::jsonb, 'bootstrap'),

  (v_brand_id, 'brand', 'delivery', '{
    "same_day_cutoff": "11:00 AM weekdays",
    "truck_fleet": [
      {"type": "Small Dump", "default_capacity_yd": 5, "mulch_capacity_yd": 7},
      {"type": "Medium Dump", "default_capacity_yd": 10, "mulch_capacity_yd": 10},
      {"type": "Tri-Axle", "default_capacity_yd": 20, "mulch_capacity_yd": 20}
    ],
    "area": "Suffolk County — Patchogue to Southampton",
    "multi_load_discount": "Additional loads at 75% of first load fee",
    "minimum_order": "$125 for delivery outside 5-mile local radius"
  }'::jsonb, 'bootstrap'),

  (v_brand_id, 'brand', 'business_hours', '{
    "spring_summer": {"mon_fri": "7:00 AM - 5:00 PM", "sat": "7:00 AM - 3:00 PM", "sun": "Closed"},
    "fall_winter": {"mon_fri": "7:00 AM - 4:00 PM", "sat": "7:00 AM - 2:00 PM", "sun": "Closed"},
    "note": "Hours may vary — call to confirm: (631) 874-6244"
  }'::jsonb, 'bootstrap')

  ON CONFLICT (brand_id, namespace, key) DO NOTHING;

  -- ═══ NAMESPACE: content ═══

  INSERT INTO mktg_agent_memory (brand_id, namespace, key, value, updated_by) VALUES
  (v_brand_id, 'content', 'pillar_rules', '{
    "max_same_pillar_per_week": 2,
    "min_each_pillar_per_2_weeks": 1,
    "pillar_weights": {
      "product_showcase": 2,
      "delivery_action": 2,
      "seasonal_tips": 2,
      "before_after": 2,
      "local_community": 1,
      "promotions": 1,
      "behind_scenes": 1
    },
    "total_posts_per_week_target": 15
  }'::jsonb, 'bootstrap'),

  (v_brand_id, 'content', 'platform_specs', '{
    "instagram_feed": {"width": 1080, "height": 1080, "alt_ratio": "4:5", "alt_height": 1350, "max_caption": 2200, "max_hashtags": 30},
    "instagram_story": {"width": 1080, "height": 1920, "max_sticker_text": 100},
    "instagram_reel": {"width": 1080, "height": 1920, "max_caption": 2200},
    "facebook_page": {"width": 1200, "height": 630, "max_caption": null, "max_hashtags": 5},
    "google_business_profile": {"width": 1200, "height": 900, "max_caption": 1500, "requires_cta": true}
  }'::jsonb, 'bootstrap'),

  (v_brand_id, 'content', 'caption_guidelines', '{
    "instagram_feed": {"length": "80-150 words", "hashtag_count": "15-25", "cta": "Link in bio or DM us", "emoji_style": "moderate, relevant"},
    "facebook_page": {"length": "50-120 words", "hashtag_count": "3-5", "cta": "Shop at easternlm.com or call (631) 874-6244", "emoji_style": "minimal"},
    "google_business_profile": {"length": "80-200 words", "hashtag_count": 0, "cta": "Always include CTA URL to relevant page", "cta_url_pattern": "https://easternlm.com/delivery/{town-slug} or /shop/{product-slug}"}
  }'::jsonb, 'bootstrap'),

  (v_brand_id, 'content', 'negative_examples', '[]'::jsonb, 'bootstrap')

  ON CONFLICT (brand_id, namespace, key) DO NOTHING;

  -- ═══ NAMESPACE: geography ═══

  INSERT INTO mktg_agent_memory (brand_id, namespace, key, value, updated_by) VALUES
  (v_brand_id, 'geography', 'towns_tier_a', '{
    "towns": ["Center Moriches", "Shirley", "Mastic", "East Moriches", "Moriches", "Eastport", "Patchogue", "Bellport", "Manorville", "Brookhaven"],
    "note": "Top 10 towns by order volume — prioritize in GBP posts and delivery mentions"
  }'::jsonb, 'bootstrap'),

  (v_brand_id, 'geography', 'towns_tier_b', '{
    "towns": ["Westhampton", "Westhampton Beach", "Quogue", "Hampton Bays", "Southampton", "East Hampton", "Sag Harbor", "Montauk", "Riverhead", "Calverton", "Medford", "Blue Point", "Bayport", "Sayville", "West Sayville", "Oakdale", "Bohemia", "Ronkonkoma", "Holbrook", "Lake Grove", "Centereach", "Selden", "Coram", "Middle Island", "Ridge", "Yaphank", "East Patchogue", "North Patchogue", "South Haven", "Speonk", "Remsenburg", "Water Mill", "Bridgehampton", "Amagansett", "Springs", "Shelter Island", "Mattituck", "Cutchogue", "Southold", "Greenport", "Orient", "Flanders", "Aquebogue", "Jamesport", "Laurel", "Peconic"],
    "note": "Extended service area — include in seasonal and GBP content rotation"
  }'::jsonb, 'bootstrap')

  ON CONFLICT (brand_id, namespace, key) DO NOTHING;

  -- ═══ NAMESPACE: competitors ═══

  INSERT INTO mktg_agent_memory (brand_id, namespace, key, value, updated_by) VALUES
  (v_brand_id, 'competitors', 'seed_accounts', '{
    "note": "Placeholder handles — verify and update with real accounts",
    "accounts": [
      {"handle": "placeholder_supply_yard_1", "platform": "instagram", "type": "competitor", "notes": "Local landscape supply competitor"},
      {"handle": "placeholder_supply_yard_2", "platform": "instagram", "type": "competitor", "notes": "Local landscape supply competitor"},
      {"handle": "placeholder_supply_yard_3", "platform": "instagram", "type": "competitor", "notes": "Regional supply yard"},
      {"handle": "placeholder_landscaper_1", "platform": "instagram", "type": "local_landscaper", "notes": "Active local landscaper"},
      {"handle": "placeholder_landscaper_2", "platform": "instagram", "type": "local_landscaper", "notes": "Active local landscaper"},
      {"handle": "placeholder_landscaper_3", "platform": "instagram", "type": "local_landscaper", "notes": "Contractor who posts project work"},
      {"handle": "placeholder_lifestyle_1", "platform": "instagram", "type": "lifestyle", "notes": "Hamptons home/garden account"},
      {"handle": "placeholder_lifestyle_2", "platform": "instagram", "type": "lifestyle", "notes": "Long Island outdoor living"},
      {"handle": "placeholder_community_1", "platform": "facebook", "type": "community", "notes": "Suffolk County community page"},
      {"handle": "placeholder_community_2", "platform": "facebook", "type": "community", "notes": "Center Moriches area page"}
    ]
  }'::jsonb, 'bootstrap')

  ON CONFLICT (brand_id, namespace, key) DO NOTHING;

  -- ═══ SEED COMPETITOR ACCOUNTS TABLE ═══

  INSERT INTO mktg_competitor_accounts (brand_id, platform, account_handle, display_name, account_type, is_active) VALUES
  (v_brand_id, 'instagram', 'placeholder_supply_yard_1', 'Local Supply Yard 1', 'competitor', true),
  (v_brand_id, 'instagram', 'placeholder_supply_yard_2', 'Local Supply Yard 2', 'competitor', true),
  (v_brand_id, 'instagram', 'placeholder_supply_yard_3', 'Regional Supply Yard', 'competitor', true),
  (v_brand_id, 'instagram', 'placeholder_landscaper_1', 'Active Landscaper 1', 'local_landscaper', true),
  (v_brand_id, 'instagram', 'placeholder_landscaper_2', 'Active Landscaper 2', 'local_landscaper', true),
  (v_brand_id, 'instagram', 'placeholder_landscaper_3', 'Project Contractor', 'local_landscaper', true),
  (v_brand_id, 'instagram', 'placeholder_landscaper_4', 'Masonry Contractor', 'local_landscaper', true),
  (v_brand_id, 'instagram', 'placeholder_lifestyle_1', 'Hamptons Home & Garden', 'lifestyle', true),
  (v_brand_id, 'instagram', 'placeholder_lifestyle_2', 'LI Outdoor Living', 'lifestyle', true),
  (v_brand_id, 'facebook', 'placeholder_community_1', 'Suffolk County Community', 'community', true),
  (v_brand_id, 'facebook', 'placeholder_community_2', 'Center Moriches Area', 'community', true),
  (v_brand_id, 'instagram', 'placeholder_supply_yard_4', 'Hamptons Supply Yard', 'competitor', true)
  ON CONFLICT DO NOTHING;

END $$;
