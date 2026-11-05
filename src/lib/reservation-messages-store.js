import { randomUUID } from 'crypto';
import { getSupabaseAdmin } from './supabase-server.js';

/**
 * The conversation on a booking (016): messages between the member who booked (`member`) and the
 * host (`host`: itemOwnerEmail, or a library admin speaking for the library), plus each side's
 * read and notified times. The server decides who may read or write; this module only stores.
 *
 * Emails: a new message emails the other side only when they have opened the conversation since
 * our last email about it (or never got one), so a run of messages sends one email. The decision
 * and its claim (`notified_at`) happen under a per-booking lock: in-process, so single-instance
 * Cloud Run only, like the item locks.
 */

export const THREAD_SIDES = ['member', 'host'];
export const THREAD_MESSAGE_KINDS = ['message', 'new_time'];

const MISSING_TABLE_CODES = new Set(['PGRST205', '42P01']);
// Ids per `.in()` filter, so a host with many bookings doesn't build an overlong URL.
const IN_CHUNK = 100;

const threadLocks = new Map();
let missingTableLogged = false;

export function otherThreadSide(side) {
  return side === 'member' ? 'host' : 'member';
}

/** 016 isn't applied: either table doesn't exist. */
export function isMissingThreadTable(error) {
  return (
    MISSING_TABLE_CODES.has(error?.code) ||
    (/reservation_message(s|_state)/i.test(error?.message ?? '') &&
      /does not exist|schema cache|could not find/i.test(error?.message ?? ''))
  );
}

function logMissingTableOnce() {
  if (!missingTableLogged) {
    missingTableLogged = true;
    console.warn(
      '[messages] reservation_messages is missing: apply supabase/migrations/016_reservation_messages.sql. ' +
        'The agenda shows no unread counts and messages cannot be sent until then.',
    );
  }
}

/** Thrown when 016 isn't applied, so the route can answer with its own error. */
export class ThreadUnavailableError extends Error {
  constructor() {
    super('Booking conversations are not available yet.');
    this.code = 'thread_unavailable';
  }
}

function fail(error, fallback) {
  if (isMissingThreadTable(error)) {
    logMissingTableOnce();
    throw new ThreadUnavailableError();
  }
  throw new Error(error?.message || fallback);
}

