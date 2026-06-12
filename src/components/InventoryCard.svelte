<script>
  import { onDestroy, onMount } from 'svelte';
  import {
    availabilityNow,
    subscribeAvailabilityClock,
    unsubscribeAvailabilityClock,
  } from '../lib/availability-clock.js';
  import { hasAvailabilityWithinDays, isCurrentlyReserved } from '../lib/calendar.js';
  import { t } from '../lib/i18n.js';

  let { item, reserveSuccessTick, onOpenReserve } = $props();

  let statusMessage = $state('');
  let statusType = $state('');
  let fadeOut = $state(false);

  let fadeTimeout;
  let hideTimeout;

  // Explicit reactive snapshot of the reservations array so Svelte 5 fine-grained
  // tracking is guaranteed even when item.reservations is mutated in-place on the proxy.
  const reservations = $derived(item.reservations ?? []);
  const itemTag = $derived(item.tag ?? 'equipment');

  let unavailable = $derived(isCurrentlyReserved(reservations, new Date($availabilityNow)));
  let checkAvailability = $derived(
    !unavailable && !hasAvailabilityWithinDays(reservations, itemTag, 7, new Date($availabilityNow)),
  );

  onMount(() => {
    subscribeAvailabilityClock();
  });

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

  function openReserveModal() {
    onOpenReserve?.(item);
  }

  $effect(() => {
    const { id, at } = reserveSuccessTick;
    if (id === item.id && at) {
      setStatus($t('inventory.reservation_complete'), 'success');
    }
  });

  onDestroy(() => {
    clearStatusTimeouts();
    unsubscribeAvailabilityClock();
  });
</script>

<article class="inventory-card">
  <div class="inventory-image-frame">
    <img class="inventory-image" src={item.image} alt={item.title} loading="lazy" />
    <span
      class="availability-badge"
      class:availability-badge--available={!unavailable && !checkAvailability}
      class:availability-badge--check={checkAvailability}
      class:availability-badge--unavailable={unavailable}
      role="status"
      aria-live="polite"
    >
      {#if unavailable}
        {$t('calendar.unavailable')}
      {:else if checkAvailability}
        {$t('calendar.check_availability')}
      {:else}
        {$t('calendar.available')}
      {/if}
    </span>
  </div>
  <div class="inventory-content">
    <h3>{item.title}</h3>
    <p>{item.body}</p>

    <button type="button" class="btn-reserve" onclick={openReserveModal}>
      {$t('inventory.reserve')}
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
