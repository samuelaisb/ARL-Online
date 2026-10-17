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

/**
 * Built-in copy of migration 010's office row. Used for every equipment, book and room item
 * until 010 is applied, and when the office row can't be loaded.
 * Coordinates: the OpenStreetMap address point for 5310 (Geocoder.ca agrees within a metre).
 * Transit: OpenStreetMap stops and stations, straight-line distances (2026-10-16).
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
  transitNoteEn:
    'Bus 55 stops about 60 m away at Saint-Laurent / Maguire (northbound) and about 200 m away at Saint-Urbain / Fairmount (southbound). Laurier metro station (Orange line) is about 750 m away.',
  transitNoteFr:
    "L'autobus 55 s'arrête à environ 60 m, à Saint-Laurent / Maguire (vers le nord), et à environ 200 m, à Saint-Urbain / Fairmount (vers le sud). La station de métro Laurier (ligne orange) est à environ 750 m.",
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
    ...(withArea ? { area: publicArea(location) } : {}),
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
    directionsUrl: directionsUrl(location),
  };
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
