/**
 * Map tile layers for LocationMap. server.js adds MAP_TILE_HOSTS to the CSP's img-src, so the
 * hosts here and the policy can't drift apart. Tiles load only after a visitor opens a map.
 *
 * - Streets: OpenStreetMap's standard tiles (free, no key; low traffic is fine with a visible
 *   credit and a Referer, https://operations.osmfoundation.org/policies/tiles/).
 * - Transit: ÖPNVKarte by memomaps.de (bus and metro lines with route numbers; free content on
 *   donated server capacity, so it's opt-in and falls back to Streets when its tiles fail).
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
    attribution: (locale) => osmCredit(locale),
  }),
  transit: Object.freeze({
    url: 'https://tileserver.memomaps.de/tilegen/{z}/{x}/{y}.png',
    // The server has no z19 tiles (404), so the last zoom step upscales z18.
    maxZoom: 19,
    maxNativeZoom: 18,
    attribution: (locale) =>
      `<a href="https://memomaps.de/" ${NEW_TAB}>memomaps.de</a> <a href="https://creativecommons.org/licenses/by-sa/2.0/" ${NEW_TAB}>CC BY-SA</a> · ${osmCredit(locale)}`,
  }),
});

export const MAP_TILE_HOSTS = Object.freeze(
  Object.values(MAP_TILE_LAYERS).map((layer) => new URL(layer.url.replace(/\{[a-z]\}/g, '0')).origin),
);
