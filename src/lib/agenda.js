/**
 * /account's agenda (design F): the member's own bookings, the bookings of the items they host
 * and their consultations (both roles), sorted into the page's sections. Pure: no Svelte, no
 * storage, no locale except in the formatting helpers at the end. Checked by
 * `.claude/design-f/checks/agenda-check.mjs`.
 *
 * Sections, in page order:
 * - `needsYou`: what waits on the viewer: a request for one of their items to approve
 *   (`needs: 'approve'`) or a consultation request to pick a time for (`needs: 'pick-time'`).
 * - `waiting`: the member's consultation requests that have no time yet.
 * - `weeks`: the timeline. Own bookings not past, hosted bookings confirmed and not ended,
 *   scheduled consultations not held, plus "Due back" milestones, by day, Sunday-first weeks. The
 *   days are the viewer's own calendar (`timelineTodayKey`, the device's date): a meeting (stored
 *   as an instant) sits on the device's day of its start, so its day and its clock agree wherever
 *   the viewer is; bookings sit on their dates, which are Montréal calendar dates everywhere.
 *   The booking rules (ended, can cancel) keep Montréal's date (`todayKey`), as the server does.
 * - `recent`: consultations closed by the other side since the last visit (B4's `recentKeys`).
 * - `earlier`: everything else that is over, newest first.
 *
 * Every entry has a `key` (`res:<id>` own booking, `host:<id>` booking of the viewer's item,
 * `con:<role>:<id>` consultation; the same id can be under several keys), a `type` ('booking',
 * 'group', 'consultation', 'due'), a `phase` ('pending', 'progress', 'confirmed', 'scheduled',
 * 'due', 'past'; also the `.agenda-node--<phase>` modifier), its `tools` (the More menu, in order)
 * and its `primary` action (the one visible button, or null). Tool ids keep the old components'
 * names: panels 'message', 'new_time', 'reschedule', 'message-mentor', 'new-time',
 * 'message-member', 'follow-up'; confirmations 'withdraw', 'cancel', 'refuse'.
 */

import { compareDateKeys, libraryTodayKey, libraryWallTimeToMs, parseDateKey, toDateKey } from './calendar.js';
import { addDays, canBookFollowUp, PICKUP_OPENS_AT, reservationStartsAt } from './reservation-rules.js';
import { isDeclinedRequest, isEntryClosed, meetingTimingFor, rowKey } from './consultation-notices.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A date with no time (a request day, an end day) sorts at Montréal noon. */
const DATE_SORT_TIME = '12:00';

/** Which tools open a panel in the card and which ask an inline confirmation first. */
export const TOOL_KINDS = {
  message: 'panel',
  new_time: 'panel',
  reschedule: 'panel',
  'message-mentor': 'panel',
  'new-time': 'panel',
  'message-member': 'panel',
  'follow-up': 'panel',
  withdraw: 'confirm',
  cancel: 'confirm',
  refuse: 'confirm',
};

function dateKeyMs(dateKey) {
  return libraryWallTimeToMs(dateKey, DATE_SORT_TIME);
}

/** Whole days from one date key to another (negative when `to` is earlier), or NaN. */
export function daysBetween(from, to) {
  const start = parseDateKey(from);
  const end = parseDateKey(to);
  return start && end ? Math.round((end.getTime() - start.getTime()) / DAY_MS) : NaN;
}

/** The Sunday that starts `dateKey`'s week (as ItemCalendar's grid). */
export function weekStartOf(dateKey) {
  const date = parseDateKey(dateKey);
  return date ? addDays(dateKey, -date.getDay()) : '';
}

function laterDateKey(a, b) {
  return compareDateKeys(a, b) >= 0 ? a : b;
}

function compareTitles(a, b) {
  return String(a.title ?? '').localeCompare(String(b.title ?? '')) || a.key.localeCompare(b.key);
}

// ---------------------------------------------------------------------------------------------
// Bookings: the member's own (AccountReservations) and their items' (AccountHostedReservations).

