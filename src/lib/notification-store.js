import { get, writable } from 'svelte/store';
import { path } from './router.js';
import { libraryTodayKey } from './calendar.js';
import { isQuietDay } from './kimchi-calendar.js';
import { readJson, readSessionJson, removeKey, writeJson, writeSessionJson } from './kimchi-memory.js';

export const DEFAULT_NOTIFICATION_DURATION = 5000;

/** localStorage `{ since: <ms> }` while Kimchi is asleep; removed when she wakes. */
const ASLEEP_STORAGE_KEY = 'arl-kimchi-asleep';

/** sessionStorage `{ count, lastAt }`: ambient bubbles shown in this tab session. */
const AMBIENT_SESSION_KEY = 'arl-kimchi-ambient';
const AMBIENT_MIN_GAP_MS = 60 * 1000;
const AMBIENT_SESSION_LIMIT = 3;

const IDLE_TIMEOUT_MS = 20000;
const IDLE_POLL_MS = 500;
/** A bubble that waited its turn joins the stack this long after the previous one. */
const STACK_GAP_MS = 1000;

let nextId = 0;
/** When the newest bubble was added (ms), for `notifyWhenIdle`'s stacking gap. */
let lastShownAt = 0;

function readAsleepSince() {
  const saved = readJson(ASLEEP_STORAGE_KEY, null);
  return saved && Number.isFinite(saved.since) ? saved.since : null;
}

/** When Kimchi fell asleep (ms), or null while she's awake. Restored from the last visit. */
let asleepSince = readAsleepSince();
/** When false, `notify()` is a no-op (Kimchi is asleep). */
let kimchiNotificationsEnabled = asleepSince == null;

/** Used when sessionStorage is blocked, so the budget still holds until the next reload. */
let ambientMemory = { count: 0, lastAt: 0 };

const queue = writable([]);

/**
 * Read-only queue of active notifications. `KimchiNotification.svelte` stacks
 * them upward (newest anchored above the avatar).
 */
export const notifications = { subscribe: queue.subscribe };

/**
 * Enable or disable Kimchi chat bubbles (e.g. asleep vs awake). The asleep state is
 * remembered in localStorage, so Kimchi stays asleep on the next visit.
 */
export function setKimchiNotificationsEnabled(enabled) {
  kimchiNotificationsEnabled = enabled;

  if (enabled) {
    asleepSince = null;
    removeKey(ASLEEP_STORAGE_KEY);
    return;
  }

  asleepSince ??= Date.now();
  writeJson(ASLEEP_STORAGE_KEY, { since: asleepSince });
}

/** True while Kimchi is awake (bubbles show). */
export function isKimchiAwake() {
  return kimchiNotificationsEnabled;
}

/** When the current nap started (ms since epoch), or null while Kimchi is awake. */
export function getKimchiAsleepSince() {
  return asleepSince;
}

function readAmbientBudget() {
  const saved = readSessionJson(AMBIENT_SESSION_KEY, null);
  const stored =
    saved && Number.isFinite(saved.count) && Number.isFinite(saved.lastAt) ? saved : null;
  if (!stored) return ambientMemory;

  return {
    count: Math.max(stored.count, ambientMemory.count),
    lastAt: Math.max(stored.lastAt, ambientMemory.lastAt),
  };
}

function recordAmbientShown(counts) {
  const budget = readAmbientBudget();
  ambientMemory = { count: budget.count + (counts ? 1 : 0), lastAt: Date.now() };
  writeSessionJson(AMBIENT_SESSION_KEY, ambientMemory);
}

/**
 * Quiet day, or this tab's 3 ambient bubbles are used up: waiting won't help.
 * `allowOnQuietDay` lifts only the quiet-day block (that day's own calendar line).
 */
function ambientClosedForSession(allowOnQuietDay = false) {
  return (
    (!allowOnQuietDay && isQuietDay(libraryTodayKey())) ||
    readAmbientBudget().count >= AMBIENT_SESSION_LIMIT
  );
}

/** Whether an ambient bubble may show right now (S1 budget). */
function ambientAllowedNow(items, allowOnQuietDay = false) {
  if (ambientClosedForSession(allowOnQuietDay)) return false;
  if (items.some((item) => item.ambient)) return false;

  const age = Date.now() - readAmbientBudget().lastAt;
  return !(age >= 0 && age < AMBIENT_MIN_GAP_MS);
}

/**
 * True when an ambient `notify()` would show right now: Kimchi is awake, it isn't a
 * quiet day, and the tab's ambient budget allows one. Lets a caller skip work (a fetch,
 * a diff) whose only use would be an ambient bubble.
 *
 * @param {{ allowOnQuietDay?: boolean }} [options] Same meaning as in `notify`.
 */
export function isAmbientAllowed({ allowOnQuietDay = false } = {}) {
  return kimchiNotificationsEnabled && ambientAllowedNow(get(queue), allowOnQuietDay);
}

/**
 * Queue a chat-bubble notification from Kimchi.
 *
 * @param {string
 *   | { text?: string, link?: { href: string, cta?: string, label: string } }
 *   | { textKey?: string, vars?: Record<string, unknown>, link?: { href: string, ctaKey?: string, labelKey: string, vars?: Record<string, unknown> } }} message
 *   Prefer the key form: the bubble renders `$t(textKey, vars)`, so it re-translates when the
 *   language changes. Array entries use numeric segments (`'kimchi.taps.2'`). A plain string
 *   or `{ text }` is frozen text (legacy).
 * @param {number} [duration] Auto-dismiss delay in ms (default 5000).
 * @param {{ force?: boolean, ambient?: boolean | 'intro', allowOnQuietDay?: boolean, kind?: string }} [options]
 *   `force`: show while Kimchi is asleep (e.g. sleep "Zzz…").
 *   `ambient`: an unprompted bubble, held to the budget: suppressed while another ambient
 *   bubble is on screen, within 60 s of the last one, after 3 in this tab session, and on
 *   quiet days. `'intro'` (the first-visit greeting and its link) counts toward the budget
 *   but is never blocked by it; an intro shown while another intro is on screen joins it
 *   rather than counting again.
 *   `allowOnQuietDay`: with `ambient: true`, lifts the quiet-day block for this one call
 *   (the day's own calendar line, D14). The rest of the budget still applies, and it counts.
 *   `kind`: a tag stored on the bubble, so `dismissKind(kind)` can remove it later.
 * @returns {number} Notification id (usable with `dismiss`), or -1 when suppressed.
 *   Spend a once-only storage flag only when this is not -1.
 */
