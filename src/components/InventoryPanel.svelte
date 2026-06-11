<script>
  import InventoryCard from './InventoryCard.svelte';

  let { items, loading, loadError } = $props();
</script>

<section
  id="inventory-panel"
  class="panel active"
  aria-labelledby="inventory-heading"
>
  <h2 id="inventory-heading" class="panel-title">Inventory</h2>

  {#if loading}
    <p class="empty-state">Loading inventory...</p>
  {:else if loadError}
    <p class="status error inventory-load-error" role="alert">{loadError}</p>
  {:else if items.length === 0}
    <p class="empty-state">No items yet. Switch to Admin to add one.</p>
  {:else}
    <div class="inventory-grid">
      {#each items as item (item.id)}
        <InventoryCard {item} />
      {/each}
    </div>
  {/if}
</section>
