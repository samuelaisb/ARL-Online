<script>
  import InventoryCard from './InventoryCard.svelte';
  import ReserveAuthRequiredModal from './ReserveAuthRequiredModal.svelte';
  import ReserveCalendarModal from './ReserveCalendarModal.svelte';
  import { authReady, session } from '../lib/auth.js';
  import { INVENTORY_TAGS, DEFAULT_INVENTORY_TAG } from '../lib/inventory.js';
  import { supabaseConfigured } from '../lib/supabase.js';
  import {
    subscribeAvailabilityClock,
    unsubscribeAvailabilityClock,
  } from '../lib/availability-clock.js';
  import { t } from '../lib/i18n.js';
  import { onDestroy, onMount } from 'svelte';

  let { items, loading, loadError, onItemUpdated, onOpenRegister, onOpenLogin } = $props();

  let activeTag = $state(DEFAULT_INVENTORY_TAG);
  let reserveModal = $state();
  let authRequiredModal = $state();
  let reserveSuccessTick = $state({ id: null, at: 0 });

  const filteredItems = $derived(
    items.filter((item) => (item.tag || DEFAULT_INVENTORY_TAG) === activeTag),
  );

  const tagLabels = {
    equipment: 'inventory.filter_equipment',
    books: 'inventory.filter_books',
    rooms: 'inventory.filter_rooms',
  };

  function openReserve(item) {
    if (supabaseConfigured && $authReady && !$session) {
      authRequiredModal?.open();
      return;
    }

    reserveModal?.open(item);
  }

  function handleReserveUpdated(updatedItem) {
    onItemUpdated?.(updatedItem);
  }

  function handleReserveSuccess(updatedItem) {
    reserveSuccessTick = { id: updatedItem.id, at: Date.now() };
    onItemUpdated?.(updatedItem);
  }

  onMount(() => {
    subscribeAvailabilityClock();
  });

  onDestroy(() => {
    unsubscribeAvailabilityClock();
  });
</script>

<section
  id="inventory-panel"
  class="panel active"
  aria-labelledby="inventory-heading"
>
  <h2 id="inventory-heading" class="panel-title">{$t('inventory.heading')}</h2>

  <div class="inventory-filter" role="group" aria-label={$t('inventory.filter_aria')}>
    {#each INVENTORY_TAGS as tag (tag)}
      <button
        type="button"
        class="inventory-filter__btn"
        class:inventory-filter__btn--active={activeTag === tag}
        aria-pressed={activeTag === tag}
        onclick={() => (activeTag = tag)}
      >
        {$t(tagLabels[tag])}
      </button>
    {/each}
  </div>

  {#if loading}
    <p class="empty-state">{$t('inventory.loading')}</p>
  {:else if loadError}
    <p class="status error inventory-load-error" role="alert">{loadError}</p>
  {:else if items.length === 0}
    <p class="empty-state">{$t('inventory.empty')}</p>
  {:else if filteredItems.length === 0}
    <p class="empty-state">{$t('inventory.empty_filtered')}</p>
  {:else}
    <div class="inventory-grid">
      {#each filteredItems as item (item.id)}
        <InventoryCard {item} {reserveSuccessTick} onOpenReserve={openReserve} />
      {/each}
    </div>
  {/if}
</section>

<ReserveAuthRequiredModal
  bind:this={authRequiredModal}
  onSignUp={onOpenRegister}
  onLogIn={onOpenLogin}
/>

<ReserveCalendarModal
  bind:this={reserveModal}
  onupdated={handleReserveUpdated}
  onsuccess={handleReserveSuccess}
/>
