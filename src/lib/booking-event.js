/**
 * GA4's `booking_request_sent`, shared by the browser (`analytics.js`, gtag) and the server
 * (`ga-measurement-protocol.js`, staff bookings an hour late), so both send the same parameters.
 * Never add names or emails: GA forbids personal information.
 */

export const BOOKING_REQUEST_EVENT = 'booking_request_sent';

const BOOKING_TYPES = {
  equipment: 'equipment',
  books: 'book',
  rooms: 'room',
  expertise: 'expertise',
};
/**
 * Any value but `internal` keeps an event out of GA's Internal Traffic filter. Staff bookings
 * from the browser come from staff browsers, which `set` `traffic_type: internal`; the event's
 * own value wins.
 */
const STAFF_BOOKING_TRAFFIC_TYPE = 'staff_booking';

/**
 * `booking_type` from the item's tag, `booking_source` `member` or `staff`, and `listing_name`
 * (the item's title) except for expertise, whose listings are titled with the expert's name.
 */
export function bookingRequestParams(item, { bookedByStaff = false } = {}) {
  const bookingType = BOOKING_TYPES[item?.tag] ?? 'equipment';
  return {
    booking_type: bookingType,
    booking_source: bookedByStaff ? 'staff' : 'member',
    ...(bookingType !== 'expertise' && item?.title ? { listing_name: item.title } : {}),
    ...(bookedByStaff ? { traffic_type: STAFF_BOOKING_TRAFFIC_TYPE } : {}),
  };
}
