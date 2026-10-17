-- Item locations: where equipment, books and rooms are picked up or used.
-- One row per place; each non-expertise item points at one through inventory_items.location_id.
-- Expertise items have no location (their meetings are online).
-- The public site shows only the city, province and postal code (and an approximate area on a
-- map); the full address goes to members once their reservation is confirmed.
-- Apply in Supabase Dashboard → SQL Editor after 009_admin_stats.sql. The app works before it
-- is applied (every non-expertise item shows the office), so it can be applied before or after
-- deploying the code that reads it.
--
-- Adding a place later (no admin screen yet): insert a row, then point items at it, e.g.
--   INSERT INTO item_locations (id, name, street_address, street_address_fr, city, province,
--     postal_code, latitude, longitude, transit_note_en, transit_note_fr)
--   VALUES ('quebec-partner', 'Partner name', '123 Rue Exemple', '123, rue Exemple', 'Québec',
--     'QC', 'G1K 1A1', 46.81, -71.21, NULL, NULL);
--   UPDATE inventory_items SET location_id = 'quebec-partner' WHERE id IN ('…');
-- Coordinates: on openstreetmap.org, right-click the building → "Show address" and copy them.
-- The server rereads this table every 5 minutes.

BEGIN;

CREATE TABLE IF NOT EXISTS item_locations (
  id TEXT PRIMARY KEY,
  -- Shown with the full address (members only), e.g. "Apathy is Boring".
  name TEXT NOT NULL,
  -- "5310 Boulevard Saint-Laurent"; street_address_fr is the French form ("5310, boulevard
  -- Saint-Laurent") and falls back to street_address when NULL.
  street_address TEXT NOT NULL,
  street_address_fr TEXT,
  city TEXT NOT NULL,
  province TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  -- A sentence on nearby transit, shown to members with the address.
  transit_note_en TEXT,
  transit_note_fr TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE item_locations DROP CONSTRAINT IF EXISTS item_locations_province_check;
ALTER TABLE item_locations ADD CONSTRAINT item_locations_province_check
  CHECK (province IN ('AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'));

-- "H2T 1S1": capitals, one space.
ALTER TABLE item_locations DROP CONSTRAINT IF EXISTS item_locations_postal_code_check;
ALTER TABLE item_locations ADD CONSTRAINT item_locations_postal_code_check
  CHECK (postal_code ~ '^[ABCEGHJ-NPRSTVXY][0-9][ABCEGHJ-NPRSTV-Z] [0-9][ABCEGHJ-NPRSTV-Z][0-9]$');

-- Both coordinates or neither, and inside Canada (catches a swapped pair).
ALTER TABLE item_locations DROP CONSTRAINT IF EXISTS item_locations_coords_pair_check;
ALTER TABLE item_locations ADD CONSTRAINT item_locations_coords_pair_check
  CHECK ((latitude IS NULL) = (longitude IS NULL));

ALTER TABLE item_locations DROP CONSTRAINT IF EXISTS item_locations_coords_canada_check;
ALTER TABLE item_locations ADD CONSTRAINT item_locations_coords_canada_check
  CHECK (
    latitude IS NULL
    OR (latitude BETWEEN 41.6 AND 83.2 AND longitude BETWEEN -141.1 AND -52.6)
  );

ALTER TABLE item_locations ENABLE ROW LEVEL SECURITY;

-- Same lockdown as 001, 003 and 009: only the service role (Express) reads or writes it.
GRANT ALL ON public.item_locations TO service_role;
REVOKE ALL ON public.item_locations FROM anon, authenticated;

-- The Apathy is Boring office. Coordinates: the OpenStreetMap address point for 5310
-- (Geocoder.ca agrees within a metre). Transit: OpenStreetMap stops and stations, straight-line
-- distances (checked 2026-10-16). Keep in step with OFFICE_LOCATION in src/lib/item-location.js,
-- which the app uses until this row exists.
INSERT INTO item_locations (
  id, name, street_address, street_address_fr, city, province, postal_code,
  latitude, longitude, transit_note_en, transit_note_fr
)
VALUES (
  'aisb-office',
  'Apathy is Boring',
  '5310 Boulevard Saint-Laurent',
  '5310, boulevard Saint-Laurent',
  'Montréal',
  'QC',
  'H2T 1S1',
  45.52448,
  -73.59644,
  'Bus 55 stops about 60 m away at Saint-Laurent / Maguire (northbound) and about 200 m away at Saint-Urbain / Fairmount (southbound). Laurier metro station (Orange line) is about 750 m away.',
  'L''autobus 55 s''arrête à environ 60 m, à Saint-Laurent / Maguire (vers le nord), et à environ 200 m, à Saint-Urbain / Fairmount (vers le sud). La station de métro Laurier (ligne orange) est à environ 750 m.'
)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS location_id TEXT;

-- RESTRICT: a place can't be deleted while items still point at it (reassign them first).
ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_location_id_fkey;
ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_location_id_fkey
  FOREIGN KEY (location_id) REFERENCES item_locations(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_inventory_items_location_id ON inventory_items(location_id);

-- Every current equipment, book and room item is at the office.
UPDATE inventory_items SET location_id = 'aisb-office'
  WHERE tag <> 'expertise' AND location_id IS NULL;

-- Mentors meet online: no location.
ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_expertise_no_location;
ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_expertise_no_location
  CHECK (tag <> 'expertise' OR location_id IS NULL);

COMMIT;

NOTIFY pgrst, 'reload schema';
