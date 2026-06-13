<script>
  import { onDestroy, onMount } from 'svelte';
  import { availabilityNow } from '../lib/availability-clock.js';
  import { hasAvailabilityWithinDays, isCurrentlyReserved } from '../lib/calendar.js';
  import { fetchInventoryItem } from '../lib/inventory.js';
  import { t } from '../lib/i18n.js';
  import {
    categoryToPath,
    clearReserveIntent,
    closeItemOverlay,
    getItemRouteParams,
    hasReserveIntent,
    navigate,
    path,
    setReserveIntent,
  } from '../lib/router.js';
  import { authReady, session } from '../lib/auth.js';
  import { supabaseConfigured } from '../lib/supabase.js';
  import {
    subscribeAvailabilityClock,
    unsubscribeAvailabilityClock,
  } from '../lib/availability-clock.js';
  import ItemCalendar from './ItemCalendar.svelte';
  import ReserveAuthRequiredModal from './ReserveAuthRequiredModal.svelte';

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
  let statusMessage = $state('');
  let statusType = $state('');
  let fadeOut = $state(false);
  let overlayDialog = $state();
  let authRequiredModal = $state();
  let calendarColumn = $state();
  let calendarHighlight = $state(false);
  let reserveIntentHandled = $state(false);

  let fadeTimeout;
  let hideTimeout;
  let highlightTimeout;

  const routeParams = $derived(getItemRouteParams($path));

  const tagLabels = {
    equipment: 'inventory.filter_equipment',
    books: 'inventory.filter_books',
    rooms: 'inventory.filter_rooms',
  };

  const reservations = $derived(item?.reservations ?? []);
  const itemTag = $derived(item?.tag ?? routeParams?.tag ?? 'equipment');

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

    if (!params) {
      item = null;
      notFound = false;
      loading = false;
      onItemLoaded?.(null);
      return;
    }

    loading = true;
    notFound = false;

    try {
      const loaded = await fetchInventoryItem(params.tag, params.slug);
      item = loaded;
      notFound = !loaded;
      onItemLoaded?.(loaded);
    } catch {
      item = null;
      notFound = true;
      onItemLoaded?.(null);
    } finally {
      loading = false;
    }
  }

  function goHome(event) {
    event.preventDefault();
    navigate('/');
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

  function handleBackdropClick(event) {
    if (event.target === overlayDialog) {
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
      detail?.reservation?.status === 'pending'
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
        pending ? $t('inventory.reservation_pending') : $t('inventory.reservation_complete'),
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
  aria-label={item ? item.title : $t('item_detail.breadcrumb_home')}
  oncancel={handleCancel}
  onclick={handleBackdropClick}
>
  <div class="item-detail-overlay">
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
            {#if item}
              <li class="item-detail-breadcrumb__item item-detail-breadcrumb__item--current" aria-current="page">
                {item.title}
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
      <p class="item-detail-page__loading" aria-busy="true">{$t('inventory.loading')}</p>
    {:else if notFound}
      <div class="item-detail-page__not-found">
        <h1>{$t('item_detail.not_found')}</h1>
        <p>
          <a href={categoryToPath(routeParams?.tag ?? 'equipment')} class="item-detail-page__back-link" onclick={goCategory}>
            {$t('item_detail.back_to_category')}
          </a>
        </p>
      </div>
    {:else if item}
      <article class="item-detail">
        <div class="item-detail__media">
          <img
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
