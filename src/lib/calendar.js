/**
 * Per-item calendar utilities for reservation availability and collision detection.
 * Dates are stored as ISO date strings (YYYY-MM-DD); ranges are inclusive.
 */

import {
  addDays,
  getBlockEndDate,
  isFixedBlockTag,
  isTuesday,
} from './reservation-rules.js';

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function toDateKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) {
    return '';
  }

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseDateKey(key) {
  if (typeof key !== 'string' || !DATE_KEY_RE.test(key)) {
    return null;
  }

  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(year, month - 1, day);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

export function compareDateKeys(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

const RESERVATION_STATUSES = ['pending', 'reserved', 'refused', 'available'];

export function normalizeReservationStatus(rawStatus) {
  const status = typeof rawStatus === 'string' ? rawStatus.trim().toLowerCase() : '';
  return RESERVATION_STATUSES.includes(status) ? status : 'reserved';
}

export function normalizeReservation(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const startDate = typeof raw.startDate === 'string' ? raw.startDate.trim() : '';
  const endDate = typeof raw.endDate === 'string' ? raw.endDate.trim() : '';
  const status = normalizeReservationStatus(raw.status);
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  const userEmail =
    typeof raw.userEmail === 'string' && raw.userEmail.trim() ? raw.userEmail.trim() : null;

  if (!parseDateKey(startDate) || !parseDateKey(endDate) || compareDateKeys(startDate, endDate) > 0) {
    return null;
  }

  if (!id) {
    return null;
  }

  return { id, startDate, endDate, status, userEmail };
}

export function normalizeReservations(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.map(normalizeReservation).filter(Boolean);
}

/** Approved reservations only — drives the card "Unavailable" badge. */
export function getConfirmedReservations(reservations) {
  return normalizeReservations(reservations).filter((r) => r.status === 'reserved');
}

/** Pending + approved — block calendar dates while awaiting or after approval. */
export function getBlockingReservations(reservations) {
  return normalizeReservations(reservations).filter(
    (r) => r.status === 'pending' || r.status === 'reserved',
  );
}

/** @deprecated Use getBlockingReservations or getConfirmedReservations. */
export function getActiveReservations(reservations) {
  return getBlockingReservations(reservations);
}

export function isDateInRange(dateKey, startDate, endDate) {
  return compareDateKeys(startDate, dateKey) <= 0 && compareDateKeys(dateKey, endDate) <= 0;
}

export function isDateReserved(reservations, dateKey) {
  return getBlockingReservations(reservations).some((r) =>
    isDateInRange(dateKey, r.startDate, r.endDate),
  );
}

export function isCurrentlyReserved(reservations, now = new Date()) {
  const todayKey = toDateKey(now);
  return getConfirmedReservations(reservations).some((r) =>
    isDateInRange(todayKey, r.startDate, r.endDate),
  );
}

/**
 * True when the item has at least one bookable window starting within `days`
 * calendar days from `now` (inclusive: today through today + days).
 * Mirrors ItemCalendar day-select rules per tag.
 */
export function hasAvailabilityWithinDays(
  reservations,
  tag,
  days = 7,
  now = new Date(),
) {
  const normalizedTag = tag === 'books' || tag === 'rooms' ? tag : 'equipment';
  const startKey = toDateKey(now);
  const endKey = addDays(startKey, days);

  if (!startKey || !endKey) {
    return false;
  }

  const blocking = getBlockingReservations(reservations);

  if (isFixedBlockTag(normalizedTag)) {
    for (let cursor = startKey; compareDateKeys(cursor, endKey) <= 0; cursor = addDays(cursor, 1)) {
      if (!cursor) {
        break;
      }

      if (
        isTuesday(cursor) &&
        !hasReservationCollision(blocking, cursor, getBlockEndDate(normalizedTag, cursor))
      ) {
        return true;
      }
    }

    return false;
  }

  for (let cursor = startKey; compareDateKeys(cursor, endKey) <= 0; cursor = addDays(cursor, 1)) {
    if (!cursor) {
      break;
    }

    const blocked = blocking.some((r) => isDateInRange(cursor, r.startDate, r.endDate));
    if (!blocked) {
      return true;
    }
  }

  return false;
}

export function hasReservationCollision(reservations, startDate, endDate, excludeId = null) {
  return getBlockingReservations(reservations).some((reservation) => {
    if (excludeId && reservation.id === excludeId) {
      return false;
    }

    return (
      compareDateKeys(reservation.startDate, endDate) <= 0 &&
      compareDateKeys(startDate, reservation.endDate) <= 0
    );
  });
}

export function isDateInSelection(rangeStart, rangeEnd, dateKey) {
  if (!rangeStart) {
    return false;
  }

  if (!rangeEnd) {
    return dateKey === rangeStart;
  }

  const start = compareDateKeys(rangeStart, rangeEnd) <= 0 ? rangeStart : rangeEnd;
  const end = compareDateKeys(rangeStart, rangeEnd) <= 0 ? rangeEnd : rangeStart;

  return isDateInRange(dateKey, start, end);
}

export function getCalendarMonthGrid(year, month) {
  const firstOfMonth = new Date(year, month, 1);
  const startWeekday = firstOfMonth.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  const weeks = [];
  let currentWeek = [];

  for (let i = startWeekday - 1; i >= 0; i -= 1) {
    const day = daysInPrevMonth - i;
    const date = new Date(year, month - 1, day);
    currentWeek.push({
      date,
      dateKey: toDateKey(date),
      inCurrentMonth: false,
    });
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month, day);
    currentWeek.push({
      date,
      dateKey: toDateKey(date),
      inCurrentMonth: true,
    });

    if (currentWeek.length === 7) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
  }

  if (currentWeek.length > 0) {
    let nextDay = 1;
    while (currentWeek.length < 7) {
      const date = new Date(year, month + 1, nextDay);
      currentWeek.push({
        date,
        dateKey: toDateKey(date),
        inCurrentMonth: false,
      });
      nextDay += 1;
    }
    weeks.push(currentWeek);
  }

  return weeks;
}

export function getWeekdayLabels(locale = 'en-CA') {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(2024, 0, 7 + index);
    return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date);
  });
}

export function formatMonthYear(year, month, locale = 'en-CA') {
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(
    new Date(year, month, 1),
  );
}
