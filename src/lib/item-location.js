/**
 * Where equipment, books and rooms are picked up or used (migration 010's item_locations).
 * Shared by the server (emails, API serializers) and the client (item window, /account).
 * Expertise has no place: its meetings are online.
 *
 * Three shapes leave the server:
 * - full location (server and admin only): every field of the row.
 * - public location (anyone): city, province and postal code, plus an approximate area for the map.
 * - member location (a member's confirmed reservation that hasn't ended): the full address,
 *   the exact point, the transit note and a directions link.
 */

export const OFFICE_LOCATION_ID = 'aisb-office';

// The office's transit note (migration 011 writes the same text to its row).
export const OFFICE_TRANSIT_NOTE_EN =
  'Bus 55 (and night bus 363) stops about 60 m away at Saint-Laurent / Maguire going north; going south, it stops at Saint-Urbain / Fairmount, about a 5-minute walk. Bus 119 stops at Casgrain / Maguire (westbound) and at Saint-Viateur / Saint-Laurent (eastbound, to Laurier metro). Laurier metro (Orange line) is about a 12-minute walk and has no elevator; Rosemont (Orange line, with elevators) is about 15 minutes away.';
export const OFFICE_TRANSIT_NOTE_FR =
  "L'autobus 55 (et l'autobus de nuit 363) s'arrête à environ 60 m, à Saint-Laurent / Maguire, vers le nord ; vers le sud, il s'arrête à Saint-Urbain / Fairmount, à environ 5 minutes de marche. L'autobus 119 s'arrête à Casgrain / Maguire (vers l'ouest) et à Saint-Viateur / Saint-Laurent (vers l'est, jusqu'au métro Laurier). Le métro Laurier (ligne orange) est à environ 12 minutes de marche et n'a pas d'ascenseur ; la station Rosemont (ligne orange, avec ascenseurs) est à environ 15 minutes.";

/**
 * Built-in copy of the office row (migrations 010 and 011). Used for every equipment, book and
 * room item until 010 is applied, and when the office row can't be loaded; its stations also
 * stand in until 011 is applied (the row's own transit note is shown until 011 replaces it).
 * Coordinates: the OpenStreetMap address point for 5310 (Geocoder.ca agrees within a metre).
 * Transit note: STM stops and routes after the May 2026 network redesign, walking times from
 * OpenStreetMap routing (checked 2026-10-16). Stations: `npm run place:stations` (OpenStreetMap,
 * 2026-10-17), with Mont-Royal's elevator taken from the STM's list (OpenStreetMap says none).
 */
export const OFFICE_LOCATION = Object.freeze({
  id: OFFICE_LOCATION_ID,
  name: 'Apathy is Boring',
  streetAddress: '5310 Boulevard Saint-Laurent',
  streetAddressFr: '5310, boulevard Saint-Laurent',
  city: 'Montréal',
  province: 'QC',
  postalCode: 'H2T 1S1',
  latitude: 45.52448,
  longitude: -73.59644,
  transitNoteEn: OFFICE_TRANSIT_NOTE_EN,
  transitNoteFr: OFFICE_TRANSIT_NOTE_FR,
  nearbyStations: Object.freeze([
    { name: 'Laurier', lat: 45.52808, lon: -73.588378, lines: [{ ref: '2', name: 'Ligne orange', colour: '#D06D07' }], wheelchair: false },
    { name: 'Rosemont', lat: 45.531496, lon: -73.597338, lines: [{ ref: '2', name: 'Ligne orange', colour: '#D06D07' }], wheelchair: true },
    { name: 'Mont-Royal', lat: 45.524599, lon: -73.581647, lines: [{ ref: '2', name: 'Ligne orange', colour: '#D06D07' }], wheelchair: true },
    { name: 'Beaubien', lat: 45.535175, lon: -73.604959, lines: [{ ref: '2', name: 'Ligne orange', colour: '#D06D07' }], wheelchair: null },
  ]),
});

/** The public map circles this area around the rounded point instead of pinning the address. */
export const PUBLIC_AREA_RADIUS_METRES = 300;

