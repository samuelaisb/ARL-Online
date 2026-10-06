<script>
  import { onDestroy, onMount } from 'svelte';
  import {
    approveReservation,
    deleteInventoryItem,
    deleteReservation,
    fetchAdminInventory,
    refuseReservation,
  } from '../lib/inventory.js';
  import { compareDateKeys, libraryTodayKey, parseDateKey } from '../lib/calendar.js';
  import { isConsultationHeld } from '../lib/reservation-rules.js';
  import { locale, t, translateKey } from '../lib/i18n.js';
  import { notify, DEFAULT_NOTIFICATION_DURATION } from '../lib/notification-store.js';
  import {
    availabilityNow,
    subscribeAvailabilityClock,
    unsubscribeAvailabilityClock,
  } from '../lib/availability-clock.js';
  import MeetingTimePicker from './MeetingTimePicker.svelte';
  import MentorBrowser from './MentorBrowser.svelte';

  let { items = [], onAddItem, onItemRemoved, onItemUpdated } = $props();

  let adminItems = $state([]);
  let loading = $state(true);
  let loadError = $state('');
  let lastParentCount = $state(0);

  let removingId = $state('');
  let removeError = $state('');
  let showRemoveList = $state(false);
  let showMentorList = $state(false);
  let showPendingList = $state(false);
  let showReservationList = $state(false);
  let deletingReservationId = $state('');
  let pendingActionId = $state('');
  let reservationError = $state('');
  let pendingError = $state('');
  // Per-entry datetime-local values for approving expertise consultations.
  let meetingTimes = $state({});

  async function refreshAdminItems() {
    loading = true;
    loadError = '';

    try {
      adminItems = await fetchAdminInventory();
    } catch (error) {
      loadError = error.message || $t('inventory.load_error');
      adminItems = [];
    } finally {
      loading = false;
    }
  }

  function sanitizeItemForPublicSync(item) {
    const publicItem = { ...item };
    delete publicItem.expertEmail;

    return {
      ...publicItem,
      reservations: (item.reservations ?? []).map(({ id, startDate, endDate, status }) => ({
        id,
        startDate,
        endDate,
        status,
      })),
    };
  }

  function handleMentorUpdated(item) {
    adminItems = adminItems.map((candidate) => (candidate.id === item.id ? item : candidate));
    onItemUpdated?.(sanitizeItemForPublicSync(item));
  }

  onMount(() => {
    subscribeAvailabilityClock();
    refreshAdminItems();
  });

  onDestroy(unsubscribeAvailabilityClock);

  $effect(() => {
    if (items.length !== lastParentCount) {
      lastParentCount = items.length;
      refreshAdminItems();
    }
  });

  const mentorItems = $derived(adminItems.filter((item) => item.tag === 'expertise'));

  const pendingEntries = $derived(
    adminItems.flatMap((item) =>
      (item.reservations ?? [])
        .filter((reservation) => reservation.status === 'pending')
        .map((reservation) => ({
          ...reservation,
          itemId: item.id,
          itemTitle: item.title,
          itemTag: item.tag ?? 'equipment',
        })),
    ),
  );

  const now = $derived.by(() => Math.max($availabilityNow, Date.now()));
  // Montréal's date, as on the server, so the "will be emailed" confirms match what it sends.
  const todayKey = $derived(libraryTodayKey(new Date(now)));

  // Pending, or approved and not over yet: deleting one (or its item) emails the member.
  function isUpcomingReservation(reservation) {
    return (
      (reservation.status === 'pending' || reservation.status === 'reserved') &&
      compareDateKeys(reservation.endDate, todayKey) >= 0
    );
  }

  // Expertise rows whose meeting has ended are `held`: shown as Completed, and deleting one
  // only removes the record (the server skips the Zoom delete and cancellation emails).
  const reservationEntries = $derived(
    adminItems.flatMap((item) =>
      (item.reservations ?? [])
        .filter((reservation) => reservation.status === 'reserved')
        .map((reservation) => ({
          ...reservation,
          itemId: item.id,
          itemTitle: item.title,
          itemTag: item.tag ?? 'equipment',
          held: item.tag === 'expertise' && isConsultationHeld(reservation, now),
          // Over, or no member address: deleting it emails nobody.
          silent:
            item.tag !== 'expertise' && (!reservation.userEmail || !isUpcomingReservation(reservation)),
        })),
    ),
  );

  function formatDateKey(key) {
    const date = parseDateKey(key);
    if (!date) {
      return key;
    }

    const localeCode = $locale === 'fr' ? 'fr-CA' : 'en-CA';
    return new Intl.DateTimeFormat(localeCode, { dateStyle: 'medium' }).format(date);
  }

  function formatMeetingTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value ?? '';
    }

    const localeCode = $locale === 'fr' ? 'fr-CA' : 'en-CA';
    return new Intl.DateTimeFormat(localeCode, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  }

  function applyItemUpdate(entry, result) {
    const item = adminItems.find((candidate) => candidate.id === entry.itemId);

    if (item && result.item?.reservations != null) {
      const updatedItem = { ...item, reservations: result.item.reservations };
      adminItems = adminItems.map((candidate) =>
        candidate.id === updatedItem.id ? updatedItem : candidate,
      );
      onItemUpdated?.(sanitizeItemForPublicSync(updatedItem));
    }
  }

  async function handleRemove(item) {
    if (removingId) {
      return;
    }

    // Reservations cascade with the item, so warn before a mentor's consultation history goes,
    // and before members' upcoming bookings are cancelled (the server emails each member).
    const consultationCount = item.tag === 'expertise' ? (item.reservations ?? []).length : 0;
    const upcomingCount =
      item.tag === 'expertise' ? 0 : (item.reservations ?? []).filter(isUpcomingReservation).length;
    let message = $t('admin.remove_confirm', { title: item.title });
    if (consultationCount > 0) {
      message = $t('admin.remove_expertise_confirm', { title: item.title, count: consultationCount });
    } else if (upcomingCount > 0) {
      message = $t('admin.remove_with_reservations_confirm', { title: item.title, count: upcomingCount });
    }
    const confirmed = window.confirm(message);
    if (!confirmed) {
      return;
    }

    removingId = item.id;
    removeError = '';

    try {
      await deleteInventoryItem(item.id);
      adminItems = adminItems.filter((candidate) => candidate.id !== item.id);
      onItemRemoved?.(item.id);
      notify(translateKey('kimchi.item_removed'), DEFAULT_NOTIFICATION_DURATION);
    } catch (error) {
      removeError = error.message || $t('admin.remove_error');
    } finally {
      removingId = '';
    }
  }

  async function handleDeleteReservation(entry) {
    if (deletingReservationId) {
      return;
    }

    const email = entry.userEmail || $t('admin.no_member_email');
    let message;
    if (entry.itemTag === 'expertise' && entry.meetingAt) {
      message = $t(
        entry.held ? 'admin.delete_held_consultation_confirm' : 'admin.delete_consultation_confirm',
        { title: entry.itemTitle, time: formatMeetingTime(entry.meetingAt), email },
      );
    } else {
      message = $t(
        entry.silent ? 'admin.delete_reservation_silent_confirm' : 'admin.delete_reservation_confirm',
        {
          title: entry.itemTitle,
          start: formatDateKey(entry.startDate),
          end: formatDateKey(entry.endDate),
          email,
        },
      );
    }
    const confirmed = window.confirm(message);

    if (!confirmed) {
      return;
    }

    deletingReservationId = entry.id;
    reservationError = '';

    try {
      const result = await deleteReservation(entry.itemId, entry.id);
      applyItemUpdate(entry, result);
      notify(translateKey('kimchi.reservation_deleted'), DEFAULT_NOTIFICATION_DURATION);
    } catch (error) {
      reservationError = error.message || $t('admin.delete_reservation_error');
    } finally {
      deletingReservationId = '';
    }
  }

  async function handleApprove(entry) {
    if (pendingActionId) {
      return;
    }

    const isExpertise = entry.itemTag === 'expertise';
    let meetingAt = null;

    if (isExpertise) {
      const rawMeetingTime = meetingTimes[entry.id]?.trim() ?? '';
      const parsed = rawMeetingTime ? new Date(rawMeetingTime) : null;

      if (!parsed || Number.isNaN(parsed.getTime())) {
        pendingError = $t('admin.meeting_time_required');
        return;
      }

      meetingAt = parsed.toISOString();
    }

    const email = entry.userEmail || $t('admin.no_member_email');
    const confirmed = window.confirm(
      isExpertise
        ? $t('admin.approve_consultation_confirm', {
            title: entry.itemTitle,
            time: formatMeetingTime(meetingAt),
            email,
          })
        : $t('admin.approve_reservation_confirm', {
            title: entry.itemTitle,
            start: formatDateKey(entry.startDate),
            end: formatDateKey(entry.endDate),
            email,
          }),
    );

    if (!confirmed) {
      return;
    }

    pendingActionId = entry.id;
    pendingError = '';

    try {
      const result = await approveReservation(
        entry.itemId,
        entry.id,
        meetingAt ? { meetingAt } : {},
      );
      applyItemUpdate(entry, result);
      notify(translateKey('kimchi.reservation_approved'), DEFAULT_NOTIFICATION_DURATION);
    } catch (error) {
      pendingError = error.message || $t('admin.approve_reservation_error');
    } finally {
      pendingActionId = '';
    }
  }

  async function handleRefuse(entry) {
    if (pendingActionId) {
      return;
    }

    const isExpertise = entry.itemTag === 'expertise';
    const email = entry.userEmail || $t('admin.no_member_email');
    const confirmed = window.confirm(
      isExpertise
        ? $t('admin.refuse_consultation_confirm', {
            title: entry.itemTitle,
            email,
          })
        : $t('admin.refuse_reservation_confirm', {
            title: entry.itemTitle,
            start: formatDateKey(entry.startDate),
            end: formatDateKey(entry.endDate),
            email,
          }),
    );

    if (!confirmed) {
      return;
    }

    pendingActionId = entry.id;
    pendingError = '';

    try {
      const result = await refuseReservation(entry.itemId, entry.id);
      applyItemUpdate(entry, result);
    } catch (error) {
      pendingError = error.message || $t('admin.refuse_reservation_error');
    } finally {
      pendingActionId = '';
    }
  }
