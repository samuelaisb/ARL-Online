<script>
  import { onMount } from 'svelte';
  import { t } from '../lib/i18n.js';

  // Rendered by App.svelte's `{:catch}` when a lazy page's chunk fails to load.
  // Usually the tab was opened before a deploy: its entry still names the old
  // hashed chunks, which the server now answers with a plain-text 404. Reload
  // once to pick up the new build. The timestamp stops a reload loop when the
  // chunk fails for another reason (bad connection, broken deploy); this message
  // and its button stay up instead.
  // The card fades in with the CSS .reveal-in: a local in:reveal directly inside
  // this component's own {#if} would not play when the component mounts.
  const RELOAD_STORAGE_KEY = 'arl-chunk-reload-at';
  const RELOAD_GUARD_MS = 60_000;

  /** `overlay`: float over the inventory grid (item overlay) instead of filling `<main>`. */
  let { overlay = false } = $props();

  function reloadPage() {
    window.location.reload();
  }

  function claimAutoReload() {
    if (navigator.onLine === false) {
      return false;
    }

    try {
      const lastReloadAt = Number(sessionStorage.getItem(RELOAD_STORAGE_KEY)) || 0;
      if (Date.now() - lastReloadAt < RELOAD_GUARD_MS) {
        return false;
      }
      sessionStorage.setItem(RELOAD_STORAGE_KEY, String(Date.now()));
      return true;
    } catch {
      // Without storage there is no loop guard, so leave it to the button.
      return false;
    }
  }

  onMount(() => {
    if (claimAutoReload()) {
      reloadPage();
    }
  });
</script>

{#snippet notice()}
  <p class="status error" role="alert">{$t('page_load_error.message')}</p>
  <button type="button" class="btn-secondary" onclick={reloadPage}>
    {$t('page_load_error.reload')}
  </button>
{/snippet}

{#if overlay}
  <div class="page-load-error page-load-error--overlay reveal-in">
    {@render notice()}
  </div>
{:else}
  <main id="main-content" class="container page-load-error reveal-in">
    {@render notice()}
  </main>
{/if}
