<script>
  import InventoryCard from './InventoryCard.svelte';
  import { INVENTORY_TAGS, DEFAULT_INVENTORY_TAG } from '../lib/inventory.js';
  import {
    subscribeAvailabilityClock,
    unsubscribeAvailabilityClock,
  } from '../lib/availability-clock.js';
  import { t } from '../lib/i18n.js';
  import {
    categoryToPath,
    getCategoryFromPath,
    getItemRouteParams,
    navigate,
    navigateToItemWithReserve,
    path,
  } from '../lib/router.js';
  import { onDestroy, onMount } from 'svelte';

  let { items, loading, loadError } = $props();

  let activeTag = $state(DEFAULT_INVENTORY_TAG);

  const filteredItems = $derived(
    items.filter((item) => (item.tag || DEFAULT_INVENTORY_TAG) === activeTag),
  );

  const tagCounts = $derived(
    Object.fromEntries(
      INVENTORY_TAGS.map((tag) => [
        tag,
        items.filter((item) => (item.tag || DEFAULT_INVENTORY_TAG) === tag).length,
      ]),
    ),
  );

  const tagLabels = {
    equipment: 'inventory.filter_equipment',
    books: 'inventory.filter_books',
    rooms: 'inventory.filter_rooms',
  };

  $effect(() => {
    const category = getCategoryFromPath($path);
    if (category) {
      activeTag = category;
      return;
    }

    // On item detail routes (/{tag}/{slug}) the overlay sits on top of the grid;
    // keep the grid filtered to the item's category so closing reveals the right list.
    const itemParams = getItemRouteParams($path);
    if (itemParams) {
      activeTag = itemParams.tag;
    }
  });

  function selectTag(tag) {
    navigate(categoryToPath(tag));
  }

  function openReserve(item) {
    if (!item) {
      return;
    }

    if (!item.slug) {
      // Defensive: server slug backfill should populate this. Fall back to a
      // client-generated slug (via itemToPath) so Reserve never silently no-ops.
      console.warn(
        `Inventory item "${item.title ?? item.id}" has no slug; using a generated slug for navigation. Run "npm run backfill:slugs" (or restart the server) to populate slugs.`,
      );
    }

    navigateToItemWithReserve(item);
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
  <h2 id="inventory-heading" class="visually-hidden">{$t('inventory.heading')}</h2>

  <div class="inventory-filter" role="group" aria-label={$t('inventory.filter_aria')}>
    {#each INVENTORY_TAGS as tag (tag)}
      <button
        type="button"
        class="inventory-filter__btn"
        class:inventory-filter__btn--active={activeTag === tag}
        aria-pressed={activeTag === tag}
        aria-label={$t('inventory.filter_with_count', {
          label: $t(tagLabels[tag]),
          count: tagCounts[tag],
        })}
        onclick={() => selectTag(tag)}
      >
        <span class="inventory-filter__label">{$t(tagLabels[tag])}</span>
        <span class="inventory-filter__count" aria-hidden="true">{tagCounts[tag]}</span>
      </button>
    {/each}
  </div>

  {#if loading}
    <div class="inventory-skeleton-grid" aria-busy="true" aria-label={$t('inventory.loading')}>
      {#each Array(6) as _, index (index)}
        <div class="inventory-skeleton-card">
          <div class="inventory-skeleton-card__image"></div>
          <div class="inventory-skeleton-card__body">
            <div class="inventory-skeleton-card__line inventory-skeleton-card__line--title"></div>
            <div class="inventory-skeleton-card__line"></div>
            <div class="inventory-skeleton-card__line inventory-skeleton-card__line--short"></div>
            <div class="inventory-skeleton-card__button"></div>
          </div>
        </div>
      {/each}
    </div>
  {:else if loadError}
    <p class="status error inventory-load-error" role="alert">{loadError}</p>
  {:else if items.length === 0}
    <p class="empty-state">{$t('inventory.empty')}</p>
  {:else if filteredItems.length === 0}
    <p class="empty-state">{$t('inventory.empty_filtered')}</p>
  {:else}
    <div class="inventory-grid">
      {#each filteredItems as item (item.id)}
        <InventoryCard {item} onOpenReserve={openReserve} />
      {/each}
    </div>
  {/if}
</section>