function hasEnded(row, today) {
  return row.status === 'reserved' && compareDateKeys(row.endDate, today) < 0;
}

// Pending requests stay current whatever their dates: they still count toward the pending cap
// until the member withdraws them or the request is answered.
function isPastReservation(row, today) {
  return row.status === 'refused' || row.status === 'cancelled' || hasEnded(row, today);
}

/** Same rule as the server: pending any time, approved only before its first day. */
function canCancelReservation(row, today) {
  return row.status === 'pending' || (row.status === 'reserved' && compareDateKeys(row.startDate, today) > 0);
}

/** A request to answer, or a confirmed booking that hasn't ended: the host can still act on it. */
function isActiveHosted(row, today) {
  return row.status === 'pending' || (row.status === 'reserved' && !hasEnded(row, today));
}

/**
 * An own booking's More menu, as the server allows: any current booking can write to its host,
 * one that is still a request or hasn't started can also suggest a new time, and Withdraw
 * (pending) or Cancel (confirmed, before its first day) comes last.
 */
export function reservationToolsFor(row, today, now) {
  if (isPastReservation(row, today)) {
    return [];
  }

  const tools =
    row.status === 'pending' || reservationStartsAt(row, row.tag) > now ? ['message', 'new_time'] : ['message'];
  if (canCancelReservation(row, today)) {
    tools.push(row.status === 'pending' ? 'withdraw' : 'cancel');
  }
  return tools;
}

/**
 * A hosted booking's More menu: new dates while it is pending or hasn't ended, a message while it
 * is pending or confirmed (ended ones too) and the member still has an account, Cancel while it
 * is confirmed and current, Decline while it is a request (Approve is its primary button).
 */
export function hostedToolsFor(row, today) {
  const active = isActiveHosted(row, today);
  const tools = [];
  if (active) {
    tools.push('reschedule');
  }
  if (row.memberEmail && (row.status === 'pending' || row.status === 'reserved')) {
    tools.push('message');
  }
  if (active && row.status === 'reserved') {
    tools.push('cancel');
  }
  if (active && row.status === 'pending') {
    tools.push('refuse');
  }
  return tools;
}

/**
 * 'progress' once the booking has really started (reservationStartsAt: a room's start time, a
 * pickup's 10:00, Montréal), not from midnight of its first day: before that it is 'confirmed'
 * and the card says "Starts today". A start that can't be read falls back to the first day.
 */
function bookingPhase(row, today, now) {
  if (row.status === 'pending') {
    return 'pending';
  }
  if (row.status === 'reserved' && !hasEnded(row, today)) {
    const startsAt = reservationStartsAt(row, row.tag);
    const started = Number.isFinite(startsAt) ? startsAt <= now : compareDateKeys(row.startDate, today) <= 0;
    return started ? 'progress' : 'confirmed';
  }
  return 'past';
}