async function withThreadLock(reservationId, fn) {
  let release;
  const waitFor = threadLocks.get(reservationId) ?? Promise.resolve();
  const next = waitFor.then(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  threadLocks.set(reservationId, next);
  await waitFor;
  try {
    return await fn();
  } finally {
    release();
    if (threadLocks.get(reservationId) === next) {
      threadLocks.delete(reservationId);
    }
  }
}

function chunks(values) {
  const out = [];
  for (let index = 0; index < values.length; index += IN_CHUNK) {
    out.push(values.slice(index, index + IN_CHUNK));
  }
  return out;
}

function toMs(value) {
  const ms = Date.parse(value ?? '');
  return Number.isNaN(ms) ? null : ms;
}

function messageRowToApi(row) {
  return {
    id: row.id,
    reservationId: row.reservation_id,
    sender: row.sender,
    byStaff: Boolean(row.by_staff),
    kind: row.kind,
    body: row.body,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

/** The booking's messages, oldest first. */
export async function listReservationMessages(reservationId) {
  const { data, error } = await getSupabaseAdmin()
    .from('reservation_messages')
    .select('id, reservation_id, sender, by_staff, kind, body, created_at')
    .eq('reservation_id', reservationId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });

  if (error) {
    fail(error, 'Could not load the messages.');
  }

  return (data ?? []).map(messageRowToApi);
}

async function loadState(reservationId) {
  const { data, error } = await getSupabaseAdmin()
    .from('reservation_message_state')
    .select('side, read_at, notified_at')
    .eq('reservation_id', reservationId);

  if (error) {
    fail(error, 'Could not load the conversation state.');
  }

  return Object.fromEntries((data ?? []).map((row) => [row.side, row]));
}

/** Upserts one side's state; only the fields given change (merge on the primary key). */
async function saveState(reservationId, side, fields) {
  const { error } = await getSupabaseAdmin()
    .from('reservation_message_state')
    .upsert({ reservation_id: reservationId, side, ...fields }, { onConflict: 'reservation_id,side' });

  if (error) {
    fail(error, 'Could not save the conversation state.');
  }
}

/** `side` has opened the conversation now: its unread count goes to 0 and the next message emails it. */
export async function markThreadRead(reservationId, side, now = Date.now()) {
  await withThreadLock(reservationId, () => saveState(reservationId, side, { read_at: new Date(now).toISOString() }));
}

/**
 * Whether a new message should email `state`'s side: never emailed yet, or they've opened the
 * conversation since the last email.
 */
export function shouldNotify(state) {
  const notifiedAt = toMs(state?.notified_at);
  if (notifiedAt === null) {
    return true;
  }
  const readAt = toMs(state?.read_at);
  return readAt !== null && readAt >= notifiedAt;
}

/**
 * Stores a message from `sender` and decides whether the other side gets an email. The sender
 * has the conversation open, so it also counts as read for them. When `notify` is true the email
 * is already claimed (`notified_at` = now); call releaseNotification if it couldn't be sent.
 * Returns `{ message, notify, previousNotifiedAt }`.
 */
export async function addReservationMessage({ reservationId, sender, byStaff = false, kind = 'message', body, now = Date.now() }) {
  if (!THREAD_SIDES.includes(sender) || !THREAD_MESSAGE_KINDS.includes(kind)) {
    throw new Error('Invalid message.');
  }

  return withThreadLock(reservationId, async () => {
    const createdAt = new Date(now).toISOString();
    const { data, error } = await getSupabaseAdmin()
      .from('reservation_messages')
      .insert({
        id: randomUUID(),
        reservation_id: reservationId,
        sender,
        by_staff: Boolean(byStaff),
        kind,
        body,
        created_at: createdAt,
      })
      .select('id, reservation_id, sender, by_staff, kind, body, created_at')
      .single();

    if (error) {
      fail(error, 'Could not save the message.');
    }

    const recipient = otherThreadSide(sender);
    const state = await loadState(reservationId);
    const notify = shouldNotify(state[recipient]);
    const previousNotifiedAt = state[recipient]?.notified_at ?? null;

    await saveState(reservationId, sender, { read_at: createdAt });
    if (notify) {
      await saveState(reservationId, recipient, { notified_at: createdAt });
    }

    return { message: messageRowToApi(data), notify, previousNotifiedAt };
  });
}

/** The claimed email couldn't be sent: put `notified_at` back, so the next message tries again. */
export async function releaseNotification(reservationId, side, previousNotifiedAt) {
  try {
    await withThreadLock(reservationId, () => saveState(reservationId, side, { notified_at: previousNotifiedAt ?? null }));
  } catch (error) {
    console.error(`[messages] Could not release the email claim on ${reservationId}:`, error?.message || error);
  }
}

/**
 * Unread messages per booking for `side`: messages from the other side newer than its read time.
 * Returns a Map (id → count, only ids with any). An empty Map before 016 or when the lookup
 * fails, so the agenda still loads.
 */
export async function countUnreadMessages(reservationIds, side) {
  const ids = [...new Set((reservationIds ?? []).filter(Boolean))];
  const counts = new Map();

  if (ids.length === 0 || !THREAD_SIDES.includes(side)) {
    return counts;
  }

  try {
    const supabase = getSupabaseAdmin();
    const readAt = new Map();
    const messages = [];

    for (const chunk of chunks(ids)) {
      const [messageResult, stateResult] = await Promise.all([
        supabase
          .from('reservation_messages')
          .select('reservation_id, created_at')
          .in('reservation_id', chunk)
          .eq('sender', otherThreadSide(side)),
        supabase
          .from('reservation_message_state')
          .select('reservation_id, read_at')
          .in('reservation_id', chunk)
          .eq('side', side),
      ]);

      if (messageResult.error || stateResult.error) {
        fail(messageResult.error ?? stateResult.error, 'Could not count unread messages.');
      }

      messages.push(...(messageResult.data ?? []));
      for (const row of stateResult.data ?? []) {
        readAt.set(row.reservation_id, toMs(row.read_at));
      }
    }

    for (const row of messages) {
      const read = readAt.get(row.reservation_id) ?? null;
      const created = toMs(row.created_at);
      if (read === null || (created !== null && created > read)) {
        counts.set(row.reservation_id, (counts.get(row.reservation_id) ?? 0) + 1);
      }
    }
  } catch (error) {
    if (!(error instanceof ThreadUnavailableError)) {
      console.error('[messages] Could not count unread messages:', error?.message || error);
    }
    return new Map();
  }

  return counts;
}

/** Deletes the conversations on these bookings (a deleted account's). Nothing to do before 016. */
export async function deleteReservationThreads(reservationIds) {
  const ids = [...new Set((reservationIds ?? []).filter(Boolean))];
  const supabase = getSupabaseAdmin();

  for (const chunk of chunks(ids)) {
    for (const table of ['reservation_messages', 'reservation_message_state']) {
      const { error } = await supabase.from(table).delete().in('reservation_id', chunk);
      if (error) {
        if (isMissingThreadTable(error)) {
          return;
        }
        throw new Error(error.message || 'Could not delete the conversations.');
      }
    }
  }
}
