// Every app email's subject, HTML and text: the build*EmailPayload(s) functions return Resend
// payloads and send nothing. server.js sends them (sendEmailPayloads) and decides when.
// docs/automated-emails.md lists each email's trigger. Pure functions. Server only.

import { compareDateKeys } from '../src/lib/calendar.js';
import { orgContact, renderBrandedEmail } from '../src/lib/email-brand.js';
import { emailsMatch } from '../src/lib/inventory-store.js';
import { hasPhysicalLocation, memberLocation } from '../src/lib/item-location.js';
import {
  consultationTitle,
  emailSubject,
  endSentence,
  formatMeetingDateTime,
  formatReadableDate,
  formatReservationDates,
  formatRoomTimes,
  itemPlaceLines,
  trimmedOrNull,
} from './format.js';
import { buildConsultationIcs } from './ics.js';
import {
  CONTACT_TO,
  EMAIL_REPLY_TO,
  FROM,
  absoluteSiteUrl,
  itemPageUrl,
} from './site.js';

// Equipment and books only: rooms are booked for any dates and have no Tuesday handover.
// The address is in the email's Where row; without one (see itemPlaceLines), the member is
// asked to reply for it rather than sent to an address that may be wrong.
const APPROVAL_PICKUP_NOTICE = 'Pickups and drop offs are between 10am and 5pm on Tuesdays at the address above.';
const APPROVAL_PICKUP_NOTICE_NO_ADDRESS =
  'Pickups and drop offs are between 10am and 5pm on Tuesdays. Reply to this email and we will send you the address.';
const APPROVAL_ROOM_NO_ADDRESS = "Reply to this email and we will send you the room's address.";

const RESERVATION_CHANGES_NOTICE = 'If anything changes, just reply to this email.';
const APPROVAL_SEE_YOU_AT_PICKUP = 'We look forward to seeing you at pickup.';

const WELCOME_EQUIPMENT_PICKUP_NOTICE = `Equipment reservations are typically on Tuesdays at ${orgContact.address}.`;

// TODO: replace with the real YES Employment participant data-sharing form URL.
const CONSULTATION_DATA_FORM_URL = 'https://REPLACE-ME.example/participant-info';

const CONSULTATION_FUNDING_NOTICE = 'This project is funded by YES Employment.';

const CONSULTATION_DATA_NOTICE =
  'To meet our deliverables, can you share more data about who you are?';

const EMAIL_WHY = {
  reservation:
    'You are receiving this because you requested an item from the Activist Resource Library.',
  staffReservation:
    'You are receiving this because the Activist Resource Library team made a reservation for this email address.',
  staffConsultation:
    'You are receiving this because the Activist Resource Library team booked a consultation for this email address.',
  consultationMember:
    'You are receiving this because you requested a consultation through the Activist Resource Library.',
  consultationExpert:
    'You are receiving this because your email is listed as the expert for an Activist Resource Library consultation.',
  itemOwner:
    'You are receiving this email because you are listed as the host of this item in the Activist Resource Library.',
  welcome:
    'You are receiving this because you created an Activist Resource Library member account.',
  passwordReset:
    'You are receiving this because the Activist Resource Library team sent a password reset link to your member account.',
  contact: 'This message was sent from the Activist Resource Library About page.',
};

/**
 * Branded transactional email. `details` entries are `[label, value, href?]`;
 * empty values are skipped. Text and HTML come from the same fields.
 */
function buildConsultationEmail({
  to,
  subject,
  heading,
  intro,
  details = [],
  paragraphs = [],
  links = [],
  cta,
  why,
  funderStrip = false,
  attachments,
}) {
  const rendered = renderBrandedEmail({
    subject,
    preheader: intro,
    headline: heading,
    intro,
    details,
    paragraphs,
    links,
    cta,
    why,
    funderStrip,
  });

  return {
    from: FROM,
    replyTo: EMAIL_REPLY_TO,
    to,
    subject,
    text: rendered.text,
    html: rendered.html,
    attachments,
  };
}

function zoomDetailRows(reservation) {
  return [['Passcode', reservation.zoomPassword]];
}

function consultationCta(reservation, accountUrl, accountLabel = 'Your account panel') {
  if (reservation.zoomJoinUrl) {
    return { label: 'Join Zoom', href: reservation.zoomJoinUrl };
  }
  return { label: accountLabel, href: accountUrl };
}

const ZOOM_ROOM_NOTICE =
  'You can join before the host, and everyone in the meeting can share their screen.';
const NO_ZOOM_NOTICE = 'We will send you a meeting link by email before your consultation.';

/** New request → the item's expert, with a link to their account panel. */
export function buildExpertRequestEmailPayload(item, reservation) {
  const to = trimmedOrNull(item?.expertEmail);
  if (!to) {
    return null;
  }

  const title = consultationTitle(item);
  const accountUrl = absoluteSiteUrl('/account');

  return buildConsultationEmail({
    to,
    subject: `New consultation request: ${title}`,
    heading: 'New consultation request',
    intro: `A member has requested a consultation with you through the Activist Resource Library. To view the request, log in with this email address: ${to}`,
    details: [
      ['Consultation', title],
      ['Member', reservation.userEmail],
      ['Their available time slots', reservation.timeSlots],
      ['What they would like to discuss', reservation.requestSummary],
    ],
    paragraphs: [
      `No account yet? Register with ${to} and confirm your email address; the request will then be in your account panel.`,
      'Open your account panel to pick a meeting date and time. Once you choose a time, we create a Zoom meeting and email the invitation to you both.',
    ],
    cta: { label: 'Schedule this meeting', href: accountUrl },
    why: EMAIL_WHY.consultationExpert,
  });
}

