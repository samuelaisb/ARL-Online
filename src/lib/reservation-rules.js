/**
 * Tag-specific reservation block rules (shared by client and server).
 * All ranges are inclusive YYYY-MM-DD date strings.
 *
 * Equipment: start Tuesday → end the following Tuesday (+7 days).
 * Books: start Tuesday → end four weeks later (+28 days, also a Tuesday).
 * Rooms: any inclusive date range (no weekday or duration rules). Members also give the
 *   hours (the same on each day) and what the room is for; see validateRoomRequest.
 * Expertise: no calendar — consultation requests store the submission date
 *   as both start and end, so any valid single date/range passes. A scheduled
 *   consultation is held once its meeting has ended (`isConsultationHeld`).
 */

const FLEXIBLE_TAGS = ['rooms', 'expertise'];

import {
  compareDateKeys,
  libraryTodayKey,
  libraryWallTimeToMs,
  parseDateKey,
  toDateKey,
} from './calendar.js';

export function isFixedBlockTag(tag) {
  return tag === 'equipment' || tag === 'books';
}

export function isTuesday(dateKey) {
  const date = parseDateKey(dateKey);
  return date !== null && date.getDay() === 2;
}

export function addDays(dateKey, days) {
  const date = parseDateKey(dateKey);
  if (!date) {
    return '';
  }

  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return toDateKey(next);
}

export function getBlockEndDate(tag, startDate) {
  if (tag === 'equipment') {
    return addDays(startDate, 7);
  }

  if (tag === 'books') {
    return addDays(startDate, 28);
  }

  return startDate;
}

export function validateReservationDates(tag, startDate, endDate) {
  const normalizedTag =
    tag === 'books' || FLEXIBLE_TAGS.includes(tag) ? tag : 'equipment';

  if (!parseDateKey(startDate) || !parseDateKey(endDate)) {
    return { ok: false, error: 'Dates must be valid YYYY-MM-DD values.' };
  }

  if (compareDateKeys(startDate, endDate) > 0) {
    return { ok: false, error: 'startDate must be on or before endDate.' };
  }

  if (FLEXIBLE_TAGS.includes(normalizedTag)) {
    return { ok: true };
  }

  if (!isTuesday(startDate)) {
    return {
      ok: false,
      error:
        normalizedTag === 'books'
          ? 'Books reservations must start on a Tuesday.'
          : 'Equipment reservations must start on a Tuesday.',
    };
  }

  const expectedEnd = getBlockEndDate(normalizedTag, startDate);
  if (endDate !== expectedEnd) {
    return {
      ok: false,
      error:
        normalizedTag === 'books'
          ? 'Books must be reserved for a four-week block starting on the selected Tuesday.'
          : 'Equipment must be reserved for a one-week block from Tuesday to the following Tuesday.',
    };
  }

  return { ok: true };
}

/** Longest answer to "What will you use the room for?". Stored as reservations.request_summary. */
export const ROOM_PURPOSE_MAX = 1000;

