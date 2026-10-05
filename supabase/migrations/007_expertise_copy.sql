-- Short list blurb stays in inventory_items.body.
-- Long bio shown when an expert is opened.
-- Apply in Supabase Dashboard → SQL Editor after 006_consultation_scheduling.sql.

ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS long_body TEXT;
