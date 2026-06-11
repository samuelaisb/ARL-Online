<script>
  import { onMount } from 'svelte';
  import { loadInventoryItems } from './lib/inventory.js';
  import { t } from './lib/i18n.js';
  import InventoryPanel from './components/InventoryPanel.svelte';
  import AddItemModal from './components/AddItemModal.svelte';
  import QuoteFooter from './components/QuoteFooter.svelte';
  import HeaderAuth from './components/HeaderAuth.svelte';
  import LocaleSwitcher from './components/LocaleSwitcher.svelte';

  let items = $state([]);
  let loading = $state(true);
  let loadError = $state('');

  let addItemModal;

  async function refreshInventory() {
    loadError = '';
    loading = true;

    try {
      items = await loadInventoryItems();
    } catch (error) {
      loadError = error.message || $t('inventory.load_error');
      items = [];
    } finally {
      loading = false;
    }
  }

  function handleItemCreated(item) {
    items = [item, ...items];
  }

  function handleItemRemoved(id) {
    items = items.filter((item) => item.id !== id);
  }

  function handleItemUpdated(updatedItem) {
    items = items.map((item) => (item.id === updatedItem.id ? updatedItem : item));
  }

  function openAddItemModal() {
    addItemModal?.open();
  }

  $effect(() => {
    document.title = $t('site.title');
  });

  onMount(() => {
    refreshInventory();
  });
</script>

<div class="app">
  <header class="site-header">
    <a class="site-header__brand" href="/" aria-label={$t('site.brand_home_aria')}>
      <img
        class="site-header__logo"
        src="/assets/brand/apathy-is-boring-logo.png"
        alt={$t('site.brand_name')}
        width="240"
        height="64"
      />
    </a>
    <div class="site-header__actions">
      <LocaleSwitcher />
      <HeaderAuth
        {items}
        {loading}
        {loadError}
        onAddItem={openAddItemModal}
        onItemRemoved={handleItemRemoved}
      />
    </div>
  </header>

  <div class="app-body">
    <main class="container">
      <header class="page-header">
        <h1>{$t('site.title')}</h1>
        <p class="subtitle">{$t('site.subtitle')}</p>
      </header>

      <InventoryPanel
        items={items}
        loading={loading}
        loadError={loadError}
        onItemUpdated={handleItemUpdated}
      />
    </main>
  </div>
</div>

<QuoteFooter />

<aside class="site-attribution" aria-label={$t('site.attribution_aria')}>
  <p class="site-attribution__text">
    {$t('site.attribution_text')}
  </p>
  <a
    class="site-attribution__logo-link"
    href="https://www.fesplanet.org"
    target="_blank"
    rel="noopener noreferrer"
    aria-label={$t('site.attribution_link_aria')}
  >
    <img
      class="site-attribution__logo"
      src="/assets/brand/fes-logo.webp"
      alt={$t('site.fes_name')}
      width="120"
      height="40"
    />
  </a>
</aside>

<AddItemModal bind:this={addItemModal} oncreated={handleItemCreated} />
