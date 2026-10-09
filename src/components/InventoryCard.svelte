<script module>
  import { translateKey } from '../lib/i18n.js';
  import { readSessionJson, writeSessionJson } from '../lib/kimchi-memory.js';
  import { notify } from '../lib/notification-store.js';

  // Shared across all card instances: shuffle cycle + cooldown for item reactions.
  const ITEM_HOVER_DELAY = 4000;
  const ITEM_REACTION_COOLDOWN = 3000;
  let lastItemReactionTime = 0;
  let reactionShuffledIndices = [];
  let reactionShufflePos = 0;

  /** sessionStorage: `${line}:${itemId}` for each card status line already said this tab session. */
  const STATUS_LINES_SESSION_KEY = 'arl-kimchi-card-lines';
  const STATUS_LINES_LIMIT = 200;
  /** Same entries in memory, so a blocked sessionStorage still holds until the next reload. */
  const statusLinesSaid = new Set();

  /** Index into `kimchi.item_reactions` (shuffled, no repeat until every line has shown), or null. */
  function getNextReactionIndex() {
    const reactions = translateKey('kimchi.item_reactions');
    const count = Array.isArray(reactions) ? reactions.length : 0;
    if (count === 0) return null;

    if (reactionShufflePos >= reactionShuffledIndices.length || reactionShuffledIndices.length !== count) {
      reactionShuffledIndices = [...Array(count).keys()].sort(() => Math.random() - 0.5);
      reactionShufflePos = 0;
    }

    return reactionShuffledIndices[reactionShufflePos++];
  }

  /** The card's own line (`kimchi.card_reactions.*`): expertise, or its availability badge. */
  function getStatusLine({ isExpertise, unavailable, checkAvailability }) {
    if (isExpertise) return 'expertise';
    if (unavailable) return 'unavailable';
    if (checkAvailability) return 'check_availability';
    return null;
  }

  function readStatusLinesSaid() {
    const saved = readSessionJson(STATUS_LINES_SESSION_KEY, []);
    return Array.isArray(saved) ? saved : [];
  }

  function statusLineSaid(entry) {
    return statusLinesSaid.has(entry) || readStatusLinesSaid().includes(entry);
  }

  function rememberStatusLine(entry) {
    statusLinesSaid.add(entry);
    const entries = readStatusLinesSaid().filter((saved) => saved !== entry);
    entries.push(entry);
    writeSessionJson(STATUS_LINES_SESSION_KEY, entries.slice(-STATUS_LINES_LIMIT));
  }

  /**
   * The hover reaction. A card's status line (booked, busy week, or a mentor) comes first,
   * once per item per tab session; after that the random reactions, except on mentor cards,
   * since those lines are about things ("Oh I haven't tried that one…").
   * `getCardState` is read when the hover delay ends, so a badge that changed meanwhile counts.
   */
  function triggerItemReaction(getCardState) {
    const now = Date.now();
    if (now - lastItemReactionTime < ITEM_REACTION_COOLDOWN) return;

    const { itemId, ...state } = getCardState();
    const line = getStatusLine(state);
    const lineEntry = line ? `${line}:${itemId}` : null;
    const sayStatusLine = Boolean(lineEntry) && !statusLineSaid(lineEntry);

    let message;
    if (sayStatusLine) {
      message = { textKey: `kimchi.card_reactions.${line}` };
    } else if (state.isExpertise) {
      return;
    } else {
      const index = getNextReactionIndex();
      if (index == null) return;
      message = { textKey: `kimchi.item_reactions.${index}` };
    }

    lastItemReactionTime = now;
    const id = notify(message);
    // Asleep (-1): the line hasn't been said yet.
    if (sayStatusLine && id !== -1) rememberStatusLine(lineEntry);
  }
</script>

<script>
  import { onDestroy } from 'svelte';
  import { availabilityNow } from '../lib/availability-clock.js';
  import { splitExpertiseCopy } from '../lib/expertise-fields.js';
  import { hasAvailabilityWithinDays, isCurrentlyReserved } from '../lib/calendar.js';
  import { t } from '../lib/i18n.js';
  import { revealOnLoad } from '../lib/motion.js';
  import { itemToPath, navigateToItem } from '../lib/router.js';

  let { item, reserveSuccessTick = { id: null, at: 0 }, onOpenReserve } = $props();

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
  const isExpertise = $derived(itemTag === 'expertise');
  const expertiseCopy = $derived(splitExpertiseCopy(item));

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
    // The item dialog opens over the card: a pending hover reaction would land behind it.
    clearTimeout(hoverTimer);
    onOpenReserve?.(item);
  }

  function goToDetail(event) {
    event.preventDefault();
    clearTimeout(hoverTimer);
    navigateToItem(item);
  }

  /** What the hover reaction reacts to, read when the delay ends. */
  function getCardState() {
    return { itemId: item.id, isExpertise, unavailable, checkAvailability };
  }

  // Mouse pointers only: a tap on a touch screen also fires enter events (and emulated
  // mouse ones), which would start a reaction nobody hovered for.
  function handlePointerEnter(event) {
    if (event.pointerType !== 'mouse') return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => triggerItemReaction(getCardState), ITEM_HOVER_DELAY);
  }

  function handlePointerLeave() {
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

<article class="inventory-card" onpointerenter={handlePointerEnter} onpointerleave={handlePointerLeave}>
  <div class="inventory-image-frame">
    <img
      {@attach revealOnLoad}
      class="inventory-image"
      src={item.image}
      alt={isExpertise ? '' : $t('inventory.image_alt', { title: item.title })}
      width="640"
      height="360"
      decoding="async"
      loading="lazy"
    />
    {#if !isExpertise}
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
    {/if}
  </div>
  <div class="inventory-content">
    <h3>
      <a class="inventory-card__title-link" href={itemToPath(item)} onclick={goToDetail}>
        {item.title}
      </a>
    </h3>
    <p>{isExpertise ? expertiseCopy.shortText : item.body}</p>

    <button type="button" class="btn-reserve" onclick={openReserveModal}>
      {isExpertise ? $t('inventory.request_consultation') : $t('inventory.reserve')}
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
