-- Nearby rapid-transit stations for each place, and a corrected transit note for the office.
-- item_locations.nearby_stations: up to 6 métro, light-rail or commuter-rail stations within
-- 1.5 km, as worked out by `npm run place:stations -- <lat> <lon> <id>` (OpenStreetMap), which
-- prints the UPDATE for a new place. Shown on the item and booking maps; public data.
-- Apply in Supabase Dashboard → SQL Editor after 010_item_locations.sql. The app works before it
-- is applied: the office's stations come from src/lib/item-location.js until then, and the
-- office keeps 010's transit note until this replaces it.

BEGIN;

ALTER TABLE item_locations ADD COLUMN IF NOT EXISTS nearby_stations JSONB;

ALTER TABLE item_locations DROP CONSTRAINT IF EXISTS item_locations_nearby_stations_check;
ALTER TABLE item_locations ADD CONSTRAINT item_locations_nearby_stations_check
  CHECK (nearby_stations IS NULL OR jsonb_typeof(nearby_stations) = 'array');

-- The office (OpenStreetMap, 2026-10-17; Mont-Royal's elevator from the STM's list).
UPDATE item_locations
SET nearby_stations = '[{"name":"Laurier","lat":45.52808,"lon":-73.588378,"lines":[{"ref":"2","name":"Ligne orange","colour":"#D06D07"}],"wheelchair":false},{"name":"Rosemont","lat":45.531496,"lon":-73.597338,"lines":[{"ref":"2","name":"Ligne orange","colour":"#D06D07"}],"wheelchair":true},{"name":"Mont-Royal","lat":45.524599,"lon":-73.581647,"lines":[{"ref":"2","name":"Ligne orange","colour":"#D06D07"}],"wheelchair":true},{"name":"Beaubien","lat":45.535175,"lon":-73.604959,"lines":[{"ref":"2","name":"Ligne orange","colour":"#D06D07"}],"wheelchair":null}]'::jsonb
WHERE id = 'aisb-office' AND nearby_stations IS NULL;

-- The office's transit note, checked against the STM after its May 2026 bus redesign (the 119
-- replaced the 46; the 363 night bus shares the 55's stops; walking times, not straight lines).
-- Each language only replaces 010's text, so a note already edited by hand is kept.
UPDATE item_locations SET transit_note_en = 'Bus 55 (and night bus 363) stops about 60 m away at Saint-Laurent / Maguire going north; going south, it stops at Saint-Urbain / Fairmount, about a 5-minute walk. Bus 119 stops at Casgrain / Maguire (westbound) and at Saint-Viateur / Saint-Laurent (eastbound, to Laurier metro). Laurier metro (Orange line) is about a 12-minute walk and has no elevator; Rosemont (Orange line, with elevators) is about 15 minutes away.'
WHERE id = 'aisb-office' AND transit_note_en = 'Bus 55 stops about 60 m away at Saint-Laurent / Maguire (northbound) and about 200 m away at Saint-Urbain / Fairmount (southbound). Laurier metro station (Orange line) is about 750 m away.';

UPDATE item_locations SET transit_note_fr = 'L''autobus 55 (et l''autobus de nuit 363) s''arrête à environ 60 m, à Saint-Laurent / Maguire, vers le nord ; vers le sud, il s''arrête à Saint-Urbain / Fairmount, à environ 5 minutes de marche. L''autobus 119 s''arrête à Casgrain / Maguire (vers l''ouest) et à Saint-Viateur / Saint-Laurent (vers l''est, jusqu''au métro Laurier). Le métro Laurier (ligne orange) est à environ 12 minutes de marche et n''a pas d''ascenseur ; la station Rosemont (ligne orange, avec ascenseurs) est à environ 15 minutes.'
WHERE id = 'aisb-office' AND transit_note_fr = 'L''autobus 55 s''arrête à environ 60 m, à Saint-Laurent / Maguire (vers le nord), et à environ 200 m, à Saint-Urbain / Fairmount (vers le sud). La station de métro Laurier (ligne orange) est à environ 750 m.';

COMMIT;

NOTIFY pgrst, 'reload schema';