/** `timelineToday`: the viewer's date, where bookings under way and overdue requests sit. */
function bookingEntry(row, source, today, now, timelineToday = today) {
  const phase = bookingPhase(row, today, now);
  const current = source === 'res' ? !isPastReservation(row, today) : isActiveHosted(row, today);
  const needs = source === 'host' && row.status === 'pending' ? 'approve' : null;
  const startsAt = reservationStartsAt(row, row.tag);

  return {
    key: `${source}:${row.id}`,
    type: 'booking',
    source,
    row,
    title: row.title ?? '',
    tag: row.tag,
    startDate: row.startDate,
    endDate: row.endDate,
    status: row.status,
    statusKey: hasEnded(row, today) ? 'ended' : row.status,
    phase: current ? phase : 'past',
    needs,
    // Bookings under way, and requests whose dates have passed, sit on today.
    anchorDay: current && !needs ? laterDateKey(row.startDate, timelineToday) : null,
    sortAt: Number.isFinite(startsAt) ? startsAt : dateKeyMs(row.startDate),
    pastAt: dateKeyMs(row.endDate),
    // Hosted rows that wait on the viewer sort by when they were made.
    requestedAt: Number.isFinite(Date.parse(row.createdAt ?? '')) ? Date.parse(row.createdAt) : dateKeyMs(row.startDate),
    tools: source === 'res' ? reservationToolsFor(row, today, now) : hostedToolsFor(row, today),
    primary: needs ? 'approve' : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Consultations (AccountConsultations), both roles.

/**
 * Book a follow-up (expert rows): the member still has an account, and `canBookFollowUp` against
 * the same member's other consultations on this item (`allExpertRows` is the whole asExpert list).
 */
export function followUpAllowedFor(row, allExpertRows, now) {
  // No member email: the member's account was deleted (admin Members), so there's no one
  // to meet again. Same guard as AdminPanel; the server refuses it too.
  const member = (row.memberEmail ?? '').toLowerCase();
  if (row.role !== 'expert' || !member) {
    return false;
  }

  const others = allExpertRows.filter(
    (other) => other.itemId === row.itemId && (other.memberEmail ?? '').toLowerCase() === member,
  );
  return canBookFollowUp(row, others, now);
}

/**
 * A consultation's More menu, as the server allows. A member's open request or meeting: write
 * to the mentor, suggest a new time until the meeting starts, Cancel. The mentor's (or host's):
 * choose a new time until it starts, book a follow-up (`followUpAllowedFor`), write to the member
 * while it is pending or scheduled (held meetings too), and Cancel (Decline while pending).
 */
export function consultationToolsFor(row, allExpertRows, now) {
  const closed = isEntryClosed(row, now);
  const startsLater = Date.parse(row.meetingAt ?? '') > now;

  if (row.role === 'member') {
    if (closed) {
      return [];
    }
    const tools = row.status === 'pending' || startsLater ? ['message-mentor', 'new-time'] : ['message-mentor'];
    tools.push('cancel');
    return tools;
  }

  const tools = [];
  if (row.status === 'reserved' && startsLater) {
    tools.push('reschedule');
  }
  if (followUpAllowedFor(row, allExpertRows, now)) {
    tools.push('follow-up');
  }
  if (row.memberEmail && (row.status === 'pending' || row.status === 'reserved')) {
    tools.push('message-member');
  }
  if (!closed) {
    tools.push('cancel');
  }
  return tools;
}

/** `today` is the timeline's (the viewer's) date: the card shows the meeting's time in the device's zone. */
function consultationEntry(row, allExpertRows, now, today) {
  const closed = isEntryClosed(row, now);
  const needs = row.role === 'expert' && row.status === 'pending' ? 'pick-time' : null;
  const scheduled = !closed && row.status === 'reserved';
  const meetingMs = Date.parse(row.meetingAt ?? '');
  // The device's day of the meeting, so the rail's date matches the clock on the card (which is
  // in the device's zone); one still running after midnight stays on today.
  const meetingDay = Number.isNaN(meetingMs) ? today : laterDateKey(toDateKey(new Date(meetingMs)), today);

  return {
    key: `con:${rowKey(row)}`,
    type: 'consultation',
    source: 'con',
    role: row.role,
    row,
    title: row.itemTitle ?? '',
    status: row.status,
    // A request the mentor declined reads "Declined" (grey), like one staff refused.
    statusKey: closed && row.status === 'reserved' ? 'completed' : isDeclinedRequest(row) ? 'refused' : row.status,
    phase: closed ? 'past' : scheduled ? 'scheduled' : 'pending',
    closed,
    needs,
    timing: closed ? null : meetingTimingFor(row, now),
    followUpAllowed: followUpAllowedFor(row, allExpertRows, now),
    anchorDay: scheduled ? meetingDay : null,
    sortAt: Number.isNaN(meetingMs) ? dateKeyMs(today) : meetingMs,
    pastAt: Number.isNaN(meetingMs) ? dateKeyMs(row.requestedOn) : meetingMs,
    requestedAt: dateKeyMs(row.requestedOn),
    tools: consultationToolsFor(row, allExpertRows, now),
    primary: needs ? 'schedule' : scheduled && row.zoomJoinUrl ? 'join' : null,
  };
}

// ---------------------------------------------------------------------------------------------
// The timeline: groups, milestones, days and weeks.

function locationKey(location) {
  return location ? [location.name ?? '', location.streetAddress ?? '', location.postalCode ?? ''].join('|') : '';
}

/**
 * Own confirmed bookings on the same day with the same dates (and the same hours and place, and
 * all loans or all rooms) become one card when there are two or more.
 */
function groupBookings(entries) {
  const buckets = new Map();
  const result = [];

  for (const entry of entries) {
    if (entry.type !== 'booking' || entry.source !== 'res' || entry.phase === 'pending') {
      result.push(entry);
      continue;
    }

    const bucketKey = [
      entry.anchorDay,
      entry.startDate,
      entry.endDate,
      entry.phase,
      // Same kind only: the card's meta line names one kind for every item.
      entry.tag,
      entry.row.timeSlots ?? '',
      locationKey(entry.row.location),
    ].join('#');
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, []);
      result.push(bucketKey);
    }
    buckets.get(bucketKey).push(entry);
  }

  const groupKeys = new Set();
  return result.map((item) => {
    if (typeof item !== 'string') {
      return item;
    }

    const items = buckets.get(item).sort(compareTitles);
    if (items.length === 1) {
      return items[0];
    }

    const [first] = items;
    // Stays the same while the group's members change; a second group on the same dates (other
    // hours or place) gets a number.
    const baseKey = `group:${first.startDate}:${first.endDate}:${first.tag === 'rooms' ? 'room' : 'loan'}`;
    let key = baseKey;
    for (let n = 2; groupKeys.has(key); n += 1) {
      key = `${baseKey}:${n}`;
    }
    groupKeys.add(key);

    return {
      key,
      type: 'group',
      source: 'res',
      items,
      title: first.title,
      tag: first.tag,
      startDate: first.startDate,
      endDate: first.endDate,
      status: 'reserved',
      statusKey: 'reserved',
      phase: first.phase,
      needs: null,
      anchorDay: first.anchorDay,
      sortAt: first.sortAt,
      tools: [],
      primary: null,
    };
  });
}