/** Province and territory codes, as stored, with their French names (Canada Post order). */
export const PROVINCE_NAMES_FR = Object.freeze({
  NL: 'Terre-Neuve-et-Labrador',
  NS: 'Nouvelle-Écosse',
  PE: 'Île-du-Prince-Édouard',
  NB: 'Nouveau-Brunswick',
  QC: 'Québec',
  ON: 'Ontario',
  MB: 'Manitoba',
  SK: 'Saskatchewan',
  AB: 'Alberta',
  BC: 'Colombie-Britannique',
  YT: 'Yukon',
  NT: 'Territoires du Nord-Ouest',
  NU: 'Nunavut',
});

const MAX_STATIONS = 6;
const MAX_LINES = 6;
const HEX_COLOUR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function shortText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Rapid-transit stations near a place (item_locations.nearby_stations, from OpenStreetMap):
 * `[{ name, lat, lon, lines: [{ ref, name, colour }], wheelchair }]`. Anything malformed is
 * dropped; a colour must be a hex colour (it ends up in a style), else ''. Public data.
 */
export function normalizeStations(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const stations = [];
  for (const raw of value) {
    const name = shortText(raw?.name, 80);
    const lat = coordinate(raw?.lat, 90);
    const lon = coordinate(raw?.lon, 180);
    if (!name || lat === null || lon === null) {
      continue;
    }

    const lines = (Array.isArray(raw.lines) ? raw.lines : [])
      .map((line) => ({
        ref: shortText(line?.ref, 12),
        name: shortText(line?.name, 60),
        colour: typeof line?.colour === 'string' && HEX_COLOUR_RE.test(line.colour) ? line.colour : '',
      }))
      .filter((line) => line.ref || line.name)
      .slice(0, MAX_LINES);

    stations.push({
      name,
      lat,
      lon,
      lines,
      wheelchair: raw.wheelchair === true ? true : raw.wheelchair === false ? false : null,
    });

    if (stations.length === MAX_STATIONS) {
      break;
    }
  }

  return stations;
}

/** True for the tags that have a physical place (everything but expertise). */
export function hasPhysicalLocation(tag) {
  return tag !== 'expertise';
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function coordinate(value, limit) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
}

/** An item_locations row (snake_case) as a full location; null when a required field is missing. */
export function locationRowToApi(row) {
  if (!row || typeof row !== 'object') {
    return null;
  }

  const location = {
    id: text(row.id),
    name: text(row.name),
    streetAddress: text(row.street_address),
    streetAddressFr: text(row.street_address_fr) || null,
    city: text(row.city),
    province: text(row.province).toUpperCase(),
    postalCode: text(row.postal_code).toUpperCase(),
    latitude: coordinate(row.latitude, 90),
    longitude: coordinate(row.longitude, 180),
    transitNoteEn: text(row.transit_note_en) || null,
    transitNoteFr: text(row.transit_note_fr) || null,
    // Migration 011. Undefined before it, when the office falls back to OFFICE_LOCATION's list.
    nearbyStations:
      row.nearby_stations === undefined && text(row.id) === OFFICE_LOCATION_ID
        ? OFFICE_LOCATION.nearbyStations
        : normalizeStations(row.nearby_stations),
  };

  if (!location.id || !location.streetAddress || !location.city || !location.province || !location.postalCode) {
    return null;
  }

  // Both or neither: one coordinate alone can't place a map.
  if (location.latitude === null || location.longitude === null) {
    location.latitude = null;
    location.longitude = null;
  }

  return location;
}

/**
 * The part of the address anyone may see. EN "Montréal QC H2T 1S1" (Canada Post style);
 * FR "Montréal (Québec) H2T 1S1", as the French privacy policy writes the office.
 */
export function locationAreaLine(location, locale = 'en') {
  const city = text(location?.city);
  const province = text(location?.province);
  const postalCode = text(location?.postalCode);

  if (locale === 'fr' && province) {
    const provinceName = PROVINCE_NAMES_FR[province] ?? province;
    return [city ? `${city} (${provinceName})` : provinceName, postalCode].filter(Boolean).join(' ');
  }

  return [city, province, postalCode].filter(Boolean).join(' ');
}

