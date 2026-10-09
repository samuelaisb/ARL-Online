<script module>
  // "New in the library" state that outlives the panel (leaving the grid unmounts it).
  /** This load wrote the first-seen key: a first visit, so nothing is new to this browser yet. */
  let firstVisitLoad = false;
  /** Memory copy of the once-per-visit flag, for when sessionStorage is blocked. */
  let newItemShownThisLoad = false;
</script>

<script>
  import InventoryCard from './InventoryCard.svelte';
  import LoadingStatus from './LoadingStatus.svelte';
  import { INVENTORY_TAGS, DEFAULT_INVENTORY_TAG } from '../lib/inventory.js';
  import {
    subscribeAvailabilityClock,
    unsubscribeAvailabilityClock,
  } from '../lib/availability-clock.js';
  import { authReady, isApathyAdmin, session } from '../lib/auth.js';
  import { t } from '../lib/i18n.js';
  import {
    hasSeen,
    markSeen,
    readJson,
    readSessionJson,
    writeJson,
    writeSessionJson,
  } from '../lib/kimchi-memory.js';
  import { isAmbientAllowed, notifications, notifyWhenIdle } from '../lib/notification-store.js';
  import {
    categoryToPath,
    getCategoryFromPath,
    getItemRouteParams,
    isPlainLeftClick,
    itemToPath,
    navigate,
    navigateToItem,
    navigateToItemWithReserve,
    path,
  } from '../lib/router.js';
  import { onDestroy, onMount, untrack } from 'svelte';

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
    expertise: 'inventory.filter_expertise',
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

  // Kimchi's "New in the library": an item added since this browser first saw the shelves,
  // and in the last 14 days, gets one ambient bubble. One per tab session, each item once
  // per browser, and nothing without a readable first-seen key. Not for admins (they add
  // the items) or mentors (until mentor profiles are reviewed).
  const FIRST_SEEN_STORAGE_KEY = 'arl-kimchi-first-seen';
  const NEW_ITEM_SESSION_KEY = 'arl-kimchi-new-item-shown';
  const NEW_ITEM_SEEN_SCOPE = 'new-in-library';
  const NEW_ITEM_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
  const NEW_ITEM_DURATION = 8000;

  /** The announcement waiting to show, `{ path }`. A path change cancels that wait inside
   *  `path.set`, before the effect re-runs, so only the same grid path is blocked. */
  let newItemWait = null;

  /** When this browser first showed the shelves (ms), or null when missing or unreadable. */
  function readFirstSeenAt() {
    const saved = readJson(FIRST_SEEN_STORAGE_KEY, null);
    return saved && Number.isFinite(saved.at) ? saved.at : null;
  }

  function rememberFirstVisit() {
    if (readFirstSeenAt() != null) return;
    firstVisitLoad = writeJson(FIRST_SEEN_STORAGE_KEY, { at: Date.now() });
  }

  function newItemShownThisVisit() {
    return newItemShownThisLoad || readSessionJson(NEW_ITEM_SESSION_KEY, false) === true;
  }

  /**
   * The bubble's link opens the item the way a card does (`navigateToItem`: the overlay's
   * history marker, so closing it steps back, and `?lang`). KimchiNotification routes bubble
   * links through `navigateToPage`, which can't carry an item, so a capturing listener takes
   * plain left clicks (and Enter) on this one bubble's link first. Modifier clicks keep the
   * browser's default on the item URL. The listener goes when the bubble leaves the queue.
   */
  function openItemFromBubbleLink(bubbleId, item) {
    let stopped = false;
    let unsubscribe = null;

    function handleClick(event) {
      const link = event.target?.closest?.('a[href]');
      if (!link?.closest(`[data-kimchi-bubble-id="${bubbleId}"]`)) return;
      if (!isPlainLeftClick(event)) return;
      event.preventDefault();
      event.stopPropagation();
      navigateToItem(item);
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      document.removeEventListener('click', handleClick, true);
      unsubscribe?.();
    }

    document.addEventListener('click', handleClick, true);
    unsubscribe = notifications.subscribe((queued) => {
      if (!queued.some((entry) => entry.id === bubbleId)) stop();
    });
    // The bubble was already gone when the subscription first ran.
    if (stopped) unsubscribe();
  }

  async function announceNewItem(shelfItems, gridPath) {
    if (newItemWait?.path === gridPath || firstVisitLoad || newItemShownThisVisit() || !isAmbientAllowed()) {
      return;
    }

    const firstSeenAt = readFirstSeenAt();
    if (firstSeenAt == null) return;

    const now = Date.now();
    const item = shelfItems
      .filter(
        (candidate) =>
          candidate.tag !== 'expertise' &&
          Number.isFinite(candidate.createdAt) &&
          candidate.createdAt > firstSeenAt &&
          now - candidate.createdAt <= NEW_ITEM_WINDOW_MS &&
          !hasSeen(null, NEW_ITEM_SEEN_SCOPE, candidate.id),
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!item) return;

    const wait = { path: gridPath };
    newItemWait = wait;
    // Waits for the queue and any dialog to clear; gives up if the visitor leaves the grid.
    const id = await notifyWhenIdle(
      {
        textKey: 'kimchi.new_in_library',
        vars: { title: item.title },
        link: { href: itemToPath(item), labelKey: 'kimchi.new_in_library_link' },
      },
      NEW_ITEM_DURATION,
      { ambient: true, kind: 'new-in-library' },
    );
    // A newer shelf's wait may hold the marker by now.
    if (newItemWait === wait) newItemWait = null;
    if (id === -1) return;

    openItemFromBubbleLink(id, item);
    markSeen(null, NEW_ITEM_SEEN_SCOPE, item.id);
    newItemShownThisLoad = true;
    writeSessionJson(NEW_ITEM_SESSION_KEY, true);
  }

  $effect(() => {
    if (loading || loadError || !$authReady) return;

    // The grid itself (not under an item overlay), and not the Expertise list.
    const gridPath = $path;
    const category = getCategoryFromPath(gridPath);
    if (!category || category === 'expertise' || isApathyAdmin($session)) return;

    const shelfItems = items.filter((item) => (item.tag || DEFAULT_INVENTORY_TAG) === category);
    untrack(() => announceNewItem(shelfItems, gridPath));
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
    rememberFirstVisit();
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
        aria-label={loading
          ? undefined
          : $t('inventory.filter_with_count', {
              label: $t(tagLabels[tag]),
              count: tagCounts[tag],
            })}
        onclick={() => selectTag(tag)}
      >
        <span class="inventory-filter__label">{$t(tagLabels[tag])}</span>
        {#if loading}
          <!-- Not "0" while the counts are still unknown. -->
          <span class="inventory-filter__count inventory-filter__count--loading" aria-hidden="true"></span>
        {:else}
          <span class="inventory-filter__count" aria-hidden="true">{tagCounts[tag]}</span>
        {/if}
      </button>
    {/each}
  </div>

  {#if loading}
    <div class="inventory-grid skeleton" aria-hidden="true">
      {#each Array(6) as _, index (index)}
        <div class="inventory-card skeleton-card skeleton-sheen">
          <div class="inventory-image-frame">
            <span class="bone skeleton-card__media"></span>
          </div>
          <div class="inventory-content">
            <span class="bone skeleton-card__title"></span>
            <div class="skeleton-card__lines">
              <span class="bone bone--line"></span>
              <span class="bone bone--line"></span>
              <span class="bone bone--line"></span>
            </div>
            <span class="bone skeleton-card__button"></span>
          </div>
        </div>
      {/each}
    </div>
    <LoadingStatus text={$t('inventory.loading')} />
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

