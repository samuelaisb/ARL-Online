/**
 * Live bike-share docks near a point, read from each system's public GBFS 2.x feed and served by
 * our own GET /api/bike-share (so visitors' browsers never download the ~900 KB feeds, and no
 * third-party host is added to the CSP). Server only.
 *
 * Caches (single Cloud Run instance): the station list for 6 hours, availability for 60 s, each
 * loaded by one request at a time, capped at 5 s, refreshed only when a request arrives (no
 * timers: Cloud Run throttles the CPU between requests). A failed refresh keeps the last copy,
 * but availability older than 10 minutes is never shown (the map shows no docks rather than
 * stale counts). An answer with no stations counts as a failure. Never throws.
 *
 * Adding a city: one entry below (its GBFS discovery URL from MobilityData's systems.csv, a
 * bounding box, and a credit). Check the system's terms first (system_information's license).
 */

export const BIKE_SHARE_SYSTEMS = Object.freeze([
  Object.freeze({
    id: 'bixi',
    name: 'BIXI Montréal',
    discoveryUrl: 'https://gbfs.velobixi.com/gbfs/2-2/gbfs.json',
    // Montréal and its neighbours (Laval, Longueuil, Westmount…), generously.
    bounds: Object.freeze({ south: 45.35, west: -74.05, north: 45.75, east: -73.35 }),
  }),
]);

export const BIKE_SHARE_RADIUS_METRES = 600;
const MAX_DOCKS = 10;
const INFO_TTL_MS = 6 * 60 * 60 * 1000;
const STATUS_TTL_MS = 60 * 1000;
// Older availability is dropped rather than shown as current.
const STATUS_MAX_AGE_MS = 10 * 60 * 1000;
const RETRY_MS = 30 * 1000;
const TIMEOUT_MS = 5 * 1000;
const USER_AGENT = 'ARL-Online (+https://activistresourcelibrary.com)';

const caches = new Map();

