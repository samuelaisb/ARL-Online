/**
 * Kimchi's calendar (D14): 15 Canadian holidays and observances plus three days of
 * remembrance, each with a `kimchi.days.<id>` line. The three days of remembrance are also
 * quiet days: their own sober line is the only ambient bubble Kimchi may show (its notify
 * passes `allowOnQuietDay`); every other ambient bubble stays silent.
 *
 * Pure functions on `YYYY-MM-DD` keys. Pass Montréal's date (`libraryTodayKey()` from
 * calendar.js), not the browser's local one.
 */

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Every id that has a `kimchi.days.<id>` string in both locales. */
export const CALENDAR_DAY_IDS = [
  'new_year',
  'valentines',
  'family_day',
  'st_patricks',
  'easter',
  'victoria_day',
  'indigenous_peoples_day',
  'fete_nationale',
  'canada_day',
  'labour_day',
  'thanksgiving',
  'halloween',
  'holidays',
  'boxing_day',
  'new_years_eve',
  'truth_reconciliation',
  'remembrance_day',
  'violence_against_women',
];

/** Same date every year (`MM-DD`). */
const FIXED_DAYS = {
  '01-01': 'new_year',
  '02-14': 'valentines',
  '03-17': 'st_patricks',
  '06-21': 'indigenous_peoples_day',
  '06-24': 'fete_nationale',
  '07-01': 'canada_day',
  '09-30': 'truth_reconciliation',
  '10-31': 'halloween',
  '11-11': 'remembrance_day',
  '12-06': 'violence_against_women',
  '12-24': 'holidays',
  '12-25': 'holidays',
  '12-26': 'boxing_day',
  '12-31': 'new_years_eve',
};

/**
 * Quiet days (`MM-DD`): National Day for Truth and Reconciliation, Remembrance Day, and
 * the National Day of Remembrance and Action on Violence Against Women. No ambient bubbles
 * except that day's own line.
 */
const QUIET_DAYS = new Set(['09-30', '11-11', '12-06']);

const MONDAY = 1;

function pad(value) {
  return String(value).padStart(2, '0');
}

function toKey(year, month, day) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** `{ year, month, day }` for a real calendar date key, else null. */
function parseKey(dateKey) {
  const match = typeof dateKey === 'string' ? DATE_KEY_RE.exec(dateKey) : null;
  if (!match) return null;

  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;

  return { year, month, day };
}

/** Day of the week (0 = Sunday) in UTC, so the browser's zone and DST never shift it. */
function weekdayOf(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Day of the month of the nth `weekday` (1 = first) in `month`. */
function nthWeekday(year, month, weekday, n) {
  const first = weekdayOf(year, month, 1);
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}

/** Easter Sunday as `YYYY-MM-DD` (Gregorian computus, the "anonymous" algorithm). */
export function easterDateKey(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return toKey(year, month, day);
}

/** Family Day: third Monday of February. */
export function familyDayKey(year) {
  return toKey(year, 2, nthWeekday(year, 2, MONDAY, 3));
}

/** Victoria Day / National Patriots' Day: the Monday on or before May 24. */
export function victoriaDayKey(year) {
  const back = (weekdayOf(year, 5, 24) - MONDAY + 7) % 7;
  return toKey(year, 5, 24 - back);
}

/** Labour Day: first Monday of September. */
export function labourDayKey(year) {
  return toKey(year, 9, nthWeekday(year, 9, MONDAY, 1));
}

/** Thanksgiving (Canada): second Monday of October. */
export function thanksgivingKey(year) {
  return toKey(year, 10, nthWeekday(year, 10, MONDAY, 2));
}

/** The movable days for `year`, as `{ id: 'YYYY-MM-DD' }`. */
export function movableDayKeys(year) {
  return {
    family_day: familyDayKey(year),
    easter: easterDateKey(year),
    victoria_day: victoriaDayKey(year),
    labour_day: labourDayKey(year),
    thanksgiving: thanksgivingKey(year),
  };
}

/** The calendar day id for a date key (e.g. `'canada_day'`), or null on an ordinary day. */
export function calendarDayId(dateKey) {
  const parts = parseKey(dateKey);
  if (!parts) return null;

  const fixed = FIXED_DAYS[`${pad(parts.month)}-${pad(parts.day)}`];
  if (fixed) return fixed;

  const movable = movableDayKeys(parts.year);
  return Object.keys(movable).find((id) => movable[id] === dateKey) ?? null;
}

/** The locale key of Kimchi's line for that day (`'kimchi.days.<id>'`), or null. */
export function calendarLineKey(dateKey) {
  const id = calendarDayId(dateKey);
  return id ? `kimchi.days.${id}` : null;
}

/** True on a quiet day: no ambient bubbles except the day's own calendar line. */
export function isQuietDay(dateKey) {
  const parts = parseKey(dateKey);
  return Boolean(parts) && QUIET_DAYS.has(`${pad(parts.month)}-${pad(parts.day)}`);
}
