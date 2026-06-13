<script module>
  import { translateKey } from '../lib/i18n.js';
  import { notify } from '../lib/notification-store.js';

  // Shared across all card instances: shuffle cycle + cooldown for item reactions.
  const ITEM_HOVER_DELAY = 3000;
  const ITEM_REACTION_COOLDOWN = 3000;
  let lastItemReactionTime = 0;
  let reactionShuffledIndices = [];
  let reactionShufflePos = 0;

  function getNextReaction() {
    const reactions = translateKey('kimchi.item_reactions');
    const messages = Array.isArray(reactions) ? reactions : [];
    if (messages.length === 0) return null;

    if (reactionShufflePos >= reactionShuffledIndices.length || reactionShuffledIndices.length !== messages.length) {
      reactionShuffledIndices = [...Array(messages.length).keys()].sort(() => Math.random() - 0.5);
      reactionShufflePos = 0;
    }

    return messages[reactionShuffledIndices[reactionShufflePos++]];
  }

  function triggerItemReaction() {
    const now = Date.now();
    if (now - lastItemReactionTime < ITEM_REACTION_COOLDOWN) return;
    const text = getNextReaction();
    if (!text) return;
    lastItemReactionTime = now;
    notify(text);
  }
</script>

<script>
  import { onDestroy } from 'svelte';
  import { availabilityNow } from '../lib/availability-clock.js';
  import { hasAvailabilityWithinDays, isCurrentlyReserved } from '../lib/calendar.js';
  import { t } from '../lib/i18n.js';

  let { item, reserveSuccessTick, onOpenReserve } = $props();

  let statusMessage = $state('');
  let statusType = $state('');
  let fadeOut = $state(false);

  let fadeTimeout;
  let hideTimeout;
  let hoverTimer;

  // Explicit reactive snapshot of the reservations array so Svelte 5 fine-grained
  // tracking is guaranteed even when item.reservations is mutated in-place on the proxy.
  const reservations = $derived(item.reservations ?? []);
  const itemTag = $derived(item.tag ?? 'equipment');

  let unavailable = $derived(isCurrentlyReserved(reservations, new Date($availabilityNow)));
  let checkAvailability = $derived(
    !unavailable && !hasAvailabilityWithinDays(reservations, itemTag, 7, new Date($availabilityNow)),
  );

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
    triggerItemReaction();
    onOpenReserve?.(item);
  }

  function handleMouseEnter() {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(triggerItemReaction, ITEM_HOVER_DELAY);
  }

  function handleMouseLeave() {
    clearTimeout(hoverTimer);
  }

  $effect(() => {
    const { id, at, pending } = reserveSuccessTick;
    if (id === item.id && at) {
      setStatus(
        pending ? $t('inventory.reservation_pending') : $t('inventory.reservation_complete'),
        'success',
      );
    }
  });

  onDestroy(() => {
    clearStatusTimeouts();
    clearTimeout(hoverTimer);
  });
</script>

<article class="inventory-card" onmouseenter={handleMouseEnter} onmouseleave={handleMouseLeave}>
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
