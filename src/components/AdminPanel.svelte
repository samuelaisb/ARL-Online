<script>
  import { onMount } from 'svelte';
  import {
    approveReservation,
    deleteInventoryItem,
    deleteReservation,
    fetchAdminInventory,
    refuseReservation,
  } from '../lib/inventory.js';
  import { parseDateKey } from '../lib/calendar.js';
  import { locale, t, translateKey } from '../lib/i18n.js';
  import { notify, DEFAULT_NOTIFICATION_DURATION } from '../lib/notification-store.js';

  let { items = [], onAddItem, onItemRemoved, onItemUpdated } = $props();

  let adminItems = $state([]);
  let loading = $state(true);
  let loadError = $state('');
  let lastParentCount = $state(0);

  let removingId = $state('');
  let removeError = $state('');
  let showRemoveList = $state(false);
  let showPendingList = $state(false);
  let showReservationList = $state(false);
  let deletingReservationId = $state('');
  let pendingActionId = $state('');
  let reservationError = $state('');
  let pendingError = $state('');

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
    return {
      ...item,
      reservations: (item.reservations ?? []).map(({ id, startDate, endDate, status }) => ({
        id,
        startDate,
        endDate,
        status,
      })),
    };
  }

  onMount(() => {
    refreshAdminItems();
  });

  $effect(() => {
    if (items.length !== lastParentCount) {
      lastParentCount = items.length;
      refreshAdminItems();
    }
  });

  const pendingEntries = $derived(
    adminItems.flatMap((item) =>
      (item.reservations ?? [])
        .filter((reservation) => reservation.status === 'pending')
        .map((reservation) => ({
          ...reservation,
          itemId: item.id,
          itemTitle: item.title,
        })),
    ),
  );

  const reservationEntries = $derived(
    adminItems.flatMap((item) =>
      (item.reservations ?? [])
        .filter((reservation) => reservation.status === 'reserved')
        .map((reservation) => ({
          ...reservation,
          itemId: item.id,
          itemTitle: item.title,
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

    const confirmed = window.confirm($t('admin.remove_confirm', { title: item.title }));
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

    const start = formatDateKey(entry.startDate);
    const end = formatDateKey(entry.endDate);
    const confirmed = window.confirm(
      $t('admin.delete_reservation_confirm', {
        title: entry.itemTitle,
        start,
        end,
      }),
    );

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

    const start = formatDateKey(entry.startDate);
    const end = formatDateKey(entry.endDate);
    const confirmed = window.confirm(
      $t('admin.approve_reservation_confirm', {
        title: entry.itemTitle,
        start,
        end,
        email: entry.userEmail || $t('admin.no_member_email'),
      }),
    );

    if (!confirmed) {
      return;
    }

    pendingActionId = entry.id;
    pendingError = '';

    try {
      const result = await approveReservation(entry.itemId, entry.id);
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

    const start = formatDateKey(entry.startDate);
    const end = formatDateKey(entry.endDate);
    const confirmed = window.confirm(
      $t('admin.refuse_reservation_confirm', {
        title: entry.itemTitle,
        start,
        end,
        email: entry.userEmail || $t('admin.no_member_email'),
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
            <li class="admin-item-row admin-item-row--pending">
              <div class="admin-reservation-details">
                <span class="admin-item-title">{entry.itemTitle}</span>
                <span class="admin-reservation-dates">
                  {$t('admin.reservation_dates', {
                    start: formatDateKey(entry.startDate),
                    end: formatDateKey(entry.endDate),
                  })}
                </span>
                {#if entry.userEmail}
                  <span class="admin-reservation-email">{entry.userEmail}</span>
                {:else}
                  <span class="admin-reservation-email admin-reservation-email--missing">
                    {$t('admin.no_member_email')}
                  </span>
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
                <span class="admin-reservation-dates">
                  {$t('admin.reservation_dates', {
                    start: formatDateKey(entry.startDate),
                    end: formatDateKey(entry.endDate),
                  })}
                </span>
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
