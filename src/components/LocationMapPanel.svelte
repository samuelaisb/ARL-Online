<script module>
  // Leaflet's stylesheet goes in as a <link> of our own, not as a CSS import of LocationMap:
  // Vite's preload remembers a stylesheet that failed and never fetches it again, so a retry
  // would mount Leaflet with no styles. Pages without a map never load either file.
  import leafletCssUrl from 'leaflet/dist/leaflet.css?url';

  let leafletCss = null;
  let mapModule = null;

  function loadLeafletCss() {
    leafletCss ??= new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = leafletCssUrl;
      link.onload = () => resolve();
      link.onerror = () => {
        link.remove();
        leafletCss = null;
        reject(new Error('Could not load the map stylesheet.'));
      };
      document.head.append(link);
    });
    return leafletCss;
  }

  // LocationMap (and Leaflet with it) is its own chunk, fetched the first time someone opens a
  // map. A failed load is dropped, so Try again fetches it anew.
  function loadLocationMap() {
    mapModule ??= Promise.all([loadLeafletCss(), import('./LocationMap.svelte')]).then(
      ([, module]) => module,
      (error) => {
        mapModule = null;
        throw error;
      },
    );
    return mapModule;
  }
</script>

<script>
  import { tick } from 'svelte';
  import { t } from '../lib/i18n.js';

  /** The opened map (see LocationMap for the props). `id` is what the toggle's aria-controls names. */
  let { id, latitude, longitude, radiusMetres = 0, label, caption = '', stations = [] } = $props();

  let panel = $state();
  let loading = $state(loadLocationMap());

  // Try again is replaced by the loading frame, so focus moves to the panel instead of the page.
  async function retry() {
    loading = loadLocationMap();
    await tick();
    panel?.focus();
  }
</script>

<div bind:this={panel} {id} class="location-map" tabindex="-1">
  {#await loading}
    <div class="location-map__canvas location-map__canvas--loading" role="status">
      <span class="location-map__loading-text">{$t('map.loading')}</span>
    </div>
  {:then { default: LocationMap }}
    <LocationMap {latitude} {longitude} {radiusMetres} {label} {caption} {stations} />
  {:catch}
    <div class="location-map__error">
      <p class="status error" role="alert">{$t('map.load_error')}</p>
      <button type="button" class="btn-secondary" onclick={retry}>{$t('item_detail.try_again')}</button>
    </div>
  {/await}
</div>
