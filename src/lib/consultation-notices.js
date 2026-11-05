/**
 * The pure parts of /account's consultation notices (no Svelte, no storage): which rows count as
 * closed, held or recently closed by the other side (B4), the meeting timing chip and nudge (B6),
 * and which one load-time Kimchi bubble a visit gets (B4 > B5 > C8). The agenda reads, writes and
 * marks the browser memory (`kimchi-memory.js`) itself and passes the answers in as functions.
 */

import { compareDateKeys } from './calendar.js';
import { addDays, isConsultationHeld } from './reservation-rules.js';

/** Kimchi's load-time and meeting bubbles from the consultations; they leave with the page. */
export const PANEL_BUBBLE_KIND = 'account-consultations';
export const PANEL_BUBBLE_DURATION = 8000;
export const LINK_BUBBLE_DURATION = 10000;
export const MEETING_NUDGE_DURATION = 10000;
/** B6: "starting soon" this long before a meeting, "happening now" this long after it starts. */
export const MEETING_NUDGE_WINDOW_MS = 15 * 60 * 1000;
/** C8: a member's pending request is mentioned once it has waited this many days. */
export const STILL_WAITING_DAYS = 7;
/** Per-user snapshot `{ [rowKey]: status }`: what this browser saw last time (B4). */
export const STATUS_SNAPSHOT = 'consultation-statuses';
/** sessionStorage list of `id:phase` meeting nudges already shown in this tab (B6). */
export const MEETING_NUDGE_SESSION_KEY = 'arl-kimchi-meeting-nudges';

const STATUS_ORDER = { pending: 0, reserved: 1, cancelled: 2, refused: 3 };

/** One consultation row: the same consultation can be listed under both roles. */
export function rowKey(entry) {
  return `${entry.role}:${entry.id}`;
}

/**
 * A request the mentor's side closed before any time was set: the mentor (or the host of a
 * mentor with no address, `expert` or `admin`) used **Decline request**, which the server records
 * as `cancelled` with no `meetingAt`. Shown as declined, like a request staff refused.
 */
export function isDeclinedRequest(entry) {
  return (
    entry?.status === 'cancelled' &&
    !entry.meetingAt &&
    (entry.cancelledBy === 'expert' || entry.cancelledBy === 'admin')
  );
}

/** Same held rule as the server, which refuses to cancel a meeting that has already ended. */
export function isEntryClosed(entry, now) {
  return entry.status === 'cancelled' || entry.status === 'refused' || isConsultationHeld(entry, now);
}

/**
 * B6's inline chip: `soon` when an open scheduled meeting starts within 15 min, `live` from
 * its start until it ends. Null otherwise.
 */
export function meetingTimingFor(entry, now) {
  if (entry.status !== 'reserved' || !entry.meetingAt || isConsultationHeld(entry, now)) {
    return null;
  }

  const start = Date.parse(entry.meetingAt);
  if (Number.isNaN(start) || start - now > MEETING_NUDGE_WINDOW_MS) {
    return null;
  }

  return start <= now
    ? { phase: 'live', start, minutes: 0 }
    : { phase: 'soon', start, minutes: Math.max(1, Math.ceil((start - now) / 60000)) };
}

/** Open rows first: pending (newest request first), then scheduled (soonest first). */
export function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    const byStatus = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    if (byStatus !== 0) {
      return byStatus;
    }
    const aKey = a.meetingAt ?? a.requestedOn ?? '';
    const bKey = b.meetingAt ?? b.requestedOn ?? '';
    return a.status === 'reserved' ? aKey.localeCompare(bKey) : bKey.localeCompare(aKey);
  });
}

/** Closed rows in `recentKeys` stay out of the collapsed past list, so they're seen this visit. */
export function splitEntries(entries, now, recentKeys) {
  const active = [];
  const recent = [];
  const past = [];

  for (const entry of entries) {
    if (!isEntryClosed(entry, now)) {
      active.push(entry);
    } else if (recentKeys.includes(rowKey(entry))) {
      recent.push(entry);
    } else {
      past.push(entry);
    }
  }

  past.sort((a, b) => {
    const aKey = a.meetingAt ?? a.requestedOn ?? '';
    const bKey = b.meetingAt ?? b.requestedOn ?? '';
    return bKey.localeCompare(aKey);
  });

  return { active: sortEntries(active), recent, past };
}

/**
 * Every row's status for the snapshot (B4), `{ [rowKey]: status }`. A row in `heldStatuses`
 * keeps the status it had before, so a later visit finds it again until its bubble shows.
 */
export function statusSnapshot(entries, heldStatuses = {}) {
  const statuses = {};
  for (const entry of entries) {
    const key = rowKey(entry);
    statuses[key] = heldStatuses[key] ?? entry.status;
  }
  return statuses;
}

/**
 * B4: rows the other side cancelled, or that were declined, since this browser last saw them
 * pending or scheduled. Empty on the first visit (no snapshot yet) and for the viewer's own cancels.
 */
export function findClosedByOthers(entries, previous) {
  if (!previous || typeof previous !== 'object') {
    return [];
  }

  return entries.filter((entry) => {
    const before = previous[rowKey(entry)];
    if (before !== 'pending' && before !== 'reserved') {
      return false;
    }
    return (
      entry.status === 'refused' ||
      (entry.status === 'cancelled' && Boolean(entry.cancelledBy) && entry.cancelledBy !== entry.role)
    );
  });
}

