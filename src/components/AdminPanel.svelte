<script>
  import { deleteInventoryItem } from '../lib/inventory.js';
  import { t } from '../lib/i18n.js';

  let {
    items,
    loading,
    loadError,
    onAddItem,
    onItemRemoved,
    variant = 'panel',
  } = $props();

  let removingId = $state('');
  let removeError = $state('');

  async function handleRemove(item) {
    if (removingId) {
      return;
    }

    const confirmed = window.confirm($t('admin.remove_confirm', { title: item.title }));
    if (!confirmed) {
      return;
    }

    removingId = item.id;
    removeError = '';

    try {
      await deleteInventoryItem(item.id);
      onItemRemoved?.(item.id);
    } catch (error) {
      removeError = error.message || $t('admin.remove_error');
    } finally {
      removingId = '';
    }
  }
</script>

<section
  id="admin-panel"
  class="panel active"
  class:admin-panel--dropdown={variant === 'dropdown'}
  aria-labelledby="admin-heading"
>
  {#if variant !== 'dropdown'}
    <h2 id="admin-heading" class="panel-title">{$t('admin.heading')}</h2>
    <p class="admin-copy">{$t('admin.copy')}</p>
  {:else}
    <h2 id="admin-heading" class="visually-hidden">{$t('admin.heading')}</h2>
  {/if}
  <button
    type="button"
    class={variant === 'dropdown' ? 'btn-header btn-header--primary' : 'btn-primary'}
    onclick={onAddItem}
  >
    {$t('admin.add_item')}
  </button>

  <h3 class="admin-subheading">{$t('admin.remove_items_heading')}</h3>

  {#if loading}
    <p class="admin-status" role="status">{$t('admin.loading')}</p>
  {:else if loadError}
    <p class="admin-status admin-status-error" role="alert">{loadError}</p>
  {:else if items.length === 0}
    <p class="empty-state">{$t('admin.empty')}</p>
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
              {$t('admin.removing')}
            {:else}
              {$t('admin.remove')}
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