export function notify(message, duration = DEFAULT_NOTIFICATION_DURATION, options = {}) {
  if (!kimchiNotificationsEnabled && !options.force) {
    return -1;
  }

  const items = get(queue);
  const ambient = options.ambient === 'intro' ? 'intro' : Boolean(options.ambient);

  if (ambient === true && !ambientAllowedNow(items, options.allowOnQuietDay === true)) {
    return -1;
  }

  if (ambient) {
    const joinsIntro = ambient === 'intro' && items.some((item) => item.ambient === 'intro');
    recordAmbientShown(!joinsIntro);
  }

  const id = ++nextId;
  const content = typeof message === 'string' ? { text: message } : { ...message };

  queue.update((current) => [
    ...current,
    { ...content, id, duration, ambient, kind: options.kind ?? null },
  ]);
  lastShownAt = Date.now();

  return id;
}

function isTabVisible() {
  return document.visibilityState !== 'hidden';
}

/** True while a modal <dialog> is open. `:modal` throws in older browsers. */
function isModalDialogOpen() {
  try {
    return Boolean(document.querySelector('dialog:modal'));
  } catch {
    return Boolean(document.querySelector('dialog[open]'));
  }
}

/**
 * `notify()` once nothing would hide the bubble: no modal dialog is open (bubbles land
 * behind its backdrop) and the tab is visible. It joins the stack like any other bubble,
 * a second after the newest one so waiting bubbles arrive one by one. An ambient bubble
 * also waits for another ambient one on screen to leave (one at a time).
 *
 * @param {Parameters<typeof notify>[0]} message Same shapes as `notify`.
 * @param {number} [duration]
 * @param {{ timeoutMs?: number, cancelOnPathChange?: boolean, force?: boolean, ambient?: boolean | 'intro', allowOnQuietDay?: boolean, kind?: string }} [options]
 *   The `notify` options, plus: `timeoutMs` (default 20000) gives up after that long;
 *   `cancelOnPathChange` (default true) gives up when the page changes while waiting.
 * @returns {Promise<number>} The id, or -1 when suppressed, timed out or cancelled.
 */
export function notifyWhenIdle(message, duration = DEFAULT_NOTIFICATION_DURATION, options = {}) {
  const { timeoutMs = IDLE_TIMEOUT_MS, cancelOnPathChange = true, ...notifyOptions } = options;

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.resolve(-1);
  }

  // Asleep, a quiet day or a spent session budget won't change while we wait.
  if (!kimchiNotificationsEnabled && !notifyOptions.force) return Promise.resolve(-1);
  if (
    notifyOptions.ambient === true &&
    ambientClosedForSession(notifyOptions.allowOnQuietDay === true)
  ) {
    return Promise.resolve(-1);
  }

  return new Promise((resolve) => {
    const startPath = get(path);
    const cleanups = [];
    let settled = false;
    let gapTimer = null;

    function finish(id) {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups) cleanup();
      resolve(id);
    }

    function check() {
      if (settled) return;
      if (isModalDialogOpen() || !isTabVisible()) return;

      const items = get(queue);
      if (notifyOptions.ambient === true && items.some((item) => item.ambient)) return;

      const sinceLast = Date.now() - lastShownAt;
      if (items.length > 0 && sinceLast >= 0 && sinceLast < STACK_GAP_MS) {
        gapTimer ??= setTimeout(() => {
          gapTimer = null;
          check();
        }, STACK_GAP_MS - sinceLast);
        return;
      }

      finish(notify(message, duration, notifyOptions));
    }

    cleanups.push(() => clearTimeout(gapTimer));

    if (cancelOnPathChange) {
      cleanups.push(
        path.subscribe((current) => {
          if (current !== startPath) finish(-1);
        }),
      );
    }

    // Dialogs can also close by unmounting (no `close` event), hence the poll as well.
    const poll = setInterval(check, IDLE_POLL_MS);
    const timeout = setTimeout(() => finish(-1), timeoutMs);
    // `close` doesn't bubble, but a capturing listener on the document still hears it.
    document.addEventListener('close', check, true);
    document.addEventListener('visibilitychange', check);
    cleanups.push(
      () => clearInterval(poll),
      () => clearTimeout(timeout),
      () => document.removeEventListener('close', check, true),
      () => document.removeEventListener('visibilitychange', check),
    );
    // Subscribing runs `check` at once, so an idle page shows the bubble straight away.
    cleanups.push(queue.subscribe(() => queueMicrotask(check)));
  });
}

/** Remove a notification by id (no-op if already gone). */
export function dismiss(id) {
  queue.update((items) => items.filter((item) => item.id !== id));
}

/** Remove every bubble tagged with `kind` (see `notify`'s `options.kind`). */
export function dismissKind(kind) {
  if (!kind) return;
  queue.update((items) => items.filter((item) => item.kind !== kind));
}

/** Drop every queued notification. */
export function clearNotifications() {
  queue.set([]);
}
