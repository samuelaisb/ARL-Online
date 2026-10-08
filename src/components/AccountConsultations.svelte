<script module>
  /** B6 nudges shown in this tab (`id:phase`), kept here too in case sessionStorage is blocked. */
  const meetingNudgesShown = new Set();
</script>

<script>
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import {
    bookFollowUpConsultation,
    cancelConsultation,
    fetchAccountConsultations,
    scheduleConsultation,
  } from '../lib/inventory.js';
  import { FOLLOW_UP_NOTE_MAX } from '../lib/expertise-fields.js';
  import { navigate } from '../lib/router.js';
  import { session } from '../lib/auth.js';
  import { compareDateKeys, libraryTodayKey } from '../lib/calendar.js';
  import { addDays, canBookFollowUp, isConsultationHeld } from '../lib/reservation-rules.js';
  import { locale, t } from '../lib/i18n.js';
  import {
    dismiss,
    dismissKind,
    isKimchiAwake,
    notify,
    notifyWhenIdle,
    DEFAULT_NOTIFICATION_DURATION,
  } from '../lib/notification-store.js';
  import {
    hasSeen,
    markSeen,
    readSessionJson,
    readSnapshot,
    writeSessionJson,
    writeSnapshot,
  } from '../lib/kimchi-memory.js';
  import {
    availabilityNow,
    subscribeAvailabilityClock,
    unsubscribeAvailabilityClock,
  } from '../lib/availability-clock.js';
  import MeetingTimePicker, { parseMeetingTimeInput } from './MeetingTimePicker.svelte';
  import { reveal } from '../lib/motion.js';
  import BusyLabel from './BusyLabel.svelte';
  import Skeleton from './Skeleton.svelte';

  const STATUS_ORDER = { pending: 0, reserved: 1, cancelled: 2, refused: 3 };
  const PAST_LIST_IDS = {
    expert: 'account-consultations-expert-past',
    member: 'account-consultations-member-past',
  };

  /** Kimchi's load-time and meeting bubbles from this panel; they leave with it. */
  const PANEL_BUBBLE_KIND = 'account-consultations';
  const PANEL_BUBBLE_DURATION = 8000;
  const LINK_BUBBLE_DURATION = 10000;
  const MEETING_NUDGE_DURATION = 10000;
  /** B6: "starting soon" this long before a meeting, "happening now" this long after it starts. */
  const MEETING_NUDGE_WINDOW_MS = 15 * 60 * 1000;
  /** C8: a member's pending request is mentioned once it has waited this many days. */
  const STILL_WAITING_DAYS = 7;
  /** Per-user snapshot `{ [rowKey]: status }`: what this browser saw last time (B4). */
  const STATUS_SNAPSHOT = 'consultation-statuses';
  /** sessionStorage list of `id:phase` meeting nudges already shown in this tab (B6). */
  const MEETING_NUDGE_SESSION_KEY = 'arl-kimchi-meeting-nudges';

  /**
   * A7: the cancel confirmation by role and by what was cancelled (`role:status` before the
   * cancel). `told` names the other side; `plain` is the same news without that claim.
   */
  const CANCEL_FEEDBACK = {
    'member:pending': {
      told: 'kimchi.consultation_withdrawn',
      plain: 'kimchi.consultation_withdrawn_plain',
      status: 'account_consultations.withdrawn_status',
      toldStatus: 'account_consultations.expert_told_status',
    },
    'member:reserved': {
      told: 'kimchi.consultation_cancelled_member',
      plain: 'kimchi.consultation_cancelled_plain',
      status: 'account_consultations.meeting_cancelled_status',
      toldStatus: 'account_consultations.expert_told_status',
    },
    'expert:pending': {
      told: 'kimchi.consultation_closed_expert',
      plain: 'kimchi.consultation_closed_expert_plain',
      status: 'account_consultations.request_cancelled_status',
      toldStatus: 'account_consultations.member_told_status',
    },
    'expert:reserved': {
      told: 'kimchi.consultation_cancelled_expert',
      plain: 'kimchi.consultation_cancelled_plain',
      status: 'account_consultations.meeting_cancelled_status',
      toldStatus: 'account_consultations.member_told_status',
    },
  };

  let loading = $state(true);
  let loadError = $state('');
  let asMember = $state([]);
  let asExpert = $state([]);
  let meetingTimes = $state({});
  let meetingTimeErrors = $state({});
  const meetingPickers = {};
  // The running request: { id: rowKey(entry), kind: 'schedule' | 'cancel' | 'follow-up' }.
  // Every action button stays disabled while it runs; only the clicked one shows busy.
  let action = $state(null);
  let actionError = $state('');
  let actionErrorId = $state('');
  let showExpertPast = $state(false);
  let showMemberPast = $state(false);
  let followUpOpenId = $state('');
  let followUpTimes = $state({});
  let followUpTimeErrors = $state({});
  let followUpNotes = $state({});
  const followUpPickers = {};
  // F8: schedule and cancel remove the pressed button, and Kimchi may be asleep, so the
  // outcome is announced here and focus moves on (as in AccountReservations).
  let statusMessage = $state('');
  const scheduleButtons = {};
  const cancelButtons = {};
  const followUpButtons = {};
  const titleLinks = {};
  const pastToggles = {};
  /** Row keys someone else cancelled or declined since this browser last looked (B4's inline list). */
  let recentlyClosed = $state([]);
  /** B4 rows whose bubble hasn't shown yet, `{ [rowKey]: status before }`: the snapshot keeps that status so a later visit finds them again. */
  let heldStatuses = {};
  let destroyed = false;
  let meetingNudgeWaiting = false;

  /** One rendered row: the same consultation can be listed under both roles. */
  function rowKey(entry) {
    return `${entry.role}:${entry.id}`;
  }

  function isBusy(entry, kind) {
    return action?.id === rowKey(entry) && action.kind === kind;
  }

  /** Same held rule as the server, which refuses to cancel a meeting that has already ended. */
  function isEntryClosed(entry, now) {
    return entry.status === 'cancelled' || entry.status === 'refused' || isConsultationHeld(entry, now);
  }

  function followUpAllowedFor(entry, now) {
    if (entry.role !== 'expert') {
      return false;
    }

    const member = (entry.memberEmail ?? '').toLowerCase();
    const others = asExpert.filter(
      (other) => other.itemId === entry.itemId && (other.memberEmail ?? '').toLowerCase() === member,
    );
    return canBookFollowUp(entry, others, now);
  }

  /** Closed rows in `recentKeys` stay out of the collapsed Past list, so they're seen this visit. */
  function splitEntries(entries, now, recentKeys) {
    const active = [];
    const recent = [];
    const past = [];

    for (const entry of entries) {
      if (!isEntryClosed(entry, now)) {
        active.push(entry);
      } else if (recentKeys.includes(rowKey(entry))) {
        recent.push(entry);
      } else {
        past.push(entry);
      }
    }

    past.sort((a, b) => {
      const aKey = a.meetingAt ?? a.requestedOn ?? '';
      const bKey = b.meetingAt ?? b.requestedOn ?? '';
      return bKey.localeCompare(aKey);
    });

    return { active: sortEntries(active), recent, past };
  }

  /**
   * B6's inline chip: `soon` when an open scheduled meeting starts within 15 min, `live` from
   * its start until it ends. Null otherwise.
   */
  function meetingTimingFor(entry, now) {
    if (entry.status !== 'reserved' || !entry.meetingAt || isConsultationHeld(entry, now)) {
      return null;
    }

    const start = Date.parse(entry.meetingAt);
    if (Number.isNaN(start) || start - now > MEETING_NUDGE_WINDOW_MS) {
      return null;
    }

    return start <= now
      ? { phase: 'live', start, minutes: 0 }
      : { phase: 'soon', start, minutes: Math.max(1, Math.ceil((start - now) / 60000)) };
  }

  function sortEntries(entries) {
    return [...entries].sort((a, b) => {
      const byStatus = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
      if (byStatus !== 0) {
        return byStatus;
      }
      const aKey = a.meetingAt ?? a.requestedOn ?? '';
      const bKey = b.meetingAt ?? b.requestedOn ?? '';
      return a.status === 'reserved' ? aKey.localeCompare(bKey) : bKey.localeCompare(aKey);
    });
  }

  function formatMeetingTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value ?? '';
    }

    // dateStyle + timeZoneName throws in Chrome and Safari and blanks this list.
    return new Intl.DateTimeFormat($locale === 'fr' ? 'fr-CA' : 'en-CA', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(date);
  }

  function formatDateKey(dateKey) {
    const [year, month, day] = (dateKey ?? '').split('-').map(Number);
    if (!year || !month || !day) {
      return dateKey ?? '';
    }

    return new Intl.DateTimeFormat($locale === 'fr' ? 'fr-CA' : 'en-CA', {
      dateStyle: 'medium',
    }).format(new Date(year, month - 1, day));
  }

  function replaceEntry(updated) {
    const swap = (entries) => entries.map((entry) => (entry.id === updated.id ? { ...entry, ...updated, role: entry.role } : entry));
    asMember = swap(asMember);
    asExpert = swap(asExpert);
  }

  async function load() {
    loading = true;
    loadError = '';

    try {
      const result = await fetchAccountConsultations();
      asMember = result.asMember;
      asExpert = result.asExpert;
    } catch (error) {
      loadError = error.message || $t('account_consultations.load_error');
    } finally {
      loading = false;
    }

    if (!loadError) {
      announceAfterLoad();
    }
  }

  /** F8's status line: what happened, then who was emailed when that's known to be true. */
  function statusLine(key, vars = {}, toldKey = '') {
    return toldKey ? `${$t(key, vars)} ${$t(toldKey)}` : $t(key, vars);
  }

  /** Remember every row's status for this user, so the next visit can tell what changed (B4). */
  function rememberStatuses() {
    const userId = $session?.user?.id;
    if (!userId) {
      return;
    }

    const statuses = {};
    for (const entry of [...asMember, ...asExpert]) {
      const key = rowKey(entry);
      statuses[key] = heldStatuses[key] ?? entry.status;
    }
    writeSnapshot(userId, STATUS_SNAPSHOT, statuses);
  }

  /**
   * B4: rows the other side cancelled, or that were declined, since this browser last saw them
   * pending or scheduled. Empty on the first visit (no snapshot yet) and for the viewer's own cancels.
   */
  function findClosedByOthers(previous) {
    if (!previous || typeof previous !== 'object') {
      return [];
    }

    return [...asMember, ...asExpert].filter((entry) => {
      const before = previous[rowKey(entry)];
      if (before !== 'pending' && before !== 'reserved') {
        return false;
      }
      return (
        entry.status === 'refused' ||
        (entry.status === 'cancelled' && Boolean(entry.cancelledBy) && entry.cancelledBy !== entry.role)
      );
    });
  }

  /** B4's bubble for a closed row. Experts only hear about members' cancels (never named). */
  function closedMessage(entry) {
    if (entry.role === 'member') {
      const byExpert = entry.status === 'cancelled' && entry.cancelledBy === 'expert';
      return {
        textKey: byExpert ? 'kimchi.consultation_cancelled_by_expert' : 'kimchi.consultation_declined',
        vars: { title: entry.itemTitle },
      };
    }

    return entry.status === 'cancelled' && entry.cancelledBy === 'member'
      ? { textKey: 'kimchi.consultation_cancelled_by_member' }
      : null;
  }

  /** C8: the member's oldest pending request that has waited a week and hasn't been mentioned. */
  function oldestWaitingRequest(userId) {
    const today = libraryTodayKey();
    const waiting = asMember.filter((entry) => {
      const due = entry.status === 'pending' ? addDays(entry.requestedOn, STILL_WAITING_DAYS) : '';
      return due && compareDateKeys(due, today) <= 0 && !hasSeen(userId, 'consultation-waiting', entry.id);
    });

    waiting.sort((a, b) => compareDateKeys(a.requestedOn, b.requestedOn));
    return waiting[0] ?? null;
  }

  /** The one load-time bubble after B6, in the order B4 > B5 > C8, with how to remember it. */
  function pickLoadBubble(userId, closedByOthers) {
    for (const entry of closedByOthers) {
      const message = closedMessage(entry);
      if (message && !hasSeen(userId, 'consultation-closed', rowKey(entry))) {
        return {
          message,
          duration: PANEL_BUBBLE_DURATION,
          remember: () => {
            markSeen(userId, 'consultation-closed', rowKey(entry));
            delete heldStatuses[rowKey(entry)];
            rememberStatuses();
          },
        };
      }
    }

    // B5: never reads the member's email, time slots or summary.
    const newRequests = asExpert.filter(
      (entry) => entry.status === 'pending' && !hasSeen(userId, 'consultation-request', entry.id),
    );
    if (newRequests.length > 0) {
      const count = newRequests.length;
      return {
        message: {
          textKey: count === 1 ? 'kimchi.expert_requests_waiting_one' : 'kimchi.expert_requests_waiting_other',
          vars: { count },
        },
        duration: PANEL_BUBBLE_DURATION,
        remember: () => newRequests.forEach((entry) => markSeen(userId, 'consultation-request', entry.id)),
      };
    }

    const waiting = oldestWaitingRequest(userId);
    if (waiting) {
      return {
        message: {
          textKey: 'kimchi.consultation_still_waiting',
          vars: {
            title: waiting.itemTitle,
            // A getter, so the date follows a language switch like the sentence does (S2).
            get date() {
              return formatDateKey(waiting.requestedOn);
            },
          },
          link: {
            href: '/about#contact',
            ctaKey: 'kimchi.consultation_still_waiting_cta',
            labelKey: 'kimchi.consultation_still_waiting_link',
          },
        },
        duration: LINK_BUBBLE_DURATION,
        remember: () => markSeen(userId, 'consultation-waiting', waiting.id),
      };
    }

    return null;
  }

  /** Waits until nothing would hide the bubble; one that lands after the panel is gone is dropped. */
  async function sendPanelBubble(message, duration) {
    const id = await notifyWhenIdle(message, duration, { kind: PANEL_BUBBLE_KIND });
    if (id !== -1 && destroyed) {
      dismiss(id);
      return -1;
    }
    return id;
  }

  /**
   * After the list loads: keep what others closed since the last visit in view (B4's inline
   * list), then at most one Kimchi bubble for this visit, in the order B6 > B4 > B5 > C8.
   */
  async function announceAfterLoad() {
    const userId = $session?.user?.id;
    if (!userId || destroyed) {
      return;
    }

    const previous = readSnapshot(userId, STATUS_SNAPSHOT);
    const closedByOthers = findClosedByOthers(previous);
    recentlyClosed = closedByOthers.map(rowKey);
    // An unannounced B4 row keeps its old status until its bubble really shows (B6 or a busy
    // page can take this visit). Asleep, the inline list is the carrier, so the snapshot moves on.
    heldStatuses = {};
    if (isKimchiAwake()) {
      for (const entry of closedByOthers) {
        const key = rowKey(entry);
        if (closedMessage(entry) && !hasSeen(userId, 'consultation-closed', key)) {
          heldStatuses[key] = previous[key];
        }
      }
    }
    rememberStatuses();

    // A meeting about to start takes this visit's bubble; the clock effect below sends it.
    if (meetingNudgeAt(Date.now())) {
      return;
    }

    const pick = pickLoadBubble(userId, closedByOthers);
    if (pick && (await sendPanelBubble(pick.message, pick.duration)) !== -1) {
      pick.remember();
    }
  }

  function meetingNudgeKey(nudge) {
    return `${nudge.id}:${nudge.phase}`;
  }

  function meetingNudgeShown(nudge) {
    const key = meetingNudgeKey(nudge);
    const shown = readSessionJson(MEETING_NUDGE_SESSION_KEY, []);
    return meetingNudgesShown.has(key) || (Array.isArray(shown) && shown.includes(key));
  }

  function rememberMeetingNudge(nudge) {
    const key = meetingNudgeKey(nudge);
    const shown = readSessionJson(MEETING_NUDGE_SESSION_KEY, []);
    meetingNudgesShown.add(key);
    writeSessionJson(MEETING_NUDGE_SESSION_KEY, [...(Array.isArray(shown) ? shown : []), key].slice(-50));
  }

  /**
   * B6: the earliest meeting with a Zoom link that starts within 15 min or started less than
   * 15 min ago, unless this tab already had its nudge for that phase. Either role.
   */
  function meetingNudgeAt(now) {
    let earliest = null;

    for (const entry of [...asMember, ...asExpert]) {
      const timing = entry.zoomJoinUrl ? meetingTimingFor(entry, now) : null;
      if (!timing || now - timing.start >= MEETING_NUDGE_WINDOW_MS) {
        continue;
      }
      if (!earliest || timing.start < earliest.start) {
        earliest = { ...timing, id: entry.id };
      }
    }

    return earliest && !meetingNudgeShown(earliest) ? earliest : null;
  }

  /** Never puts the Zoom link in the bubble: it points at the row's Join link and chip. */
  async function sendMeetingNudge(nudge) {
    if (meetingNudgeWaiting) {
      return;
    }

    meetingNudgeWaiting = true;
    const id = await sendPanelBubble(
      nudge.phase === 'live'
        ? { textKey: 'kimchi.meeting_live' }
        : { textKey: 'kimchi.meeting_starting_soon', vars: { minutes: nudge.minutes } },
      MEETING_NUDGE_DURATION,
    );
    meetingNudgeWaiting = false;

    if (id !== -1) {
      rememberMeetingNudge(nudge);
    }
  }

  async function handleSchedule(entry) {
    if (action) {
      return;
    }

    const parsed = parseMeetingTimeInput(meetingTimes[entry.id]);
    // iOS doesn't enforce min in its picker, so check for a past time here, before the confirm.
    const timeError = !parsed
      ? $t('account_consultations.meeting_time_required')
      : parsed.getTime() <= Date.now()
        ? $t('account_consultations.meeting_time_past')
        : '';

    meetingTimeErrors[entry.id] = timeError;
    if (timeError) {
      meetingPickers[entry.id]?.focus();
      return;
    }

    actionError = '';
    actionErrorId = '';

    const meetingAt = parsed.toISOString();
    const confirmed = window.confirm(
      $t('account_consultations.schedule_confirm', {
        title: entry.itemTitle,
        email: entry.memberEmail ?? '',
        time: formatMeetingTime(meetingAt),
      }),
    );

    if (!confirmed) {
      return;
    }

    action = { id: rowKey(entry), kind: 'schedule' };
    actionError = '';
    actionErrorId = '';
    statusMessage = '';
    let failed = false;

    try {
      const { consultation, emailSent } = await scheduleConsultation(entry.id, meetingAt);
      replaceEntry(consultation);
      rememberStatuses();
      // Only claim the invitations went out when the server didn't say otherwise.
      const emailed = emailSent !== false;
      statusMessage = statusLine(
        'account_consultations.scheduled_status',
        { time: formatMeetingTime(meetingAt) },
        emailed && 'account_consultations.invitations_sent_status',
      );
      notify(
        { textKey: emailed ? 'kimchi.consultation_scheduled' : 'kimchi.consultation_scheduled_plain' },
        DEFAULT_NOTIFICATION_DURATION,
      );
    } catch (error) {
      failed = true;
      actionErrorId = rowKey(entry);
      actionError = error.message || $t('account_consultations.schedule_error');
    } finally {
      action = null;
    }

    // On success the Schedule button is gone, so focus the row's title; on failure, the button.
    await tick();
    (failed ? scheduleButtons[entry.id] : titleLinks[rowKey(entry)])?.focus();
  }

  async function handleCancel(entry) {
    if (action) {
      return;
    }

    const confirmed = window.confirm(
      entry.role === 'expert'
        ? $t('account_consultations.cancel_confirm_expert', {
            title: entry.itemTitle,
            email: entry.memberEmail ?? '',
          })
        : $t('account_consultations.cancel_confirm_member', { title: entry.itemTitle }),
    );

    if (!confirmed) {
      return;
    }

    const feedback = CANCEL_FEEDBACK[`${entry.role}:${entry.status === 'pending' ? 'pending' : 'reserved'}`];
    action = { id: rowKey(entry), kind: 'cancel' };
    actionError = '';
    actionErrorId = '';
    statusMessage = '';
    let failed = false;

    try {
      const { consultation, emailSent, otherPartyEmailed } = await cancelConsultation(entry.id);
      replaceEntry(consultation);
      rememberStatuses();
      // A mentor may have no email address, so a member hears "{title} has been told" only when
      // the server says so; the member side of a consultation always has one.
      const told =
        emailSent !== false &&
        (entry.role === 'member' ? otherPartyEmailed === true : otherPartyEmailed !== false);
      statusMessage = statusLine(feedback.status, {}, told && feedback.toldStatus);
      notify(
        { textKey: told ? feedback.told : feedback.plain, vars: { title: entry.itemTitle } },
        DEFAULT_NOTIFICATION_DURATION,
      );
    } catch (error) {
      failed = true;
      actionErrorId = rowKey(entry);
      actionError = error.message || $t('account_consultations.cancel_error');
    } finally {
      action = null;
    }

    // On success the row moved to the past list, so focus its toggle; on failure, the button.
    await tick();
    (failed ? cancelButtons[rowKey(entry)] : pastToggles[PAST_LIST_IDS[entry.role]])?.focus();
  }

  function toggleFollowUp(entry) {
    followUpOpenId = followUpOpenId === entry.id ? '' : entry.id;
    if (actionErrorId === rowKey(entry)) {
      actionError = '';
      actionErrorId = '';
    }
  }

  async function handleFollowUp(entry) {
    if (action) {
      return;
    }

    const parsed = parseMeetingTimeInput(followUpTimes[entry.id]);
    const timeError = !parsed
      ? $t('account_consultations.meeting_time_required')
      : parsed.getTime() <= Date.now()
        ? $t('account_consultations.meeting_time_past')
        : '';

    followUpTimeErrors[entry.id] = timeError;
    if (timeError) {
      followUpPickers[entry.id]?.focus();
      return;
    }

    actionError = '';
    actionErrorId = '';

    const meetingAt = parsed.toISOString();
    const confirmed = window.confirm(
      $t('account_consultations.follow_up_confirm', {
        title: entry.itemTitle,
        email: entry.memberEmail ?? '',
        time: formatMeetingTime(meetingAt),
      }),
    );

    if (!confirmed) {
      return;
    }

    action = { id: rowKey(entry), kind: 'follow-up' };
    statusMessage = '';
    let bookedKey = '';

    try {
      const { consultation, emailSent } = await bookFollowUpConsultation(
        entry.id,
        meetingAt,
        followUpNotes[entry.id] ?? '',
      );
      const booked = { ...consultation, role: 'expert' };
      asExpert = [...asExpert, booked];
      bookedKey = rowKey(booked);
      rememberStatuses();
      followUpOpenId = '';
      followUpTimes[entry.id] = '';
      followUpNotes[entry.id] = '';
      const emailed = emailSent !== false;
      statusMessage = statusLine(
        'account_consultations.follow_up_booked_status',
        { time: formatMeetingTime(meetingAt) },
        emailed && 'account_consultations.invitations_sent_status',
      );
      notify(
        { textKey: emailed ? 'kimchi.follow_up_booked' : 'kimchi.follow_up_booked_plain' },
        DEFAULT_NOTIFICATION_DURATION,
      );
    } catch (error) {
      actionErrorId = rowKey(entry);
      actionError = error.message || $t('account_consultations.follow_up_error');
    } finally {
      action = null;
    }

    // On success the form closes, so focus the new meeting's row; on failure, the Book button.
    await tick();
    (bookedKey ? titleLinks[bookedKey] : followUpButtons[entry.id])?.focus();
  }

  function openPath(event, path) {
    event.preventDefault();
    navigate(path);
  }

  onMount(() => {
    subscribeAvailabilityClock();
    load();
  });

  onDestroy(() => {
    destroyed = true;
    unsubscribeAvailabilityClock();
    // "On this page" / "below" stop being true once the panel is gone.
    dismissKind(PANEL_BUBBLE_KIND);
  });

  const now = $derived.by(() => Math.max($availabilityNow, Date.now()));
  const memberLists = $derived(splitEntries(asMember, now, recentlyClosed));
  const expertLists = $derived(splitEntries(asExpert, now, recentlyClosed));

  // B6: the shared minute clock re-checks the window, so a page left open still gets the nudge.
  $effect(() => {
    if (loading || loadError) {
      return;
    }

    const nudge = meetingNudgeAt(now);
    if (nudge) {
      untrack(() => sendMeetingNudge(nudge));
    }
  });
