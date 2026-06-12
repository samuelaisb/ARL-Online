<script>
  import { createReservation } from '../lib/inventory.js';
  import { availabilityNow } from '../lib/availability-clock.js';
  import { locale, t, translateKey } from '../lib/i18n.js';
  import { notify, DEFAULT_NOTIFICATION_DURATION } from '../lib/notification-store.js';
  import {
    compareDateKeys,
    formatMonthYear,
    getCalendarMonthGrid,
    getWeekdayLabels,
    hasReservationCollision,
    isDateInSelection,
    isDateReserved,
    toDateKey,
  } from '../lib/calendar.js';
  import {
    getBlockEndDate,
    isFixedBlockTag,
    isTuesday,
  } from '../lib/reservation-rules.js';

  let { item, onupdated, onconfirmed, hideHeading = false } = $props();

  let todayKey = $derived(toDateKey(new Date($availabilityNow)));
  const itemTag = $derived(item?.tag ?? 'equipment');
  const fixedBlock = $derived(isFixedBlockTag(itemTag));
  const showPickupNotice = $derived(itemTag === 'equipment' || itemTag === 'books');

  // Explicit reactive snapshot so Svelte 5 fine-grained tracking picks up
  // any change to item.reservations when the item prop updates.
  const itemReservations = $derived(item?.reservations ?? []);

  let viewYear = $state(new Date().getFullYear());
  let viewMonth = $state(new Date().getMonth());
  let rangeStart = $state(null);
  let rangeEnd = $state(null);
  let saving = $state(false);
  let statusMessage = $state('');
  let statusType = $state('');

  let monthGrid = $derived(getCalendarMonthGrid(viewYear, viewMonth));
  let weekdayLabels = $derived(getWeekdayLabels($locale === 'fr' ? 'fr-CA' : 'en-CA'));
  let monthLabel = $derived(formatMonthYear(viewYear, viewMonth, $locale === 'fr' ? 'fr-CA' : 'en-CA'));

  let selectedStart = $derived.by(() => {
    if (!rangeStart) {
      return null;
    }

    if (!rangeEnd) {
      return rangeStart;
    }

    return compareDateKeys(rangeStart, rangeEnd) <= 0 ? rangeStart : rangeEnd;
  });

  let selectedEnd = $derived.by(() => {
    if (!rangeStart) {
      return null;
    }

    if (!rangeEnd) {
      return rangeStart;
    }

    return compareDateKeys(rangeStart, rangeEnd) <= 0 ? rangeEnd : rangeStart;
  });

  let canConfirm = $derived(
    Boolean(selectedStart && selectedEnd) &&
      !hasReservationCollision(itemReservations, selectedStart, selectedEnd),
  );

  function clearStatus() {
    statusMessage = '';
    statusType = '';
  }

  function goToPreviousMonth() {
    if (viewMonth === 0) {
      viewMonth = 11;
      viewYear -= 1;
    } else {
      viewMonth -= 1;
    }
  }

  function goToNextMonth() {
    if (viewMonth === 11) {
      viewMonth = 0;
      viewYear += 1;
    } else {
      viewMonth += 1;
    }
  }

  function isPastDate(dateKey) {
    return compareDateKeys(dateKey, todayKey) < 0;
  }

  function isDayDisabled(dateKey, inCurrentMonth) {
    if (!inCurrentMonth || isPastDate(dateKey)) {
      return true;
    }

    if (fixedBlock) {
      if (!isTuesday(dateKey)) {
        return true;
      }

      const blockEnd = getBlockEndDate(itemTag, dateKey);
      return hasReservationCollision(itemReservations, dateKey, blockEnd);
    }

    return isDateReserved(itemReservations, dateKey);
  }

  function handleFixedBlockClick(dateKey) {
    const blockEnd = getBlockEndDate(itemTag, dateKey);

    if (hasReservationCollision(itemReservations, dateKey, blockEnd)) {
      statusMessage = $t('calendar.block_unavailable');
      statusType = 'error';
      rangeStart = null;
      rangeEnd = null;
      return;
    }

    rangeStart = dateKey;
    rangeEnd = blockEnd;
  }

  function handleFlexibleRangeClick(dateKey) {
    if (isDateReserved(itemReservations, dateKey)) {
      return;
    }

    if (!rangeStart || rangeEnd) {
      rangeStart = dateKey;
      rangeEnd = null;
      return;
    }

    if (compareDateKeys(dateKey, rangeStart) < 0) {
      rangeEnd = rangeStart;
      rangeStart = dateKey;
    } else {
      rangeEnd = dateKey;
    }

    const start = compareDateKeys(rangeStart, rangeEnd) <= 0 ? rangeStart : rangeEnd;
    const end = compareDateKeys(rangeStart, rangeEnd) <= 0 ? rangeEnd : rangeStart;

    if (hasReservationCollision(itemReservations, start, end)) {
      statusMessage = $t('calendar.collision_error');
      statusType = 'error';
      rangeStart = null;
      rangeEnd = null;
    }
  }

  function handleDayClick(dateKey, inCurrentMonth) {
    if (isDayDisabled(dateKey, inCurrentMonth)) {
      return;
    }

    clearStatus();

    if (fixedBlock) {
      handleFixedBlockClick(dateKey);
      return;
    }

    handleFlexibleRangeClick(dateKey);
  }

  function clearSelection() {
    rangeStart = null;
    rangeEnd = null;
    clearStatus();
  }

  async function handleConfirm() {
    if (!selectedStart || !selectedEnd || saving) {
      return;
    }

    saving = true;
    clearStatus();

    try {
      const result = await createReservation(item.id, {
        startDate: selectedStart,
        endDate: selectedEnd,
      });

      const updatedItem =
        result.item?.reservations != null
          ? { ...item, reservations: result.item.reservations }
          : result.item;

      onupdated?.(updatedItem);
      onconfirmed?.({ item: updatedItem, reservation: result.reservation });
      if (result.reservation?.status === 'pending') {
        notify(translateKey('kimchi.reservation_sent'), DEFAULT_NOTIFICATION_DURATION);
      }
      rangeStart = null;
      rangeEnd = null;
      statusMessage =
        result.reservation?.status === 'pending'
          ? $t('calendar.reservation_pending')
          : $t('calendar.reservation_saved');
      statusType = 'success';
    } catch (error) {
      statusMessage = error.message || $t('calendar.create_error');
      statusType = 'error';
    } finally {
      saving = false;
    }
  }