const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes after midnight for a 24-hour `HH:MM` value (what `<input type="time">` gives), or null. */
function timeOfDayMinutes(value) {
  const match = TIME_OF_DAY_PATTERN.exec(typeof value === 'string' ? value.trim() : '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * A room request's hours, stored in reservations.time_slots as `HH:MM-HH:MM` (Montréal wall
 * time, the same hours on each day of the range). Returns `{ start, end }`, or null for rooms
 * booked without hours (staff bookings and requests from before hours were asked).
 */
export function parseRoomTimes(timeSlots) {
  const [start, end, extra] = typeof timeSlots === 'string' ? timeSlots.split('-') : [];
  if (extra !== undefined || timeOfDayMinutes(start) === null || timeOfDayMinutes(end) === null) {
    return null;
  }

  return { start, end };
}

/** "6:30 p.m." (en-CA) or "18 h 30" (fr-CA) for an `HH:MM` value; no time-zone conversion. */
export function formatTimeOfDay(value, localeCode = 'en-CA') {
  const minutes = timeOfDayMinutes(value);
  if (minutes === null) {
    return value ?? '';
  }

  return new Intl.DateTimeFormat(localeCode, { timeStyle: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2000, 0, 1, Math.floor(minutes / 60), minutes % 60)),
  );
}

/**
 * A room reservation's hours for the account and admin lists ("6:00 p.m. to 9:00 p.m.",
 * "… each day" over several days), or '' when it has none. `translate` is the `$t` value.
 */
export function describeRoomTimes(reservation, translate, localeCode) {
  const times = parseRoomTimes(reservation?.timeSlots);
  if (!times) {
    return '';
  }

  const key =
    reservation.startDate === reservation.endDate ? 'calendar.room_times_value' : 'calendar.room_times_value_each_day';
  return translate(key, {
    start: formatTimeOfDay(times.start, localeCode),
    end: formatTimeOfDay(times.end, localeCode),
  });
}

/**
 * Checks a room booking's hours (a member's request, or a host choosing new ones). Returns
 * `{ ok: true, timeSlots }` with the `HH:MM-HH:MM` value to store, or `{ ok: false, code, error }`
 * (`room_times_required`, `room_times_order`).
 */
export function validateRoomTimes({ startTime, endTime } = {}) {
  const start = timeOfDayMinutes(startTime);
  const end = timeOfDayMinutes(endTime);

  if (start === null || end === null) {
    return { ok: false, code: 'room_times_required', error: 'Choose a start and end time for the room.' };
  }

  if (end <= start) {
    return { ok: false, code: 'room_times_order', error: 'The end time must be after the start time.' };
  }

  return { ok: true, timeSlots: `${startTime.trim()}-${endTime.trim()}` };
}

/**
 * Checks the hours and purpose a member gives with a room request. Returns
 * `{ ok: true, timeSlots, purpose }` ready to store, or `{ ok: false, code, error }` with
 * the code the client translates (`calendar.<code>`).
 */
export function validateRoomRequest({ startTime, endTime, purpose }) {
  const times = validateRoomTimes({ startTime, endTime });

  if (!times.ok) {
    return times;
  }

  const text = typeof purpose === 'string' ? purpose.trim() : '';

  if (!text) {
    return { ok: false, code: 'room_purpose_required', error: 'Tell us what you will use the room for.' };
  }

  if (text.length > ROOM_PURPOSE_MAX) {
    return {
      ok: false,
      code: 'room_purpose_too_long',
      error: `What the room is for must be ${ROOM_PURPOSE_MAX} characters or fewer.`,
    };
  }

  return { ok: true, timeSlots: times.timeSlots, purpose: text };
}

/** Consultation meeting length; matches Zoom `CONSULTATION_DURATION_MINUTES` in `src/lib/zoom.js`. */
export const CONSULTATION_MEETING_LENGTH_MS = 60 * 60 * 1000;

/**
 * A scheduled consultation whose meeting has ended (start + 60 min). There is no
 * `completed` status: the row stays `reserved`, and the server and `/account` both read
 * it as held (Completed) from `meetingAt`.
 */
export function isConsultationHeld(reservation, now = Date.now()) {
  if (reservation?.status !== 'reserved' || !reservation.meetingAt) {
    return false;
  }

  const start = Date.parse(reservation.meetingAt);
  return !Number.isNaN(start) && start + CONSULTATION_MEETING_LENGTH_MS <= now;
}

/**
 * Whether the account and admin lists offer **Book a follow-up** on a consultation: it is
 * scheduled and its meeting is today or earlier (Montréal dates, so it shows from the morning of
 * the meeting), it is the member's latest meeting with that expert, and nothing else between
 * them is open. `others` are the same member's other consultations on the same item. The server
 * enforces the day and the "nothing else open" parts, and that the follow-up starts after it.
 */
export function canBookFollowUp(source, others, now = Date.now()) {
  if (source?.status !== 'reserved') {
    return false;
  }

  const start = Date.parse(source.meetingAt ?? '');
  if (
    Number.isNaN(start) ||
    compareDateKeys(libraryTodayKey(new Date(start)), libraryTodayKey(new Date(now))) > 0
  ) {
    return false;
  }

  return !others.some(
    (other) =>
      other.id !== source.id &&
      (other.status === 'pending' ||
        (other.status === 'reserved' &&
          (!isConsultationHeld(other, now) || Date.parse(other.meetingAt ?? '') > start))),
  );
}

/** Longest message a member or host sends about a booking from /account (emailed, never stored). */
export const RESERVATION_MESSAGE_MAX = 2000;

/** The reminder goes out once a booking starts within a day... */
export const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;
/** ...but not in the last hour before it starts, when it would only be noise. */
export const REMINDER_MIN_LEAD_MS = 60 * 60 * 1000;
/** Equipment and book pickups open at 10am (Montréal) on the Tuesday a loan starts. */
export const PICKUP_OPENS_AT = '10:00';

/**
 * When a booking starts (epoch ms), or NaN: a consultation's meeting; a room's first day at its
 * start time (Montréal); a pickup's first day at PICKUP_OPENS_AT, as for a room with no hours.
 */
export function reservationStartsAt(reservation, tag) {
  if (tag === 'expertise') {
    return Date.parse(reservation?.meetingAt ?? '');
  }

  const times = tag === 'rooms' ? parseRoomTimes(reservation?.timeSlots) : null;
  return libraryWallTimeToMs(reservation?.startDate, times ? times.start : PICKUP_OPENS_AT);
}

/** The day-before reminder is due: the start is less than a day away and more than an hour. */
export function isReminderDue(startsAt, now = Date.now()) {
  if (!Number.isFinite(startsAt)) {
    return false;
  }

  const lead = startsAt - now;
  return lead > REMINDER_MIN_LEAD_MS && lead <= REMINDER_LEAD_MS;
}

/**
 * The reservations.reminder_email to write when a booking is confirmed or moved: 'skipped' when
 * it starts within a day (that email is the reminder, and the pass must not send another), else
 * null so the pass sends one the day before.
 */
export function reminderStateFor(startsAt, now = Date.now()) {
  return Number.isFinite(startsAt) && startsAt - now <= REMINDER_LEAD_MS ? 'skipped' : null;
}

/**
 * Cancelled this soon after it was made: a test (or a slip fixed at once), not a request.
 * /admin Stats leaves these out, and the server doesn't send a staff booking's GA event until
 * this long after it was made, and then only if it isn't one.
 */
export const TEST_CANCEL_WINDOW_MS = 60 * 60 * 1000;

/** Cancelled within an hour of being made. Rows from before 009 have no `createdAt`. */
export function isTestCancellation(reservation) {
  if (reservation?.status !== 'cancelled' || !reservation.createdAt || !reservation.cancelledAt) {
    return false;
  }
  const made = Date.parse(reservation.createdAt);
  const cancelled = Date.parse(reservation.cancelledAt);
  return !Number.isNaN(made) && !Number.isNaN(cancelled) && cancelled - made < TEST_CANCEL_WINDOW_MS;
}
