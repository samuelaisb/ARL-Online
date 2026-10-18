/**
 * Google Analytics (GA4) beyond page views. The tag loads in `index.html`; App sends the
 * route page views. Never send names or emails: GA forbids personal information.
 */

import { isApathyAdmin, session } from './auth.js';

/**
 * localStorage flag set once staff sign in on a browser. The gtag bootstrap in `index.html`
 * reads the same key before `config`, so keep the two in sync.
 */
const INTERNAL_TRAFFIC_KEY = 'arl-ga-internal';

const BOOKING_TYPES = { equipment: 'equipment', books: 'book', rooms: 'room', expertise: 'expertise' };

/**
 * `booking_confirmed`, sent once a member's request saves (pending or confirmed at once).
 * Expertise listings are titled with the expert's name, so they send no `listing_name`.
 */
export function trackBookingConfirmed(item) {
  if (typeof window.gtag !== 'function') return;

  const bookingType = BOOKING_TYPES[item?.tag] ?? 'equipment';
  window.gtag('event', 'booking_confirmed', {
    booking_type: bookingType,
    ...(bookingType !== 'expertise' && item?.title ? { listing_name: item.title } : {}),
  });
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
