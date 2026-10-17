/**
 * Map tile layers for LocationMap. server.js adds MAP_TILE_HOSTS to the CSP's img-src, so the
 * hosts here and the policy can't drift apart. Tiles load only after a visitor opens a map.
 *
 * - Streets (default): OpenStreetMap's standard tiles (free, no key; low traffic is fine with a
 *   visible credit and a Referer, https://operations.osmfoundation.org/policies/tiles/).
 * - Transit: Thunderforest's Transport style (bus routes with their numbers, stops, stations).
 *   Needs THUNDERFOREST_API_KEY (free Hobby plan, https://www.thunderforest.com/pricing/); the
 *   key sits in the tile URL, so it is public. Without it the map offers Streets only.
 *   Both carry our own stations and bike-share layer on top (LocationMap).
 */

const NEW_TAB = 'target="_blank" rel="noopener noreferrer"';

/** The OpenStreetMap credit its licence asks for, in the page's language. */
function osmCredit(locale) {
  const link = `<a href="https://www.openstreetmap.org/copyright" ${NEW_TAB}>OpenStreetMap</a>`;
  return locale === 'fr' ? `&copy; les contributeurs d’${link}` : `&copy; ${link} contributors`;
}

export const MAP_TILE_LAYERS = Object.freeze({
  streets: Object.freeze({
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxZoom: 19,
    maxNativeZoom: 19,
    needsKey: false,
    attribution: (locale) => osmCredit(locale),
  }),
  transit: Object.freeze({
    // {r} is "@2x" on high-density screens (Leaflet); {apikey} comes from the layer's options.
    url: 'https://api.thunderforest.com/transport/{z}/{x}/{y}{r}.png?apikey={apikey}',
    maxZoom: 19,
    maxNativeZoom: 22,
    needsKey: true,
    // Thunderforest's terms ask for both credits.
    attribution: (locale) =>
      `${locale === 'fr' ? 'Cartes' : 'Maps'} &copy; <a href="https://www.thunderforest.com/" ${NEW_TAB}>Thunderforest</a> · ${osmCredit(locale)}`,
  }),
});

export const MAP_TILE_HOSTS = Object.freeze(
  Object.values(MAP_TILE_LAYERS).map((layer) => new URL(layer.url.replace(/\{[a-z]+\}/g, '0')).origin),
);
