<script>
  import { deleteInventoryItem } from '../lib/inventory.js';

  let { items, loading, loadError, onAddItem, onItemRemoved } = $props();

  let removingId = $state('');
  let removeError = $state('');

  async function handleRemove(item) {
    if (removingId) {
      return;
    }

    const confirmed = window.confirm(`Remove "${item.title}" from inventory?`);
    if (!confirmed) {
      return;
    }

    removingId = item.id;
    removeError = '';

    try {
      await deleteInventoryItem(item.id);
      onItemRemoved?.(item.id);
    } catch (error) {
      removeError = error.message || 'Could not remove item.';
    } finally {
      removingId = '';
    }
  }
</script>

<section id="admin-panel" class="panel active" aria-labelledby="admin-heading">
  <h2 id="admin-heading" class="panel-title">Admin</h2>
  <p class="admin-copy">Create new inventory items or remove existing ones.</p>
  <button type="button" class="btn-primary" onclick={onAddItem}>Add Item</button>

  <h3 class="admin-subheading">Remove items</h3>

  {#if loading}
    <p class="admin-status" role="status">Loading inventory…</p>
  {:else if loadError}
    <p class="admin-status admin-status-error" role="alert">{loadError}</p>
  {:else if items.length === 0}
    <p class="empty-state">No items to remove.</p>
  {:else}
    <ul class="admin-item-list">
      {#each items as item (item.id)}
        <li class="admin-item-row">
          <span class="admin-item-title">{item.title}</span>
          <button
            type="button"
            class="btn-remove"
            disabled={Boolean(removingId)}
            onclick={() => handleRemove(item)}
          >
            {#if removingId === item.id}
              Removing…
            {:else}
              Remove
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if removeError}
    <p class="admin-status admin-status-error" role="alert">{removeError}</p>
  {/if}
</section>
