/**
 * The fixed parts of a consultation card on /account's agenda (AgendaConsultationCard.svelte),
 * moved out of AccountConsultations.svelte unchanged: what a cancel says by role and status (A7),
 * the message tools, the More menu's labels, the meeting time checks and the time formats. Pure:
 * the card passes the locale and the clock in.
 */

/**
 * A7: the cancel confirmation by role and by what was cancelled (`role:status` before the
 * cancel). `told` names the other side; `plain` is the same news without that claim.
 */
export const CANCEL_FEEDBACK = {
  'member:pending': {
    told: 'kimchi.consultation_withdrawn',
    plain: 'kimchi.consultation_withdrawn_plain',
    status: 'account_consultations.withdrawn_status',
    toldStatus: 'account_consultations.expert_told_status',
  },
  'member:reserved': {
    told: 'kimchi.consultation_cancelled_member',
    plain: 'kimchi.consultation_cancelled_plain',
    status: 'account_consultations.meeting_cancelled_status',
    toldStatus: 'account_consultations.expert_told_status',
  },
  'expert:pending': {
    told: 'kimchi.consultation_closed_expert',
    plain: 'kimchi.consultation_closed_expert_plain',
    status: 'account_consultations.request_cancelled_status',
    toldStatus: 'account_consultations.member_told_status',
  },
  'expert:reserved': {
    told: 'kimchi.consultation_cancelled_expert',
    plain: 'kimchi.consultation_cancelled_plain',
    status: 'account_consultations.meeting_cancelled_status',
    toldStatus: 'account_consultations.member_told_status',
  },
};

/**
 * The message tools on a consultation (ReservationMessageForm): `kind` and `as` go to the
 * server, the rest are locale keys for the More item, the form and what follows a sent message.
 */
export const MESSAGE_TOOLS = {
  'message-mentor': {
    kind: 'message',
    as: 'member',
    toggle: 'account_consultations.message_mentor',
    label: 'account_consultations.message_label_mentor',
    hint: 'account_consultations.message_hint',
    placeholder: '',
    status: 'reservation_message.sent_status',
    kimchi: 'kimchi.message_sent',
  },
  'new-time': {
    kind: 'new_time',
    as: 'member',
    toggle: 'account_consultations.suggest_time',
    label: 'account_consultations.suggest_label',
    hint: 'account_consultations.suggest_hint',
    placeholder: 'account_consultations.suggest_placeholder',
    status: 'reservation_message.suggested_status',
    kimchi: 'kimchi.time_suggestion_sent',
  },
  'message-member': {
    kind: 'message',
    as: 'owner',
    toggle: 'account_consultations.message_member',
    label: 'account_consultations.message_label_member',
    hint: 'account_consultations.message_hint',
    placeholder: '',
    status: 'reservation_message.sent_status',
    kimchi: 'kimchi.message_sent',
  },
};

/** CANCEL_FEEDBACK's entry for a row, by its role and status before the cancel. */
export function cancelFeedbackFor(row) {
  return CANCEL_FEEDBACK[`${row.role}:${row.status === 'pending' ? 'pending' : 'reserved'}`];
}

/**
 * Cancel's words in the More menu and on the question's Yes: a member withdraws a request, a
 * mentor declines one, and either side cancels a scheduled meeting. Same request every time.
 */
export function cancelLabelKeys(row) {
  if (row.status === 'pending') {
    return row.role === 'member'
      ? { label: 'account_reservations.withdraw', busyLabel: 'account_reservations.withdrawing' }
      : { label: 'account_agenda.decline_request', busyLabel: 'account_hosted.refusing' };
  }
  return { label: 'account_agenda.cancel_meeting', busyLabel: 'account_consultations.cancelling' };
}

/** A tool's label in the More menu (the old toggles' closed labels). */
export function toolLabelKey(tool, row) {
  if (MESSAGE_TOOLS[tool]) {
    return MESSAGE_TOOLS[tool].toggle;
  }
  if (tool === 'reschedule') {
    return 'account_consultations.reschedule_open';
  }
  if (tool === 'follow-up') {
    return 'account_consultations.follow_up_open';
  }
  return cancelLabelKeys(row).label;
}

/** A tool panel's id (and the message form's id prefix); the follow-up keeps its old id. */
export function toolPanelId(row, tool) {
  return tool === 'follow-up' ? `consultation-follow-up-${row.id}` : `consultation-${tool}-${row.role}-${row.id}`;
}

/**
 * Whether the other side heard about a cancel. A mentor may have no email address, so a member
 * hears "{title} has been told" only when the server says so; the member side always has one.
 */
export function otherSideTold(role, { emailSent, otherPartyEmailed }) {
  return emailSent !== false && (role === 'member' ? otherPartyEmailed === true : otherPartyEmailed !== false);
}

/**
 * Checks a parsed meeting time (`parseMeetingTimeInput`) before the question is asked, since iOS
 * enforces no min in its picker. Pass `current` (the meeting's `meetingAt`) when moving a
 * meeting: the picker has minutes, so the same minute is no change. Returns an error key or ''.
 */
export function meetingTimeErrorKey(parsed, now, current = null) {
  if (!parsed) {
    return 'account_consultations.meeting_time_required';
  }
  if (parsed.getTime() <= now) {
    return 'account_consultations.meeting_time_past';
  }
  if (current !== null && Math.floor(parsed.getTime() / 60000) === Math.floor(Date.parse(current ?? '') / 60000)) {
    return 'account_consultations.reschedule_unchanged';
  }
  return '';
}

function intlLocale(locale) {
  return String(locale ?? '').startsWith('fr') ? 'fr-CA' : 'en-CA';
}

/** "Thursday, November 5, 2026 at 1:00 p.m. EST" in the device's time zone. */
export function formatMeetingTime(value, locale) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value ?? '';
  }

  // dateStyle + timeZoneName throws in Chrome and Safari and blanks the card.
  return new Intl.DateTimeFormat(intlLocale(locale), {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

/** "1:00 p.m. EST": a meeting on the timeline, where the day rail gives the date. */
export function formatMeetingClock(value, locale) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value ?? '';
  }

  return new Intl.DateTimeFormat(intlLocale(locale), {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

/** A request's day (`YYYY-MM-DD`) as "Nov 2, 2026". */
export function formatDateKey(dateKey, locale) {
  const [year, month, day] = (dateKey ?? '').split('-').map(Number);
  if (!year || !month || !day) {
    return dateKey ?? '';
  }

  return new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: 'medium' }).format(
    new Date(year, month - 1, day),
  );
}