/**
 * Staff bookings (admin **Create Reservation**) go to any address, member or not, and the account
 * page lists them by email. By `account` ('member', 'new' or 'unknown', when the lookup failed),
 * how to see it online; `seeIt` starts the sentence ("To see or cancel it").
 */
function staffBookingAccountLine(account, seeIt, email) {
  return {
    member: `${seeIt}, log in with this email address: ${email}`,
    new: `${seeIt} online, create a free account with this email address: ${email}`,
  }[account] ?? `${seeIt} online, log in or create a free account with this email address: ${email}`;
}

/** The staff booking's account paragraph; none for a member. `what`: "reservation", "consultation". */
function staffBookingAccountParagraph(account, what) {
  return {
    member: '',
    new: `Once you have confirmed your email address, the ${what} will be on your account page.`,
  }[account] ?? `If you create an account, confirm your email address and the ${what} will be on your account page.`;
}

/**
 * Scheduled → member and expert, each with the Zoom link and a calendar invite. A follow-up
 * booked by the expert says so, and its optional note replaces the member's request summary.
 * `message` is the optional note the expert (`messageFrom: 'expert'`) or staff (`'admin'`)
 * wrote when scheduling; both emails show it. `account` is set ('member', 'new' or 'unknown',
 * as in buildStaffReservationEmailPayload) when staff booked the meeting themselves (admin
 * **Create Reservation**): the member never asked through the site, so their email says who
 * booked it, shows the topic staff typed, and asks them to log in or register with the address.
 * `onlyExpert` leaves the member's email out (a mentor email handover).
 */
export function buildConsultationScheduledEmailPayloads(
  item,
  reservation,
  { message = '', messageFrom = 'expert', account = null, onlyExpert = false } = {},
) {
  const title = consultationTitle(item);
  const fromStaff = messageFrom === 'admin';
  const bookedByStaff = account !== null;
  const followUp = Boolean(reservation.followUpOf);
  const kind = followUp ? 'Follow-up consultation' : 'Consultation';
  const noteRow = followUp
    ? ['Follow-up note', reservation.requestSummary]
    : ['What they would like to discuss', reservation.requestSummary];
  const meetingTime = formatMeetingDateTime(reservation.meetingAt);
  const accountUrl = absoluteSiteUrl('/account');
  const roomNotice = reservation.zoomJoinUrl ? ZOOM_ROOM_NOTICE : NO_ZOOM_NOTICE;
  const cancelNotice = 'Need to cancel? You can do it from your account panel; we will let the other person know.';
  const payloads = [];
  const memberEmail = trimmedOrNull(reservation.userEmail);
  const expertEmail = trimmedOrNull(item.expertEmail);

  if (memberEmail && !onlyExpert) {
    const accountLabel = account === 'new' ? 'Create your account' : 'Your account panel';
    const cta = consultationCta(reservation, accountUrl, accountLabel);
    // A staff booking's account sentence is in the intro, so the inbox preview says what to do.
    const intro = bookedByStaff
      ? `The Activist Resource Library team has booked you a consultation with ${expertEmail ?? title} for ${meetingTime}. ${staffBookingAccountLine(account, 'To see or cancel it', memberEmail)}`
      : `Your ${kind.toLowerCase()} is booked for ${meetingTime} with ${expertEmail ?? title}.`;
    let memberNoteRow = [];
    if (followUp) {
      memberNoteRow = [noteRow];
    } else if (bookedByStaff) {
      memberNoteRow = [['What you would like to discuss', reservation.requestSummary]];
    }
    payloads.push(
      buildConsultationEmail({
        to: memberEmail,
        subject: `${kind} confirmed: ${title}`,
        heading: `${kind} confirmed`,
        intro,
        details: [
          ['Consultation', title, itemPageUrl(item)],
          ['When', meetingTime],
          [fromStaff ? 'Message from the library team' : `Message from ${title}`, message],
          ...memberNoteRow,
          ...zoomDetailRows(reservation),
        ],
        paragraphs: [
          roomNotice,
          bookedByStaff ? staffBookingAccountParagraph(account, 'consultation') : '',
          CONSULTATION_FUNDING_NOTICE,
          CONSULTATION_DATA_NOTICE,
          cancelNotice,
        ],
        cta,
        links: [
          ['Share your information', CONSULTATION_DATA_FORM_URL],
          ...(cta.href === accountUrl ? [] : [[accountLabel, accountUrl]]),
        ],
        why: bookedByStaff ? EMAIL_WHY.staffConsultation : EMAIL_WHY.consultationMember,
        funderStrip: true,
        attachments: [buildConsultationIcs(item, reservation, 'REQUEST')],
      }),
    );
  }

  if (expertEmail) {
    const cta = consultationCta(reservation, accountUrl);
    payloads.push(
      buildConsultationEmail({
        to: expertEmail,
        subject: `${kind} scheduled: ${title}`,
        heading: `${kind} scheduled`,
        intro: bookedByStaff
          ? `The Activist Resource Library team has booked ${memberEmail ?? 'a member'} a consultation with you for ${meetingTime}.`
          : `Your ${kind.toLowerCase()} with ${memberEmail ?? 'a member'} is booked for ${meetingTime}.`,
        details: [
          ['Consultation', title],
          ['When', meetingTime],
          ['Member', memberEmail],
          [fromStaff ? 'Message from the library team to the member' : 'Your message to the member', message],
          noteRow,
          ...zoomDetailRows(reservation),
        ],
        paragraphs: [roomNotice, cancelNotice],
        cta,
        links: cta.href === accountUrl ? [] : [['Your account panel', accountUrl]],
        why: EMAIL_WHY.consultationExpert,
        attachments: [buildConsultationIcs(item, reservation, 'REQUEST')],
      }),
    );
  }

  return payloads;
}

