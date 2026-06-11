<script>
  import ItemCalendar from './ItemCalendar.svelte';
  import { t } from '../lib/i18n.js';

  let { onupdated, onsuccess } = $props();

  let dialog = $state();
  let item = $state(null);

  export function open(inventoryItem) {
    item = inventoryItem;
    dialog?.showModal();
  }

  export function close() {
    dialog?.close();
    item = null;
  }

  function handleCancel(event) {
    event.preventDefault();
    close();
  }

  function handleItemUpdated(updatedItem) {
    item = updatedItem;
    onupdated?.(updatedItem);
  }

  function handleConfirmed(detail) {
    onsuccess?.(detail?.item ?? item);
    close();
  }
</script>

<dialog
  bind:this={dialog}
  class="modal modal--calendar"
  oncancel={handleCancel}
>
  {#if item}
    <div class="modal-calendar-body">
      <header class="modal-header">
        <h2>{$t('inventory.reserve_modal_title', { title: item.title })}</h2>
        <button type="button" class="icon-btn" aria-label={$t('auth.close_aria')} onclick={close}>
          &times;
        </button>
      </header>
      <ItemCalendar
        item={item}
        hideHeading
        onupdated={handleItemUpdated}
        onconfirmed={handleConfirmed}
      />
    </div>
  {/if}
</dialog>
