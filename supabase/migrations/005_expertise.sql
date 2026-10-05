-- Expertise category + consultation requests
-- Apply in Supabase Dashboard → SQL Editor after 004_inventory_slug.sql.

-- Allow the new 'expertise' inventory tag.
ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_tag_check;
ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_tag_check
  CHECK (tag IN ('equipment', 'books', 'rooms', 'expertise'));

-- Optional expert contact for expertise items (admin-only; never returned on public routes).
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS expert_email TEXT;

-- Consultation request fields on reservations (expertise items only).
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS time_slots TEXT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS request_summary TEXT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS meeting_at TIMESTAMPTZ;
