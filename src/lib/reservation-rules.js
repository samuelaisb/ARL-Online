/**
 * Tag-specific reservation block rules (shared by client and server).
 * All ranges are inclusive YYYY-MM-DD date strings.
 *
 * Equipment: start Tuesday → end the following Tuesday (+7 days).
 * Books: start Tuesday → end four weeks later (+28 days, also a Tuesday).
 * Rooms: any inclusive date range (no weekday or duration rules).
 */

import { compareDateKeys, parseDateKey, toDateKey } from './calendar.js';

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
  const normalizedTag = tag === 'books' || tag === 'rooms' ? tag : 'equipment';

  if (!parseDateKey(startDate) || !parseDateKey(endDate)) {
    return { ok: false, error: 'Dates must be valid YYYY-MM-DD values.' };
  }

  if (compareDateKeys(startDate, endDate) > 0) {
    return { ok: false, error: 'startDate must be on or before endDate.' };
  }

  if (normalizedTag === 'rooms') {
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
