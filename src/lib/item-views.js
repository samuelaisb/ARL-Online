/**
 * Item page views for the admin Stats section. App calls `recordItemView` once an item's
 * page has loaded; the server adds one to that item's count for the Montréal day.
 *
 * One view per item, per tab session, per library day: Back/Forward re-opens, reloads and
 * sign-in round trips don't count again. Staff (@apathyisboring.com) and automated
 * browsers are skipped. The request carries no body, no auth header and no cookies.
 */

import { get } from 'svelte/store';
import { authReady, isApathyAdmin, session } from './auth.js';
import { libraryTodayKey } from './calendar.js';
import { readSessionJson, writeSessionJson } from './kimchi-memory.js';

/** sessionStorage: `${dayKey}:${itemId}` for each view already sent this tab session. */
const VIEWS_SESSION_KEY = 'arl-item-views';
const VIEWS_SESSION_LIMIT = 200;
/** Same entries in memory, so a blocked sessionStorage still dedupes until the next reload. */
const viewsRecorded = new Set();

function readRecordedViews() {
  const saved = readSessionJson(VIEWS_SESSION_KEY, []);
  return Array.isArray(saved) ? saved : [];
}

/** Resolves once the session is known (a deep link can load the item before initAuth ends). */
function whenAuthReady() {
  return new Promise((resolve) => {
    let ready = false;
    let unsubscribe = null;

    unsubscribe = authReady.subscribe((value) => {
      if (!value || ready) return;
      ready = true;
      unsubscribe?.();
      resolve();
    });
    // Already ready: the first callback ran before `unsubscribe` was assigned.
    if (ready) unsubscribe();
  });
}

export async function recordItemView(itemId) {
  if (typeof itemId !== 'string' || !itemId) return;
  if (typeof navigator !== 'undefined' && navigator.webdriver) return;

  const entry = `${libraryTodayKey()}:${itemId}`;
  if (viewsRecorded.has(entry) || readRecordedViews().includes(entry)) return;

  // Claim it before waiting, so a second load of the same item meanwhile doesn't send too.
  viewsRecorded.add(entry);
  const entries = readRecordedViews().filter((saved) => saved !== entry);
  entries.push(entry);
  writeSessionJson(VIEWS_SESSION_KEY, entries.slice(-VIEWS_SESSION_LIMIT));

  await whenAuthReady();
  if (isApathyAdmin(get(session))) return;

  fetch(`/api/inventory/${encodeURIComponent(itemId)}/view`, {
    method: 'POST',
    keepalive: true,
    credentials: 'omit',
  }).catch(() => {});
}