/**
 * A scheduled consultation moved to a new time (POST /api/consultations/:id/reschedule) → member
 * and expert, each with the new time, the old one, the optional `message` and an updated invite
 * (same UID, later SEQUENCE: calendars move the event). `messageFrom` as in
 * buildConsultationScheduledEmailPayloads: 'expert' (the mentor) or 'admin' (staff, or the owner
 * of a mentor with no address of its own, who has the library team's wording).
 */
export function buildConsultationRescheduledEmailPayloads(
  item,
  reservation,
  previousMeetingAt,
  { message = '', messageFrom = 'expert' } = {},
) {
  const title = consultationTitle(item);
  const fromStaff = messageFrom === 'admin';
  const kind = reservation.followUpOf ? 'Follow-up consultation' : 'Consultation';
  const newTime = formatMeetingDateTime(reservation.meetingAt);
  const previousTime = previousMeetingAt ? formatMeetingDateTime(previousMeetingAt) : '';
  const accountUrl = absoluteSiteUrl('/account');
  const roomNotice = reservation.zoomJoinUrl ? ZOOM_ROOM_NOTICE : NO_ZOOM_NOTICE;
  const subject = emailSubject(`${kind} moved: ${title}`);
  const memberEmail = trimmedOrNull(reservation.userEmail);
  const expertEmail = trimmedOrNull(item.expertEmail);
  const payloads = [];

  if (memberEmail) {
    const who = fromStaff ? 'The Activist Resource Library team' : title;
    const cta = consultationCta(reservation, accountUrl);
    payloads.push(
      buildConsultationEmail({
        to: memberEmail,
        subject,
        heading: `${kind} moved`,
        intro: `${who} moved your ${kind.toLowerCase()} to ${newTime}.`,
        details: [
          ['Consultation', title, itemPageUrl(item)],
          ['New time', newTime],
          ['Was', previousTime],
          [fromStaff ? 'Message from the library team' : `Message from ${title}`, message],
          ...zoomDetailRows(reservation),
        ],
        paragraphs: [
          roomNotice,
          'If the new time does not work for you, you can message them, suggest another time or cancel from your account panel.',
        ],
        cta,
        links: cta.href === accountUrl ? [] : [['Your account panel', accountUrl]],
        why: reservation.bookedByStaff ? EMAIL_WHY.staffConsultation : EMAIL_WHY.consultationMember,
        funderStrip: true,
        attachments: [buildConsultationIcs(item, reservation, 'REQUEST')],
      }),
    );
  }

  if (expertEmail) {
    const member = memberEmail ?? 'a member';
    const cta = consultationCta(reservation, accountUrl);
    payloads.push(
      buildConsultationEmail({
        to: expertEmail,
        subject,
        heading: `${kind} moved`,
        intro: fromStaff
          ? `The Activist Resource Library team moved your ${kind.toLowerCase()} with ${member} to ${newTime}.`
          : `You moved your ${kind.toLowerCase()} with ${member} to ${newTime}.`,
        details: [
          ['Consultation', title],
          ['New time', newTime],
          ['Was', previousTime],
          ['Member', memberEmail],
          [fromStaff ? 'Message from the library team to the member' : 'Your message to the member', message],
          ...zoomDetailRows(reservation),
        ],
        paragraphs: [roomNotice],
        cta,
        links: cta.href === accountUrl ? [] : [['Your account panel', accountUrl]],
        why: EMAIL_WHY.consultationExpert,
        attachments: [buildConsultationIcs(item, reservation, 'REQUEST')],
      }),
    );
  }

  return payloads;
}

const CANCELLED_BY_LABELS = {
  member: 'the member',
  expert: 'the expert',
  admin: 'the Activist Resource Library team',
  // A host cancelling a booking of their own item (rooms, equipment, books) from /account.
  owner: 'the Activist Resource Library team',
};

/** Cancelled → member and expert; scheduled meetings also get an iCalendar CANCEL. */
/**
 * `declined`: the mentor's side closed a pending request with **Decline request** on /account
 * (the cancel route, so the row is `cancelled`), worded as declined. Other cancels of a request
 * (the member withdrawing, staff deleting it, a member account deleted) stay "cancelled".
 */