/** "Due back" rows: own loans under way that end after today, one row per end day. */
function dueMilestones(entries, today) {
  const byDay = new Map();

  for (const entry of entries) {
    if (
      entry.type === 'booking' &&
      entry.source === 'res' &&
      entry.phase === 'progress' &&
      entry.tag !== 'rooms' &&
      compareDateKeys(entry.endDate, today) > 0
    ) {
      if (!byDay.has(entry.endDate)) {
        byDay.set(entry.endDate, []);
      }
      byDay.get(entry.endDate).push(entry);
    }
  }

  return [...byDay].map(([endDate, items]) => {
    items.sort(compareTitles);
    const startsAt = libraryWallTimeToMs(endDate, PICKUP_OPENS_AT);
    return {
      key: `due:${endDate}`,
      type: 'due',
      source: 'res',
      items,
      titles: items.map((item) => item.title),
      title: items[0].title,
      endDate,
      phase: 'due',
      needs: null,
      anchorDay: endDate,
      sortAt: Number.isFinite(startsAt) ? startsAt : dateKeyMs(endDate),
      tools: [],
      primary: null,
    };
  });
}

/** Within a day: by start (meeting, room hours or 10:00 pickup), a due row first on a tie, then title. */
function compareInDay(a, b) {
  return (
    a.sortAt - b.sortAt ||
    (a.type === 'due' ? 0 : 1) - (b.type === 'due' ? 0 : 1) ||
    compareTitles(a, b)
  );
}

