/**
 * Google Analytics (GA4) beyond page views. The tag loads in `index.html`; App sends the
 * route page views. Never send names or emails: GA forbids personal information.
 */

import { isApathyAdmin, session } from './auth.js';
import { BOOKING_REQUEST_EVENT, bookingRequestParams } from './booking-event.js';

/**
 * localStorage flag set once staff sign in on a browser. The gtag bootstrap in `index.html`
 * reads the same key before `config`, so keep the two in sync.
 */
const INTERNAL_TRAFFIC_KEY = 'arl-ga-internal';

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
