/**
 * Kimchi's memory: small per-browser records that keep a bubble from repeating
 * ("already told this member about that request", "already greeted today").
 *
 * Every storage access is wrapped in try/catch (private windows, blocked site data,
 * quota errors), and nothing here may hold titles, names or emails: store ids,
 * statuses, date keys and counts only.
 */

import { libraryTodayKey } from './calendar.js';

/** Each `hasSeen` scope remembers at most this many ids (oldest dropped first). */
const SEEN_LIMIT = 200;

function localStore() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Some browsers throw on the bare `localStorage` getter when site data is blocked.
    return null;
  }
}

function sessionStore() {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function readFrom(store, key, fallback) {
  try {
    const raw = store?.getItem(key);
    if (raw == null) return fallback;
    const value = JSON.parse(raw);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function writeTo(store, key, value) {
  if (!store) return false;
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** True when localStorage can be written right now (a test write, then removed). */
export function storageAvailable() {
  const store = localStore();
  if (!store) return false;
  try {
    const probe = 'arl-kimchi-probe';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/** Parsed JSON from localStorage, or `fallback` when missing, unreadable or blocked. */
export function readJson(key, fallback = null) {
  return readFrom(localStore(), key, fallback);
}

/** Save `value` as JSON in localStorage. Returns false when storage refused it. */
export function writeJson(key, value) {
  return writeTo(localStore(), key, value);
}

export function removeKey(key) {
  try {
    localStore()?.removeItem(key);
  } catch {
    // Blocked storage: nothing was saved, so nothing to remove.
  }
}

/** Parsed JSON from sessionStorage (this tab only), or `fallback`. */
export function readSessionJson(key, fallback = null) {
  return readFrom(sessionStore(), key, fallback);
}

/** Save `value` as JSON in sessionStorage. Returns false when storage refused it. */
export function writeSessionJson(key, value) {
  return writeTo(sessionStore(), key, value);
}

function snapshotKey(userId, name) {
  return `arl-kimchi:${name}:${userId}`;
}

/** A per-user snapshot (e.g. `{ [id]: status }`) saved by `writeSnapshot`, or null. */
export function readSnapshot(userId, name) {
  if (!userId || !name) return null;
  return readJson(snapshotKey(userId, name), null);
}

/** Save a per-user snapshot. Ids, statuses, dates and counts only. Returns false if not saved. */
export function writeSnapshot(userId, name, value) {
  if (!userId || !name) return false;
  return writeJson(snapshotKey(userId, name), value);
}

// A null userId means "this browser, whoever is signed in" (e.g. signed-out visitors).
function seenKey(userId, scope) {
  return `arl-kimchi-seen:${scope}:${userId ?? 'browser'}`;
}

function readSeenIds(userId, scope) {
  const ids = readJson(seenKey(userId, scope), []);
  return Array.isArray(ids) ? ids.map(String) : [];
}

/**
 * Whether `id` was already marked in this scope for this user in this browser. When
 * storage is unavailable this answers true, so a bubble never repeats on every load.
 */
export function hasSeen(userId, scope, id) {
  if (!scope || id == null) return true;
  if (!storageAvailable()) return true;
  return readSeenIds(userId, scope).includes(String(id));
}

/** Remember `id` for this user and scope (the newest 200 ids are kept). Returns false if not saved. */
export function markSeen(userId, scope, id) {
  if (!scope || id == null) return false;
  const value = String(id);
  const ids = readSeenIds(userId, scope).filter((candidate) => candidate !== value);
  ids.push(value);
  return writeJson(seenKey(userId, scope), ids.slice(-SEEN_LIMIT));
}

function dayFlagKey(name) {
  return `arl-kimchi-day:${name}`;
}

/** The Montréal day key (`YYYY-MM-DD`) last saved for `name`, or null. */
export function getDayFlag(name) {
  const value = readJson(dayFlagKey(name), null);
  return typeof value === 'string' ? value : null;
}

/** Save `dayKey` (default: today in Montréal) for `name`. Returns false if not saved. */
export function setDayFlag(name, dayKey = libraryTodayKey()) {
  if (!name || !dayKey) return false;
  return writeJson(dayFlagKey(name), dayKey);
}

/** True when `setDayFlag(name)` already ran today (Montréal). */
export function isDayFlagToday(name, today = libraryTodayKey()) {
  return Boolean(today) && getDayFlag(name) === today;
}
