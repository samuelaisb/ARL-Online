<script>
  import { onDestroy, onMount } from 'svelte';
  import { availabilityNow } from '../lib/availability-clock.js';
  import { hasAvailabilityWithinDays, isCurrentlyReserved } from '../lib/calendar.js';
  import { splitExpertiseCopy } from '../lib/expertise-fields.js';
  import { fetchInventoryItem } from '../lib/inventory.js';
  import { locale, t } from '../lib/i18n.js';
  import { locationAreaLine } from '../lib/item-location.js';
  import { revealOnLoad } from '../lib/motion.js';
  import {
    categoryToPath,
    clearReserveIntent,
    closeItemOverlay,
    getItemRouteParams,
    hasReserveIntent,
    navigate,
    navigateToPage,
    // Renamed: a `path` binding would make the SVG <path> elements below read as components.
    path as routePath,
    setReserveIntent,
  } from '../lib/router.js';
  import { authReady, session } from '../lib/auth.js';
  import { supabaseConfigured } from '../lib/supabase.js';
  import {
    subscribeAvailabilityClock,
    unsubscribeAvailabilityClock,
  } from '../lib/availability-clock.js';
  import ConsultationRequestForm from './ConsultationRequestForm.svelte';
  import ItemCalendar from './ItemCalendar.svelte';
  import LocationMapPanel from './LocationMapPanel.svelte';
  import ReserveAuthRequiredModal from './ReserveAuthRequiredModal.svelte';
  import Skeleton from './Skeleton.svelte';

  let {
    reserveSuccessTick,
    onOpenRegister,
    onOpenLogin,
    onItemUpdated,
    onItemLoaded,
    onReserveSuccess,
  } = $props();

  let item = $state(null);
  let loading = $state(true);
  let notFound = $state(false);
  // Network or server error: offer a retry instead of claiming the item doesn't exist.
  let loadFailed = $state(false);
  let statusMessage = $state('');
  let statusType = $state('');
  let fadeOut = $state(false);
  let overlayDialog = $state();
  let authRequiredModal = $state();
  let calendarColumn = $state();
  let calendarHighlight = $state(false);
  let reserveIntentHandled = $state(false);
  let showMap = $state(false);
  // Set on a press that starts outside the dialog's box (see handleBackdropClick).
  let pressStartedOnBackdrop = false;

  let fadeTimeout;
  let hideTimeout;
  let highlightTimeout;

  const routeParams = $derived(getItemRouteParams($routePath));

  const tagLabels = {
    equipment: 'inventory.filter_equipment',
    books: 'inventory.filter_books',
    rooms: 'inventory.filter_rooms',
    expertise: 'inventory.filter_expertise',
  };

  const reservations = $derived(item?.reservations ?? []);
  const itemTag = $derived(item?.tag ?? routeParams?.tag ?? 'equipment');
  const isExpertise = $derived(itemTag === 'expertise');
  const expertiseCopy = $derived(splitExpertiseCopy(item));
  // Public: city, province, postal code and an approximate area (never the street).
  const location = $derived(isExpertise ? null : item?.location ?? null);
  const locationArea = $derived(location ? locationAreaLine(location, $locale) : '');

  let unavailable = $derived(
    item ? isCurrentlyReserved(reservations, new Date($availabilityNow)) : false,
  );
  let checkAvailability = $derived(
    item &&
      !unavailable &&
      !hasAvailabilityWithinDays(reservations, itemTag, 7, new Date($availabilityNow)),
  );

  function clearStatusTimeouts() {
    clearTimeout(fadeTimeout);
    clearTimeout(hideTimeout);
  }

  function clearHighlightTimeout() {
    clearTimeout(highlightTimeout);
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

  async function loadItem() {
    const params = routeParams;
    // Tells App which URL this result is for, so a slow response can't land on the
    // next item's page tags.
    const loadedFor = { path: $routePath };

    if (!params) {
      item = null;
      notFound = false;
      loadFailed = false;
      loading = false;
      onItemLoaded?.(null, loadedFor);
      return;
    }

    loading = true;
    notFound = false;
    loadFailed = false;
    onItemLoaded?.(null, loadedFor);

    try {
      const loaded = await fetchInventoryItem(params.tag, params.slug);
      item = loaded;
      notFound = !loaded;
      onItemLoaded?.(loaded, { ...loadedFor, notFound: !loaded });
    } catch {
      item = null;
      loadFailed = true;
      onItemLoaded?.(null, loadedFor);
    } finally {
      loading = false;
    }
  }

  // The homepage opens at the top with focus on its heading, like the header logo.
  // A plain navigate would let App's focus return jump to this item's homepage tile.
  function goHome(event) {
    event.preventDefault();
    navigateToPage('/');
  }

  function goCategory(event) {
    event.preventDefault();
    navigate(categoryToPath(itemTag));
  }

  function closeOverlay() {
    closeItemOverlay(itemTag);
  }

  function handleCancel(event) {
    event.preventDefault();
    closeOverlay();
  }

  // A click lands on the common ancestor of where the press started and where it ended, so a
  // text selection or a map drag that ends on the backdrop also "clicks" the dialog. Close only
  // when the press started and ended outside the dialog's box (its scrollbar is inside it).
  function isOnBackdrop(event) {
    if (event.target !== overlayDialog) {
      return false;
    }

    const box = overlayDialog.getBoundingClientRect();
    return (
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom
    );
  }

  function handleDialogPointerDown(event) {
    pressStartedOnBackdrop = isOnBackdrop(event);
  }

  function handleBackdropClick(event) {
    const startedOnBackdrop = pressStartedOnBackdrop;
    pressStartedOnBackdrop = false;

    if (startedOnBackdrop && isOnBackdrop(event)) {
      closeOverlay();
    }
  }

  function handleAuthRequiredClose() {
    clearReserveIntent();
  }

  function requireAuthForReservation() {
    if (!supabaseConfigured || !$authReady || $session) {
      return true;
    }

    setReserveIntent();
    authRequiredModal?.open();
    return false;
  }

  function focusCalendarColumn() {
    clearHighlightTimeout();
    calendarColumn?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    calendarHighlight = true;
    highlightTimeout = setTimeout(() => {
      calendarHighlight = false;
    }, 2400);
  }

  function tryOpenReserveFromQuery() {
    if (reserveIntentHandled || !hasReserveIntent()) {
      return;
    }

    if (loading || !item || notFound) {
      return;
    }

    if (supabaseConfigured && !$authReady) {
      return;
    }

    if (supabaseConfigured && !$session) {
      authRequiredModal?.open();
      reserveIntentHandled = true;
      return;
    }

    reserveIntentHandled = true;
    clearReserveIntent();
    focusCalendarColumn();
  }

  function handleReserveUpdated(updatedItem) {
    item = updatedItem;
    onItemUpdated?.(updatedItem);
  }

  function handleReserveSuccess(detail) {
    const updatedItem = detail?.item;
    if (updatedItem) {
      item = updatedItem;
      onItemUpdated?.(updatedItem);
    }

    setStatus(
      isExpertise
        ? $t('consultation.request_pending')
        : detail?.reservation?.status === 'pending'
          ? $t('inventory.reservation_pending')
          : $t('inventory.reservation_complete'),
      'success',
    );
    onReserveSuccess?.(detail);
    clearReserveIntent();
  }

  $effect(() => {
    if (overlayDialog && !overlayDialog.open) {
      overlayDialog.showModal();
    }
  });

  $effect(() => {
    routeParams;
    loadItem();
  });

  $effect(() => {
    routeParams;
    reserveIntentHandled = false;
    calendarHighlight = false;
    showMap = false;
    clearHighlightTimeout();
  });

  $effect(() => {
    routeParams;
    hasReserveIntent();
    loading;
    item;
    notFound;
    $authReady;
    $session;
    tryOpenReserveFromQuery();
  });

  $effect(() => {
    const { id, at, pending } = reserveSuccessTick ?? {};
    if (item && id === item.id && at) {
      setStatus(
        isExpertise
          ? $t('consultation.request_pending')
          : pending
            ? $t('inventory.reservation_pending')
            : $t('inventory.reservation_complete'),
        'success',
      );
    }
  });

  onMount(() => {
    subscribeAvailabilityClock();

    function handlePopState() {
      if (!hasReserveIntent()) {
        authRequiredModal?.close();
      }
      reserveIntentHandled = false;
      tryOpenReserveFromQuery();
    }

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  });

  onDestroy(() => {
    unsubscribeAvailabilityClock();
    clearStatusTimeouts();
    clearHighlightTimeout();
  });
</script>

<dialog
  bind:this={overlayDialog}
  class="modal modal--item-detail"
  class:modal--expertise={routeParams?.tag === 'expertise'}
  aria-label={item ? item.title : $t('item_detail.breadcrumb_home')}
  oncancel={handleCancel}
  onpointerdowncapture={handleDialogPointerDown}
  onclick={handleBackdropClick}
>
  <div
    class="item-detail-overlay"
    class:item-detail-overlay--expertise={routeParams?.tag === 'expertise'}
  >
    <div class="item-detail-overlay__bar">
      <nav class="item-detail-breadcrumb" aria-label={$t('item_detail.breadcrumb_aria')}>
        <ol class="item-detail-breadcrumb__list">
          <li class="item-detail-breadcrumb__item">
            <a href="/" class="item-detail-breadcrumb__link" onclick={goHome}>
              {$t('item_detail.breadcrumb_home')}
            </a>
          </li>
          {#if routeParams}
            <li class="item-detail-breadcrumb__item">
              <a
                href={categoryToPath(routeParams.tag)}
                class="item-detail-breadcrumb__link"
                onclick={goCategory}
              >
                {$t(tagLabels[routeParams.tag] ?? tagLabels.equipment)}
              </a>
            </li>
            {#if loading}
              <li class="item-detail-breadcrumb__item item-detail-breadcrumb__item--current" aria-hidden="true">
                <span class="bone item-detail-breadcrumb__bone skeleton"></span>
              </li>
            {:else if item}
              <li class="item-detail-breadcrumb__item item-detail-breadcrumb__item--current" aria-current="page">
                {item.title}
                {#if !isExpertise}
                  <span
                    class="availability-badge item-detail-breadcrumb__badge"
                    class:availability-badge--available={!unavailable && !checkAvailability}
                    class:availability-badge--check={checkAvailability}
                    class:availability-badge--unavailable={unavailable}
                    role="status"
                    aria-live="polite"
                  >
                    {#if unavailable}
                      ({$t('calendar.unavailable')})
                    {:else if checkAvailability}
                      ({$t('calendar.check_availability')})
                    {:else}
                      ({$t('calendar.available')})
                    {/if}
                  </span>
                {/if}
              </li>
            {/if}
          {/if}
        </ol>
      </nav>
      <button
        type="button"
        class="icon-btn item-detail-overlay__close"
        aria-label={$t('auth.close_aria')}
        onclick={closeOverlay}
      >
        &times;
      </button>
    </div>

    {#if loading}
      <!-- routeParams, not the item: during a reload `item` is still the previous one. -->
      <Skeleton
        variant="detail"
        expert={routeParams?.tag === 'expertise'}
        label={$t('item_detail.loading')}
      />
    {:else if loadFailed}
      <div class="item-detail-page__not-found">
        <p class="status error" role="alert">{$t('item_detail.load_error')}</p>
        <button type="button" class="btn-secondary" onclick={loadItem}>
          {$t('item_detail.try_again')}
        </button>
      </div>
    {:else if notFound}
      <div class="item-detail-page__not-found">
        <h1>{$t('item_detail.not_found')}</h1>
        <p>
          <a href={categoryToPath(routeParams?.tag ?? 'equipment')} class="item-detail-page__back-link" onclick={goCategory}>
            {$t('item_detail.back_to_category')}
          </a>
        </p>
      </div>
    {:else if item && isExpertise}
      <article class="item-detail item-detail--expertise">
        <header class="expert-detail__heading">
          <img
            {@attach revealOnLoad}
            class="expert-detail__avatar"
            src={item.image}
            alt=""
            width="80"
            height="80"
            decoding="async"
          />
          <h1>{item.title}</h1>
        </header>
        <p class="expert-detail__bio">{expertiseCopy.longText}</p>
        <p class="item-location item-location--online">
          <svg class="item-location__icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
            <rect x="2" y="6" width="14" height="12" rx="2" />
            <path d="m16 10 6-3v10l-6-3z" />
          </svg>
          {$t('item_detail.meetings_online')}
        </p>

        {#if statusMessage}
          <p
            class="card-status status {statusType} item-detail__status"
            class:fade-out={fadeOut}
            role="status"
            aria-live="polite"
          >
            {statusMessage}
          </p>
        {/if}

        <aside
          bind:this={calendarColumn}
          class="item-detail__calendar"
          class:item-detail__calendar--highlight={calendarHighlight}
        >
          <ConsultationRequestForm
            item={item}
            onbeforeconfirm={requireAuthForReservation}
            onupdated={handleReserveUpdated}
            onconfirmed={handleReserveSuccess}
          />
        </aside>
      </article>
    {:else if item}
      <article class="item-detail">
        <div class="item-detail__media">
          <img
            {@attach revealOnLoad}
            class="item-detail__image"
            src={item.image}
            alt={$t('inventory.image_alt', { title: item.title })}
            width="960"
            height="540"
            decoding="async"
          />
        </div>

        <div class="item-detail__content">
          <header class="item-detail__header">
            <h1>{item.title}</h1>
          </header>
          <div class="item-detail__body">
            <p>{item.body}</p>
          </div>

          {#if location}
            <section class="item-location" aria-labelledby="item-location-heading">
              <h2 id="item-location-heading" class="item-location__heading">
                <svg class="item-location__icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
                  <path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z" />
                  <circle cx="12" cy="10" r="2.5" />
                </svg>
                {$t(itemTag === 'rooms' ? 'item_detail.location_heading_room' : 'item_detail.location_heading_pickup')}
              </h2>
              <p class="item-location__area">{locationArea}</p>
              <p class="item-location__note">{$t('item_detail.location_full_address_note')}</p>
              {#if location.area}
                <button
                  type="button"
                  class="link-btn item-location__toggle"
                  aria-expanded={showMap}
                  aria-controls="item-location-map"
                  onclick={() => (showMap = !showMap)}
                >
                  {$t(showMap ? 'map.hide' : 'map.show')}
                </button>
                {#if showMap}
                  <LocationMapPanel
                    id="item-location-map"
                    latitude={location.area.latitude}
                    longitude={location.area.longitude}
                    radiusMetres={location.area.radiusMetres}
                    label={$t('item_detail.location_map_aria', { area: locationArea })}
                    caption={$t('item_detail.location_map_caption')}
                  />
                {/if}
              {/if}
            </section>
          {/if}

          {#if statusMessage}
            <p
              class="card-status status {statusType} item-detail__status"
              class:fade-out={fadeOut}
              role="status"
              aria-live="polite"
            >
              {statusMessage}
            </p>
          {/if}
        </div>

        <aside
          bind:this={calendarColumn}
          class="item-detail__calendar"
          class:item-detail__calendar--highlight={calendarHighlight}
        >
          <ItemCalendar
            item={item}
            hideHeading
            onbeforeconfirm={requireAuthForReservation}
            onupdated={handleReserveUpdated}
            onconfirmed={handleReserveSuccess}
          />
        </aside>
      </article>
    {/if}
  </div>
</dialog>

<ReserveAuthRequiredModal
  bind:this={authRequiredModal}
  onSignUp={onOpenRegister}
  onLogIn={onOpenLogin}
  onclose={handleAuthRequiredClose}
/>
