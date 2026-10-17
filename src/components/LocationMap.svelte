<script module>
  import L from 'leaflet';
  // Leaflet's stylesheet is loaded by LocationMapPanel before this module mounts (see there).

  // Leaflet focuses the map on a press, and after a zoom-button click, then restores only the
  // window's scroll, so a map partly scrolled out of the item dialog made the dialog jump.
  L.Map.Keyboard.include({
    _onMouseDown() {
      if (!this._focused) {
        this._map.getContainer().focus({ preventScroll: true });
      }
    },
  });
  L.Control.include({
    _refocusOnMap(event) {
      // Pointer clicks only, as in Leaflet (keyboard presses keep focus on the button).
      if (this._map && event && event.screenX > 0 && event.screenY > 0) {
        this._map.getContainer().focus({ preventScroll: true });
      }
    },
  });

  // Static markup (never place data: Leaflet writes divIcon html with innerHTML).
  const PIN_SVG =
    '<svg viewBox="0 0 28 40" width="28" height="40" aria-hidden="true" focusable="false"><path d="M14 1C6.8 1 1 6.7 1 13.8 1 23.4 14 39 14 39s13-15.6 13-25.2C27 6.7 21.2 1 14 1z"/><circle cx="14" cy="14" r="5"/></svg>';

  // A transit layer that fails this many tiles before showing one falls back to Streets.
  const TRANSIT_FAILURES_BEFORE_FALLBACK = 3;
</script>

<script>
  import { locale, t } from '../lib/i18n.js';
  import { MAP_TILE_LAYERS } from '../lib/map-tiles.js';
  import { createTransitOverlay } from '../lib/transit-overlay.js';

  /**
   * `radiusMetres` > 0 draws that circle around the point and no pin (the public area);
   * otherwise a pin marks the exact point. `label` names the map for screen readers.
   * `stations`: the place's nearby rapid-transit stations (normalizeStations' shape).
   */
  let { latitude, longitude, radiusMetres = 0, label, caption = '', stations = [] } = $props();

  const uid = $props.id();
  const hintId = `${uid}-hint`;
  // Thunderforest's key (public: it sits in every tile URL), from /config.js. Without it the map
  // offers Streets only.
  const thunderforestKey =
    window.__ARL_ENV__?.THUNDERFOREST_API_KEY || import.meta.env.VITE_THUNDERFOREST_API_KEY || '';
  const layerNames = thunderforestKey ? ['streets', 'transit'] : ['streets'];

  let canvas = $state();
  let map = $state(null);
  // Built with the map; plain values, read without tracking them.
  let mapLocale = 'en';
  let credits = null;
  let overlay = null;
  let layerName = $state('streets');
  let transitUnavailable = $state(false);
  // GET /api/bike-share for this point: `{ system, updatedAt, docks }`, or null.
  let bike = $state(null);

  const approximate = $derived(radiusMetres > 0);
  const origin = $derived({ lat: latitude, lon: longitude });

  function chooseLayer(name) {
    layerName = name;
    if (name === 'transit') {
      transitUnavailable = false;
    }
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

  /** "750 m", "1.2 km" (FR "1,2 km"); "~" on the public map, measured from the area's centre. */
  function formatDistance(metres, localeCode = $locale) {
    const number =
      metres >= 1000
        ? `${new Intl.NumberFormat(localeCode === 'fr' ? 'fr-CA' : 'en-CA', { maximumFractionDigits: 1 }).format(Math.round(metres / 100) / 10)} km`
        : `${Math.max(50, Math.round(metres / 50) * 50)} m`;
    return approximate ? `~${number}` : number;
  }

  function formatTime(iso) {
    const date = iso ? new Date(iso) : null;
    return date && !Number.isNaN(date.getTime())
      ? new Intl.DateTimeFormat($locale === 'fr' ? 'fr-CA' : 'en-CA', { hour: '2-digit', minute: '2-digit' }).format(date)
      : '';
  }

  /** "Laurier (2) 750 m, elevator": a station's line, distance and step-free access. */
  function stationText(station) {
    const refs = station.lines.map((line) => line.ref).filter(Boolean).join(', ');
    return [
      station.name,
      refs ? ` (${refs})` : '',
      ` ${formatDistance(station.distance)}`,
      station.wheelchair === true ? `, ${$t('map.elevator')}` : '',
    ].join('');
  }

  const nearbyStations = $derived(
    stations
      .map((station) => ({ ...station, distance: metresBetween(origin, station) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 3),
  );

  // Builds the map; again when the language changes (zoom titles, credits) or the point moves.
  $effect(() => {
    const currentLocale = $locale;
    const point = L.latLng(latitude, longitude);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // One finger scrolls the page on phones; pinch still zooms.
    const coarsePointer = window.matchMedia('(pointer: coarse)').matches;

    const created = L.map(canvas, {
      zoomControl: false,
      attributionControl: false,
      scrollWheelZoom: false,
      dragging: !coarsePointer,
      minZoom: 4,
      maxZoom: 19,
      zoomAnimation: !reduceMotion,
      fadeAnimation: !reduceMotion,
      markerZoomAnimation: !reduceMotion,
      inertia: !reduceMotion,
    });

    L.control
      .zoom({ zoomInTitle: $t('map.zoom_in'), zoomOutTitle: $t('map.zoom_out') })
      .addTo(created);
    credits = L.control.attribution({ prefix: false }).addTo(created);

    if (radiusMetres > 0) {
      L.circle(point, {
        radius: radiusMetres,
        interactive: false,
        className: 'location-map__area',
      }).addTo(created);
      created.fitBounds(point.toBounds(radiusMetres * 2), {
        padding: [16, 16],
        maxZoom: 16,
        animate: false,
      });
    } else {
      L.marker(point, {
        icon: L.divIcon({
          className: 'location-map__pin',
          html: PIN_SVG,
          iconSize: [28, 40],
          iconAnchor: [14, 40],
        }),
        interactive: false,
        keyboard: false,
      }).addTo(created);
      created.setView(point, 16, { animate: false });
    }

    overlay = createTransitOverlay(L, created, {
      origin: { lat: latitude, lon: longitude },
      stations,
      text: {
        distance: (metres) => formatDistance(metres, currentLocale),
        elevator: $t('map.elevator'),
      },
    });

    // Leaflet only notices window resizes; the dialog or a row can change size on its own.
    const resizeObserver = new ResizeObserver(() => created.invalidateSize({ pan: false }));
    resizeObserver.observe(canvas);

    mapLocale = currentLocale;
    map = created;

    return () => {
      resizeObserver.disconnect();
      map = null;
      overlay?.destroy();
      overlay = null;
      credits = null;
      created.remove();
    };
  });

  // The tile layer for the chosen style; Transit falls back to Streets when its server fails.
  $effect(() => {
    if (!map) {
      return;
    }

    const name = layerName;
    const spec = MAP_TILE_LAYERS[name];
    const layer = L.tileLayer(spec.url, {
      maxZoom: spec.maxZoom,
      maxNativeZoom: spec.maxNativeZoom,
      attribution: spec.attribution(mapLocale),
      ...(spec.needsKey ? { apikey: thunderforestKey } : {}),
      // The site sends no Referer; OpenStreetMap's tile policy asks for one (the origin only).
      referrerPolicy: 'strict-origin-when-cross-origin',
    });

    if (name === 'transit') {
      let loaded = 0;
      let failed = 0;
      layer.on('tileload', () => {
        loaded += 1;
      });
      layer.on('tileerror', () => {
        failed += 1;
        if (!loaded && failed >= TRANSIT_FAILURES_BEFORE_FALLBACK && layerName === 'transit') {
          transitUnavailable = true;
          layerName = 'streets';
        }
      });
    }

    const shownOn = map;
    layer.addTo(shownOn);
    // The credits changed size: chips and docks step around them again.
    overlay?.layout();

    return () => {
      // A rebuilt map already dropped its layers with remove().
      if (shownOn.hasLayer(layer)) {
        shownOn.removeLayer(layer);
      }
    };
  });

  // Live bike-share docks near the point (our server reads the system's feed; the public map
  // sends its area's centre, never the address). Nothing shows when there are none or it fails.
  $effect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ lat: String(latitude), lon: String(longitude) });
    bike = null;
    fetch(`/api/bike-share?${params}`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((result) => {
        bike = result?.system && Array.isArray(result.docks) && result.docks.length ? result : null;
      })
      .catch(() => {});
    return () => controller.abort();
  });

  // Docks onto the map (again after a rebuild), with the system's credit.
  $effect(() => {
    if (!map || !overlay) {
      return;
    }

    const docks = bike?.docks ?? [];
    const credit = bike ? $t('map.bike_credit', { system: bike.system.name }) : '';
    const shownOn = credits;
    // The credit first, so the layout below steps around the credits at their final size.
    if (credit) {
      shownOn?.addAttribution(credit);
    }
    overlay.setDocks(docks);
    return () => {
      if (credit) {
        shownOn?.removeAttribution(credit);
      }
    };
  });