</script>

<div class="item-calendar">
  <div
    class="item-calendar__header"
    class:item-calendar__header--nav-only={hideHeading}
  >
    {#if !hideHeading}
      <h4 class="item-calendar__title">{$t('calendar.heading')}</h4>
    {/if}
    <div class="item-calendar__nav">
      <button
        type="button"
        class="item-calendar__nav-btn"
        onclick={goToPreviousMonth}
        aria-label={$t('calendar.prev_month')}
      >
        ‹
      </button>
      <span class="item-calendar__month" aria-live="polite">{monthLabel}</span>
      <button
        type="button"
        class="item-calendar__nav-btn"
        onclick={goToNextMonth}
        aria-label={$t('calendar.next_month')}
      >
        ›
      </button>
    </div>
  </div>

  {#if showPickupNotice}
    <p class="item-calendar__pickup-notice" role="note">
      {$t('calendar.pickup_dropoff_hours')}
    </p>
  {/if}

  <div class="item-calendar__weekdays" aria-hidden="true">
    {#each weekdayLabels as label}
      <span class="item-calendar__weekday">{label}</span>
    {/each}
  </div>

  <div class="item-calendar__grid" role="grid" aria-label={$t('calendar.grid_aria')}>
    {#each monthGrid as week}
      {#each week as day}
        {@const reserved =
          day.inCurrentMonth && isDateReserved(itemReservations, day.dateKey)}
        {@const past = isPastDate(day.dateKey)}
        {@const selected = isDateInSelection(rangeStart, rangeEnd, day.dateKey)}
        {@const disabled = isDayDisabled(day.dateKey, day.inCurrentMonth)}
        {@const blockedWeekday =
          fixedBlock && day.inCurrentMonth && !past && !reserved && !isTuesday(day.dateKey)}
        <button
          type="button"
          class="item-calendar__day"
          class:item-calendar__day--outside={!day.inCurrentMonth}
          class:item-calendar__day--reserved={reserved}
          class:item-calendar__day--blocked={blockedWeekday}
          class:item-calendar__day--past={past && day.inCurrentMonth && !reserved}
          class:item-calendar__day--selected={selected && day.inCurrentMonth}
          class:item-calendar__day--today={day.dateKey === todayKey && day.inCurrentMonth}
          disabled={disabled}
          aria-label={day.dateKey}
          aria-pressed={selected}
          onclick={() => handleDayClick(day.dateKey, day.inCurrentMonth)}
        >
          {day.date.getDate()}
        </button>
      {/each}
    {/each}
  </div>

  <div class="item-calendar__legend">
    <span class="item-calendar__legend-item">
      <span class="item-calendar__swatch item-calendar__swatch--available"></span>
      {$t('calendar.legend_available')}
    </span>
    <span class="item-calendar__legend-item">
      <span class="item-calendar__swatch item-calendar__swatch--reserved"></span>
      {$t('calendar.legend_reserved')}
    </span>
  </div>

  {#if selectedStart && selectedEnd}
    <p class="item-calendar__selection">
      {$t('calendar.selected_range', { start: selectedStart, end: selectedEnd })}
    </p>
  {:else if fixedBlock}
    <p class="item-calendar__selection item-calendar__selection--hint">
      {#if itemTag === 'books'}
        {$t('calendar.select_tuesday_books')}
      {:else}
        {$t('calendar.select_tuesday_equipment')}
      {/if}
    </p>
  {:else if rangeStart}
    <p class="item-calendar__selection">{$t('calendar.select_end_date')}</p>
  {:else}
    <p class="item-calendar__selection item-calendar__selection--hint">{$t('calendar.select_start_date')}</p>
  {/if}

  <div class="item-calendar__actions">
    <button
      type="button"
      class="btn-calendar-confirm"
      disabled={!canConfirm || saving}
      onclick={handleConfirm}
    >
      {#if saving}
        {$t('calendar.saving')}
      {:else}
        {$t('calendar.confirm_reservation')}
      {/if}
    </button>
    {#if rangeStart}
      <button type="button" class="btn-calendar-clear" onclick={clearSelection}>
        {$t('calendar.clear_selection')}
      </button>
    {/if}
  </div>

  {#if statusMessage}
    <p class="item-calendar__status status {statusType}" role="status" aria-live="polite">
      {statusMessage}
    </p>
  {/if}
</div>