export function buildConsultationCancelledEmailPayloads(item, reservation, previousStatus, { declined = false } = {}) {
  const title = consultationTitle(item);
  const wasScheduled = previousStatus === 'reserved' && reservation.meetingAt;
  const meetingTime = wasScheduled ? formatMeetingDateTime(reservation.meetingAt) : '';
  const cancelledBy = reservation.cancelledBy;
  const libraryUrl = absoluteSiteUrl('/');
  const asDecline = declined && !wasScheduled;
  const recipients = [
    ['member', trimmedOrNull(reservation.userEmail)],
    ['expert', trimmedOrNull(item.expertEmail)],
  ];

  return recipients
    .filter(([, email]) => email)
    .map(([role, email]) => {
      const byYou = role === cancelledBy;
      const who = byYou ? 'You' : CANCELLED_BY_LABELS[cancelledBy] ?? 'Someone';
      let what = wasScheduled ? `the consultation scheduled for ${meetingTime}` : 'the consultation request';
      if (asDecline) {
        what = role === 'member' ? 'your consultation request' : 'the consultation request';
      }
      const intro = `${who.charAt(0).toUpperCase()}${who.slice(1)} ${asDecline ? 'declined' : 'cancelled'} ${what}.`;
      const closing =
        role === 'member'
          ? 'You are welcome to submit a new request whenever it suits you.'
          : 'No further action is needed.';

      return buildConsultationEmail({
        to: email,
        subject: asDecline ? `Consultation request declined: ${title}` : `Consultation cancelled: ${title}`,
        heading: asDecline ? 'Consultation request declined' : 'Consultation cancelled',
        intro,
        details: [['Consultation', title], ['Was scheduled for', meetingTime]],
        paragraphs: [wasScheduled ? 'The Zoom meeting has been removed.' : '', closing].filter(Boolean),
        cta: { label: 'Browse the library', href: libraryUrl },
        why: role === 'expert' ? EMAIL_WHY.consultationExpert : EMAIL_WHY.consultationMember,
        attachments: wasScheduled ? [buildConsultationIcs(item, reservation, 'CANCEL')] : undefined,
      });
    });
}

function buildConsultationDecisionEmailPayload(item, reservation) {
  const to = trimmedOrNull(reservation?.userEmail);
  if (!to) {
    return null;
  }

  const title = consultationTitle(item);

  return buildConsultationEmail({
    to,
    subject: `Consultation update: ${title}`,
    heading: 'Consultation not available',
    intro: 'Unfortunately, we cannot accommodate your consultation request right now.',
    details: [['Consultation', title, itemPageUrl(item)]],
    paragraphs: ['Feel free to submit another request or browse other resources in the library.'],
    cta: { label: 'Browse the library', href: absoluteSiteUrl('/') },
    why: EMAIL_WHY.consultationMember,
  });
}

export function buildConsultationRequestEmailPayload(item, reservation) {
  const to = trimmedOrNull(reservation?.userEmail);
  if (!to) {
    return null;
  }

  const title = consultationTitle(item);

  return buildConsultationEmail({
    to,
    subject: `Consultation request received: ${title}`,
    heading: 'Consultation request received',
    intro: 'Thanks for requesting a consultation! The expert will pick a time from your availability, and you will both receive a Zoom invitation by email.',
    details: [
      ['Consultation', title, itemPageUrl(item)],
      ['Your available time slots', reservation.timeSlots],
      ['What you would like to discuss', reservation.requestSummary],
    ],
    paragraphs: ['You can follow or cancel this request from your account panel.'],
    cta: { label: 'Your account panel', href: absoluteSiteUrl('/account') },
    links: [['Browse the library', absoluteSiteUrl('/')]],
    why: EMAIL_WHY.consultationMember,
  });
}

/**
 * What every confirmed equipment, book or room email shows (the approval and the staff
 * booking): the full address (the item's own place; see resolveItemLocation), its directions
 * link, and the pickup or room lines.
 */
function confirmedReservationEmailParts(item) {
  const isRoom = item.tag === 'rooms';
  const location = hasPhysicalLocation(item.tag) ? item.location ?? null : null;
  const where = location ? itemPlaceLines(location) : '';
  // Rooms have no Tuesday pickup: confirm where and when instead.
  let paragraphs;
  if (isRoom) {
    paragraphs = where ? [RESERVATION_CHANGES_NOTICE] : [APPROVAL_ROOM_NO_ADDRESS, RESERVATION_CHANGES_NOTICE];
  } else {
    paragraphs = [
      where ? APPROVAL_PICKUP_NOTICE : APPROVAL_PICKUP_NOTICE_NO_ADDRESS,
      APPROVAL_SEE_YOU_AT_PICKUP,
    ];
  }

  return {
    isRoom,
    location,
    where,
    paragraphs,
    directions: location ? memberLocation(location).directionsUrl : '',
  };
}