/** B4's bubble for a closed row. Experts only hear about members' cancels (never named). */
export function closedMessage(entry) {
  if (entry.role === 'member') {
    // A declined request (no meeting yet) gets the "didn't go ahead" line, as a refused one does.
    const byExpert = entry.status === 'cancelled' && entry.cancelledBy === 'expert' && !isDeclinedRequest(entry);
    return {
      textKey: byExpert ? 'kimchi.consultation_cancelled_by_expert' : 'kimchi.consultation_declined',
      vars: { title: entry.itemTitle },
    };
  }

  return entry.status === 'cancelled' && entry.cancelledBy === 'member'
    ? { textKey: 'kimchi.consultation_cancelled_by_member' }
    : null;
}

/**
 * The B4 rows whose bubble hasn't shown yet, `{ [rowKey]: status before }`. Only while Kimchi
 * is awake: asleep, the inline list is the carrier, so the snapshot moves on.
 * `isSeen(scope, id)` is `hasSeen` for the signed-in user.
 */
export function heldStatusesFor(closedByOthers, previous, isSeen) {
  const held = {};
  for (const entry of closedByOthers) {
    const key = rowKey(entry);
    if (closedMessage(entry) && !isSeen('consultation-closed', key)) {
      held[key] = previous[key];
    }
  }
  return held;
}

/** C8: the member's oldest pending request that has waited a week and hasn't been mentioned. */
export function oldestWaitingRequest(asMember, todayKey, isSeen) {
  const waiting = asMember.filter((entry) => {
    const due = entry.status === 'pending' ? addDays(entry.requestedOn, STILL_WAITING_DAYS) : '';
    return due && compareDateKeys(due, todayKey) <= 0 && !isSeen('consultation-waiting', entry.id);
  });

  waiting.sort((a, b) => compareDateKeys(a.requestedOn, b.requestedOn));
  return waiting[0] ?? null;
}

/**
 * The one load-time bubble after B6, in the order B4 > B5 > C8, or null. Returns
 * `{ kind: 'closed' | 'requests' | 'waiting', message, duration, seen: { scope, ids } }`: once the
 * bubble really shows, mark each of `seen.ids` in `seen.scope`, and for `closed` also drop
 * `heldStatuses[seen.ids[0]]` and save the snapshot again. `formatDate(dateKey)` dates C8's
 * request; it is read through a getter, so the date follows a language switch like the sentence (S2).
 */
export function pickLoadBubble({ closedByOthers, asMember, asExpert, todayKey, isSeen, formatDate }) {
  for (const entry of closedByOthers) {
    const message = closedMessage(entry);
    if (message && !isSeen('consultation-closed', rowKey(entry))) {
      return {
        kind: 'closed',
        message,
        duration: PANEL_BUBBLE_DURATION,
        seen: { scope: 'consultation-closed', ids: [rowKey(entry)] },
      };
    }
  }

  // B5: never reads the member's email, time slots or summary.
  const newRequests = asExpert.filter(
    (entry) => entry.status === 'pending' && !isSeen('consultation-request', entry.id),
  );
  if (newRequests.length > 0) {
    const count = newRequests.length;
    return {
      kind: 'requests',
      message: {
        textKey: count === 1 ? 'kimchi.expert_requests_waiting_one' : 'kimchi.expert_requests_waiting_other',
        vars: { count },
      },
      duration: PANEL_BUBBLE_DURATION,
      seen: { scope: 'consultation-request', ids: newRequests.map((entry) => entry.id) },
    };
  }

  const waiting = oldestWaitingRequest(asMember, todayKey, isSeen);
  if (waiting) {
    return {
      kind: 'waiting',
      message: {
        textKey: 'kimchi.consultation_still_waiting',
        vars: {
          title: waiting.itemTitle,
          get date() {
            return formatDate(waiting.requestedOn);
          },
        },
        link: {
          href: '/about#contact',
          ctaKey: 'kimchi.consultation_still_waiting_cta',
          labelKey: 'kimchi.consultation_still_waiting_link',
        },
      },
      duration: LINK_BUBBLE_DURATION,
      seen: { scope: 'consultation-waiting', ids: [waiting.id] },
    };
  }

  return null;
}

export function meetingNudgeKey(nudge) {
  return `${nudge.id}:${nudge.phase}`;
}

/**
 * B6: the earliest meeting with a Zoom link that starts within 15 min or started less than
 * 15 min ago, unless this tab already had its nudge for that phase (`wasShown(key)`, with
 * `meetingNudgeKey`). Either role. Null when there is none.
 */
export function meetingNudgeAt(entries, now, wasShown) {
  let earliest = null;

  for (const entry of entries) {
    const timing = entry.zoomJoinUrl ? meetingTimingFor(entry, now) : null;
    if (!timing || now - timing.start >= MEETING_NUDGE_WINDOW_MS) {
      continue;
    }
    if (!earliest || timing.start < earliest.start) {
      earliest = { ...timing, id: entry.id };
    }
  }

  return earliest && !wasShown(meetingNudgeKey(earliest)) ? earliest : null;
}

/** Never puts the Zoom link in the bubble: it points at the entry's Join link and chip. */
export function meetingNudgeMessage(nudge) {
  return nudge.phase === 'live'
    ? { textKey: 'kimchi.meeting_live' }
    : { textKey: 'kimchi.meeting_starting_soon', vars: { minutes: nudge.minutes } };
}
