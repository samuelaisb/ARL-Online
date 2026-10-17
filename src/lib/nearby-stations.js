/**
 * Rapid-transit stations near a place (métro, light rail, commuter rail), from OpenStreetMap.
 * Worked out once per place by `npm run place:stations` (never while someone views a page) and
 * stored in item_locations.nearby_stations (migration 011). Server and scripts only: it builds
 * the Overpass query and reads its answer; the caller does the fetching.
 */

import { normalizeStations } from './item-location.js';

export const STATIONS_RADIUS_METRES = 1500;
/** A route stop this close to a station counts as that station's platform. */
const PLATFORM_RADIUS_METRES = 250;
const MAX_STATIONS = 5;
const RAIL_ROUTES = '^(subway|light_rail|train|monorail)$';

export function stationsOverpassQuery(latitude, longitude, radius = STATIONS_RADIUS_METRES) {
  const around = `around:${radius},${latitude},${longitude}`;
  const aroundStops = `around:${radius + PLATFORM_RADIUS_METRES},${latitude},${longitude}`;
  return `[out:json][timeout:120];
(
  nwr(${around})[railway=station][station~"^(subway|light_rail|train|monorail)$"];
  nwr(${around})[public_transport=station][subway=yes];
  nwr(${around})[public_transport=station][light_rail=yes];
  nwr(${around})[public_transport=station][train=yes];
)->.stations;
.stations out center tags;
(
  nwr(${aroundStops})[public_transport~"^(stop_position|platform)$"];
  nwr(${aroundStops})[railway~"^(stop|platform|halt)$"];
)->.stops;
.stops out center tags;
(rel(bn.stops)[route~"${RAIL_ROUTES}"]; rel(bw.stops)[route~"${RAIL_ROUTES}"];)->.routes;
.routes out body;
rel(br.routes)[type=route_master];
out body;`;
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

function pointOf(element) {
  if (typeof element.lat === 'number') {
    return { lat: element.lat, lon: element.lon };
  }
  return element.center ? { lat: element.center.lat, lon: element.center.lon } : null;
}

const key = (type, id) => `${type}/${id}`;

/**
 * Overpass's answer → up to 5 stations, nearest first, with their lines (ref, name, colour from
 * the route or its route master) and step-free access when tagged. The nearest station of each
 * line comes first, so a second line isn't crowded out by more stations of the first.
 */
export function stationsFromOverpass(answer, origin) {
  const elements = Array.isArray(answer?.elements) ? answer.elements : [];
  const stations = [];
  const stops = [];
  const routes = [];
  const masters = [];

  for (const element of elements) {
    const tags = element.tags ?? {};
    if (element.type === 'relation' && tags.type === 'route_master') {
      masters.push(element);
    } else if (element.type === 'relation' && tags.route) {
      routes.push(element);
    } else if (tags.railway === 'station' || tags.public_transport === 'station') {
      const point = pointOf(element);
      if (point && tags.name) {
        stations.push({ element, point, tags });
      }
    } else {
      const point = pointOf(element);
      if (point) {
        stops.push({ id: key(element.type, element.id), point });
      }
    }
  }

  const masterOf = new Map();
  for (const master of masters) {
    for (const member of master.members ?? []) {
      masterOf.set(member.ref, master);
    }
  }

  const lineOf = (route) => {
    const master = masterOf.get(route.id);
    const tags = { ...(route.tags ?? {}), ...(master?.tags ?? {}) };
    return {
      ref: tags.ref ?? route.tags?.ref ?? '',
      name: tags.name ?? route.tags?.name ?? '',
      colour: tags.colour ?? route.tags?.colour ?? '',
    };
  };

  const result = stations.map(({ point, tags }) => {
    const nearStops = new Set(
      stops.filter((stop) => metresBetween(stop.point, point) <= PLATFORM_RADIUS_METRES).map((stop) => stop.id),
    );
    const lines = [];
    for (const route of routes) {
      if (!(route.members ?? []).some((member) => nearStops.has(key(member.type, member.ref)))) {
        continue;
      }
      const line = lineOf(route);
      if (!lines.some((other) => other.ref === line.ref && other.name === line.name)) {
        lines.push(line);
      }
    }

    return {
      name: tags.name,
      lat: Math.round(point.lat * 1e6) / 1e6,
      lon: Math.round(point.lon * 1e6) / 1e6,
      lines,
      wheelchair: tags.wheelchair === 'yes' ? true : tags.wheelchair === 'no' ? false : null,
      distance: metresBetween(origin, point),
    };
  });

  // Several station objects for one stop (a node and its area, or one per line) keep the nearest.
  result.sort((a, b) => a.distance - b.distance);
  const unique = result.filter(
    (station, index) => result.findIndex((other) => other.name === station.name) === index,
  );

  const chosen = [];
  const lineKey = (line) => `${line.ref}|${line.name}`;
  const seenLines = new Set();
  for (const station of unique) {
    if (station.lines.some((line) => !seenLines.has(lineKey(line)))) {
      chosen.push(station);
      station.lines.forEach((line) => seenLines.add(lineKey(line)));
    }
  }
  for (const station of unique) {
    if (!chosen.includes(station)) {
      chosen.push(station);
    }
  }

  return normalizeStations(
    chosen
      .slice(0, MAX_STATIONS)
      .sort((a, b) => a.distance - b.distance)
      .map(({ distance: _distance, ...station }) => station),
  );
}