</script>

<section id="admin-panel" class="panel active" aria-labelledby="admin-panel-heading">
  <h2 id="admin-panel-heading" class="visually-hidden">{$t('admin.heading')}</h2>

  <div class="admin-actions">
    <button type="button" class="btn-primary" onclick={onAddItem}>
      {$t('admin.add_item')}
    </button>
    <button
      type="button"
      class="btn-primary"
      aria-expanded={showMentorList}
      aria-controls="admin-mentor-list"
      onclick={() => (showMentorList = !showMentorList)}
    >
      {$t('admin.mentors')}
      {#if mentorItems.length > 0}
        <span class="admin-pending-count">({mentorItems.length})</span>
      {/if}
    </button>
    <button
      type="button"
      class="btn-primary"
      aria-expanded={showRemoveList}
      aria-controls="admin-remove-list"
      onclick={() => (showRemoveList = !showRemoveList)}
    >
      {$t('admin.remove_items')}
    </button>
    <button
      type="button"
      class="btn-primary"
      aria-expanded={showPendingList}
      aria-controls="admin-pending-list"
      onclick={() => (showPendingList = !showPendingList)}
    >
      {$t('admin.pending_reservations')}
      {#if pendingEntries.length > 0}
        <span class="admin-pending-count">({pendingEntries.length})</span>
      {/if}
    </button>
    <button
      type="button"
      class="btn-primary"
      aria-expanded={showReservationList}
      aria-controls="admin-reservation-list"
      onclick={() => (showReservationList = !showReservationList)}
    >
      {$t('admin.edit_reservations')}
    </button>
  </div>

  {#if showMentorList}
    <MentorBrowser
      mentors={mentorItems}
      {loading}
      {loadError}
      onupdated={handleMentorUpdated}
    />
  {/if}

  {#if showRemoveList}
    <div id="admin-remove-list">
      {#if loading}
        <p class="admin-status" role="status">{$t('admin.loading')}</p>
      {:else if loadError}
        <p class="admin-status admin-status-error" role="alert">{loadError}</p>
      {:else if adminItems.length === 0}
        <p class="empty-state">{$t('admin.empty')}</p>
      {:else}
        <ul class="admin-item-list">
          {#each adminItems as item (item.id)}
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
    </div>
  {/if}

  {#if showPendingList}
    <div id="admin-pending-list" class="admin-reservation-list">
      {#if loading}
        <p class="admin-status" role="status">{$t('admin.loading')}</p>
      {:else if loadError}
        <p class="admin-status admin-status-error" role="alert">{loadError}</p>
      {:else if pendingEntries.length === 0}
        <p class="empty-state">{$t('admin.pending_empty')}</p>
      {:else}
        <ul class="admin-item-list">
          {#each pendingEntries as entry (entry.id)}
            {@const isExpertiseEntry = entry.itemTag === 'expertise'}
            <li class="admin-item-row admin-item-row--pending">
              <div class="admin-reservation-details">
                <span class="admin-item-title">{entry.itemTitle}</span>
                {#if isExpertiseEntry}
                  <span class="admin-reservation-dates">
                    {$t('admin.consultation_requested_on', {
                      date: formatDateKey(entry.startDate),
                    })}
                  </span>
                  {#if entry.timeSlots}
                    <span class="consultation-field">
                      <span class="consultation-field__label">{$t('admin.consultation_slots_label')}</span>
                      <span class="consultation-field__value">{entry.timeSlots}</span>
                    </span>
                  {/if}
                  {#if entry.requestSummary}
                    <span class="consultation-field">
                      <span class="consultation-field__label">{$t('admin.consultation_summary_label')}</span>
                      <span class="consultation-field__value">{entry.requestSummary}</span>
                    </span>
                  {/if}
                {:else}
                  <span class="admin-reservation-dates">
                    {$t('admin.reservation_dates', {
                      start: formatDateKey(entry.startDate),
                      end: formatDateKey(entry.endDate),
                    })}
                  </span>
                {/if}
                {#if entry.userEmail}
                  <span class="admin-reservation-email">{entry.userEmail}</span>
                {:else}
                  <span class="admin-reservation-email admin-reservation-email--missing">
                    {$t('admin.no_member_email')}
                  </span>
                {/if}
                {#if isExpertiseEntry}
                  <MeetingTimePicker
                    bind:value={meetingTimes[entry.id]}
                    selectLabel={$t('admin.select_meeting_time')}
                    changeLabel={$t('admin.change_meeting_time')}
                    displayValue={formatMeetingTime(meetingTimes[entry.id])}
                  />
                {/if}
              </div>
              <div class="admin-pending-actions">
                <button
                  type="button"
                  class="btn-approve"
                  disabled={Boolean(pendingActionId)}
                  onclick={() => handleApprove(entry)}
                >
                  {#if pendingActionId === entry.id}
                    {$t('admin.approving_reservation')}
                  {:else}
                    {$t('admin.approve_reservation')}
                  {/if}
                </button>
                <button
                  type="button"
                  class="btn-remove"
                  disabled={Boolean(pendingActionId)}
                  onclick={() => handleRefuse(entry)}
                >
                  {#if pendingActionId === entry.id}
                    {$t('admin.refusing_reservation')}
                  {:else}
                    {$t('admin.refuse_reservation')}
                  {/if}
                </button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}

      {#if pendingError}
        <p class="admin-status admin-status-error" role="alert">{pendingError}</p>
      {/if}
    </div>
  {/if}

  {#if showReservationList}
    <div id="admin-reservation-list" class="admin-reservation-list">
      {#if loading}
        <p class="admin-status" role="status">{$t('admin.loading')}</p>
      {:else if loadError}
        <p class="admin-status admin-status-error" role="alert">{loadError}</p>
      {:else if reservationEntries.length === 0}
        <p class="empty-state">{$t('admin.reservations_empty')}</p>
      {:else}
        <ul class="admin-item-list">
          {#each reservationEntries as entry (entry.id)}
            <li class="admin-item-row">
              <div class="admin-reservation-details">
                <span class="admin-item-title">{entry.itemTitle}</span>
                {#if entry.itemTag === 'expertise' && entry.meetingAt}
                  <span class="admin-reservation-dates">
                    {$t('admin.consultation_meeting', {
                      time: formatMeetingTime(entry.meetingAt),
                    })}
                    {#if entry.held}
                      <span class="consultation-status consultation-status--completed">
                        {$t('account_consultations.status_completed')}
                      </span>
                    {/if}
                  </span>
                  {#if entry.zoomJoinUrl}
                    <a
                      class="admin-consultation-detail"
                      href={entry.zoomJoinUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {$t('admin.consultation_zoom_link')}
                    </a>
                  {/if}
                {:else}
                  <span class="admin-reservation-dates">
                    {$t('admin.reservation_dates', {
                      start: formatDateKey(entry.startDate),
                      end: formatDateKey(entry.endDate),
                    })}
                  </span>
                {/if}
                {#if entry.userEmail}
                  <span class="admin-reservation-email">{entry.userEmail}</span>
                {:else}
                  <span class="admin-reservation-email admin-reservation-email--missing">
                    {$t('admin.no_member_email')}
                  </span>
                {/if}
              </div>
              <button
                type="button"
                class="btn-remove"
                disabled={Boolean(deletingReservationId)}
                onclick={() => handleDeleteReservation(entry)}
              >
                {#if deletingReservationId === entry.id}
                  {$t('admin.deleting_reservation')}
                {:else}
                  {$t('admin.delete_reservation')}
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}

      {#if reservationError}
        <p class="admin-status admin-status-error" role="alert">{reservationError}</p>
      {/if}
    </div>
  {/if}
</section>
