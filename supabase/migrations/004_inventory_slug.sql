-- ARL Online: per-tag URL slugs for inventory item detail pages
-- Apply in Supabase Dashboard → SQL Editor, or via Supabase CLI.

ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS slug TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_items_tag_slug
  ON inventory_items (tag, slug);
