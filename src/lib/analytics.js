/**
 * Google Analytics (GA4) beyond page views. The tag loads in `index.html`; App sends the
 * route page views. Never send names or emails: GA forbids personal information.
 */

import { isApathyAdmin, session } from './auth.js';
import { BOOKING_REQUEST_EVENT, bookingRequestParams, bookingTypeOf } from './booking-event.js';

/**
 * localStorage flag set once staff sign in on a browser. The gtag bootstrap in `index.html`
 * reads the same key before `config`, so keep the two in sync.
 */
const INTERNAL_TRAFFIC_KEY = 'arl-ga-internal';

/** Conversion events (both GA4 properties in `index.html` get every event). */
const ACCOUNT_EVENT = 'arl_account';
const REQUEST_EVENT = 'arl_request';
const ACCOUNT_METHODS = new Set(['google', 'discord', 'email']);

/**
 * Sends a GA4 event when the tag loaded (a blocker or no network leaves `window.gtag` unset).
 * Never put emails, names or user ids in `params`: GA forbids personal information.
 */
export function track(name, params) {
  if (typeof window.gtag !== 'function') return;

  window.gtag('event', name, params);
}

/**
 * `arl_account`, sent once when a new account is complete: an email registration that created
 * the account, or the first save of the member agreement by an account from Google or Discord.
 * `auth.js` calls it after the Supabase write succeeds and keeps it to once per account.
 */
export function trackAccountCreated(method) {
  if (!ACCOUNT_METHODS.has(method)) return;

  track(ACCOUNT_EVENT, { method });
}

/**
 * `arl_request`, sent once a member's request saves (Reserve Inventory for equipment, books and
 * rooms; Request Consultation for expertise), next to `booking_request_sent`. `item_id` is the
 * listing's database id; `item_name` is its title, left out for expertise, whose listings are
 * titled with the expert's name. Staff bookings from /admin don't send it.
 */
export function trackRequestSubmitted(item) {
  if (item?.id == null) return;

  const itemType = bookingTypeOf(item);
  track(REQUEST_EVENT, {
    item_type: itemType,
    item_id: String(item.id),
    ...(itemType !== 'expertise' && item.title ? { item_name: item.title } : {}),
  });
}

/**
 * `booking_request_sent`, sent once a request saves: a member's (pending or confirmed at once),
 * or a staff booking from /admin → Create Reservation (`{ bookedByStaff: true }`) when the server
 * didn't queue it (`gaEventQueued` false: GA's Measurement Protocol isn't set up, or migration 013
 * isn't applied). Queued staff bookings are sent by the server an hour later, unless they were a
 * test. Parameters: `bookingRequestParams` in `booking-event.js`.
 */
export function trackBookingRequestSent(item, { bookedByStaff = false } = {}) {
  if (typeof window.gtag !== 'function') return;

  window.gtag('event', BOOKING_REQUEST_EVENT, bookingRequestParams(item, { bookedByStaff }));
}

/**
 * True once staff have signed in on this browser (the `arl-ga-internal` flag), signed in now or
 * not. The item view counter skips these browsers too, so /admin Stats leaves out what GA does.
 */
export function isInternalTrafficBrowser() {
  try {
    return localStorage.getItem(INTERNAL_TRAFFIC_KEY) === '1';
  } catch {
    return false;
  }
}

function markInternalTraffic() {
  try {
    localStorage.setItem(INTERNAL_TRAFFIC_KEY, '1');
  } catch {
    // storage blocked: this page load is still tagged below
  }
  if (typeof window.gtag === 'function') {
    window.gtag('set', { traffic_type: 'internal' });
  }
}

/**
 * Tags staff (@apathyisboring.com) browsers `traffic_type: internal` for GA's Internal Traffic
 * data filter. The flag outlives sign-out on purpose, so staff browsing signed out is left
 * out too. Returns the unsubscribe.
 */
export function tagStaffTraffic() {
  let marked = false;
  return session.subscribe((value) => {
    if (marked || !isApathyAdmin(value)) return;
    marked = true;
    markInternalTraffic();
  });
}