/** `message`: the optional note staff wrote when approving; only approvals show it. */
export function buildMemberDecisionEmailPayload(item, reservation, decision, message = '') {
  if (item?.tag === 'expertise') {
    // Approved consultations send buildConsultationScheduledEmailPayloads instead.
    return decision === 'refused' ? buildConsultationDecisionEmailPayload(item, reservation) : null;
  }

  const title = typeof item.title === 'string' ? item.title.trim() : 'Inventory item';
  const isRoom = item.tag === 'rooms';
  const to =
    typeof reservation?.userEmail === 'string' && reservation.userEmail.trim()
      ? reservation.userEmail.trim()
      : null;

  if (!to) {
    return null;
  }

  const approved = decision === 'approved';
  // The full address only on an approval.
  const confirmed = approved ? confirmedReservationEmailParts(item) : null;
  const location = confirmed?.location ?? null;
  const where = confirmed?.where ?? '';
  const subject = approved
    ? `Reservation confirmed: ${title}`
    : `Reservation update: ${title}`;
  const intro = approved
    ? 'Your reservation request has been approved by Apathy is Boring.'
    : 'Unfortunately, the item you requested is not available for those dates.';
  const itemUrl = itemPageUrl(item);
  const libraryUrl = absoluteSiteUrl('/');
  const paragraphs = confirmed?.paragraphs ?? ['Please choose different dates or another item from the library.'];
  const directions = confirmed?.directions ?? '';

  const rendered = renderBrandedEmail({
    subject,
    preheader: intro,
    headline: approved ? 'Reservation confirmed' : 'Reservation not available',
    intro,
    details: [
      [isRoom ? 'Room' : 'Item', title, itemUrl],
      ['Dates', formatReservationDates(reservation)],
      ['Times', formatRoomTimes(item, reservation)],
      ['Where', where],
      ['Getting there', location?.transitNoteEn ?? ''],
      ['Message from the library team', approved ? message : ''],
    ],
    paragraphs,
    cta: {
      label: approved ? (isRoom ? 'View the room' : 'View your item') : 'Choose different dates',
      href: itemUrl,
    },
    // In links, not on the Where row, so the plain-text part carries the URL too.
    links: [
      ...(directions ? [['Get directions', directions]] : []),
      ['Browse the library', libraryUrl],
    ],
    why: EMAIL_WHY.reservation,
  });

  return {
    from: FROM,
    replyTo: EMAIL_REPLY_TO,
    to,
    subject,
    text: rendered.text,
    html: rendered.html,
  };
}

/**
 * Staff booked an equipment, book or room reservation for this address (admin **Create
 * Reservation**), member or not. `account`: 'member' (a confirmed account uses the address),
 * 'new' (none, or one never confirmed) or 'unknown' (the lookup failed). The account page
 * lists reservations by email, so the invitation is to sign in or register with this one.
 * `today` is a libraryTodayKey(): members can cancel online only before the first day.
 */
export function buildStaffReservationEmailPayload(item, reservation, { account, message = '', today }) {
  const to = trimmedOrNull(reservation?.userEmail);
  if (!to) {
    return null;
  }

  const title = trimmedOrNull(item?.title) ?? 'Inventory item';
  const { isRoom, location, where, paragraphs, directions } = confirmedReservationEmailParts(item);
  const canCancel = compareDateKeys(reservation.startDate ?? '', today) > 0;
  const seeIt = canCancel ? 'To see or cancel it' : 'To see it';
  // The account sentence is in the intro, so the inbox preview already says what to do.
  const accountLine = staffBookingAccountLine(account, seeIt, to);
  const intro = `The Activist Resource Library team has booked ${title} for you. ${accountLine}`;
  const accountUrl = absoluteSiteUrl('/account');
  const itemUrl = itemPageUrl(item);

  return buildConsultationEmail({
    to,
    subject: `Reservation confirmed: ${title}`,
    heading: 'Reservation confirmed',
    intro,
    details: [
      [isRoom ? 'Room' : 'Item', title, itemUrl],
      ['Dates', formatReservationDates(reservation)],
      ['Times', formatRoomTimes(item, reservation)],
      ['Where', where],
      ['Getting there', location?.transitNoteEn ?? ''],
      ['Message from the library team', message],
    ],
    paragraphs: [
      staffBookingAccountParagraph(account, 'reservation'),
      canCancel ? 'You can cancel it there until the day before it starts.' : '',
      ...paragraphs,
    ],
    cta: {
      label: { member: 'See your reservation', new: 'Create your account' }[account] ?? 'Go to your account',
      href: accountUrl,
    },
    // In links, not on the Where row, so the plain-text part carries the URL too.
    links: [
      ...(directions ? [['Get directions', directions]] : []),
      [isRoom ? 'View the room' : 'View the item', itemUrl],
    ],
    why: EMAIL_WHY.staffReservation,
  });
}

/**
 * Admin deleted the reservation, or its whole item, or the item's host cancelled it from /account
 * → the member. `today` (a libraryTodayKey()) tells a booking still ahead of its pickup from a
 * loan already under way; `reservation.status` is the one it had before. `message`: the host's
 * optional note (staff deletes have none).
 */
export function buildReservationCancelledByTeamEmailPayload(item, reservation, today, message = '') {
  const to = trimmedOrNull(reservation?.userEmail);
  if (!to) {
    return null;
  }

  const title = trimmedOrNull(item?.title) ?? 'Inventory item';
  const tag = trimmedOrNull(item?.tag) ?? 'equipment';
  const what = reservation.status === 'pending' ? 'reservation request' : 'reservation';
  const intro = `Your ${what} for ${title} (${formatReservationDates(reservation)}) was cancelled by the Activist Resource Library team.`;
  let pickupNotice = '';
  if (reservation.status === 'reserved' && (tag === 'equipment' || tag === 'books')) {
    // From the first day on, the member may already be holding the item.
    pickupNotice =
      compareDateKeys(reservation.startDate ?? '', today) > 0
        ? 'Please do not come to pickup for this reservation.'
        : 'If you have already picked up the item, please reply to this email to arrange returning it. Otherwise, please do not come to pickup.';
  }

  return buildConsultationEmail({
    to,
    subject: `Reservation cancelled: ${title}`,
    heading: 'Reservation cancelled',
    intro,
    details: [['Message from the library team', message]],
    paragraphs: [
      pickupNotice,
      'You are welcome to choose other dates or another item from the library. If you have questions, just reply to this email.',
    ],
    // The item may be gone (item delete), so link its category instead.
    cta: { label: 'Browse the library', href: absoluteSiteUrl(`/${tag}`) },
    why: EMAIL_WHY.reservation,
  });
}