function buildWeeks(entries, today) {
  if (entries.length === 0) {
    return [];
  }

  const days = new Map([[today, []]]);
  for (const entry of entries) {
    if (!days.has(entry.anchorDay)) {
      days.set(entry.anchorDay, []);
    }
    days.get(entry.anchorDay).push(entry);
  }

  const weeks = new Map();
  for (const dayKey of [...days.keys()].sort(compareDateKeys)) {
    const start = weekStartOf(dayKey);
    if (!weeks.has(start)) {
      weeks.set(start, { key: start, start, end: addDays(start, 6), days: [] });
    }
    weeks.get(start).days.push({
      key: dayKey,
      dayKey,
      isToday: dayKey === today,
      entries: days.get(dayKey).sort(compareInDay),
    });
  }

  return [...weeks.values()];
}

/**
 * Sorts the three account lists into the agenda's sections (see the top of this file).
 * `reservations`, `hosted`, `asMember` and `asExpert` are exactly what fetchAccountReservations,
 * fetchHostedReservations and fetchAccountConsultations return; `now` is epoch ms; `todayKey`
 * Montréal's date (`libraryTodayKey`), for the booking rules; `timelineTodayKey` the device's date
 * (`toDateKey`), for the timeline's days; `recentKeys` B4's row keys (`<role>:<id>`).
 */
