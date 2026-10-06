<script>
  import { onDestroy, onMount, tick } from 'svelte';
  import { cancelAccountReservation, fetchAccountReservations } from '../lib/inventory.js';
  import { compareDateKeys, libraryTodayKey, parseDateKey } from '../lib/calendar.js';
  import { itemToPath, navigate, navigateToItem } from '../lib/router.js';
  import { locale, t, translateKey } from '../lib/i18n.js';
  import { notify, DEFAULT_NOTIFICATION_DURATION } from '../lib/notification-store.js';
  import {
    availabilityNow,
    subscribeAvailabilityClock,
    unsubscribeAvailabilityClock,
  } from '../lib/availability-clock.js';

  let loading = $state(true);
  let loadError = $state('');
  let reservations = $state([]);
  let actionId = $state('');
  let actionError = $state('');
  let actionErrorId = $state('');
  let showPast = $state(false);
  let pastToggle = $state();
  let cancelButtons = $state({});
  // Announced even when Kimchi is asleep (its bubbles are the only other confirmation).
  let statusMessage = $state('');

  // Montréal's date, as on the server, so Cancel disappears when the server stops accepting it.
  const todayKey = $derived(libraryTodayKey(new Date(Math.max($availabilityNow, Date.now()))));

  function hasEnded(entry, today) {
    return entry.status === 'reserved' && compareDateKeys(entry.endDate, today) < 0;
  }

  // Pending requests stay in the active list whatever their dates: they still count toward
  // the pending cap until the member withdraws them or AisB reviews them.
  function isPast(entry, today) {
    return entry.status === 'refused' || entry.status === 'cancelled' || hasEnded(entry, today);
  }

  /** Same rule as the server: pending any time, approved only before its first day. */
  function canCancel(entry, today) {
    return (
      entry.status === 'pending' ||
      (entry.status === 'reserved' && compareDateKeys(entry.startDate, today) > 0)
    );
  }

  function splitEntries(entries, today) {
    const active = [];
    const past = [];

    for (const entry of entries) {
      (isPast(entry, today) ? past : active).push(entry);
    }

    active.sort((a, b) => compareDateKeys(a.startDate, b.startDate));
    past.sort((a, b) => compareDateKeys(b.startDate, a.startDate));
    return { active, past };
  }

  function formatDateKey(dateKey) {
    const date = parseDateKey(dateKey);
    if (!date) {
      return dateKey ?? '';
    }

    return new Intl.DateTimeFormat($locale === 'fr' ? 'fr-CA' : 'en-CA', {
      dateStyle: 'medium',
    }).format(date);
  }

  function formatDates(entry) {
    const start = formatDateKey(entry.startDate);
    if (!entry.endDate || entry.endDate === entry.startDate) {
      return start;
    }

    return $t('account_reservations.dates', { start, end: formatDateKey(entry.endDate) });
  }

  async function load() {
    loading = true;
    loadError = '';

    try {
      reservations = await fetchAccountReservations();
    } catch (error) {
      loadError = error.message || $t('account_reservations.load_error');
    } finally {
      loading = false;
    }
  }

  async function handleCancel(entry) {
    if (actionId) {
      return;
    }

    const pending = entry.status === 'pending';
    const confirmed = window.confirm(
      $t(pending ? 'account_reservations.withdraw_confirm' : 'account_reservations.cancel_confirm', {
        title: entry.title,
        dates: formatDates(entry),
      }),
    );

    if (!confirmed) {
      return;
    }

    actionId = entry.id;
    actionError = '';
    actionErrorId = '';
    statusMessage = '';
    let failed = false;

    try {
      const updated = await cancelAccountReservation(entry.id);
      reservations = reservations.map((candidate) =>
        candidate.id === updated.id ? { ...candidate, ...updated } : candidate,
      );
      statusMessage = $t(pending ? 'account_reservations.withdrawn_status' : 'account_reservations.cancelled_status');
      notify(
        translateKey(pending ? 'kimchi.reservation_withdrawn' : 'kimchi.reservation_cancelled'),
        DEFAULT_NOTIFICATION_DURATION,
      );
    } catch (error) {
      failed = true;
      actionErrorId = entry.id;
      actionError = error.message || $t('account_reservations.cancel_error');
    } finally {
      actionId = '';
    }

    // Disabling the button while the request ran dropped its focus; on success the row
    // moved to the past list, so focus its toggle instead.
    await tick();
    (failed ? cancelButtons[entry.id] : pastToggle)?.focus();
  }

  function openItem(event, entry) {
    event.preventDefault();
    // Marks the overlay entry, so closing it steps back to /account.
    navigateToItem({ tag: entry.tag, slug: entry.slug, title: entry.title });
  }

  function openLibrary(event) {
    event.preventDefault();
    navigate('/');
  }

  onMount(() => {
    subscribeAvailabilityClock();
    load();
  });

  onDestroy(unsubscribeAvailabilityClock);

  const lists = $derived(splitEntries(reservations, todayKey));