/**
 * The host of a room, equipment or book moved a booking from /account → the member. A pending
 * request stays a request; a confirmed booking shows where to go again, as its approval did.
 * `previous` is `{ startDate, endDate, timeSlots }` before the move, `message` the host's optional
 * note, and `today` a libraryTodayKey(): members can cancel online only before the first day.
 * Hosts are staff today, so the email speaks for the library team.
 */
export function buildReservationRescheduledEmailPayload(item, reservation, previous, { message = '', today } = {}) {
  const to = trimmedOrNull(reservation?.userEmail);
  if (!to) {
    return null;
  }

  const title = trimmedOrNull(item?.title) ?? 'Inventory item';
  const isRoom = item.tag === 'rooms';
  const pending = reservation.status === 'pending';
  const confirmed = pending ? null : confirmedReservationEmailParts(item);
  const location = confirmed?.location ?? null;
  const directions = confirmed?.directions ?? '';
  const datesChanged =
    previous.startDate !== reservation.startDate || previous.endDate !== reservation.endDate;
  const timesChanged = isRoom && (previous.timeSlots ?? null) !== (reservation.timeSlots ?? null);
  let change = 'dates';
  if (timesChanged) {
    change = datesChanged ? 'dates and times' : 'times';
  }
  const what = pending ? 'request' : 'reservation';
  const previousTimes = formatRoomTimes(item, previous);
  const started = !pending && compareDateKeys(reservation.startDate ?? '', today) <= 0;
  let changeNotice = `If the new ${change} do not work for you, just reply to this email.`;
  if (pending) {
    changeNotice = `If the new ${change} do not work for you, you can withdraw your request from your account panel or reply to this email.`;
  } else if (compareDateKeys(reservation.startDate ?? '', today) > 0) {
    changeNotice = `If the new ${change} do not work for you, you can cancel from your account panel or reply to this email.`;
  }

  return buildConsultationEmail({
    to,
    subject: emailSubject(`New ${change} for your ${what}: ${title}`),
    heading: `Your ${what} has new ${change}`,
    intro: `The Activist Resource Library team changed the ${change} of your ${pending ? 'reservation request' : 'reservation'} for ${title}.`,
    details: [
      [isRoom ? 'Room' : 'Item', title, itemPageUrl(item)],
      ['New dates', formatReservationDates(reservation)],
      ['New times', formatRoomTimes(item, reservation)],
      ['Was', `${formatReservationDates(previous)}${previousTimes ? `, ${previousTimes}` : ''}`],
      ['Where', confirmed?.where ?? ''],
      ['Getting there', location?.transitNoteEn ?? ''],
      ['Message from the library team', message],
    ],
    // changeNotice replaces the rooms' "just reply" line; a loan already under way has had its
    // pickup (the Tuesday hours line stays: drop-offs keep them).
    paragraphs: [
      ...(confirmed?.paragraphs ?? []).filter(
        (paragraph) =>
          paragraph !== RESERVATION_CHANGES_NOTICE && (!started || paragraph !== APPROVAL_SEE_YOU_AT_PICKUP),
      ),
      changeNotice,
    ],
    cta: { label: 'See your reservation', href: absoluteSiteUrl('/account') },
    // In links, not on the Where row, so the plain-text part carries the URL too.
    links: [
      ...(directions ? [['Get directions', directions]] : []),
      ['Browse the library', absoluteSiteUrl('/')],
    ],
    why: reservation.bookedByStaff ? EMAIL_WHY.staffReservation : EMAIL_WHY.reservation,
  });
}

/**
 * The day-before reminder of a confirmed booking (sendDueReservationReminders, about 24 hours
 * before reservationStartsAt). Equipment, books and rooms → the member, with where and when as in
 * the approval. Consultations → member and expert, with the Zoom link; no `.ics`, the invite went
 * out when it was scheduled. Each only with an address: an empty array when nobody has one.
 */
