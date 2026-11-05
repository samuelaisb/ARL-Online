import { translateKey } from './i18n.js';
import { supabase, supabaseConfigured } from './supabase.js';

const LEGACY_STORAGE_KEY = 'arl-inventory-items';

// Display order for the category tabs, the homepage links and the admin tag picker.
export const INVENTORY_TAGS = ['expertise', 'equipment', 'books', 'rooms'];
export const DEFAULT_INVENTORY_TAG = 'equipment';

function loadLegacyLocalItems() {
  try {
    const stored = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!stored) {
      return [];
    }

    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function clearLegacyLocalItems() {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // private browsing or storage disabled
  }
}

/** Errors the server tags with a `code`, shown in the reader's language. */
const ERROR_CODE_KEYS = {
  image_too_large: 'add_item.image_too_large',
  image_invalid: 'add_item.image_invalid',
  reservation_rate_limited: 'calendar.rate_limited',
  daily_request_limit: 'calendar.daily_limit',
  pending_request_limit: 'calendar.pending_limit',
  consultation_already_open: 'consultation.already_open',
  consultation_already_held: 'account_consultations.already_held',
  follow_up_not_available: 'account_consultations.follow_up_not_available',
  follow_up_already_open: 'account_consultations.follow_up_already_open',
  follow_up_before_meeting: 'account_consultations.follow_up_before_meeting',
  consultation_reschedule_unavailable: 'account_consultations.reschedule_unavailable',
  consultation_time_unchanged: 'account_consultations.reschedule_unchanged',
  consultation_zoom_failed: 'account_consultations.reschedule_zoom_failed',
  reservation_already_started: 'account_reservations.already_started',
  reservation_not_active: 'account_reservations.not_active',
  reservation_action_limit: 'account_reservations.rate_limited',
  reservation_not_pending: 'account_hosted.not_pending',
  reservation_time_unchanged: 'account_hosted.reschedule_unchanged',
  message_required: 'reservation_message.required',
  message_too_long: 'reservation_message.too_long',
  message_kind_invalid: 'reservation_message.send_error',
  message_not_available: 'reservation_message.not_available',
  message_no_recipient: 'reservation_message.no_recipient',
  message_rate_limited: 'reservation_message.rate_limited',
  thread_rate_limited: 'reservation_message.rate_limited',
  thread_unavailable: 'reservation_message.unavailable',
  account_suspended: 'auth.account_suspended',
  user_protected: 'admin.users_protected_error',
  password_reset_unavailable: 'admin.users_reset_unavailable',
  password_reset_limited: 'admin.users_reset_limited',
  password_reset_failed: 'admin.users_reset_failed',
  user_delete_incomplete: 'admin.users_delete_incomplete',
  user_name_too_long: 'admin.users_name_too_long',
  reservation_email_invalid: 'admin.create_reservation_email_invalid',
  reservation_dates_invalid: 'admin.create_reservation_dates_invalid',
  reservation_dates_past: 'admin.create_reservation_dates_past',
  reservation_dates_too_long: 'admin.create_reservation_dates_too_long',
  reservation_collision: 'admin.create_reservation_collision',
  reservation_account_suspended: 'admin.create_reservation_suspended',
  reservation_meeting_required: 'admin.create_reservation_meeting_required',
  reservation_meeting_past: 'admin.meeting_time_past',
  reservation_consultation_open: 'admin.create_reservation_consultation_open',
  reservation_zoom_failed: 'admin.create_reservation_zoom_failed',
  room_times_required: 'calendar.room_times_required',
  room_times_order: 'calendar.room_times_order',
  room_purpose_required: 'calendar.room_purpose_required',
  room_purpose_too_long: 'calendar.room_purpose_too_long',
};

function apiErrorMessage(result, fallbackKey, code = result.code) {
  const key = ERROR_CODE_KEYS[code];
  return key ? translateKey(key) : result.error || translateKey(fallbackKey);
}

/**
 * A failed admin call, translated like `apiErrorMessage`, with the server's `code` (and the
 * mentor item's `title` for `user_is_mentor`) kept so the caller can word its own message.
 */
function adminApiError(result, fallbackKey) {
  const error = new Error(apiErrorMessage(result, fallbackKey));
  error.code = result.code;
  error.title = result.title;
  return error;
}

