-- ELM Marketing Engine — Migration 005: Seed Eastern LM brand

INSERT INTO mktg_brands (slug, name, publish_mode, voice_rules, content_pillars, platform_accounts, hashtag_sets, posting_schedule, geo_target, is_active)
VALUES (
  'eastern-lm',
  'Eastern Landscape & Mason Supply',
  'draft_only',
  '{
    "always": ["family-owned", "per cu. yard", "cu yds", "Add to Order", "double ground", "Locally sourced"],
    "never": ["/yd", "cart", "Add to Cart", "established in", "founding year", "triple ground standard", "responsibly sourced", "BNPL surcharge"],
    "tone": "Professional but approachable. Knowledgeable about materials. Local pride. Suffolk County community voice.",
    "location": "110 Frowein Road, Center Moriches, NY 11934. Serving Suffolk County from Patchogue to Southampton.",
    "phone": "(631) 874-6244",
    "mulch_note": "Mulch is double ground standard. Triple ground (black and natural only) available by request, 20-yard minimum — never listed as standard."
  }'::jsonb,
  '[
    {"slug": "product_showcase", "name": "Material of the Week", "weight": 2, "description": "Feature one product with use cases, pricing context, project ideas"},
    {"slug": "delivery_action", "name": "Delivery in Action", "weight": 2, "description": "Truck shots, driver POV, just delivered X yards to [town]"},
    {"slug": "seasonal_tips", "name": "Seasonal Tips", "weight": 2, "description": "Spring mulch prep, fall driveway grading, when to order fill"},
    {"slug": "before_after", "name": "Before/After Transformations", "weight": 2, "description": "Customer project transformations using our materials"},
    {"slug": "local_community", "name": "Suffolk County Community", "weight": 1, "description": "Local events, partnerships with landscapers, community features"},
    {"slug": "promotions", "name": "Deals & Availability", "weight": 1, "description": "Multi-load discounts, same-day delivery, new stock arrivals"},
    {"slug": "behind_scenes", "name": "Behind the Scenes", "weight": 1, "description": "Yard operations, truck maintenance, loading process, new stock"}
  ]'::jsonb,
  '{"instagram": {"account_id": ""}, "facebook": {"page_id": ""}, "gbp": {"location_id": ""}}'::jsonb,
  '{
    "instagram": ["#LongIslandLandscaping", "#SuffolkCounty", "#BulkMaterials", "#LandscapeSupply", "#CenterMoriches", "#Mulch", "#Gravel", "#Topsoil", "#MasonSupply", "#DeliveryDay"],
    "facebook": ["#EasternLM", "#LandscapeSupply", "#SuffolkCountyNY", "#BulkDelivery"],
    "gbp": []
  }'::jsonb,
  '{
    "instagram_feed": {"days": ["mon","wed","fri"], "times": ["10:00","14:00"]},
    "facebook_page": {"days": ["tue","thu"], "times": ["09:00","12:00"]},
    "google_business_profile": {"days": ["mon"], "times": ["08:00"]}
  }'::jsonb,
  '{"center": "Center Moriches, NY", "radius_miles": 35, "towns": "Patchogue to Southampton"}'::jsonb,
  true
)
ON CONFLICT (slug) DO NOTHING;
