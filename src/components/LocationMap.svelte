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

  /**
   * `radiusMetres` > 0 draws that circle around the point and no pin (the public area);
   * otherwise a pin marks the exact point. `label` names the map for screen readers.
   */
  let { latitude, longitude, radiusMetres = 0, label, caption = '' } = $props();

  const uid = $props.id();
  const hintId = `${uid}-hint`;

  let canvas = $state();
  let map = $state(null);
  // The language `map` was built in, for the tile credits (read without tracking it).
  let mapLocale = 'en';
  let layerName = $state('streets');
  let transitUnavailable = $state(false);

  function chooseLayer(name) {
    layerName = name;
    if (name === 'transit') {
      transitUnavailable = false;
    }
  }

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
    L.control.attribution({ prefix: false }).addTo(created);

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

    // Leaflet only notices window resizes; the dialog or a row can change size on its own.
    const resizeObserver = new ResizeObserver(() => created.invalidateSize({ pan: false }));
    resizeObserver.observe(canvas);

    mapLocale = currentLocale;
    map = created;

    return () => {
      resizeObserver.disconnect();
      map = null;
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

    return () => {
      // A rebuilt map already dropped its layers with remove().
      if (shownOn.hasLayer(layer)) {
        shownOn.removeLayer(layer);
      }
    };
  });
</script>

<div class="location-map__body">
  <div class="inventory-filter location-map__layers" role="group" aria-label={$t('map.layers_aria')}>
    {#each ['streets', 'transit'] as name (name)}
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

  <div
    bind:this={canvas}
    class="location-map__canvas"
    role="region"
    aria-label={label}
    aria-describedby={hintId}
  ></div>
  <p id={hintId} class="visually-hidden">{$t('map.keyboard_hint')}</p>

  {#if transitUnavailable}
    <p class="location-map__note" role="status">{$t('map.transit_unavailable')}</p>
  {/if}
  {#if caption}
    <p class="location-map__caption">{caption}</p>
  {/if}
</div>