export function buildReservationReminderEmailPayloads(item, reservation) {
  const accountUrl = absoluteSiteUrl('/account');
  const memberEmail = trimmedOrNull(reservation?.userEmail);

  if (item?.tag === 'expertise') {
    const title = consultationTitle(item);
    const kind = reservation.followUpOf ? 'follow-up consultation' : 'consultation';
    const meetingTime = formatMeetingDateTime(reservation.meetingAt);
    const roomNotice = reservation.zoomJoinUrl ? ZOOM_ROOM_NOTICE : NO_ZOOM_NOTICE;
    const subject = emailSubject(`Your consultation is coming up: ${title}`);
    const expertEmail = trimmedOrNull(item.expertEmail);
    const cta = consultationCta(reservation, accountUrl);
    const links = cta.href === accountUrl ? [] : [['Your account panel', accountUrl]];
    const payloads = [];

    if (memberEmail) {
      payloads.push(
        buildConsultationEmail({
          to: memberEmail,
          subject,
          heading: 'Your consultation is coming up!',
          intro: `Just a reminder: your ${kind} with ${title} is on ${meetingTime}.`,
          details: [
            ['Consultation', title, itemPageUrl(item)],
            ['When', meetingTime],
            ...zoomDetailRows(reservation),
          ],
          paragraphs: [
            roomNotice,
            `Need to change something? From your account panel you can message ${title}, suggest a new time or cancel.`,
          ],
          cta,
          links,
          why: reservation.bookedByStaff ? EMAIL_WHY.staffConsultation : EMAIL_WHY.consultationMember,
          funderStrip: true,
        }),
      );
    }

    if (expertEmail) {
      payloads.push(
        buildConsultationEmail({
          to: expertEmail,
          subject,
          heading: 'Your consultation is coming up!',
          intro: `Just a reminder: your ${kind} with ${memberEmail ?? 'a member'} is on ${meetingTime}.`,
          details: [
            ['Consultation', title],
            ['When', meetingTime],
            ['Member', memberEmail],
            ...zoomDetailRows(reservation),
          ],
          paragraphs: [
            roomNotice,
            'Need to change something? From your account panel you can message the member, choose a new time or cancel.',
          ],
          cta,
          links,
          why: EMAIL_WHY.consultationExpert,
        }),
      );
    }

    return payloads;
  }

  if (!memberEmail) {
    return [];
  }

  const title = trimmedOrNull(item?.title) ?? 'Inventory item';
  const { isRoom, location, where, paragraphs, directions } = confirmedReservationEmailParts(item);
  const dates = formatReservationDates(reservation);
  const times = formatRoomTimes(item, reservation);
  const intro = isRoom
    ? endSentence(
        `Just a reminder: ${title} is booked for you ${reservation.startDate === reservation.endDate ? 'on' : 'from'} ${dates}${times ? `, ${times}` : ''}`,
      )
    : `Just a reminder: your pickup for ${title} is on ${formatReadableDate(reservation.startDate)}.`;

  return [
    buildConsultationEmail({
      to: memberEmail,
      subject: emailSubject(`Your reservation is coming up: ${title}`),
      heading: 'Your reservation is coming up!',
      intro,
      details: [
        [isRoom ? 'Room' : 'Item', title, itemPageUrl(item)],
        ['Dates', dates],
        ['Times', times],
        ['Where', where],
        ['Getting there', location?.transitNoteEn ?? ''],
      ],
      // The account panel line replaces the rooms' "just reply" one.
      paragraphs: [
        ...paragraphs.filter((paragraph) => paragraph !== RESERVATION_CHANGES_NOTICE),
        'Need to change something? From your account panel you can message the host, suggest a new time or cancel before the first day.',
      ],
      cta: { label: 'See your reservation', href: accountUrl },
      // In links, not on the Where row, so the plain-text part carries the URL too.
      links: [
        ...(directions ? [['Get directions', directions]] : []),
        ['Browse the library', absoluteSiteUrl('/')],
      ],
      why: reservation.bookedByStaff ? EMAIL_WHY.staffReservation : EMAIL_WHY.reservation,
    }),
  ];
}

const RESERVATION_MESSAGE_NOUNS = { expertise: 'consultation', rooms: 'room reservation' };

/**
 * "You have a new message" for a booking's conversation (016; POST /api/reservations/:id/message),
 * sent to `to` only when they've read the conversation since the last such email (see
 * reservation-messages-store.js), so it carries the first unread message and points to /account.
 * `from` 'member': the member wrote to the host (itemOwnerEmail, or the library inbox), `kind`
 * 'message' or 'new_time' (a time they'd prefer; nothing moves until the host moves it).
 * `from` 'owner': the host wrote to the member. Reply-To is the library's (EMAIL_REPLY_TO), never
 * the sender's: answers go through the conversation, so neither side gets the other's address
 * from it. `senderEmail` names the member to the host (who already sees it on /account).
 * `senderIsExpert` (the mentor) and `senderIsStaff` choose how a host is named: staff speak as
 * the library team, anyone else hosting a mentor as the mentor (consultationHostVoice).
 */