</script>

{#snippet reservationRow(entry)}
  {@const statusKey = hasEnded(entry, todayKey) ? 'ended' : entry.status}
  {@const cancellable = canCancel(entry, todayKey)}
  <li class="admin-item-row admin-item-row--pending consultation-row">
    <div class="admin-reservation-details">
      <span class="consultation-row__heading">
        <a href={itemToPath(entry)} class="consultation-row__title" onclick={(event) => openItem(event, entry)}>
          {entry.title}
        </a>
        <span class="consultation-status consultation-status--{statusKey}">
          {$t(`account_reservations.status_${statusKey}`)}
        </span>
      </span>
      <span class="admin-reservation-dates">
        {$t(`inventory.filter_${entry.tag}`)} · {formatDates(entry)}
      </span>
      {#if entry.status === 'pending'}
        <span class="admin-consultation-detail">{$t('account_reservations.pending_hint')}</span>
      {:else if statusKey === 'reserved' && !cancellable}
        <span class="admin-consultation-detail">{$t('account_reservations.started_hint')}</span>
      {/if}
    </div>

    {#if cancellable}
      <div class="consultation-row__actions">
        <div class="admin-pending-actions">
          <button
            bind:this={cancelButtons[entry.id]}
            type="button"
            class="btn-remove"
            disabled={Boolean(actionId)}
            onclick={() => handleCancel(entry)}
          >
            {#if entry.status === 'pending'}
              {actionId === entry.id ? $t('account_reservations.withdrawing') : $t('account_reservations.withdraw')}
            {:else}
              {actionId === entry.id ? $t('account_reservations.cancelling') : $t('account_reservations.cancel')}
            {/if}
          </button>
        </div>
        {#if actionError && actionErrorId === entry.id}
          <p class="admin-status admin-status-error consultation-row__error" role="alert">{actionError}</p>
        {/if}
      </div>
    {/if}
  </li>
{/snippet}

<section class="account-reservations" aria-labelledby="account-reservations-heading">
  <h2 id="account-reservations-heading" class="visually-hidden">{$t('account_reservations.heading')}</h2>
  <p class="visually-hidden" role="status">{statusMessage}</p>

  {#if loading}
    <p class="admin-status" role="status">{$t('account_reservations.loading')}</p>
  {:else if loadError}
    <p class="admin-status admin-status-error" role="alert">{loadError}</p>
  {:else}
    <h3 class="admin-subheading">{$t('account_reservations.heading_active')}</h3>
    {#if lists.active.length > 0}
      <ul class="admin-item-list">
        {#each lists.active as entry (entry.id)}
          {@render reservationRow(entry)}
        {/each}
      </ul>
    {:else if lists.past.length === 0}
      <p class="empty-state">
        {$t('account_reservations.empty')}
        <a href="/" onclick={openLibrary}>{$t('account_reservations.browse')}</a>
      </p>
    {:else}
      <p class="admin-status">{$t('account_reservations.active_empty')}</p>
    {/if}

    {#if lists.past.length > 0}
      <div class="consultation-history">
        <button
          bind:this={pastToggle}
          type="button"
          class="btn-header btn-header--secondary consultation-history__toggle"
          aria-expanded={showPast}
          aria-controls="account-reservations-past"
          onclick={() => (showPast = !showPast)}
        >
          {$t(showPast ? 'account_reservations.past_hide' : 'account_reservations.past_show')}
          <span class="admin-pending-count">({lists.past.length})</span>
        </button>
        {#if showPast}
          <ul id="account-reservations-past" class="admin-item-list consultation-history__list">
            {#each lists.past as entry (`past-${entry.id}`)}
              {@render reservationRow(entry)}
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  {/if}
</section>