</script>

{#snippet consultationRow(entry)}
  {@const closed = isEntryClosed(entry, now)}
  {@const statusKey = closed && entry.status === 'reserved' ? 'completed' : entry.status}
  {@const followUpAllowed = followUpAllowedFor(entry, now)}
  {@const followUpOpen = followUpAllowed && followUpOpenId === entry.id}
  {@const rowErrorShown = actionError && actionErrorId === rowKey(entry)}
  {@const timing = closed ? null : meetingTimingFor(entry, now)}
  <li
    class="admin-item-row admin-item-row--pending consultation-row"
    class:consultation-row--inactive={closed && !followUpOpen}
  >
    <div class="admin-reservation-details">
      <span class="consultation-row__heading">
        <a
          bind:this={titleLinks[rowKey(entry)]}
          href={entry.itemPath}
          class="consultation-row__title"
          onclick={(event) => openPath(event, entry.itemPath)}
        >
          {entry.itemTitle}
        </a>
        <span class="consultation-status consultation-status--{statusKey}">
          {$t(`account_consultations.status_${statusKey}`)}
        </span>
        {#if entry.isFollowUp}
          <span class="consultation-status consultation-status--follow-up">
            {$t('account_consultations.follow_up_badge')}
          </span>
        {/if}
        {#if timing}
          <!-- B6: Kimchi's "starting soon" nudge, kept on the row for when she's asleep. -->
          <span class="consultation-status consultation-status--{timing.phase}">
            {timing.phase === 'live'
              ? $t('account_consultations.happening_now')
              : $t('account_consultations.starts_in', { minutes: timing.minutes })}
          </span>
        {/if}
      </span>

      {#if entry.status === 'reserved' && entry.meetingAt}
        <span class="consultation-field">
          <span class="consultation-field__label">{$t('account_consultations.meeting_label')}</span>
          <span class="consultation-field__value">{formatMeetingTime(entry.meetingAt)}</span>
        </span>
        {#if entry.zoomJoinUrl}
          <a class="consultation-row__zoom" href={entry.zoomJoinUrl} target="_blank" rel="noopener noreferrer">
            {$t('account_consultations.join_zoom')}
          </a>
          {#if entry.zoomPassword}
            <span class="admin-consultation-detail">
              {$t('account_consultations.passcode', { code: entry.zoomPassword })}
            </span>
          {/if}
        {:else}
          <span class="admin-consultation-detail">{$t('account_consultations.no_zoom_link')}</span>
        {/if}
      {:else}
        <span class="admin-reservation-dates">
          {$t('account_consultations.requested_on', { date: formatDateKey(entry.requestedOn) })}
        </span>
      {/if}

      {#if entry.role === 'expert' && entry.memberEmail}
        <span class="consultation-field">
          <span class="consultation-field__label">{$t('account_consultations.member_label')}</span>
          <span class="consultation-field__value">{entry.memberEmail}</span>
        </span>
      {/if}
      {#if entry.role === 'member' && entry.expertEmail}
        <span class="consultation-field">
          <span class="consultation-field__label">{$t('account_consultations.expert_label')}</span>
          <span class="consultation-field__value">{entry.expertEmail}</span>
        </span>
      {/if}
      {#if entry.timeSlots}
        <span class="consultation-field">
          <span class="consultation-field__label">{$t('account_consultations.slots_label')}</span>
          <span class="consultation-field__value">{entry.timeSlots}</span>
        </span>
      {/if}
      {#if entry.requestSummary}
        <span class="consultation-field">
          <span class="consultation-field__label">
            {$t(entry.isFollowUp ? 'account_consultations.follow_up_note_label' : 'account_consultations.summary_label')}
          </span>
          <span class="consultation-field__value">{entry.requestSummary}</span>
        </span>
      {/if}

      {#if entry.status === 'pending' && entry.role === 'member'}
        <span class="admin-consultation-detail">{$t('account_consultations.pending_member_hint')}</span>
      {/if}
      {#if entry.status === 'cancelled' && entry.cancelledBy}
        <span class="admin-consultation-detail">
          {$t(`account_consultations.cancelled_by_${entry.cancelledBy}`)}
        </span>
      {/if}

      {#if entry.status === 'pending' && entry.role === 'expert'}
        <MeetingTimePicker
          bind:this={meetingPickers[entry.id]}
          bind:value={meetingTimes[entry.id]}
          bind:error={meetingTimeErrors[entry.id]}
          label={$t('account_consultations.meeting_time_label')}
          hint={$t('account_consultations.meeting_time_hint')}
        />
      {/if}

      {#if followUpAllowed}
        <button
          type="button"
          class="btn-header btn-header--secondary consultation-follow-up__toggle"
          aria-expanded={followUpOpen}
          aria-controls="consultation-follow-up-{entry.id}"
          disabled={Boolean(action)}
          onclick={() => toggleFollowUp(entry)}
        >
          {$t(followUpOpen ? 'account_consultations.follow_up_close' : 'account_consultations.follow_up_open')}
        </button>
        {#if followUpOpen}
          <div id="consultation-follow-up-{entry.id}" class="consultation-follow-up">
            <p class="admin-consultation-detail">
              {$t('account_consultations.follow_up_intro', { email: entry.memberEmail ?? '' })}
            </p>
            <MeetingTimePicker
              bind:this={followUpPickers[entry.id]}
              bind:value={followUpTimes[entry.id]}
              bind:error={followUpTimeErrors[entry.id]}
              label={$t('account_consultations.meeting_time_label')}
              hint={$t('account_consultations.meeting_time_hint')}
            />
            <label class="consultation-field__label" for="consultation-follow-up-note-{entry.id}">
              {$t('account_consultations.follow_up_note_input_label')}
            </label>
            <textarea
              id="consultation-follow-up-note-{entry.id}"
              class="consultation-follow-up__note"
              rows="3"
              maxlength={FOLLOW_UP_NOTE_MAX}
              bind:value={followUpNotes[entry.id]}
            ></textarea>
            <div class="admin-pending-actions">
              <button
                bind:this={followUpButtons[entry.id]}
                type="button"
                class="btn-approve"
                disabled={Boolean(action)}
                onclick={() => handleFollowUp(entry)}
              >
                <BusyLabel
                  label={$t('account_consultations.follow_up_book')}
                  busyLabel={$t('account_consultations.follow_up_booking')}
                  busy={isBusy(entry, 'follow-up')}
                />
              </button>
            </div>
            {#if closed && rowErrorShown}
              <p class="admin-status admin-status-error" role="alert">{actionError}</p>
            {/if}
          </div>
        {/if}
      {/if}
    </div>

    {#if !closed}
      <div class="consultation-row__actions">
        <div class="admin-pending-actions">
          {#if entry.status === 'pending' && entry.role === 'expert'}
            <button
              bind:this={scheduleButtons[entry.id]}
              type="button"
              class="btn-approve"
              disabled={Boolean(action)}
              onclick={() => handleSchedule(entry)}
            >
              <BusyLabel
                label={$t('account_consultations.schedule')}
                busyLabel={$t('account_consultations.scheduling')}
                busy={isBusy(entry, 'schedule')}
              />
            </button>
          {/if}
          <button
            bind:this={cancelButtons[rowKey(entry)]}
            type="button"
            class="btn-remove"
            disabled={Boolean(action)}
            onclick={() => handleCancel(entry)}
          >
            <BusyLabel
              label={$t('account_consultations.cancel')}
              busyLabel={$t('account_consultations.cancelling')}
              busy={isBusy(entry, 'cancel')}
            />
          </button>
        </div>
        {#if rowErrorShown}
          <p class="admin-status admin-status-error consultation-row__error" role="alert">{actionError}</p>
        {/if}
      </div>
    {/if}
  </li>
{/snippet}

{#snippet recentConsultations(entries)}
  <!-- B4: cancelled or declined by someone else since the last visit; shown outside the collapsed Past list. -->
  {#if entries.length > 0}
    <h4 class="consultation-recent__heading">{$t('account_consultations.recent_heading')}</h4>
    <ul class="admin-item-list">
      {#each entries as entry (`recent-${entry.role}-${entry.id}`)}
        {@render consultationRow(entry)}
      {/each}
    </ul>
  {/if}
{/snippet}

{#snippet pastConsultations(entries, open, listId, toggle)}
  {#if entries.length > 0}
    <div class="consultation-history">
      <button
        bind:this={pastToggles[listId]}
        type="button"
        class="btn-header btn-header--secondary consultation-history__toggle"
        aria-expanded={open}
        aria-controls={listId}
        onclick={toggle}
      >
        {$t(open ? 'account_consultations.past_hide' : 'account_consultations.past_show')}
        <span class="admin-pending-count">({entries.length})</span>
      </button>
      {#if open}
        <ul id={listId} class="admin-item-list consultation-history__list">
          {#each entries as entry (`past-${entry.role}-${entry.id}`)}
            {@render consultationRow(entry)}
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
{/snippet}

<section class="account-consultations" aria-labelledby="account-consultations-heading">
  <h2 id="account-consultations-heading" class="visually-hidden">{$t('account_consultations.heading')}</h2>
  <p class="visually-hidden" role="status">{statusMessage}</p>

  {#if loading}
    <Skeleton heading label={$t('account_consultations.loading')} />
  {:else if loadError}
    <p class="admin-status admin-status-error" role="alert">{loadError}</p>
  {:else}
    <!-- One wrapper so the whole section reveals once, when the load lands (not on row updates). -->
    <div in:reveal>
      {#if expertLists.active.length > 0 || expertLists.recent.length > 0 || expertLists.past.length > 0}
        <h3 class="admin-subheading">{$t('account_consultations.heading_expert')}</h3>
        {#if expertLists.active.length > 0}
          <ul class="admin-item-list">
            {#each expertLists.active as entry (`expert-${entry.id}`)}
              {@render consultationRow(entry)}
            {/each}
          </ul>
        {:else}
          <p class="admin-status">{$t('account_consultations.active_empty')}</p>
        {/if}
        {@render recentConsultations(expertLists.recent)}
        {@render pastConsultations(
          expertLists.past,
          showExpertPast,
          PAST_LIST_IDS.expert,
          () => (showExpertPast = !showExpertPast),
        )}
      {/if}

      <h3 class="admin-subheading">{$t('account_consultations.heading_member')}</h3>
      {#if memberLists.active.length > 0}
        <ul class="admin-item-list">
          {#each memberLists.active as entry (`member-${entry.id}`)}
            {@render consultationRow(entry)}
          {/each}
        </ul>
      {:else if memberLists.recent.length === 0 && memberLists.past.length === 0}
        <p class="empty-state">
          {$t('account_consultations.member_empty')}
          <a href="/expertise" onclick={(event) => openPath(event, '/expertise')}>
            {$t('account_consultations.browse_expertise')}
          </a>
        </p>
      {:else}
        <p class="admin-status">{$t('account_consultations.active_empty')}</p>
      {/if}
      {@render recentConsultations(memberLists.recent)}
      {@render pastConsultations(
        memberLists.past,
        showMemberPast,
        PAST_LIST_IDS.member,
        () => (showMemberPast = !showMemberPast),
      )}
    </div>
  {/if}
</section>
