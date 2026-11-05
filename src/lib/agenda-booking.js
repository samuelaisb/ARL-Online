/**
 * AgendaBookingCard's rules, carried over unchanged from AccountReservations and
 * AccountHostedReservations so the card stays readable: which bookings are current, the tool
 * labels, and the host's "Choose new dates" draft and its checks. Pure: no Svelte, no locale
 * (the card translates the keys).
 */

import { compareDateKeys, parseDateKey } from './calendar.js';
import { addDays, parseRoomTimes, validateRoomTimes } from './reservation-rules.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The member's message tools on their own booking: the form's text, then what confirms it. */
export const RESERVATION_TOOL_PANELS = {
  message: {
    label: 'account_reservations.message_label',
    hint: 'account_reservations.message_hint',
    placeholder: '',
    status: 'reservation_message.sent_status',
    kimchi: 'kimchi.message_sent',
  },
  new_time: {
    label: 'account_reservations.suggest_label',
    hint: 'account_reservations.suggest_hint',
    placeholder: 'account_reservations.suggest_placeholder',
    status: 'reservation_message.suggested_status',
    kimchi: 'kimchi.time_suggestion_sent',
  },
};

/** The More menu's labels, per side of the booking (agenda.js lists which tools a row has). */
export const BOOKING_TOOL_LABELS = {
  res: {
    message: 'account_reservations.message_host',
    new_time: 'account_reservations.suggest_time',
    withdraw: 'account_reservations.withdraw',
    cancel: 'account_reservations.cancel',
  },
  host: {
    reschedule: 'account_hosted.reschedule_open',
    message: 'account_hosted.message_member',
    cancel: 'account_hosted.cancel',
    refuse: 'account_agenda.decline_request',
  },
};

/** Who cancelled a booking of the viewer's item, as the host reads it. Unknown values show nothing. */
export const CANCELLED_BY_KEYS = {
  member: 'account_consultations.cancelled_by_member',
  admin: 'account_consultations.cancelled_by_admin',
  owner: 'account_hosted.cancelled_by_you',
};

/** A card's element id for an agenda key (`res:12` → `agenda-res-12`); its panels add to it. */
export function agendaDomId(key) {
  return `agenda-${String(key ?? '').replace(/[^A-Za-z0-9_-]+/g, '-')}`;
}

export function hasEnded(row, today) {
  return row.status === 'reserved' && compareDateKeys(row.endDate, today) < 0;
}

/** A request to answer, or a confirmed booking that hasn't ended: the host can still act on it. */
export function isActiveHosted(row, today) {
  return row.status === 'pending' || (row.status === 'reserved' && !hasEnded(row, today));
}

/** Same rule as the server: pending any time, approved only before its first day. */
export function canCancelReservation(row, today) {
  return row.status === 'pending' || (row.status === 'reserved' && compareDateKeys(row.startDate, today) > 0);
}

/** "Choose new dates" starts from the booking as it is, so moving it is a small edit. */
export function rescheduleDraftFor(row) {
  const times = row.tag === 'rooms' ? parseRoomTimes(row.timeSlots) : null;
  return {
    startDate: row.startDate ?? '',
    endDate: row.endDate ?? '',
    startTime: times?.start ?? '',
    endTime: times?.end ?? '',
  };
}

/** A new start date keeps the booking's length, so a move is one field. Changes `draft`. */
export function moveDraftStart(draft, value) {
  const start = parseDateKey(draft.startDate);
  const end = parseDateKey(draft.endDate);
  const length = start && end ? Math.round((end.getTime() - start.getTime()) / DAY_MS) : -1;

  draft.startDate = value;
  if (parseDateKey(value) && length >= 0) {
    draft.endDate = addDays(value, length);
  }
}

/**
 * Checks new dates with the server's staff-booking rules (any dates, the start on or before the
 * end, not all past) and a room's hours. Returns `{ datesError, timesError }` as i18n keys ('' when
 * fine; `timesError` is `calendar.<code>`) and what to send: `startDate`, `endDate`, `startTime`,
 * `endTime`, plus the `timeSlots` the booking would get (for the confirmation's dates).
 */
export function checkHostedReschedule(row, draft, todayKey) {
  const startDate = draft.startDate?.trim() ?? '';
  const endDate = draft.endDate?.trim() ?? '';
  let datesError = '';
  let timesError = '';

  if (!parseDateKey(startDate) || !parseDateKey(endDate)) {
    datesError = 'admin.create_reservation_dates_required';
  } else if (compareDateKeys(startDate, endDate) > 0) {
    datesError = 'admin.create_reservation_dates_invalid';
  } else if (compareDateKeys(endDate, todayKey) < 0) {
    datesError = 'admin.create_reservation_dates_past';
  }

  // Rooms: new hours, or none when the booking had none and both fields stay empty.
  let startTime = '';
  let endTime = '';
  let timeSlots = row.timeSlots ?? null;
  if (row.tag === 'rooms') {
    startTime = draft.startTime?.trim() ?? '';
    endTime = draft.endTime?.trim() ?? '';
    if (startTime || endTime || parseRoomTimes(row.timeSlots)) {
      const times = validateRoomTimes({ startTime, endTime });
      timeSlots = times.ok ? times.timeSlots : timeSlots;
      timesError = times.ok ? '' : `calendar.${times.code}`;
    } else {
      timeSlots = null;
    }
  }

  if (
    !datesError &&
    !timesError &&
    startDate === row.startDate &&
    endDate === row.endDate &&
    (row.tag !== 'rooms' || timeSlots === (row.timeSlots ?? null))
  ) {
    datesError = 'account_hosted.reschedule_unchanged';
  }

  return { datesError, timesError, startDate, endDate, startTime, endTime, timeSlots };
}