/** "5310 Boulevard Saint-Laurent, Montréal QC H2T 1S1" (FR: "5310, boulevard Saint-Laurent, …"). */
export function locationAddressLine(location, locale = 'en') {
  const street =
    locale === 'fr' ? text(location?.streetAddressFr) || text(location?.streetAddress) : text(location?.streetAddress);
  return [street, locationAreaLine(location, locale)].filter(Boolean).join(', ');
}

/** The transit note in the visitor's language, falling back to the other one. */
export function locationTransitNote(transitNote, locale = 'en') {
  const en = text(transitNote?.en);
  const fr = text(transitNote?.fr);
  return locale === 'fr' ? fr || en : en || fr;
}

/**
 * Google Maps directions to the street address, transit first (Google shows the other modes as
 * tabs). No key; opens the Google Maps app on phones that have it. The address rather than the
 * coordinates, so Maps lands on the building and names it.
 */
export function directionsUrl(location) {
  const destination = locationAddressLine(location, 'en');

  if (!destination) {
    return '';
  }

  const params = new URLSearchParams({ api: '1', destination, travelmode: 'transit' });
  return `https://www.google.com/maps/dir/?${params}`;
}

/**
 * The approximate area for the public map: the coordinates rounded to 3 decimals (at most about
 * 70 m from the address, the same precision as a city postal code) inside a 300 m circle, so the
 * map shows the block and its streets without pointing at a door.
 */
function publicArea(location) {
  if (typeof location?.latitude !== 'number' || typeof location?.longitude !== 'number') {
    return null;
  }

  return {
    latitude: Math.round(location.latitude * 1000) / 1000,
    longitude: Math.round(location.longitude * 1000) / 1000,
    radiusMetres: PUBLIC_AREA_RADIUS_METRES,
  };
}

/**
 * What anyone may see: city, province, postal code and (with `withArea`) the approximate area.
 * Never the place name, the street, the exact point or the transit note.
 */
export function publicLocation(location, { withArea = true } = {}) {
  if (!location) {
    return null;
  }

  return {
    city: text(location.city),
    province: text(location.province),
    postalCode: text(location.postalCode),
    ...(withArea ? { area: publicArea(location), stations: normalizeStations(location.nearbyStations) } : {}),
  };
}

/** A member's confirmed reservation: the full address, the exact point and how to get there. */
export function memberLocation(location) {
  if (!location) {
    return null;
  }

  return {
    name: text(location.name),
    streetAddress: text(location.streetAddress),
    streetAddressFr: text(location.streetAddressFr) || null,
    city: text(location.city),
    province: text(location.province),
    postalCode: text(location.postalCode),
    latitude: typeof location.latitude === 'number' ? location.latitude : null,
    longitude: typeof location.longitude === 'number' ? location.longitude : null,
    transitNote: {
      en: location.transitNoteEn ?? null,
      fr: location.transitNoteFr ?? null,
    },
    stations: normalizeStations(location.nearbyStations),
    directionsUrl: directionsUrl(location),
  };
}

/**
 * Transit's trip planner (the Montréal-made Transit app, most Canadian cities), with the place
 * as the destination; opens the app on phones that have it. Its web parameters aren't
 * documented: if the link stops landing on the place, drop it.
 */
export function transitAppUrl(location, locale = 'en') {
  if (typeof location?.latitude !== 'number' || typeof location?.longitude !== 'number') {
    return '';
  }

  const params = new URLSearchParams({
    destination: `${location.latitude},${location.longitude}`,
    destination_search: locationAddressLine(location, locale),
  });
  return `https://transitapp.com/${locale === 'fr' ? 'fr' : 'en'}/trip?${params}`;
}

/**
 * The public view of an item: an explicit whitelist, so a new server-side field (the full
 * location, expertEmail) never reaches a public route by accident. The server swaps in the
 * /media image URL; the admin panel and App use it as is for items they pass to the catalogue.
 */
export function toPublicItem(item) {
  return {
    id: item.id,
    title: item.title,
    body: item.body,
    longBody: item.longBody ?? null,
    image: item.image,
    tag: item.tag,
    slug: item.slug ?? null,
    createdAt: item.createdAt,
    location: hasPhysicalLocation(item.tag) ? publicLocation(item.location) : null,
    reservations: (item.reservations ?? []).map(({ id, startDate, endDate, status }) => ({
      id,
      startDate,
      endDate,
      status,
    })),
  };
}