</script>

<div class="location-map__body">
  {#if layerNames.length > 1}
    <div class="inventory-filter location-map__layers" role="group" aria-label={$t('map.layers_aria')}>
      {#each layerNames as name (name)}
        <button
          type="button"
          class="inventory-filter__btn"
          class:inventory-filter__btn--active={layerName === name}
          aria-pressed={layerName === name}
          onclick={() => chooseLayer(name)}
        >
          {$t(`map.layer_${name}`)}
        </button>
      {/each}
    </div>
  {/if}

  <div
    bind:this={canvas}
    class="location-map__canvas"
    role="region"
    aria-label={label}
    aria-describedby={hintId}
  ></div>
  <p id={hintId} class="visually-hidden">{$t('map.keyboard_hint')}</p>

  {#if nearbyStations.length || bike}
    <!-- The same facts as the map's markers, in text: the markers are decorative. -->
    <ul class="location-map__legend">
      {#if nearbyStations.length}
        <li class="location-map__legend-item">
          <span class="location-map__key location-map__key--station" aria-hidden="true"></span>
          <span>{$t('map.stations_label')} {nearbyStations.map(stationText).join(' · ')}</span>
        </li>
      {/if}
      {#if bike}
        <li class="location-map__legend-item">
          <span class="location-map__key location-map__key--bike" aria-hidden="true"></span>
          <span>
            {$t('map.bike_key', { system: bike.system.name, time: formatTime(bike.updatedAt) })}
            <span class="visually-hidden">
              {bike.docks
                .slice(0, 3)
                .map((dock) =>
                  $t('map.bike_dock', { name: dock.name, bikes: dock.bikes, docks: dock.freeDocks }),
                )
                .join(' · ')}
            </span>
          </span>
        </li>
      {/if}
    </ul>
  {/if}

  {#if transitUnavailable}
    <p class="location-map__note" role="status">{$t('map.transit_unavailable')}</p>
  {/if}
  {#if caption}
    <p class="location-map__caption">{caption}</p>
  {/if}
</div>