export function buildAgenda({
  reservations = [],
  hosted = [],
  asMember = [],
  asExpert = [],
  now = Date.now(),
  todayKey = libraryTodayKey(new Date(now)),
  timelineTodayKey = toDateKey(new Date(now)),
  recentKeys = [],
} = {}) {
  const needsYou = [];
  const waiting = [];
  const upcoming = [];
  const recent = [];
  const earlier = [];

  const place = (entry) => {
    if (entry.needs) {
      needsYou.push(entry);
    } else if (entry.anchorDay) {
      upcoming.push(entry);
    } else if (entry.type === 'consultation' && entry.phase === 'pending') {
      waiting.push(entry);
    } else if (entry.type === 'consultation' && recentKeys.includes(rowKey(entry.row))) {
      recent.push(entry);
    } else {
      earlier.push(entry);
    }
  };

  reservations.forEach((row) => place(bookingEntry(row, 'res', todayKey, now, timelineTodayKey)));
  hosted.forEach((row) => place(bookingEntry(row, 'host', todayKey, now, timelineTodayKey)));
  // The mentor's rows first, as the old page listed them above the member's.
  [...asExpert, ...asMember].forEach((row) => place(consultationEntry(row, asExpert, now, timelineTodayKey)));

  needsYou.sort((a, b) => a.requestedAt - b.requestedAt || compareTitles(a, b));
  waiting.sort((a, b) => a.requestedAt - b.requestedAt || compareTitles(a, b));
  earlier.sort((a, b) => b.pastAt - a.pastAt || compareTitles(a, b));

  const timeline = [...groupBookings(upcoming), ...dueMilestones(upcoming, todayKey)];
  const weeks = buildWeeks(timeline, timelineTodayKey);

  return {
    todayKey,
    timelineTodayKey,
    needsYou,
    waiting,
    weeks,
    recent,
    earlier,
    isEmpty: needsYou.length + waiting.length + timeline.length + recent.length + earlier.length === 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers for the cards and headings.

/** `_one` / `_other` plural key, as the locales spell them. */
export function pluralKey(base, count) {
  return `${base}_${count === 1 ? 'one' : 'other'}`;
}

function intlLocale(locale) {
  return String(locale ?? '').startsWith('fr') ? 'fr-CA' : 'en-CA';
}

/**
 * A week heading: `{ labelKey, vars }` for `$t`. This week and next week name their range
 * ("Nov 1–7"); later weeks their Sunday ("Week of Nov 15"). `locale` is 'en' / 'fr' (or
 * 'en-CA' / 'fr-CA').
 */
export function weekLabelParts(weekStartKey, todayKey, locale = 'en') {
  const localeCode = intlLocale(locale);
  const start = parseDateKey(weekStartKey);
  const end = parseDateKey(addDays(weekStartKey, 6));
  const thisWeek = weekStartOf(todayKey);
  const format = new Intl.DateTimeFormat(localeCode, { month: 'short', day: 'numeric' });

  if (weekStartKey === thisWeek || weekStartKey === addDays(thisWeek, 7)) {
    let range;
    try {
      range = format.formatRange(start, end);
    } catch {
      range = `${format.format(start)} – ${format.format(end)}`;
    }
    return {
      labelKey: weekStartKey === thisWeek ? 'account_agenda.week_this' : 'account_agenda.week_next',
      vars: { range },
    };
  }

  return { labelKey: 'account_agenda.week_of', vars: { date: format.format(start) } };
}

/**
 * The rail and headings for a day: `weekday` ("Thu"), `day` ("5"), `short` ("Thu, Nov 5") and
 * `full` ("Thursday, November 5"). Empty strings for a bad key.
 */
export function dayParts(dayKey, locale = 'en') {
  const localeCode = intlLocale(locale);
  const date = parseDateKey(dayKey);
  if (!date) {
    return { weekday: '', day: '', short: '', full: '' };
  }

  return {
    weekday: new Intl.DateTimeFormat(localeCode, { weekday: 'short' }).format(date),
    day: String(date.getDate()),
    short: new Intl.DateTimeFormat(localeCode, { weekday: 'short', month: 'short', day: 'numeric' }).format(date),
    full: new Intl.DateTimeFormat(localeCode, { weekday: 'long', month: 'long', day: 'numeric' }).format(date),
  };
}

/** A booking (or group) under way: `{ day, total, pct }` ("Day 4 of 8"), or null without dates. */
export function progressFor(entry, todayKey) {
  const total = daysBetween(entry.startDate, entry.endDate) + 1;
  const elapsed = daysBetween(entry.startDate, todayKey) + 1;
  if (!Number.isFinite(total) || !Number.isFinite(elapsed) || total < 1) {
    return null;
  }

  const day = Math.min(Math.max(elapsed, 1), total);
  return { day, total, pct: Math.round((day / total) * 100) };
}

/** "Starts today" / "Starts tomorrow" / "Starts in N days" for a booking, or null once started. */
export function startsInParts(startDate, todayKey) {
  const days = daysBetween(todayKey, startDate);
  if (!Number.isFinite(days) || days < 0) {
    return null;
  }
  if (days === 0) {
    return { labelKey: 'account_agenda.starts_today', vars: {} };
  }
  if (days === 1) {
    return { labelKey: 'account_agenda.starts_tomorrow', vars: {} };
  }
  return { labelKey: pluralKey('account_agenda.starts_in_days', days), vars: { count: days } };
}

/**
 * An entry's main sticker: `{ modifier, labelKey }` (`.consultation-status--<modifier>`), or
 * null for a due row. The follow-up, staff, your-item and timing stickers are the card's.
 */
export function stickerFor(entry) {
  if (entry.type === 'due') {
    return null;
  }
  if (entry.needs) {
    return { modifier: 'needs-you', labelKey: 'account_agenda.sticker_needs_you' };
  }

  if (entry.type === 'consultation') {
    if (entry.statusKey === 'reserved') {
      return { modifier: 'scheduled', labelKey: 'account_consultations.status_reserved' };
    }
    return { modifier: entry.statusKey, labelKey: `account_consultations.status_${entry.statusKey}` };
  }

  if (entry.phase === 'progress') {
    return { modifier: 'progress', labelKey: 'account_agenda.sticker_in_progress' };
  }
  return { modifier: entry.statusKey, labelKey: `account_reservations.status_${entry.statusKey}` };
}

/** B6's chip as a sticker: `{ modifier: 'soon' | 'live', labelKey, vars }`, or null. */
export function timingStickerFor(timing) {
  if (!timing) {
    return null;
  }
  return timing.phase === 'live'
    ? { modifier: 'live', labelKey: 'account_consultations.happening_now', vars: {} }
    : { modifier: 'soon', labelKey: 'account_consultations.starts_in', vars: { minutes: timing.minutes } };
}
