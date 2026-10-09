<script module>
  // Kimchi's arrival summary (B2) runs once per page load: the panel remounts each time
  // someone comes back to /admin.
  let arrivalChecked = false;
</script>

<script>
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import {
    approveReservation,
    bookFollowUpConsultation,
    deleteInventoryItem,
    deleteReservation,
    fetchAdminInventory,
    refuseReservation,
  } from '../lib/inventory.js';
  import { compareDateKeys, libraryTodayKey, parseDateKey } from '../lib/calendar.js';
  import { addDays, canBookFollowUp, isConsultationHeld, isTuesday } from '../lib/reservation-rules.js';
  import { FOLLOW_UP_NOTE_MAX } from '../lib/expertise-fields.js';
  import { locale, t } from '../lib/i18n.js';
  import {
    dismissKind,
    notify,
    notifyWhenIdle,
    DEFAULT_NOTIFICATION_DURATION,
  } from '../lib/notification-store.js';
  import { isDayFlagToday, setDayFlag } from '../lib/kimchi-memory.js';
  import {
    availabilityNow,
    subscribeAvailabilityClock,
    unsubscribeAvailabilityClock,
  } from '../lib/availability-clock.js';
  import MeetingTimePicker, { parseMeetingTimeInput } from './MeetingTimePicker.svelte';
  import MentorBrowser from './MentorBrowser.svelte';
  import BusyLabel from './BusyLabel.svelte';
  import Skeleton from './Skeleton.svelte';

  // `loading` here is App's public inventory load (AdminPage passes it through).
  let { items = [], loading: inventoryLoading = false, onAddItem, onItemRemoved, onItemUpdated } = $props();

  let adminItems = $state([]);
  // An admin fetch is running. The skeleton shows only until the first one lands
  // (hasLoaded); later refreshes keep the rows and mark the list as refreshing.
  let loading = $state(true);
  let hasLoaded = $state(false);
  let loadError = $state('');
  // App's inventory count at mount, untracked, so mounting doesn't add a second fetch
  // on top of onMount's.
  let lastParentCount = untrack(() => items.length);
  // App's first inventory load can land after this panel mounted. That count change is
  // not an edit, and onMount's fetch started after it, so it needs no refetch.
  let awaitingInventory = untrack(() => inventoryLoading);
  // One admin fetch at a time: refreshes asked for meanwhile collapse into one more fetch.
  let refreshRun = null;
  let refreshQueued = false;
  // Bumped by every in-place update (approve, delete, mentor edit...): a fetch that was
  // already running may predate it, so its result is dropped and fetched again.
  let editVersion = 0;

  let removingId = $state('');
  let removeError = $state('');
  let showRemoveList = $state(false);
  let showMentorList = $state(false);
  let showPendingList = $state(false);
  let showReservationList = $state(false);
  let deletingReservationId = $state('');
  // { id, kind: 'approve' | 'refuse' } while a pending row's action runs: every Approve
  // and Refuse stays disabled, but only the clicked button shows busy.
  let pendingAction = $state(null);
  let reservationError = $state('');
  let pendingError = $state('');
  // Per-entry datetime-local values for approving expertise consultations.
  let meetingTimes = $state({});
  let meetingTimeErrors = $state({});
  const meetingPickers = {};
  // Follow-up booking on scheduled consultations in Edit Reservations (same per-row maps).
  let followUpOpenId = $state('');
  let followUpActionId = $state('');
  let followUpError = $state('');
  let followUpTimes = $state({});
  let followUpTimeErrors = $state({});
  let followUpNotes = $state({});
  const followUpPickers = {};

  // One permanent, visually hidden status line for every approve, refuse, delete, removal and
  // follow-up result, so screen readers hear it even while Kimchi sleeps.
  let statusMessage = $state('');
  // The acted-on row disappears, so focus moves to the row that took its place (rows take
  // focus from script only: tabindex="-1"), or to the list's toggle once the list is empty.
  let removeRows = $state({});
  let pendingRows = $state({});
  let reservationRows = $state({});
  let removeToggle = $state();
  let pendingToggle = $state();
  let reservationToggle = $state();

  // Kimchi bubbles that say more than a short line (mentor without email, removals, arrival).
  const LONG_NOTIFICATION_DURATION = 9000;
  // B2: what needs attention first, at most once per Montréal day in this browser.
  const ARRIVAL_DAY_FLAG = 'admin-arrival';
  const PICKUP_DAY_FLAG = 'admin-pickup-day';
  const PICKUP_DAY_DELAY_MS = 1000;
  const CONSULTATION_WAIT_DAYS = 7;
  // D10: "all caught up" once the admin's own action empties a queue that held 3 or more.
  const QUEUE_CLEAR_DAY_FLAG = 'admin-queue-clear';
  const QUEUE_CLEAR_MIN_PEAK = 3;
  const QUEUE_CLEAR_DELAY_MS = 1200;
  let pendingPeak = 0;
  let queueClearTimer = null;
  let destroyed = false;

  function refreshAdminItems() {
    if (refreshRun) {
      // The running fetch may predate whatever asked for this one: fetch once more after it.
      refreshQueued = true;
      return refreshRun;
    }

    refreshRun = runRefresh().finally(() => {
      refreshRun = null;
    });
    return refreshRun;
  }

  async function runRefresh() {
    loading = true;
    // With no rows on screen yet, a retry drops the old error so the skeleton shows again.
    if (!hasLoaded) {
      loadError = '';
    }

    try {
      do {
        refreshQueued = false;
        const startVersion = editVersion;

        try {
          const freshItems = await fetchAdminInventory();
          if (editVersion !== startVersion) {
            refreshQueued = true;
            continue;
          }
          adminItems = freshItems;
          hasLoaded = true;
          loadError = '';
          // Only while mounted: a fetch that lands after unmount must not spend the once-per-load
          // check or start a bubble that onDestroy's dismissKind has already missed.
          if (!arrivalChecked && !destroyed) {
            arrivalChecked = true;
            announceArrival();
          }
        } catch (error) {
          // Keep the rows already on screen; the error shows above them. A queued fetch
          // is about to run, so let that one decide.
          if (!refreshQueued) {
            loadError = error.message || $t('inventory.load_error');
          }
        }
      } while (refreshQueued);
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
    editVersion += 1;
    adminItems = adminItems.map((candidate) => (candidate.id === item.id ? item : candidate));
    onItemUpdated?.(sanitizeItemForPublicSync(item));
  }

  onMount(() => {
    subscribeAvailabilityClock();
    refreshAdminItems();
  });

  onDestroy(() => {
    unsubscribeAvailabilityClock();
    destroyed = true;
    clearTimeout(queueClearTimer);
    // The arrival notes point at this page's lists: don't leave them talking elsewhere.
    dismissKind('admin-arrival');
  });

  // An item added or removed elsewhere changes App's count: refetch quietly.
  $effect(() => {
    const count = items.length;

    if (awaitingInventory && !inventoryLoading) {
      awaitingInventory = false;
      lastParentCount = count;
      return;
    }

    if (count !== lastParentCount) {
      lastParentCount = count;
      untrack(refreshAdminItems);
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
          // Nobody emails this mentor: only staff can schedule, and they forward the Zoom link.
          mentorEmailMissing: item.tag === 'expertise' && !item.expertEmail,
        })),
    ),
  );

  // The longest the Pending queue got during this visit (D10).
  $effect(() => {
    pendingPeak = Math.max(pendingPeak, pendingEntries.length);
  });

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
          mentorEmailMissing: item.tag === 'expertise' && !item.expertEmail,
          held: item.tag === 'expertise' && isConsultationHeld(reservation, now),
          // Over, or no member address: deleting it emails nobody.
          silent:
            item.tag !== 'expertise' && (!reservation.userEmail || !isUpcomingReservation(reservation)),
        })),
    ),
  );

  /** Same rule as the expert's /account list: a started meeting, the member's latest with that expert. */
  function followUpAllowedFor(entry) {
    const member = (entry.userEmail ?? '').toLowerCase();
    if (entry.itemTag !== 'expertise' || !member) {
      return false;
    }

    const item = adminItems.find((candidate) => candidate.id === entry.itemId);
    const others = (item?.reservations ?? []).filter(
      (other) => (other.userEmail ?? '').toLowerCase() === member,
    );
    return canBookFollowUp(entry, others, now);
  }

  function toggleFollowUp(entry) {
    followUpOpenId = followUpOpenId === entry.id ? '' : entry.id;
    followUpError = '';
  }

  async function handleFollowUp(entry) {
    if (followUpActionId) {
      return;
    }

    const parsed = parseMeetingTimeInput(followUpTimes[entry.id]);
    const timeError = !parsed
      ? $t('account_consultations.meeting_time_required')
      : parsed.getTime() <= Date.now()
        ? $t('admin.meeting_time_past')
        : '';

    followUpTimeErrors[entry.id] = timeError;
    if (timeError) {
      followUpPickers[entry.id]?.focus();
      return;
    }

    followUpError = '';
    const meetingAt = parsed.toISOString();
    const trigger = document.activeElement;
    const confirmed = window.confirm(
      $t(entry.mentorEmailMissing ? 'admin.follow_up_confirm_no_expert_email' : 'admin.follow_up_confirm', {
        title: entry.itemTitle,
        email: entry.userEmail ?? '',
        time: formatMeetingTime(meetingAt),
      }),
    );

    if (!confirmed) {
      return;
    }

    followUpActionId = entry.id;
    statusMessage = '';
    let failed = false;
    let followUpId = '';

    try {
      const result = await bookFollowUpConsultation(entry.id, meetingAt, followUpNotes[entry.id] ?? '');
      applyItemUpdate(entry, result);
      followUpOpenId = '';
      followUpTimes[entry.id] = '';
      followUpNotes[entry.id] = '';
      followUpId = result.consultation?.id ?? '';
      // A3: the same "who was invited" check as approving a consultation.
      confirmScheduled(
        entry,
        result.emailSent,
        result.consultation?.zoomJoinUrl,
        FOLLOW_UP_BUBBLES,
        'admin.follow_up_booked_status',
      );
    } catch (error) {
      failed = true;
      followUpError = error.message || $t('account_consultations.follow_up_error');
    } finally {
      followUpActionId = '';
    }

    // The form closed with its button: focus the new follow-up's row (else this one). On an
    // error the form stays open, so focus goes back to its button.
    await tick();
    if (!canMoveFocus(trigger)) {
      return;
    }
    if (failed) {
      restoreFocus(trigger);
      return;
    }
    (reservationRows[followUpId] ?? reservationRows[entry.id])?.focus();
  }

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
      editVersion += 1;
      const updatedItem = { ...item, reservations: result.item.reservations };
      adminItems = adminItems.map((candidate) =>
        candidate.id === updatedItem.id ? updatedItem : candidate,
      );
      onItemUpdated?.(sanitizeItemForPublicSync(updatedItem));
    }
  }

  /** Fills the status line: `key` takes the row's `{title}`; falsy note keys are skipped. */
  function announce(key, title, ...noteKeys) {
    const notes = noteKeys.filter(Boolean).map((noteKey) => $t(noteKey));
    statusMessage = [$t(key, { title }), ...notes].join(' ');
  }

  // Focus is only moved if it's still where the action left it (the pressed button, or the
  // page once that button was disabled): an admin who moved on keeps their place.
  function canMoveFocus(trigger) {
    const active = document.activeElement;
    return !active || active === document.body || active === trigger;
  }

  /** After a failed action, back to the button that started it (disabled while it ran). */
  function restoreFocus(trigger) {
    if (trigger && trigger !== document.body && trigger.isConnected) {
      trigger.focus();
    }
  }

  /**
   * After an action, once the DOM has settled. On failure focus goes back to the pressed
   * button. On success its row is gone, so focus goes to the row now in its place (or the
   * last one), else to the list's toggle.
   */
  async function focusAfterAction({ failed, trigger, getRows, rowRefs, index, toggle }) {
    await tick();
    if (!canMoveFocus(trigger)) {
      return;
    }
    if (failed) {
      restoreFocus(trigger);
      return;
    }

    const rows = getRows();
    const next = rows[Math.min(index, rows.length - 1)];
    (rowRefs[next?.id] ?? toggle)?.focus();
  }

  // Approving a consultation or booking a follow-up creates the Zoom meeting and emails the
  // member and the mentor. A mentor with no email on file isn't invited (A3), and when the
  // response says the email didn't go out the bubble drops its email claim.
  const SCHEDULED_BUBBLES = {
    sent: 'kimchi.consultation_scheduled',
    plain: 'kimchi.consultation_scheduled_plain',
    noExpertEmail: 'kimchi.consultation_scheduled_no_expert_email',
    noExpertEmailNoZoom: 'kimchi.consultation_scheduled_no_expert_email_no_zoom',
  };
  const FOLLOW_UP_BUBBLES = {
    sent: 'kimchi.follow_up_booked',
    plain: 'kimchi.follow_up_booked_plain',
    noExpertEmail: 'kimchi.follow_up_booked_no_expert_email',
    noExpertEmailNoZoom: 'kimchi.follow_up_booked_no_expert_email_no_zoom',
  };

  function confirmScheduled(entry, emailSent, zoomJoinUrl, bubbles, statusKey) {
    if (emailSent === false) {
      notify({ textKey: bubbles.plain }, DEFAULT_NOTIFICATION_DURATION);
    } else if (entry.mentorEmailMissing) {
      notify(
        { textKey: zoomJoinUrl ? bubbles.noExpertEmail : bubbles.noExpertEmailNoZoom },
        LONG_NOTIFICATION_DURATION,
      );
    } else {
      notify({ textKey: bubbles.sent }, DEFAULT_NOTIFICATION_DURATION);
    }

    if (!entry.mentorEmailMissing) {
      announce(statusKey, entry.itemTitle, emailSent === true && 'admin.status_both_emailed');
      return;
    }
    announce(
      statusKey,
      entry.itemTitle,
      emailSent === true ? 'admin.status_only_member_emailed' : 'admin.status_mentor_no_email',
      zoomJoinUrl && 'admin.status_zoom_link_here',
    );
  }

  /**
   * D10: the admin's own approve or refuse just emptied a queue that held 3 or more
   * requests during this visit. Once per Montréal day, a beat after the action's bubble.
   */
  function celebrateQueueClear() {
    if (pendingEntries.length > 0 || pendingPeak < QUEUE_CLEAR_MIN_PEAK) {
      return;
    }
    if (isDayFlagToday(QUEUE_CLEAR_DAY_FLAG)) {
      return;
    }

    clearTimeout(queueClearTimer);
    queueClearTimer = setTimeout(() => {
      const id = notify({ textKey: 'kimchi.pending_queue_clear' }, DEFAULT_NOTIFICATION_DURATION, {
        ambient: true,
      });
      if (id !== -1) {
        setDayFlag(QUEUE_CLEAR_DAY_FLAG);
      }
    }, QUEUE_CLEAR_DELAY_MS);
  }

  /**
   * B2: on the first admin load of a visit, the most urgent of (a) consultation requests only
   * staff can schedule (no mentor email), (b) pending requests that start today or earlier,
   * (c) consultation requests waiting a week or more. Then, on Tuesdays, today's handovers.
   * Counts only. Each is spent for the Montréal day only once a bubble really showed; the
   * pending rows carry the same facts inline (chips), for when Kimchi is asleep.
   */
  async function announceArrival() {
    const today = todayKey;
    const pending = pendingEntries;
    const staffOnly = pending.filter((entry) => entry.mentorEmailMissing).length;
    const due = pending.filter(
      (entry) => entry.itemTag !== 'expertise' && compareDateKeys(entry.startDate, today) <= 0,
    ).length;
    const waitingSince = addDays(today, -CONSULTATION_WAIT_DAYS);
    const waiting = pending.filter(
      (entry) => entry.itemTag === 'expertise' && compareDateKeys(entry.startDate, waitingSince) <= 0,
    ).length;

    let attention = null;
    if (staffOnly > 0) {
      attention = { textKey: 'kimchi.admin_arrival.staff_only', vars: { count: staffOnly } };
    } else if (due > 0) {
      attention = { textKey: 'kimchi.admin_arrival.pending_due', vars: { count: due } };
    } else if (waiting > 0) {
      attention = { textKey: 'kimchi.admin_arrival.consult_waiting', vars: { count: waiting } };
    }

    let attentionShown = false;
    if (attention && !isDayFlagToday(ARRIVAL_DAY_FLAG, today)) {
      const id = await notifyWhenIdle(attention, LONG_NOTIFICATION_DURATION, { kind: 'admin-arrival' });
      if (id !== -1) {
        setDayFlag(ARRIVAL_DAY_FLAG, today);
        attentionShown = true;
      }
    }

    if (destroyed || !isTuesday(today) || isDayFlagToday(PICKUP_DAY_FLAG, today)) {
      return;
    }

    // Equipment and books change hands on Tuesdays (rooms have no pickup).
    const handovers = reservationEntries.filter(
      (entry) => entry.itemTag === 'equipment' || entry.itemTag === 'books',
    );
    const pickups = handovers.filter((entry) => entry.startDate === today).length;
    const returns = handovers.filter((entry) => entry.endDate === today).length;
    if (pickups + returns === 0) {
      return;
    }

    if (attentionShown) {
      await new Promise((resolve) => setTimeout(resolve, PICKUP_DAY_DELAY_MS));
      if (destroyed) {
        return;
      }
    }

    // A flavour note rather than a to-do, so it's ambient: it respects Kimchi's budget and
    // stays quiet on quiet days.
    const id = await notifyWhenIdle(
      { textKey: 'kimchi.admin_arrival.pickup_day', vars: { pickups, returns } },
      LONG_NOTIFICATION_DURATION,
      { kind: 'admin-arrival', ambient: true },
    );
    if (id !== -1) {
      setDayFlag(PICKUP_DAY_FLAG, today);
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
      message = $t(
        item.expertEmail ? 'admin.remove_expertise_confirm' : 'admin.remove_expertise_confirm_no_expert_email',
        { title: item.title, count: consultationCount },
      );
    } else if (upcomingCount > 0) {
      message = $t('admin.remove_with_reservations_confirm', { title: item.title, count: upcomingCount });
    }
    const trigger = document.activeElement;
    const confirmed = window.confirm(message);
    if (!confirmed) {
      return;
    }

    // Rows the server emails about (A8): a mentor's pending and not-yet-held consultations,
    // or the members' pending and upcoming bookings.
    const isMentor = item.tag === 'expertise';
    const activeCount = isMentor
      ? (item.reservations ?? []).filter(
          (reservation) =>
            (reservation.status === 'pending' || reservation.status === 'reserved') &&
            !isConsultationHeld(reservation, now),
        ).length
      : upcomingCount;
    const index = adminItems.findIndex((candidate) => candidate.id === item.id);
    removingId = item.id;
    removeError = '';
    statusMessage = '';
    let failed = false;

    try {
      const result = await deleteInventoryItem(item.id);
      editVersion += 1;
      adminItems = adminItems.filter((candidate) => candidate.id !== item.id);
      onItemRemoved?.(item.id);
      // Say who was told only when the server emailed everyone about an active row.
      const notified = result?.emailSent === true && activeCount > 0;
      if (notified) {
        notify(
          { textKey: isMentor ? 'kimchi.mentor_removed_notified' : 'kimchi.item_removed_notified' },
          LONG_NOTIFICATION_DURATION,
        );
      } else {
        notify({ textKey: 'kimchi.item_removed' }, DEFAULT_NOTIFICATION_DURATION);
      }
      announce('admin.removed_status', item.title, notified && 'admin.status_removed_emailed');
    } catch (error) {
      failed = true;
      removeError = error.message || $t('admin.remove_error');
    } finally {
      removingId = '';
    }

    await focusAfterAction({
      failed,
      trigger,
      getRows: () => adminItems,
      rowRefs: removeRows,
      index,
      toggle: removeToggle,
    });
  }

  async function handleDeleteReservation(entry) {
    if (deletingReservationId) {
      return;
    }

    const email = entry.userEmail || $t('admin.no_member_email');
    let message;
    if (entry.itemTag === 'expertise' && entry.meetingAt) {
      let key = 'admin.delete_consultation_confirm';
      if (entry.held) {
        key = 'admin.delete_held_consultation_confirm';
      } else if (entry.mentorEmailMissing) {
        key = 'admin.delete_consultation_confirm_no_expert_email';
      }
      message = $t(key, { title: entry.itemTitle, time: formatMeetingTime(entry.meetingAt), email });
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
    const trigger = document.activeElement;
    const confirmed = window.confirm(message);

    if (!confirmed) {
      return;
    }

    const index = reservationEntries.findIndex((candidate) => candidate.id === entry.id);
    deletingReservationId = entry.id;
    reservationError = '';
    statusMessage = '';
    let failed = false;

    try {
      const result = await deleteReservation(entry.itemId, entry.id);
      applyItemUpdate(entry, result);
      const isConsultation = entry.itemTag === 'expertise';
      // A8: name who was told only when the server emailed about an active row; held meetings
      // and ended or address-less bookings are removed silently.
      const notified = result.emailSent === true && (isConsultation ? !entry.held : !entry.silent);
      let bubbleKey = 'kimchi.reservation_deleted';
      if (notified) {
        bubbleKey = isConsultation ? 'kimchi.consultation_deleted_notified' : 'kimchi.reservation_deleted_notified';
      }
      notify({ textKey: bubbleKey }, DEFAULT_NOTIFICATION_DURATION);

      let statusKey = 'admin.deleted_status';
      if (isConsultation) {
        statusKey = entry.held ? 'admin.held_consultation_deleted_status' : 'admin.consultation_deleted_status';
      }
      let emailNote = '';
      if (notified) {
        emailNote = isConsultation && !entry.mentorEmailMissing ? 'admin.status_both_emailed' : 'admin.status_member_emailed';
      }
      announce(statusKey, entry.itemTitle, emailNote);
    } catch (error) {
      failed = true;
      reservationError = error.message || $t('admin.delete_reservation_error');
    } finally {
      deletingReservationId = '';
    }

    await focusAfterAction({
      failed,
      trigger,
      getRows: () => reservationEntries,
      rowRefs: reservationRows,
      index,
      toggle: reservationToggle,
    });
  }

  async function handleApprove(entry) {
    if (pendingAction) {
      return;
    }

    const isExpertise = entry.itemTag === 'expertise';
    let meetingAt = null;

    if (isExpertise) {
      const parsed = parseMeetingTimeInput(meetingTimes[entry.id]);
      // iOS doesn't enforce min in its picker, so check for a past time here, before the confirm.
      const timeError = !parsed
        ? $t('admin.meeting_time_required')
        : parsed.getTime() <= Date.now()
          ? $t('admin.meeting_time_past')
          : '';

      meetingTimeErrors[entry.id] = timeError;
      if (timeError) {
        meetingPickers[entry.id]?.focus();
        return;
      }

      meetingAt = parsed.toISOString();
    }

    const email = entry.userEmail || $t('admin.no_member_email');
    const trigger = document.activeElement;
    const confirmed = window.confirm(
      isExpertise
        ? $t(
            entry.mentorEmailMissing
              ? 'admin.approve_consultation_confirm_no_expert_email'
              : 'admin.approve_consultation_confirm',
            {
              title: entry.itemTitle,
              time: formatMeetingTime(meetingAt),
              email,
            },
          )
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

    const index = pendingEntries.findIndex((candidate) => candidate.id === entry.id);
    pendingAction = { id: entry.id, kind: 'approve' };
    pendingError = '';
    statusMessage = '';
    let failed = false;

    try {
      const result = await approveReservation(
        entry.itemId,
        entry.id,
        meetingAt ? { meetingAt } : {},
      );
      applyItemUpdate(entry, result);
      if (isExpertise) {
        // Approving a consultation schedules it (A3): say "scheduled", not "approved".
        confirmScheduled(
          entry,
          result.emailSent,
          result.reservation?.zoomJoinUrl,
          SCHEDULED_BUBBLES,
          'admin.consultation_scheduled_status',
        );
      } else {
        notify(
          {
            textKey:
              result.emailSent === false ? 'kimchi.reservation_approved_plain' : 'kimchi.reservation_approved',
          },
          DEFAULT_NOTIFICATION_DURATION,
        );
        announce('admin.approved_status', entry.itemTitle, result.emailSent === true && 'admin.status_member_emailed');
      }
      celebrateQueueClear();
    } catch (error) {
      failed = true;
      pendingError = error.message || $t('admin.approve_reservation_error');
    } finally {
      pendingAction = null;
    }

    await focusAfterAction({
      failed,
      trigger,
      getRows: () => pendingEntries,
      rowRefs: pendingRows,
      index,
      toggle: pendingToggle,
    });
  }

  async function handleRefuse(entry) {
    if (pendingAction) {
      return;
    }

    const isExpertise = entry.itemTag === 'expertise';
    const email = entry.userEmail || $t('admin.no_member_email');
    const trigger = document.activeElement;
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

    const index = pendingEntries.findIndex((candidate) => candidate.id === entry.id);
    pendingAction = { id: entry.id, kind: 'refuse' };
    pendingError = '';
    statusMessage = '';
    let failed = false;

    try {
      const result = await refuseReservation(entry.itemId, entry.id);
      applyItemUpdate(entry, result);
      // A1: refusals confirm too. Without the email claim when that email didn't go out.
      const emailed = result.emailSent !== false;
      let bubbleKey = emailed ? 'kimchi.reservation_refused' : 'kimchi.reservation_refused_plain';
      if (isExpertise) {
        bubbleKey = emailed ? 'kimchi.consultation_refused' : 'kimchi.consultation_refused_plain';
      }
      notify({ textKey: bubbleKey }, DEFAULT_NOTIFICATION_DURATION);
      announce(
        isExpertise ? 'admin.consultation_refused_status' : 'admin.refused_status',
        entry.itemTitle,
        result.emailSent === true && 'admin.status_member_emailed',
      );
      celebrateQueueClear();
    } catch (error) {
      failed = true;
      pendingError = error.message || $t('admin.refuse_reservation_error');
    } finally {
      pendingAction = null;
    }

    await focusAfterAction({
      failed,
      trigger,
      getRows: () => pendingEntries,
      rowRefs: pendingRows,
      index,
      toggle: pendingToggle,
    });
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
      bind:this={removeToggle}
      type="button"
      class="btn-primary"
      aria-expanded={showRemoveList}
      aria-controls="admin-remove-list"
      onclick={() => (showRemoveList = !showRemoveList)}
    >
      {$t('admin.remove_items')}
    </button>
    <button
      bind:this={pendingToggle}
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
      bind:this={reservationToggle}
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
      {hasLoaded}
      {loadError}
      onupdated={handleMentorUpdated}
    />
  {/if}

  <!-- Each list: skeleton until the first fetch lands, then the rows stay put through
       later refreshes (.list-refreshing), with a failed refresh's error above them. -->
  {#if showRemoveList}
    <div id="admin-remove-list">
      {#if loadError}
        <p class="admin-status admin-status-error" role="alert">{loadError}</p>
      {/if}
      {#if loading && !hasLoaded}
        <Skeleton count={4} label={$t('admin.loading')} />
      {:else if adminItems.length > 0}
        <ul
          class="admin-item-list"
          class:list-refreshing={loading}
          aria-busy={loading || undefined}
        >
          {#each adminItems as item (item.id)}
            <li bind:this={removeRows[item.id]} class="admin-item-row" tabindex="-1">
              <span class="admin-item-title">{item.title}</span>
              <button
                type="button"
                class="btn-remove"
                disabled={Boolean(removingId)}
                onclick={() => handleRemove(item)}
              >
                <BusyLabel
                  label={$t('admin.remove')}
                  busyLabel={$t('admin.removing')}
                  busy={removingId === item.id}
                />
              </button>
            </li>
          {/each}
        </ul>
      {:else if hasLoaded}
        <p class="empty-state">{$t('admin.empty')}</p>
      {/if}

      {#if removeError}
        <p class="admin-status admin-status-error" role="alert">{removeError}</p>
      {/if}
    </div>
  {/if}

  {#if showPendingList}
    <div id="admin-pending-list" class="admin-reservation-list">
      {#if loadError}
        <p class="admin-status admin-status-error" role="alert">{loadError}</p>
      {/if}
      {#if loading && !hasLoaded}
        <Skeleton count={4} actions={2} label={$t('admin.loading')} />
      {:else if pendingEntries.length > 0}
        <ul
          class="admin-item-list"
          class:list-refreshing={loading}
          aria-busy={loading || undefined}
        >
          {#each pendingEntries as entry (entry.id)}
            {@const isExpertiseEntry = entry.itemTag === 'expertise'}
            {@const startVsToday = isExpertiseEntry ? 1 : compareDateKeys(entry.startDate, todayKey)}
            <!-- The chips carry what Kimchi's arrival note (B2) counts, for when she's asleep. -->
            <li
              bind:this={pendingRows[entry.id]}
              class="admin-item-row admin-item-row--pending"
              class:consultation-row={isExpertiseEntry}
              tabindex="-1"
            >
              <div class="admin-reservation-details">
                <span class="admin-item-title">{entry.itemTitle}</span>
                {#if isExpertiseEntry}
                  <span class="admin-reservation-dates">
                    {$t('admin.consultation_requested_on', {
                      date: formatDateKey(entry.startDate),
                    })}
                    {#if entry.mentorEmailMissing}
                      <span class="consultation-status consultation-status--no-email">
                        {$t('admin.no_mentor_email')}
                      </span>
                    {/if}
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
                    {#if startVsToday === 0}
                      <span class="consultation-status consultation-status--starts-today">
                        {$t('admin.starts_today')}
                      </span>
                    {:else if startVsToday < 0}
                      <span class="consultation-status consultation-status--overdue">
                        {$t('admin.start_overdue')}
                      </span>
                    {/if}
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
                    bind:this={meetingPickers[entry.id]}
                    bind:value={meetingTimes[entry.id]}
                    bind:error={meetingTimeErrors[entry.id]}
                    label={$t('admin.meeting_time_label')}
                    hint={$t('admin.meeting_time_hint')}
                  />
                {/if}
              </div>
              <div class="admin-pending-actions">
                <button
                  type="button"
                  class="btn-approve"
                  disabled={Boolean(pendingAction)}
                  onclick={() => handleApprove(entry)}
                >
                  <BusyLabel
                    label={$t('admin.approve_reservation')}
                    busyLabel={$t('admin.approving_reservation')}
                    busy={pendingAction?.id === entry.id && pendingAction.kind === 'approve'}
                  />
                </button>
                <button
                  type="button"
                  class="btn-remove"
                  disabled={Boolean(pendingAction)}
                  onclick={() => handleRefuse(entry)}
                >
                  <BusyLabel
                    label={$t('admin.refuse_reservation')}
                    busyLabel={$t('admin.refusing_reservation')}
                    busy={pendingAction?.id === entry.id && pendingAction.kind === 'refuse'}
                  />
                </button>
              </div>
            </li>
          {/each}
        </ul>
      {:else if hasLoaded}
        <p class="empty-state">{$t('admin.pending_empty')}</p>
      {/if}

      {#if pendingError}
        <p class="admin-status admin-status-error" role="alert">{pendingError}</p>
      {/if}
    </div>
  {/if}

  {#if showReservationList}
    <div id="admin-reservation-list" class="admin-reservation-list">
      {#if loadError}
        <p class="admin-status admin-status-error" role="alert">{loadError}</p>
      {/if}
      {#if loading && !hasLoaded}
        <Skeleton count={4} label={$t('admin.loading')} />
      {:else if reservationEntries.length > 0}
        <!-- No aria-busy while a follow-up form is open: it would hold back that form's alert. -->
        <ul
          class="admin-item-list"
          class:list-refreshing={loading}
          aria-busy={(loading && !followUpOpenId) || undefined}
        >
          {#each reservationEntries as entry (entry.id)}
            {@const followUpAllowed = followUpAllowedFor(entry)}
            {@const followUpOpen = followUpAllowed && followUpOpenId === entry.id}
            <li
              bind:this={reservationRows[entry.id]}
              class="admin-item-row"
              class:consultation-row={entry.itemTag === 'expertise'}
              tabindex="-1"
            >
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
                    {#if entry.followUpOf}
                      <span class="consultation-status consultation-status--follow-up">
                        {$t('account_consultations.follow_up_badge')}
                      </span>
                    {/if}
                    <!-- Nobody emailed this mentor the invitation: staff forward the Zoom link (A3). -->
                    {#if entry.mentorEmailMissing && !entry.held}
                      <span class="consultation-status consultation-status--no-email">
                        {$t('admin.no_mentor_email')}
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

                {#if followUpAllowed}
                  <button
                    type="button"
                    class="btn-header btn-header--secondary consultation-follow-up__toggle"
                    aria-expanded={followUpOpen}
                    aria-controls="admin-follow-up-{entry.id}"
                    disabled={Boolean(followUpActionId)}
                    onclick={() => toggleFollowUp(entry)}
                  >
                    {$t(followUpOpen ? 'account_consultations.follow_up_close' : 'account_consultations.follow_up_open')}
                  </button>
                  {#if followUpOpen}
                    <div id="admin-follow-up-{entry.id}" class="consultation-follow-up">
                      <p class="admin-consultation-detail">
                        {$t(
                          entry.mentorEmailMissing ? 'admin.follow_up_intro_no_expert_email' : 'admin.follow_up_intro',
                          { email: entry.userEmail ?? '', title: entry.itemTitle },
                        )}
                      </p>
                      <MeetingTimePicker
                        bind:this={followUpPickers[entry.id]}
                        bind:value={followUpTimes[entry.id]}
                        bind:error={followUpTimeErrors[entry.id]}
                        label={$t('admin.meeting_time_label')}
                        hint={$t('admin.meeting_time_hint')}
                      />
                      <label class="consultation-field__label" for="admin-follow-up-note-{entry.id}">
                        {$t('account_consultations.follow_up_note_input_label')}
                      </label>
                      <textarea
                        id="admin-follow-up-note-{entry.id}"
                        class="consultation-follow-up__note"
                        rows="3"
                        maxlength={FOLLOW_UP_NOTE_MAX}
                        bind:value={followUpNotes[entry.id]}
                      ></textarea>
                      <div class="admin-pending-actions">
                        <button
                          type="button"
                          class="btn-approve"
                          disabled={Boolean(followUpActionId)}
                          onclick={() => handleFollowUp(entry)}
                        >
                          <BusyLabel
                            label={$t('account_consultations.follow_up_book')}
                            busyLabel={$t('account_consultations.follow_up_booking')}
                            busy={followUpActionId === entry.id}
                          />
                        </button>
                      </div>
                      {#if followUpError}
                        <p class="admin-status admin-status-error" role="alert">{followUpError}</p>
                      {/if}
                    </div>
                  {/if}
                {/if}
              </div>
              <button
                type="button"
                class="btn-remove"
                disabled={Boolean(deletingReservationId)}
                onclick={() => handleDeleteReservation(entry)}
              >
                <BusyLabel
                  label={$t('admin.delete_reservation')}
                  busyLabel={$t('admin.deleting_reservation')}
                  busy={deletingReservationId === entry.id}
                />
              </button>
            </li>
          {/each}
        </ul>
      {:else if hasLoaded}
        <p class="empty-state">{$t('admin.reservations_empty')}</p>
      {/if}

      {#if reservationError}
        <p class="admin-status admin-status-error" role="alert">{reservationError}</p>
      {/if}
    </div>
  {/if}

  <!-- Always in the page, so each result is announced (Kimchi may be asleep). -->
  <p class="visually-hidden" role="status">{statusMessage}</p>
</section>
