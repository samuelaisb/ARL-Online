#!/usr/bin/env node
// Finds the métro, light-rail and commuter-rail stations near a place (OpenStreetMap, through
// the public Overpass API) and prints the SQL that stores them on the place, for the Supabase
// SQL editor. Reads and writes no database itself. One query per run; be gentle with Overpass.
//
//   npm run place:stations -- <latitude> <longitude> [location-id]
//   npm run place:stations -- 45.52448 -73.59644 aisb-office
import { stationsFromOverpass, stationsOverpassQuery } from '../src/lib/nearby-stations.js';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'ARL-Online place-stations (+https://activistresourcelibrary.com)';

const [latText, lonText, locationId = 'your-location-id'] = process.argv.slice(2);
const latitude = Number(latText);
const longitude = Number(lonText);

if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
  console.error('Usage: npm run place:stations -- <latitude> <longitude> [location-id]');
  process.exit(1);
}

const response = await fetch(OVERPASS_URL, {
  method: 'POST',
  headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ data: stationsOverpassQuery(latitude, longitude) }),
  signal: AbortSignal.timeout(180_000),
});

if (!response.ok) {
  console.error(`Overpass answered ${response.status}. It may be busy: try again in a few minutes.`);
  process.exit(1);
}

const answer = await response.json();

// Overpass reports a timeout or memory error as a 200 with partial data and a remark.
if (/error/i.test(answer.remark ?? '')) {
  console.error(`Overpass couldn't finish (${answer.remark}). Nothing printed; try again later.`);
  process.exit(1);
}
const stations = stationsFromOverpass(answer, { lat: latitude, lon: longitude });

console.error(`OpenStreetMap data as of ${answer.osm3s?.timestamp_osm_base ?? 'unknown'}.`);
console.error(
  stations.length
    ? stations
        .map((station) => `  ${station.name}: ${station.lines.map((line) => line.ref || line.name).join(', ') || 'no line data'}`)
        .join('\n')
    : '  No station within 1.5 km.',
);
const json = JSON.stringify(stations);
console.log(
  `UPDATE item_locations SET nearby_stations = '${json.replaceAll("'", "''")}'::jsonb WHERE id = '${locationId.replaceAll("'", "''")}';`,
);