export function buildReservationMessageEmailPayload({
  item,
  reservation,
  kind,
  from,
  senderEmail,
  to,
  message,
  senderIsExpert = false,
  senderIsStaff = false,
}) {
  const isConsultation = item.tag === 'expertise';
  const title = isConsultation ? consultationTitle(item) : trimmedOrNull(item.title) ?? 'Inventory item';
  const noun = RESERVATION_MESSAGE_NOUNS[item.tag] ?? 'reservation';
  const scheduled = isConsultation && Boolean(reservation.meetingAt);
  // Follows the noun in the intro ("their consultation on …"); a meeting time already ends in
  // "(Montreal time)", so no parentheses around it.
  let when;
  let whenRows;
  if (isConsultation) {
    when = scheduled
      ? ` on ${formatMeetingDateTime(reservation.meetingAt)}`
      : `, requested on ${formatReadableDate(reservation.startDate)}`;
    whenRows = [
      scheduled
        ? ['When', formatMeetingDateTime(reservation.meetingAt)]
        : ['Requested on', formatReadableDate(reservation.startDate)],
    ];
  } else {
    const dates = formatReservationDates(reservation);
    const times = formatRoomTimes(item, reservation);
    when = ` for ${times ? `${dates}, ${times}` : dates}`;
    whenRows = [
      ['Dates', dates],
      ['Times', times],
    ];
  }
  let itemLabel = 'Item';
  if (isConsultation) {
    itemLabel = 'Consultation';
  } else if (item.tag === 'rooms') {
    itemLabel = 'Room';
  }
  const itemRow = [itemLabel, title, itemPageUrl(item)];
  const cta = { label: 'Read and reply', href: absoluteSiteUrl('/account') };
  const replyNotice =
    'Read the conversation and answer from your account panel. Replies to this email reach the library team, not them.';
  const quietNotice = "If they write again before you've read this, we won't send you another email.";
  let payload;

  if (from === 'member') {
    const suggestion = kind === 'new_time';
    let moveNotice = '';
    if (suggestion) {
      moveNotice =
        isConsultation && reservation.status === 'pending'
          ? 'To schedule it, pick the time from your account panel; you will both get the invitation by email.'
          : 'To move it, choose the new time from your account panel; they will get an email with it.';
    }
    let status = 'Waiting for review';
    if (reservation.status === 'reserved') {
      status = isConsultation ? 'Scheduled' : 'Confirmed';
    }
    payload = buildConsultationEmail({
      to,
      subject: emailSubject(suggestion ? `New time suggested for ${title}` : `New message about ${title}`),
      heading: suggestion ? 'A new time was suggested' : 'New message from a member',
      intro: endSentence(
        suggestion
          ? `${senderEmail} would like a new time for their ${noun}${when}`
          : `${senderEmail} sent you a message about their ${noun}${when}`,
      ),
      details: [
        itemRow,
        ...whenRows,
        ['Status', status],
        ['From', senderEmail],
        [suggestion ? 'Their suggestion' : 'Message', message],
      ],
      paragraphs: [replyNotice, moveNotice, quietNotice],
      cta,
      // The mentor gets the expert's line; anyone else hosting it (or the library inbox), the host's.
      why: isConsultation && emailsMatch(to, item.expertEmail) ? EMAIL_WHY.consultationExpert : EMAIL_WHY.itemOwner,
    });
  } else {
    let senderLabel = senderIsStaff ? 'The Activist Resource Library team' : `The host of ${title}`;
    const asMentor = isConsultation && (senderIsExpert || !senderIsStaff);
    if (isConsultation) {
      senderLabel = asMentor ? title : 'The Activist Resource Library team';
    }
    let why = reservation.bookedByStaff ? EMAIL_WHY.staffReservation : EMAIL_WHY.reservation;
    if (isConsultation) {
      why = reservation.bookedByStaff ? EMAIL_WHY.staffConsultation : EMAIL_WHY.consultationMember;
    }
    payload = buildConsultationEmail({
      to,
      subject: emailSubject(`Message about your ${noun}: ${title}`),
      heading: asMentor ? `A message from ${title}` : `A message about your ${noun}`,
      intro: endSentence(`${senderLabel} sent you a message about your ${noun}${when}`),
      details: [itemRow, ...whenRows, ['Message', message]],
      paragraphs: [replyNotice, quietNotice],
      cta,
      why,
    });
  }

  return { ...payload, replyTo: EMAIL_REPLY_TO };
}

export function buildWelcomeEmailPayload(email) {
  const to = typeof email === 'string' ? email.trim() : '';
  if (!to) {
    return null;
  }

  const howItWorksUrl = absoluteSiteUrl('/howthisworks');
  const aboutUrl = absoluteSiteUrl('/about');
  const libraryUrl = absoluteSiteUrl('/');
  const subject = 'Welcome to the Activist Resource Library';
  const intro = 'Thanks for creating your member account with Apathy is Boring.';

  const rendered = renderBrandedEmail({
    subject,
    preheader: 'Welcome to the Activist Resource Library.',
    headline: 'Welcome to the Activist Resource Library',
    intro,
    paragraphs: [
      'To get started, read How it works. It walks through browsing inventory, reserving items, and pickup.',
      WELCOME_EQUIPMENT_PICKUP_NOTICE,
      'Questions? Contact us on the About page.',
    ],
    cta: { label: 'How it works', href: howItWorksUrl },
    links: [
      ['Contact us', aboutUrl],
      ['Browse inventory', libraryUrl],
    ],
    why: EMAIL_WHY.welcome,
  });

  return {
    from: FROM,
    replyTo: EMAIL_REPLY_TO,
    to,
    subject,
    text: rendered.text,
    html: rendered.html,
  };
}

/** Admin "Send password reset" → the member, with Supabase's one-time recovery link as the CTA. */
export function buildPasswordResetEmailPayload(email, actionLink) {
  const to = trimmedOrNull(email);
  if (!to || !actionLink) {
    return null;
  }

  return buildConsultationEmail({
    to,
    subject: 'Set a new password for the Activist Resource Library',
    heading: 'Set a new password',
    intro: 'The Activist Resource Library team sent you a link to choose a new password for your member account.',
    paragraphs: [
      'The link works once and expires after a short while. If it has expired, choose "Forgot password?" when you log in to get a new one.',
      "If you weren't expecting this email, you can ignore it. Your password stays the same until you choose a new one.",
    ],
    cta: { label: 'Choose a new password', href: actionLink },
    why: EMAIL_WHY.passwordReset,
  });
}

export function buildContactEmailPayload({ name, email, message }) {
  const subject = `Activist Resource Library contact: ${name}`;
  const aboutUrl = absoluteSiteUrl('/about');
  const intro = 'New message from the About page contact form.';

  const rendered = renderBrandedEmail({
    subject,
    preheader: `New message from ${name}`,
    headline: 'Contact form message',
    intro,
    details: [
      ['Name', name],
      ['Email', email, `mailto:${email}`],
      ['Message', message],
    ],
    links: [['About page', aboutUrl]],
    why: EMAIL_WHY.contact,
  });

  return {
    from: FROM,
    to: CONTACT_TO,
    replyTo: email,
    subject,
    text: rendered.text,
    html: rendered.html,
  };
}