function imageWriteErrorMessage(response, result, fallbackKey) {
  // A 413 without JSON comes from a proxy body limit; it is still an oversized photo.
  return apiErrorMessage(
    result,
    fallbackKey,
    result.code || (response.status === 413 ? 'image_too_large' : ''),
  );
}

async function authHeaders(includeJson = false) {
  const headers = {};

  if (includeJson) {
    headers['Content-Type'] = 'application/json';
  }

  if (supabaseConfigured && supabase) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  return headers;
}

export async function fetchInventoryItem(tag, slug) {
  const response = await fetch(
    `/api/inventory/by-slug/${encodeURIComponent(tag)}/${encodeURIComponent(slug)}`,
    { cache: 'no-store' },
  );
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }

    throw new Error(result.error || translateKey('inventory.load_error'));
  }

  return result.item ?? null;
}

export async function fetchInventory() {
  const response = await fetch('/api/inventory');
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || translateKey('inventory.load_error'));
  }

  return Array.isArray(result.items) ? result.items : [];
}

export async function fetchAdminInventory() {
  const response = await fetch('/api/admin/inventory', {
    headers: await authHeaders(),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || translateKey('inventory.load_error'));
  }

  return Array.isArray(result.items) ? result.items : [];
}

export async function createInventoryItem(item) {
  const response = await fetch('/api/inventory', {
    method: 'POST',
    headers: await authHeaders(true),
    body: JSON.stringify(item),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(imageWriteErrorMessage(response, result, 'add_item.save_error'));
  }

  return result.item;
}

export async function fetchMentorProfile() {
  const response = await fetch('/api/account/mentor-profile', {
    headers: await authHeaders(),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(apiErrorMessage(result, 'share_expertise.load_error'));
  }

  return {
    profile: result.profile ?? null,
    emailConfirmed: result.emailConfirmed !== false,
  };
}

function mentorProfileError(response, result) {
  const error = new Error(imageWriteErrorMessage(response, result, 'share_expertise.save_error'));
  error.status = response.status;
  error.profile = result.profile ?? null;
  return error;
}

export async function createMentorProfile(payload) {
  const response = await fetch('/api/account/mentor-profile', {
    method: 'POST',
    headers: await authHeaders(true),
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw mentorProfileError(response, result);
  }

  return result.profile;
}

export async function updateMentorProfile(payload) {
  const response = await fetch('/api/account/mentor-profile', {
    method: 'PATCH',
    headers: await authHeaders(true),
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw mentorProfileError(response, result);
  }

  return result.profile;
}

/**
 * `{ item, handover }`. `handover` is `{ count, emailSent }` when the mentor got a new email
 * address with open consultations (the server emailed it each one), otherwise null.
 */
export async function updateExpertiseItem(id, item) {
  const response = await fetch(`/api/inventory/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: await authHeaders(true),
    body: JSON.stringify(item),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(imageWriteErrorMessage(response, result, 'admin.mentors_save_error'));
  }

  return { item: result.item, handover: result.handover ?? null };
}

export async function deleteInventoryItem(id) {
  const response = await fetch(`/api/inventory/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || translateKey('admin.delete_error'));
  }

  return result;
}

async function migrateLegacyLocalItems() {
  const legacyItems = loadLegacyLocalItems();
  if (legacyItems.length === 0) {
    return [];
  }

  const migratedItems = [];

  for (const legacyItem of legacyItems) {
    try {
      const item = await createInventoryItem(legacyItem);
      migratedItems.push(item);
    } catch (error) {
      console.error('Failed to migrate legacy inventory item:', error);
    }
  }

  clearLegacyLocalItems();
  return migratedItems;
}

export async function loadInventoryItems() {
  let items = await fetchInventory();

  if (items.length === 0) {
    items = await migrateLegacyLocalItems();
  }

  return items;
}

/**
 * Create a reservation request. Payload is either calendar dates
 * ({ startDate, endDate }, plus { startTime, endTime, purpose } for rooms) or a
 * consultation request ({ timeSlots, summary }) for expertise items.
 */
export async function createReservation(itemId, payload) {
  const response = await fetch(`/api/inventory/${encodeURIComponent(itemId)}/reservations`, {
    method: 'POST',
    headers: await authHeaders(true),
    body: JSON.stringify(payload),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(apiErrorMessage(result, 'calendar.create_error'));
  }

  return result;
}

export async function deleteReservation(itemId, reservationId) {
  const response = await fetch(
    `/api/inventory/${encodeURIComponent(itemId)}/reservations/${encodeURIComponent(reservationId)}`,
    { method: 'DELETE', headers: await authHeaders() },
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || translateKey('calendar.delete_error'));
  }

  return result;
}

export async function approveReservation(itemId, reservationId, { meetingAt = null, message = '' } = {}) {
  const body = {
    ...(meetingAt ? { meetingAt } : {}),
    ...(message.trim() ? { message: message.trim() } : {}),
  };
  const response = await fetch(
    `/api/inventory/${encodeURIComponent(itemId)}/reservations/${encodeURIComponent(reservationId)}/approve`,
    Object.keys(body).length > 0
      ? {
          method: 'POST',
          headers: await authHeaders(true),
          body: JSON.stringify(body),
        }
      : { method: 'POST', headers: await authHeaders() },
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || translateKey('admin.approve_reservation_error'));
  }

  return result;
}

/**
 * Admin Create Reservation: books an item for any email, confirmed at once, and emails them.
 * Equipment, books and rooms take `startDate` and `endDate`; a mentor takes `meetingAt` (ISO) and
 * an optional `summary`, and the server schedules the consultation (Zoom, both emailed). Returns
 * `{ item, reservation, emailSent, hasAccount, gaEventQueued }` (`hasAccount` null when the
 * server couldn't tell).
 */
export async function createStaffReservation(
  itemId,
  { email, startDate = '', endDate = '', meetingAt = '', summary = '', message = '' },
) {
  const response = await fetch(`/api/admin/inventory/${encodeURIComponent(itemId)}/reservations`, {
    method: 'POST',
    headers: await authHeaders(true),
    body: JSON.stringify({
      email: email.trim(),
      ...(meetingAt ? { meetingAt } : { startDate, endDate }),
      ...(summary.trim() ? { summary: summary.trim() } : {}),
      ...(message.trim() ? { message: message.trim() } : {}),
    }),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(apiErrorMessage(result, 'admin.create_reservation_error'));
  }

  return result;
}

/** Consultations for the signed-in user: `{ asMember, asExpert }`. */
export async function fetchAccountConsultations() {
  const response = await fetch('/api/account/consultations', {
    headers: await authHeaders(),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(apiErrorMessage(result, 'account_consultations.load_error'));
  }

  return {
    asMember: Array.isArray(result.asMember) ? result.asMember : [],
    asExpert: Array.isArray(result.asExpert) ? result.asExpert : [],
  };
}

/**
 * Expert picks the meeting time; the server creates the Zoom meeting and emails both, with the
 * optional `message` to the member in both emails.
 * Returns `{ consultation, emailSent }`: `emailSent` is false when an invitation didn't go out
 * (undefined if the server didn't say).
 */
export async function scheduleConsultation(reservationId, meetingAt, message = '') {
  const response = await fetch(`/api/consultations/${encodeURIComponent(reservationId)}/schedule`, {
    method: 'POST',
    headers: await authHeaders(true),
    body: JSON.stringify({ meetingAt, message: message.trim() }),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(apiErrorMessage(result, 'account_consultations.schedule_error'));
  }

  return { consultation: result.consultation, emailSent: result.emailSent };
}

/**
 * Expert (or admin) books the next meeting from one that has started. The server creates the
 * follow-up already scheduled (Zoom meeting, invitations to both). Returns `{ consultation,
 * emailSent }`, plus the full `item` when the caller is an admin.
 */
export async function bookFollowUpConsultation(reservationId, meetingAt, note = '') {
  const response = await fetch(`/api/consultations/${encodeURIComponent(reservationId)}/follow-up`, {
    method: 'POST',
    headers: await authHeaders(true),
    body: JSON.stringify({ meetingAt, note }),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(apiErrorMessage(result, 'account_consultations.follow_up_error'));
  }

  return result;
}

/**
 * Member or expert cancels; the server deletes the Zoom meeting and emails both. Returns
 * `{ consultation, emailSent, otherPartyEmailed }`. `emailSent` is false when an email didn't go
 * out. `otherPartyEmailed` is true only when the other side had an address and was emailed (a
 * mentor may have none); it stays undefined until the server sends it.
 */
export async function cancelConsultation(reservationId) {
  const response = await fetch(`/api/consultations/${encodeURIComponent(reservationId)}/cancel`, {
    method: 'POST',
    headers: await authHeaders(),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(apiErrorMessage(result, 'account_consultations.cancel_error'));
  }

  return {
    consultation: result.consultation,
    emailSent: result.emailSent,
    otherPartyEmailed: result.otherPartyEmailed,
  };
}

/**
 * The mentor (or the item's host) moves a scheduled meeting that hasn't started. The server moves
 * the Zoom meeting and emails the new time, with the optional `message` to the member. Returns
 * `{ consultation, emailSent }` like scheduleConsultation.
 */
export async function rescheduleConsultation(reservationId, meetingAt, message = '') {
  const response = await fetch(`/api/consultations/${encodeURIComponent(reservationId)}/reschedule`, {
    method: 'POST',
    headers: await authHeaders(true),
    body: JSON.stringify({ meetingAt, message: message.trim() }),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(apiErrorMessage(result, 'account_consultations.reschedule_error'));
  }

  return { consultation: result.consultation, emailSent: result.emailSent };
}

/**
 * Adds a message to a booking's conversation (any tag) from /account: a member writes to the
 * item's host (`as` 'member'; `kind` 'new_time' marks it as a request for another time), or the
 * host writes to the member (`as` 'owner'). The other side is emailed only when they've read the
 * conversation since the last email. A message that could not be saved throws.
 */
export async function sendReservationMessage(reservationId, { message = '', kind = 'message', as = 'member' } = {}) {
  const response = await fetch(`/api/reservations/${encodeURIComponent(reservationId)}/message`, {
    method: 'POST',
    headers: await authHeaders(true),
    body: JSON.stringify({ message: message.trim(), kind, as }),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(apiErrorMessage(result, 'reservation_message.send_error'));
  }

  // `message`: the saved message as the thread shows it. `notified`: false when the other side
  // already had an unread email about this conversation, so none went out.
  return { message: result.message ?? null, emailSent: result.emailSent, notified: result.notified };
}

/**
 * A booking's conversation, oldest first: `{ id, mine, byStaff, kind, body, createdAt }` each.
 * `as` 'member' (the person who booked) or 'owner' (the host). Opening it marks it read.
 */
export async function fetchReservationMessages(reservationId, as = 'member') {
  const response = await fetch(
    `/api/reservations/${encodeURIComponent(reservationId)}/messages?as=${encodeURIComponent(as)}`,
    { headers: await authHeaders() },
  );
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(apiErrorMessage(result, 'reservation_message.load_error'));
  }

  return Array.isArray(result.messages) ? result.messages : [];
}

/** The signed-in member's equipment, book and room reservations (all statuses but `available`). */
export async function fetchAccountReservations() {
  const response = await fetch('/api/account/reservations', {
    headers: await authHeaders(),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(apiErrorMessage(result, 'account_reservations.load_error'));
  }

  return Array.isArray(result.reservations) ? result.reservations : [];
}

/** Member withdraws a pending request or cancels an approved booking that has not started. */
export async function cancelAccountReservation(reservationId) {
  const response = await fetch(
    `/api/account/reservations/${encodeURIComponent(reservationId)}/cancel`,
    { method: 'POST', headers: await authHeaders() },
  );
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(apiErrorMessage(result, 'account_reservations.cancel_error'));
  }

  return result.reservation;
}

/**
 * Bookings of the equipment, books and rooms the signed-in member hosts (owns), every status but
 * `available`, each with the member's email. Empty for most members.
 */
export async function fetchHostedReservations() {
  const response = await fetch('/api/account/hosted-reservations', {
    headers: await authHeaders(),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(apiErrorMessage(result, 'account_hosted.load_error'));
  }

  return Array.isArray(result.reservations) ? result.reservations : [];
}

/** One host action on a booking of their item; returns `{ reservation, emailSent }`. */
async function postHostedReservationAction(reservationId, action, body, fallbackKey) {
  const response = await fetch(
    `/api/account/hosted-reservations/${encodeURIComponent(reservationId)}/${action}`,
    { method: 'POST', headers: await authHeaders(true), body: JSON.stringify(body) },
  );
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(apiErrorMessage(result, fallbackKey));
  }

  return { reservation: result.reservation, emailSent: result.emailSent };
}

/** Host approves a pending request; the optional `message` goes into the member's email. */
export function approveHostedReservation(reservationId, message = '') {
  return postHostedReservationAction(
    reservationId,
    'approve',
    { message: message.trim() },
    'account_hosted.approve_error',
  );
}

/** Host declines a pending request; the member is emailed. */
export function refuseHostedReservation(reservationId) {
  return postHostedReservationAction(reservationId, 'refuse', {}, 'account_hosted.refuse_error');
}

/**
 * Host gives a pending or upcoming booking new dates (and, for a room, new hours as `HH:MM`;
 * both empty keep a room booked without hours that way). The member is emailed the change.
 */
export function rescheduleHostedReservation(
  reservationId,
  { startDate, endDate, startTime = '', endTime = '', message = '' },
) {
  return postHostedReservationAction(
    reservationId,
    'reschedule',
    { startDate, endDate, startTime, endTime, message: message.trim() },
    'account_hosted.reschedule_error',
  );
}

/** Host cancels a confirmed booking that hasn't ended; the member is emailed. */
export function cancelHostedReservation(reservationId, message = '') {
  return postHostedReservationAction(
    reservationId,
    'cancel',
    { message: message.trim() },
    'account_hosted.cancel_error',
  );
}

export async function refuseReservation(itemId, reservationId) {
  const response = await fetch(
    `/api/inventory/${encodeURIComponent(itemId)}/reservations/${encodeURIComponent(reservationId)}/refuse`,
    { method: 'POST', headers: await authHeaders() },
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || translateKey('admin.refuse_reservation_error'));
  }

  return result;
}

/**
 * Admin Stats: item page views from the view beacon. `{ available: true, today, since30,
 * since60, firstDay, items: [{ itemId, total, last30, last60 }], daily: [{ day, views }] }`
 * (`daily` is the last 30 days, oldest first, zero-filled), or `{ available: false, today }`
 * until migration 009 is applied.
 */
export async function fetchAdminItemViews() {
  const response = await fetch('/api/admin/item-views', {
    headers: await authHeaders(),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw adminApiError(result, 'admin.stats_views_error');
  }

  return {
    ...result,
    available: result.available === true,
    items: Array.isArray(result.items) ? result.items : [],
    daily: Array.isArray(result.daily) ? result.daily : [],
  };
}

/** Admin Members: every account, newest first (the server's AdminUser shape). */
export async function fetchAdminUsers() {
  const response = await fetch('/api/admin/users', {
    headers: await authHeaders(),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw adminApiError(result, 'admin.users_load_error');
  }

  return Array.isArray(result.users) ? result.users : [];
}

/** Sets (or, when empty, clears) a member's display name. Returns the updated user. */
export async function updateAdminUser(id, { name }) {
  const response = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: await authHeaders(true),
    body: JSON.stringify({ name }),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw adminApiError(result, 'admin.users_save_error');
  }

  return result.user;
}

/** Suspends a member's account, or lifts the suspension. Returns the updated user. */
export async function setAdminUserSuspended(id, suspended) {
  const response = await fetch(`/api/admin/users/${encodeURIComponent(id)}/suspend`, {
    method: 'POST',
    headers: await authHeaders(true),
    body: JSON.stringify({ suspended: Boolean(suspended) }),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw adminApiError(result, 'admin.users_suspend_error');
  }

  return result.user;
}

/** Emails a member a link to set a new password. Returns `{ emailSent }`. */
export async function sendAdminUserPasswordReset(id) {
  const response = await fetch(`/api/admin/users/${encodeURIComponent(id)}/password-reset`, {
    method: 'POST',
    headers: await authHeaders(),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw adminApiError(result, 'admin.users_reset_error');
  }

  return { emailSent: result.emailSent };
}

/**
 * Deletes a member's account for good. The server cancels their active bookings first (and
 * emails about them), then strips their email from past ones. Returns `{ success, cancelled,
 * emailSent? }`: `emailSent` is left out when nothing needed an email. A mentor's account
 * fails with `code: 'user_is_mentor'` and the item's `title` on the error.
 */
export async function deleteAdminUser(id) {
  const response = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw adminApiError(result, 'admin.users_delete_error');
  }

  return result;
}
