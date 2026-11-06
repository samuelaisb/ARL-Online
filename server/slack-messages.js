// What the server posts to the Slack workflow trigger: the request message and the 14 keys every
// post carries. Pure functions. server.js posts them (postSlackWorkflow). docs/automated-webhooks.md
// describes the payload. Server only.

import { toDateKey } from '../src/lib/calendar.js';
import { formatReservationDates, formatRoomTimes } from './format.js';
import { absoluteSiteUrl } from './site.js';

const SLACK_REQUEST_KIND = { equipment: 'equipment', books: 'book', rooms: 'room' };

const SLACK_ALERT_EMOJI = {
  member_signed_up: '👋',
  mentor_profile_published: '🧑‍🏫',
  mentor_profile_updated: '✏️',
  reservation_cancelled_by_member: '↩️',
  consultation_follow_up: '🔁',
};

/**
 * The whole Slack message for a new request, sent as `message` so the workflow shows only
 * `{message}`. Plain text with line breaks: the workflow does not format variables.
 */
function reservationSlackMessage(item, reservation) {
  const from = `From ${reservation.userEmail || 'an unknown member'}`;

  if (item.tag === 'expertise') {
    return [
      `📚 New consultation request: ${item.title}`,
      from,
      reservation.requestSummary ? `Topic: ${reservation.requestSummary}` : '',
      reservation.timeSlots ? `Availability: ${reservation.timeSlots}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const kind = SLACK_REQUEST_KIND[item.tag] ?? 'reservation';
  const roomTimes = formatRoomTimes(item, reservation);
  return [
    `📚 New ${kind} request: ${item.title}`,
    from,
    formatReservationDates(reservation),
    roomTimes ? `Times: ${roomTimes}` : '',
    item.tag === 'rooms' && reservation.requestSummary ? `For: ${reservation.requestSummary}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The post for a new request: the message plus the 14 keys the workflow trigger expects. */
export function buildSlackReservationPayload({ item, reservation }) {
  return {
    message: reservationSlackMessage(item, reservation),
    item_id: item.id,
    item_title: item.title,
    item_body: item.body,
    item_tag: item.tag,
    reservation_id: reservation.id,
    start_date: reservation.startDate,
    end_date: reservation.endDate,
    status: reservation.status,
    user_email: reservation.userEmail ?? '',
    time_slots: reservation.timeSlots ?? '',
    request_summary: reservation.requestSummary ?? '',
    expert_email: item.expertEmail ?? '',
    admin_url: absoluteSiteUrl('/admin'),
  };
}

/**
 * A staff alert through the same Slack workflow trigger, so it sends exactly the
 * buildSlackReservationPayload keys (unused ones ''). `status` names the event (e.g.
 * 'mentor_profile_published') and `summary` is the sentence staff read, sent as `message`
 * (after the event's emoji) and as `request_summary`. Pass `reservation` when the alert is about
 * one reservation or consultation; its id and dates fill `reservation_id`, `start_date` and
 * `end_date` (otherwise both dates are today).
 */
export function buildSlackAlertPayload({ status, item, userEmail, summary, reservation = null }) {
  const today = toDateKey(new Date());

  return {
    message: `${SLACK_ALERT_EMOJI[status] ?? '📣'} ${summary}`,
    item_id: item?.id ?? '',
    item_title: item?.title ?? '',
    item_body: item?.body ?? '',
    item_tag: item?.tag ?? '',
    reservation_id: reservation?.id ?? '',
    start_date: reservation?.startDate || today,
    end_date: reservation?.endDate || today,
    status,
    user_email: userEmail ?? '',
    time_slots: '',
    request_summary: summary,
    expert_email: item?.expertEmail ?? '',
    admin_url: absoluteSiteUrl('/admin'),
  };
}
