<script>
  import { onMount } from 'svelte';
  import { loadInventoryItems } from './lib/inventory.js';
  import InventoryPanel from './components/InventoryPanel.svelte';
  import AdminPanel from './components/AdminPanel.svelte';
  import AddItemModal from './components/AddItemModal.svelte';
  import QuoteFooter from './components/QuoteFooter.svelte';
  import HeaderAuth from './components/HeaderAuth.svelte';

  let activeTab = $state('inventory');
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
      loadError = error.message || 'Could not load inventory.';
      items = [];
    } finally {
      loading = false;
    }
  }

  function switchTab(tabName) {
    activeTab = tabName;
  }

  function handleItemCreated(item) {
    items = [item, ...items];
    activeTab = 'inventory';
  }

  function handleItemRemoved(id) {
    items = items.filter((item) => item.id !== id);
  }

  function openAddItemModal() {
    addItemModal?.open();
  }

  onMount(() => {
    refreshInventory();
  });
</script>

<div class="app">
  <header class="site-header">
    <a class="site-header__brand" href="/" aria-label="Apathy is Boring home">
      <img
        class="site-header__logo"
        src="/assets/brand/apathy-is-boring-logo.png"
        alt="Apathy is Boring"
        width="240"
        height="64"
      />
    </a>
    <HeaderAuth />
  </header>

  <div class="app-body">
    <main class="container">
      <header class="page-header">
        <h1>Activist Resource Library - Montreal</h1>
        <p class="subtitle">Browse inventory or add new items in admin.</p>
        <nav class="tabs" aria-label="Main navigation">
          <button
            type="button"
            class="tab"
            class:active={activeTab === 'inventory'}
            onclick={() => switchTab('inventory')}
          >
            Inventory
          </button>
          <button
            type="button"
            class="tab"
            class:active={activeTab === 'admin'}
            onclick={() => switchTab('admin')}
          >
            Admin
          </button>
        </nav>
      </header>

      {#if activeTab === 'inventory'}
        <InventoryPanel items={items} loading={loading} loadError={loadError} />
      {:else}
        <AdminPanel
          {items}
          {loading}
          {loadError}
          onAddItem={openAddItemModal}
          onItemRemoved={handleItemRemoved}
        />
      {/if}
    </main>
  </div>
</div>

<QuoteFooter />

<aside class="site-attribution" aria-label="Created by Finance Engage Sustain">
  <p class="site-attribution__text">
    The Activist Resource Library was created by Finance Engage Sustain
  </p>
  <img
    class="site-attribution__logo"
    src="/assets/brand/fes-logo.webp"
    alt="Finance Engage Sustain"
    width="120"
    height="40"
  />
</aside>

<AddItemModal bind:this={addItemModal} oncreated={handleItemCreated} />