function cacheFor(system) {
  if (!caches.has(system.id)) {
    caches.set(system.id, {
      id: system.id,
      feeds: { value: null, loadedAt: 0, nextAt: 0, loading: null },
      info: { value: null, loadedAt: 0, nextAt: 0, loading: null },
      status: { value: null, loadedAt: 0, nextAt: 0, loading: null },
      failing: false,
    });
  }
  return caches.get(system.id);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}`);
  }
  return response.json();
}

/**
 * One cached value: a failed refresh keeps the last good copy (logged once per run of failures)
 * and retries after 30 s. `maxAge` drops a copy that old instead of returning it.
 */
async function cached(cache, entry, ttl, load, maxAge = Infinity) {
  const usable = () => entry.value && Date.now() - entry.loadedAt <= maxAge;
  if (usable() && Date.now() < entry.nextAt) {
    return entry.value;
  }
  if (Date.now() < entry.nextAt) {
    throw new Error('waiting before retrying');
  }

  entry.loading ??= (async () => {
    try {
      entry.value = await load();
      entry.loadedAt = Date.now();
      entry.nextAt = Date.now() + ttl;
    } catch (error) {
      entry.nextAt = Date.now() + RETRY_MS;
      if (!cache.failing) {
        console.error(`Bike share (${cache.id}) failed to load; keeping the last copy:`, error?.message || error);
      }
      cache.failing = true;
      if (!usable()) {
        throw error;
      }
      return entry.value;
    } finally {
      entry.loading = null;
    }
    cache.failing = false;
    return entry.value;
  })();
  return entry.loading;
}

/** GBFS discovery → { station_information, station_status } URLs (English feeds first). */
async function loadFeeds(system) {
  const discovery = await fetchJson(system.discoveryUrl);
  const languages = discovery?.data ?? {};
  const feeds = (languages.en ?? languages.fr ?? Object.values(languages)[0])?.feeds ?? [];
  const urlOf = (name) => feeds.find((feed) => feed?.name === name)?.url;
  const information = urlOf('station_information');
  const status = urlOf('station_status');
  if (!information || !status) {
    throw new Error(`${system.id}: no station feeds in GBFS discovery`);
  }
  return { information, status };
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function loadInformation(system, feeds) {
  const answer = await fetchJson(feeds.information);
  const byId = new Map();
  for (const station of answer?.data?.stations ?? []) {
    const lat = finite(station?.lat);
    const lon = finite(station?.lon);
    const name = typeof station?.name === 'string' ? station.name.trim().slice(0, 80) : '';
    if (station?.station_id != null && lat !== null && lon !== null && name) {
      byId.set(String(station.station_id), { name, lat, lon, capacity: finite(station.capacity) });
    }
  }
  if (!byId.size) {
    throw new Error(`${system.id}: station_information has no stations`);
  }
  return byId;
}

async function loadStatus(system, feeds) {
  const answer = await fetchJson(feeds.status);
  const byId = new Map();
  for (const station of answer?.data?.stations ?? []) {
    if (station?.station_id == null) {
      continue;
    }
    const bikes = finite(station.num_bikes_available) ?? 0;
    byId.set(String(station.station_id), {
      // Off season, or a dock being moved: not installed or not renting.
      open: Boolean(station.is_installed) && Boolean(station.is_renting),
      bikes,
      // BIXI (PBSC) counts e-bikes among the bikes and also apart; other systems may not.
      ebikes: Math.min(finite(station.num_ebikes_available) ?? 0, bikes),
      docks: finite(station.num_docks_available) ?? 0,
    });
  }
  if (!byId.size) {
    throw new Error(`${system.id}: station_status has no stations`);
  }
  const updated = finite(answer?.last_updated);
  return { byId, updatedAt: updated ? new Date(updated * 1000).toISOString() : new Date().toISOString() };
}

function metresBetween(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

export function bikeShareSystemAt(lat, lon) {
  return (
    BIKE_SHARE_SYSTEMS.find(
      ({ bounds }) => lat >= bounds.south && lat <= bounds.north && lon >= bounds.west && lon <= bounds.east,
    ) ?? null
  );
}

/**
 * `{ system: { id, name } | null, updatedAt, docks: [{ id, name, lat, lon, bikes, ebikes, freeDocks }] }`:
 * the open docks within 600 m of the point, nearest first (at most 10). Never throws.
 */
export async function bikeShareNear(lat, lon) {
  const system = bikeShareSystemAt(lat, lon);
  if (!system) {
    return { system: null, updatedAt: null, docks: [] };
  }

  const cache = cacheFor(system);
  try {
    const feeds = await cached(cache, cache.feeds, INFO_TTL_MS, () => loadFeeds(system));
    const [information, status] = await Promise.all([
      cached(cache, cache.info, INFO_TTL_MS, () => loadInformation(system, feeds)),
      cached(cache, cache.status, STATUS_TTL_MS, () => loadStatus(system, feeds), STATUS_MAX_AGE_MS),
    ]);

    const origin = { lat, lon };
    const docks = [];
    for (const [id, station] of information) {
      const state = status.byId.get(id);
      if (!state?.open || station.capacity === 0) {
        continue;
      }
      const distance = metresBetween(origin, station);
      if (distance <= BIKE_SHARE_RADIUS_METRES) {
        docks.push({
          id,
          name: station.name,
          lat: Math.round(station.lat * 1e6) / 1e6,
          lon: Math.round(station.lon * 1e6) / 1e6,
          bikes: state.bikes,
          ebikes: state.ebikes,
          freeDocks: state.docks,
          distance,
        });
      }
    }

    docks.sort((a, b) => a.distance - b.distance);
    return {
      system: { id: system.id, name: system.name },
      updatedAt: status.updatedAt,
      docks: docks.slice(0, MAX_DOCKS).map(({ distance: _distance, ...dock }) => dock),
    };
  } catch {
    // Logged in cached(); no docks rather than an error, and nothing stale.
    return { system: { id: system.id, name: system.name }, updatedAt: null, docks: [] };
  }
}
