// Text, date and HTML helpers shared by the emails, calendar invites, Slack messages and routes.
// Pure functions. Server only.

import { parseDateKey } from '../src/lib/calendar.js';
import { locationAreaLine } from '../src/lib/item-location.js';
import { formatTimeOfDay, parseRoomTimes } from '../src/lib/reservation-rules.js';
import { CONSULTATION_TIMEZONE } from '../src/lib/zoom.js';

export function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatMeetingDateTime(meetingAt) {
  const date = new Date(meetingAt);
  if (Number.isNaN(date.getTime())) {
    return typeof meetingAt === 'string' ? meetingAt : '';
  }

  const formatted = new Intl.DateTimeFormat('en-CA', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: CONSULTATION_TIMEZONE,
  }).format(date);
  return `${formatted} (Montreal time)`;
}

export function trimmedOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const READABLE_DATE_FORMAT = new Intl.DateTimeFormat('en-CA', { dateStyle: 'full', timeZone: 'UTC' });

/** `YYYY-MM-DD` → "Tuesday, October 13, 2026" (emails are English). Anything else comes back as given. */
export function formatReadableDate(dateKey) {
  const date = parseDateKey(dateKey);
  if (!date) {
    return dateKey ?? '';
  }

  return READABLE_DATE_FORMAT.format(
    new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12)),
  );
}

/** A reservation's date range for emails and Slack; one date when it starts and ends the same day. */
export function formatReservationDates(reservation) {
  const start = trimmedOrNull(reservation?.startDate);
  const end = trimmedOrNull(reservation?.endDate);

  if (start && end && start !== end) {
    return `${formatReadableDate(start)} to ${formatReadableDate(end)}`;
  }

  return formatReadableDate(start || end || '');
}

/**
 * A room request's hours for emails and Slack ("6:00 p.m. to 9:00 p.m.", "… each day" over
 * several days), or '' when it has none (other items, staff bookings, older requests).
 */
export function formatRoomTimes(item, reservation) {
  const times = item?.tag === 'rooms' ? parseRoomTimes(reservation?.timeSlots) : null;
  if (!times) {
    return '';
  }

  const range = `${formatTimeOfDay(times.start)} to ${formatTimeOfDay(times.end)}`;
  return reservation.startDate !== reservation.endDate ? `${range}, each day` : range;
}

export function consultationTitle(item) {
  return trimmedOrNull(item?.title) ?? 'Consultation';
}

/**
 * A subject line from text that may hold a title or an address someone typed: control characters
 * (a line break above all) become spaces, so the subject stays one line.
 */
export function emailSubject(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

export function bareEmailAddress(address) {
  const match = /<([^>]+)>/.exec(address ?? '');
  return (match ? match[1] : address ?? '').trim();
}

/** "Apathy is Boring\n5310 Boulevard Saint-Laurent\nMontréal QC H2T 1S1": the email's Where row. */
export function itemPlaceLines(location) {
  return [location.name, location.streetAddress, locationAreaLine(location)]
    .filter((line) => typeof line === 'string' && line.trim())
    .join('\n');
}

/** Adds the closing period unless the sentence already ends with one ("… 12:00 p.m."). */
export function endSentence(text) {
  return text.endsWith('.') ? text : `${text}.`;
}
