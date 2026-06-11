<script>
  import { reserveInventoryItem } from '../lib/inventory.js';

  let { item } = $props();

  let reserving = $state(false);
  let reserved = $state(false);
  let statusMessage = $state('');
  let statusType = $state('');
  let fadeOut = $state(false);

  let fadeTimeout;
  let hideTimeout;

  function clearStatusTimeouts() {
    clearTimeout(fadeTimeout);
    clearTimeout(hideTimeout);
  }

  function setStatus(message, type) {
    clearStatusTimeouts();
    statusMessage = message;
    statusType = type;
    fadeOut = false;

    if (type === 'success') {
      fadeTimeout = setTimeout(() => {
        fadeOut = true;
        hideTimeout = setTimeout(() => {
          statusMessage = '';
          statusType = '';
          fadeOut = false;
        }, 500);
      }, 5000);
    }
  }

  async function handleReserve() {
    reserving = true;
    setStatus('', '');

    try {
      await reserveInventoryItem(item);
      reserving = false;
      reserved = true;
      setStatus('Reservation email sent.', 'success');
    } catch (error) {
      reserving = false;
      setStatus(error.message || 'Could not send reservation email.', 'error');
    }
  }
</script>

<article class="inventory-card">
  <div class="inventory-image-frame">
    <img class="inventory-image" src={item.image} alt={item.title} loading="lazy" />
  </div>
  <div class="inventory-content">
    <h3>{item.title}</h3>
    <p>{item.body}</p>
    <button
      type="button"
      class="btn-reserve"
      disabled={reserving || reserved}
      onclick={handleReserve}
    >
      {#if reserving}
        Reserving...
      {:else if reserved}
        Reserved
      {:else}
        Reserve Inventory
      {/if}
    </button>
    {#if statusMessage}
      <p
        class="card-status status {statusType}"
        class:fade-out={fadeOut}
        role="status"
        aria-live="polite"
      >
        {statusMessage}
      </p>
    {/if}
  </div>
</article>
