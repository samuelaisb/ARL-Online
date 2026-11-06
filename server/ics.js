// Calendar invites (.ics) attached to consultation emails. Pure functions. Server only.

import { CONSULTATION_DURATION_MINUTES } from '../src/lib/zoom.js';
import { bareEmailAddress, consultationTitle } from './format.js';
import { FROM, absoluteSiteUrl } from './site.js';

function icsEscape(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function icsFold(line) {
  const chunks = [];
  for (let index = 0; index < line.length; index += 73) {
    chunks.push(line.slice(index, index + 73));
  }
  return chunks.join('\r\n ');
}

function icsTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * RFC 5545 invite (METHOD:REQUEST) or cancellation (METHOD:CANCEL) for a consultation. The UID is
 * the reservation's, so a new time, a handover or a cancellation updates the same calendar event.
 * SEQUENCE is the time it was built, in seconds since 1970 (nothing stores a revision number):
 * calendars apply the highest one for a UID, so a later invite or cancellation always replaces an
 * earlier one, and an old email opened late can't undo it. It fits RFC 5545's integer until 2038.
 */
export function buildConsultationIcs(item, reservation, method) {
  const start = new Date(reservation.meetingAt);
  const end = new Date(start.getTime() + CONSULTATION_DURATION_MINUTES * 60 * 1000);
  const cancelled = method === 'CANCEL';
  const organizer = bareEmailAddress(FROM);
  const attendees = [reservation.userEmail, item.expertEmail].filter(Boolean);
  const description = [
    reservation.zoomJoinUrl ? `Join Zoom: ${reservation.zoomJoinUrl}` : '',
    reservation.zoomPassword ? `Passcode: ${reservation.zoomPassword}` : '',
    `Manage: ${absoluteSiteUrl('/account')}`,
  ]
    .filter(Boolean)
    .join('\n');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Activist Resource Library//Consultations//EN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${reservation.id}@activistresourcelibrary.com`,
    `SEQUENCE:${Math.floor(Date.now() / 1000)}`,
    `DTSTAMP:${icsTimestamp(new Date())}`,
    `DTSTART:${icsTimestamp(start)}`,
    `DTEND:${icsTimestamp(end)}`,
    `SUMMARY:${icsEscape(`${reservation.followUpOf ? 'Follow-up consultation' : 'Consultation'}: ${consultationTitle(item)}`)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    ...(reservation.zoomJoinUrl ? [`LOCATION:${icsEscape(reservation.zoomJoinUrl)}`] : []),
    `ORGANIZER;CN=Activist Resource Library:mailto:${organizer}`,
    ...attendees.map((email) => `ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=FALSE:mailto:${email}`),
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  return {
    filename: cancelled ? 'consultation-cancelled.ics' : 'consultation.ics',
    content: Buffer.from(`${lines.map(icsFold).join('\r\n')}\r\n`, 'utf8'),
    contentType: `text/calendar; charset=utf-8; method=${method}`,
  };
}
