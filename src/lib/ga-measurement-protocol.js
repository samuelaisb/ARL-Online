/**
 * GA4 Measurement Protocol (server only). Sends a staff booking's `booking_request_sent` from the
 * server about an hour after it was made, so a test cancelled straight after never reaches GA
 * (`sendDueStaffBookingEvents` in `server.js`). Never send names or emails: the payload is built
 * from the item's tag and title only.
 */

import { BOOKING_REQUEST_EVENT, bookingRequestParams } from './booking-event.js';

const MP_COLLECT_URL = 'https://www.google-analytics.com/mp/collect';
const MP_TIMEOUT_MS = 5000;
/**
 * Measurement Protocol needs a client id. One fixed id makes every staff booking the same GA
 * "user", instead of adding a new user per booking. No session id, so no sessions are invented.
 */
const STAFF_BOOKINGS_CLIENT_ID = 'arl-server.staff-bookings';
/** GA accepts events backdated up to 72 hours; the server gives up an hour before that. */
export const GA_BACKDATE_LIMIT_MS = 71 * 60 * 60 * 1000;

function gaEnv() {
  return {
    measurementId: process.env.GA_MEASUREMENT_ID?.trim() || '',
    apiSecret: process.env.GA_API_SECRET?.trim() || '',
  };
}

export function isGaMeasurementProtocolConfigured() {
  const { measurementId, apiSecret } = gaEnv();
  return Boolean(measurementId && apiSecret);
}

/**
 * The request body for one staff booking: `booking_request_sent` with the browser event's
 * parameters, dated when the booking was made (`createdAt`, ISO).
 */
export function staffBookingEventBody({ item, createdAt }) {
  const madeAtMs = Date.parse(createdAt);
  return {
    client_id: STAFF_BOOKINGS_CLIENT_ID,
    timestamp_micros: madeAtMs * 1000,
    non_personalized_ads: true,
    events: [
      { name: BOOKING_REQUEST_EVENT, params: bookingRequestParams(item, { bookedByStaff: true }) },
    ],
  };
}

/**
 * Sends one staff booking's event. Throws when GA can't be reached or answers an error status;
 * GA answers 2xx even to an event it drops (a wrong secret included), so success means sent,
 * not recorded.
 */
export async function sendStaffBookingEvent(booking) {
  const { measurementId, apiSecret } = gaEnv();
  if (!measurementId || !apiSecret) {
    throw new Error('GA_MEASUREMENT_ID and GA_API_SECRET are not set.');
  }

  const url = new URL(MP_COLLECT_URL);
  url.searchParams.set('measurement_id', measurementId);
  url.searchParams.set('api_secret', apiSecret);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(staffBookingEventBody(booking)),
    signal: AbortSignal.timeout(MP_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`GA Measurement Protocol answered ${response.status}`);
  }
}
