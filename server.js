import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Resend } from 'resend';
import { compareDateKeys, parseDateKey, toDateKey } from './src/lib/calendar.js';
import { EXPERT_LONG_TEXT_MAX, EXPERT_NAME_MAX, EXPERT_SHORT_TEXT_MAX } from './src/lib/expertise-fields.js';
import { validateReservationDates } from './src/lib/reservation-rules.js';
import {
  addReservation,
  approveReservation,
  cancelConsultation,
  checkReservationSchema,
  countPendingReservationsByEmail,
  createInventoryItem,
  createMentorProfileForEmail,
  deleteInventoryItem,
  updateExpertiseItem,
  ensureInventory,
  fetchInventoryItems,
  findInventoryItem,
  findInventoryItemBySlug,
  findMentorProfileByEmail,
  findReservationWithItem,
  isConsultationExpert,
  isConsultationMember,
  isReservationSchemaError,
  isValidInventoryImage,
  isValidTag,
  listConsultationsForUser,
  normalizeInventoryItem,
  reservationSchemaErrorMessage,
  patchReservation,
  refuseReservation,
  removeReservation,
  scheduleConsultation,
  updateMentorProfileForEmail,
} from './src/lib/inventory-store.js';
import {
  CONSULTATION_DURATION_MINUTES,
  CONSULTATION_TIMEZONE,
  createConsultationMeeting,
  deleteConsultationMeeting,
  isZoomConfigured,
} from './src/lib/zoom.js';
import { assertSupabaseAdminConfigured, getSupabaseAdmin } from './src/lib/supabase-server.js';
import { injectSeoIntoHtml, resolveRequestLocale } from './src/lib/seo-server.js';
import { normalizeSeoPath, PRODUCTION_SITE_ORIGIN } from './src/lib/seo.js';
import { orgContact, renderBrandedEmail } from './src/lib/email-brand.js';
import { slugifyTitle } from './src/lib/slug.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const STRICT_PORT = process.env.NODE_ENV === 'development' || process.env.STRICT_PORT === 'true';
const APATHY_ADMIN_DOMAIN = '@apathyisboring.com';
const VALID_RESERVATION_STATUSES = ['pending', 'reserved', 'refused'];
const MAX_PENDING_RESERVATIONS_PER_USER = 5;
const SUPABASE_URL =
  (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');

try {
  assertSupabaseAdminConfigured();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const apiKey = process.env.RESEND_API_KEY;
if (!apiKey) {
  console.warn(
    'RESEND_API_KEY is not set. Reservation notification emails will fail until configured.',
  );
}

let resendClient = null;

function getResend() {
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured. Set it in .env to send emails.');
  }

  if (!resendClient) {
    resendClient = new Resend(apiKey);
  }

  return resendClient;
}

const LEGACY_RESEND_FROM = 'onboarding@resend.dev';
const DEFAULT_EMAIL_FROM = 'noreply@activistresourcelibrary.com';

function resolveEmailFrom() {
  const configured = process.env.EMAIL_FROM?.trim();

  if (configured && configured !== LEGACY_RESEND_FROM) {
    return configured;
  }

  return DEFAULT_EMAIL_FROM;
}

const FROM = resolveEmailFrom();
const SLACK_RESERVATION_WEBHOOK_URL = process.env.SLACK_RESERVATION_WEBHOOK_URL?.trim() || '';
const SITE_URL = (process.env.SITE_URL || process.env.VITE_SITE_URL || '').replace(/\/$/, '');
const EMAIL_SITE_ORIGIN = SITE_URL || PRODUCTION_SITE_ORIGIN;
const PLAUSIBLE_DOMAIN = process.env.PLAUSIBLE_DOMAIN?.trim() || '';
const INDEX_HTML_PATH = path.join(__dirname, 'dist', 'index.html');

let indexHtmlTemplate = '';

function loadIndexHtmlTemplate() {
  try {
    indexHtmlTemplate = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  } catch {
    indexHtmlTemplate = '';
  }
}

loadIndexHtmlTemplate();

/**
 * CSP `script-src` hashes for the inline scripts in the built `index.html`
 * (currently only the Google Analytics gtag bootstrap). Computed at startup so
 * the policy tracks whatever Vite emitted, and we never need `'unsafe-inline'`.
 * Prerendered shells (`dist/{route}/index.html`) and the per-request SEO
 * injection only add JSON-LD data blocks / external scripts, so the same
 * hashes cover every HTML response.
 */
function extractInlineScriptHashes(html) {
  if (!html) {
    return [];
  }

  const hashes = new Set();
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = scriptRe.exec(html))) {
    const attrs = match[1] ?? '';
    const content = match[2] ?? '';

    if (/\bsrc\s*=/i.test(attrs) || !content.trim()) {
      continue;
    }

    const typeMatch = attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i);
    const type = typeMatch ? typeMatch[1].toLowerCase() : '';
    const executable =
      !type || type === 'module' || type === 'text/javascript' || type === 'application/javascript';

    if (!executable) {
      continue;
    }

    const digest = crypto.createHash('sha256').update(content, 'utf8').digest('base64');
    hashes.add(`'sha256-${digest}'`);
  }

  return [...hashes];
}

const INLINE_SCRIPT_HASHES = extractInlineScriptHashes(indexHtmlTemplate);

function absoluteSiteUrl(pathOrUrl) {
  if (!pathOrUrl) {
    return EMAIL_SITE_ORIGIN;
  }

  if (/^https?:\/\//i.test(pathOrUrl)) {
    return pathOrUrl;
  }

  const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
  return `${EMAIL_SITE_ORIGIN}${path}`;
}

function itemPagePath(item) {
  const tag = typeof item?.tag === 'string' && item.tag.trim() ? item.tag.trim() : 'equipment';
  const slug =
    typeof item?.slug === 'string' && item.slug.trim() ? item.slug.trim() : slugifyTitle(item?.title);

  return `/${tag}/${encodeURIComponent(slug)}`;
}

function itemPageUrl(item) {
  return absoluteSiteUrl(itemPagePath(item));
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  const token =
    typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : '';

  if (!token) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  try {
    const { data, error } = await getSupabaseAdmin().auth.getUser(token);

    if (error || !data.user) {
      return res.status(401).json({ error: 'Invalid or expired session.' });
    }

    req.user = data.user;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(401).json({ error: 'Authentication failed.' });
  }
}

function isConfirmedUser(user) {
  return Boolean(user?.email_confirmed_at || user?.confirmed_at);
}

function isAdminUser(user) {
  const email = user?.email?.trim().toLowerCase() ?? '';
  return email.endsWith(APATHY_ADMIN_DOMAIN) && isConfirmedUser(user);
}

function requireAdmin(req, res, next) {
  const email = req.user?.email?.trim();

  if (!email || !email.toLowerCase().endsWith(APATHY_ADMIN_DOMAIN)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  if (!isConfirmedUser(req.user)) {
    return res.status(403).json({ error: 'Admin email must be confirmed.' });
  }

  next();
}

function auditAdminAction(req, action, details = {}) {
  console.log('[admin-audit]', {
    email: req.user?.email ?? 'unknown',
    action,
    ...details,
  });
}

function sanitizeReservationForPublic(reservation) {
  return {
    id: reservation.id,
    startDate: reservation.startDate,
    endDate: reservation.endDate,
    status: reservation.status,
  };
}

function sanitizeItemForPublic(item) {
  // expertEmail is admin-only contact info — never expose it on public routes.
  const { expertEmail, ...publicItem } = item;
  return {
    ...publicItem,
    reservations: (item.reservations ?? []).map(sanitizeReservationForPublic),
  };
}

const reservationCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reservation requests. Please try again later.' },
});

const CONTACT_TO = 'samuel@apathyisboring.com';
const CONTACT_NAME_MAX = 120;
const CONTACT_MESSAGE_MAX = 5000;

const contactFormLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many contact form submissions. Please try again later.' },
});

const welcomeEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many welcome email requests. Please try again later.' },
});

const WELCOME_EMAIL_SIGNUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const APPROVAL_PICKUP_NOTICE = `Pickups and drop offs are between 10am and 5pm on Tuesdays at ${orgContact.address}.`;

const WELCOME_EQUIPMENT_PICKUP_NOTICE = `Equipment reservations are typically on Tuesdays at ${orgContact.address}.`;

// TODO: replace with the real YES Employment participant data-sharing form URL.
const CONSULTATION_DATA_FORM_URL = 'https://REPLACE-ME.example/participant-info';

const CONSULTATION_FUNDING_NOTICE = 'This project is funded by YES Employment.';

const CONSULTATION_DATA_NOTICE =
  'To meet our deliverables, can you share more data about who you are?';

const EMAIL_WHY = {
  reservation:
    'You are receiving this because you requested an item from the Activist Resource Library.',
  consultationMember:
    'You are receiving this because you requested a consultation through the Activist Resource Library.',
  consultationExpert:
    'You are receiving this because your email is listed as the expert for an Activist Resource Library consultation.',
  welcome:
    'You are receiving this because you created an Activist Resource Library member account.',
  contact: 'This message was sent from the Activist Resource Library About page.',
};

function formatMeetingDateTime(meetingAt) {
  const date = new Date(meetingAt);
  if (Number.isNaN(date.getTime())) {
    return typeof meetingAt === 'string' ? meetingAt : '';
  }

  const formatted = new Intl.DateTimeFormat('en-CA', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: CONSULTATION_TIMEZONE,
  }).format(date);
  return `${formatted} (Montreal time)`;
}

function trimmedOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function consultationTitle(item) {
  return trimmedOrNull(item?.title) ?? 'Consultation';
}

function bareEmailAddress(address) {
  const match = /<([^>]+)>/.exec(address ?? '');
  return (match ? match[1] : address ?? '').trim();
}

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
    to,
    subject,
    text: rendered.text,
    html: rendered.html,
    attachments: [...rendered.attachments, ...(attachments ?? [])],
  };
}

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

/** RFC 5545 invite (METHOD:REQUEST) or cancellation (METHOD:CANCEL) for a consultation. */
function buildConsultationIcs(item, reservation, method) {
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
    `SEQUENCE:${cancelled ? 1 : 0}`,
    `DTSTAMP:${icsTimestamp(new Date())}`,
    `DTSTART:${icsTimestamp(start)}`,
    `DTEND:${icsTimestamp(end)}`,
    `SUMMARY:${icsEscape(`Consultation: ${consultationTitle(item)}`)}`,
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

function zoomDetailRows(reservation) {
  return [['Passcode', reservation.zoomPassword]];
}

function consultationCta(reservation, accountUrl) {
  if (reservation.zoomJoinUrl) {
    return { label: 'Join Zoom', href: reservation.zoomJoinUrl };
  }
  return { label: 'Your account panel', href: accountUrl };
}

const ZOOM_ROOM_NOTICE =
  'You can join before the host, and everyone in the meeting can share their screen.';
const NO_ZOOM_NOTICE = 'We will send you a meeting link by email before your consultation.';

/** New request → the item's expert, with a link to their account panel. */
function buildExpertRequestEmailPayload(item, reservation) {
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
    intro: 'A member has requested a consultation with you through the Activist Resource Library.',
    details: [
      ['Consultation', title],
      ['Member', reservation.userEmail],
      ['Their available time slots', reservation.timeSlots],
      ['What they would like to discuss', reservation.requestSummary],
    ],
    paragraphs: [
      `Open your account panel to pick a meeting date and time. Log in (or register) with ${to} to see the request. Once you choose a time, we create a Zoom meeting and email the invitation to you both.`,
    ],
    cta: { label: 'Schedule this meeting', href: accountUrl },
    why: EMAIL_WHY.consultationExpert,
  });
}

/** Scheduled → member and expert, each with the Zoom link and a calendar invite. */
function buildConsultationScheduledEmailPayloads(item, reservation) {
  const title = consultationTitle(item);
  const meetingTime = formatMeetingDateTime(reservation.meetingAt);
  const accountUrl = absoluteSiteUrl('/account');
  const roomNotice = reservation.zoomJoinUrl ? ZOOM_ROOM_NOTICE : NO_ZOOM_NOTICE;
  const cancelNotice = 'Need to cancel? You can do it from your account panel; we will let the other person know.';
  const payloads = [];
  const memberEmail = trimmedOrNull(reservation.userEmail);
  const expertEmail = trimmedOrNull(item.expertEmail);

  if (memberEmail) {
    const cta = consultationCta(reservation, accountUrl);
    payloads.push(
      buildConsultationEmail({
        to: memberEmail,
        subject: `Consultation confirmed: ${title}`,
        heading: 'Consultation confirmed',
        intro: `Your consultation is booked for ${meetingTime} with ${expertEmail ?? title}.`,
        details: [['Consultation', title, itemPageUrl(item)], ['When', meetingTime], ...zoomDetailRows(reservation)],
        paragraphs: [roomNotice, CONSULTATION_FUNDING_NOTICE, CONSULTATION_DATA_NOTICE, cancelNotice],
        cta,
        links: [
          ['Share your information', CONSULTATION_DATA_FORM_URL],
          ...(cta.href === accountUrl ? [] : [['Your account panel', accountUrl]]),
        ],
        why: EMAIL_WHY.consultationMember,
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
        subject: `Consultation scheduled: ${title}`,
        heading: 'Consultation scheduled',
        intro: `Your consultation with ${memberEmail ?? 'a member'} is booked for ${meetingTime}.`,
        details: [
          ['Consultation', title],
          ['When', meetingTime],
          ['Member', memberEmail],
          ['What they would like to discuss', reservation.requestSummary],
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

const CANCELLED_BY_LABELS = {
  member: 'the member',
  expert: 'the expert',
  admin: 'the Activist Resource Library team',
};

/** Cancelled → member and expert; scheduled meetings also get an iCalendar CANCEL. */
function buildConsultationCancelledEmailPayloads(item, reservation, previousStatus) {
  const title = consultationTitle(item);
  const wasScheduled = previousStatus === 'reserved' && reservation.meetingAt;
  const meetingTime = wasScheduled ? formatMeetingDateTime(reservation.meetingAt) : '';
  const cancelledBy = reservation.cancelledBy;
  const libraryUrl = absoluteSiteUrl('/');
  const recipients = [
    ['member', trimmedOrNull(reservation.userEmail)],
    ['expert', trimmedOrNull(item.expertEmail)],
  ];

  return recipients
    .filter(([, email]) => email)
    .map(([role, email]) => {
      const byYou = role === cancelledBy;
      const who = byYou ? 'You' : CANCELLED_BY_LABELS[cancelledBy] ?? 'Someone';
      const what = wasScheduled
        ? `the consultation scheduled for ${meetingTime}`
        : 'the consultation request';
      const intro = `${who.charAt(0).toUpperCase()}${who.slice(1)} cancelled ${what}.`;
      const closing =
        role === 'member'
          ? 'You are welcome to submit a new request whenever it suits you.'
          : 'No further action is needed.';

      return buildConsultationEmail({
        to: email,
        subject: `Consultation cancelled: ${title}`,
        heading: 'Consultation cancelled',
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

async function sendEmailPayloads(payloads, label) {
  const results = await Promise.allSettled(
    payloads.filter(Boolean).map(async (payload) => {
      const { error } = await getResend().emails.send(payload);
      if (error) {
        throw new Error(error.message || `Failed to send ${label} email.`);
      }
    }),
  );

  for (const result of results) {
    if (result.status === 'rejected') {
      console.error(`${label} email failed:`, result.reason);
    }
  }
}

function buildConsultationRequestEmailPayload(item, reservation) {
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

/** Member "request received" + expert "new request" on consultation create. */
async function sendConsultationRequestEmails(item, reservation) {
  if (!item.expertEmail) {
    console.warn(`Consultation ${reservation.id}: item ${item.id} has no expert email; only admins can schedule it.`);
  }

  await sendEmailPayloads(
    [
      buildConsultationRequestEmailPayload(item, reservation),
      buildExpertRequestEmailPayload(item, reservation),
    ],
    'Consultation request',
  );
}

function buildMemberDecisionEmailPayload(item, reservation, decision) {
  if (item?.tag === 'expertise') {
    // Approved consultations send buildConsultationScheduledEmailPayloads instead.
    return decision === 'refused' ? buildConsultationDecisionEmailPayload(item, reservation) : null;
  }

  const title = typeof item.title === 'string' ? item.title.trim() : 'Inventory item';
  const startDate =
    typeof reservation?.startDate === 'string' ? reservation.startDate.trim() : '';
  const endDate = typeof reservation?.endDate === 'string' ? reservation.endDate.trim() : '';
  const dateRange =
    startDate && endDate ? `${startDate} to ${endDate}` : startDate || endDate || '';
  const to =
    typeof reservation?.userEmail === 'string' && reservation.userEmail.trim()
      ? reservation.userEmail.trim()
      : null;

  if (!to) {
    return null;
  }

  const approved = decision === 'approved';
  const subject = approved
    ? `Reservation confirmed: ${title}`
    : `Reservation update: ${title}`;
  const intro = approved
    ? 'Your reservation request has been approved by Apathy is Boring.'
    : 'Unfortunately, the item you requested is not available for those dates.';
  const closing = approved
    ? 'We look forward to seeing you at pickup.'
    : 'Please choose different dates or another item from the library.';
  const itemUrl = itemPageUrl(item);
  const libraryUrl = absoluteSiteUrl('/');

  const rendered = renderBrandedEmail({
    subject,
    preheader: intro,
    headline: approved ? 'Reservation confirmed' : 'Reservation not available',
    intro,
    details: [
      ['Item', title, itemUrl],
      ['Dates', dateRange],
    ],
    paragraphs: [approved ? APPROVAL_PICKUP_NOTICE : '', closing].filter(Boolean),
    cta: { label: approved ? 'View your item' : 'Choose different dates', href: itemUrl },
    links: [['Browse the library', libraryUrl]],
    why: EMAIL_WHY.reservation,
  });

  return {
    from: FROM,
    to,
    subject,
    text: rendered.text,
    html: rendered.html,
    attachments: rendered.attachments,
  };
}

async function sendMemberDecisionEmail(item, reservation, decision) {
  const emailPayload = buildMemberDecisionEmailPayload(item, reservation, decision);

  if (!emailPayload) {
    console.warn(`Skipping ${decision} email: no member email on reservation ${reservation?.id}.`);
    return null;
  }

  const { data, error } = await getResend().emails.send(emailPayload);

  if (error) {
    throw new Error(error.message || `Failed to send ${decision} email.`);
  }

  return data;
}

function isWithinWelcomeEmailSignupWindow(user) {
  const created = user?.created_at;
  if (!created) {
    return true;
  }

  const createdMs = Date.parse(created);
  if (Number.isNaN(createdMs)) {
    return true;
  }

  return Date.now() - createdMs < WELCOME_EMAIL_SIGNUP_WINDOW_MS;
}

function buildWelcomeEmailPayload(email) {
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
    to,
    subject,
    text: rendered.text,
    html: rendered.html,
    attachments: rendered.attachments,
  };
}

/** In-process per-user lock — safe for single-instance Cloud Run only, not across replicas. */
const welcomeEmailLocks = new Map();

async function withWelcomeEmailLock(userId, fn) {
  const waitFor = welcomeEmailLocks.get(userId) ?? Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  welcomeEmailLocks.set(userId, waitFor.then(() => next));

  await waitFor;
  try {
    return await fn();
  } finally {
    release();
    if (welcomeEmailLocks.get(userId) === next) {
      welcomeEmailLocks.delete(userId);
    }
  }
}

async function sendWelcomeEmailIfNeeded(user) {
  const userId = user?.id;
  if (!userId) {
    return { sent: false, reason: 'no_user' };
  }

  return withWelcomeEmailLock(userId, async () => {
    const { data: freshData, error: fetchError } = await getSupabaseAdmin().auth.admin.getUserById(
      userId,
    );

    if (fetchError) {
      throw new Error(fetchError.message || 'Failed to load user for welcome email.');
    }

    const freshUser = freshData.user;

    if (freshUser?.user_metadata?.welcome_email_sent) {
      return { sent: false, reason: 'already_sent' };
    }

    if (!isWithinWelcomeEmailSignupWindow(freshUser)) {
      return { sent: false, reason: 'signup_window_expired' };
    }

    const email = freshUser?.email?.trim();
    const emailPayload = buildWelcomeEmailPayload(email);

    if (!emailPayload) {
      return { sent: false, reason: 'no_email' };
    }

    const existingMetadata =
      freshUser.user_metadata && typeof freshUser.user_metadata === 'object'
        ? freshUser.user_metadata
        : {};

    const { error: claimError } = await getSupabaseAdmin().auth.admin.updateUserById(userId, {
      user_metadata: { ...existingMetadata, welcome_email_sent: true },
    });

    if (claimError) {
      throw new Error(claimError.message || 'Failed to claim welcome email send.');
    }

    const { error } = await getResend().emails.send(emailPayload);

    if (error) {
      console.error('Welcome email send failed after metadata claim:', error);
      throw new Error(error.message || 'Failed to send welcome email.');
    }

    return { sent: true };
  });
}

function isValidEmailAddress(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function buildContactEmailPayload({ name, email, message }) {
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
    attachments: rendered.attachments,
  };
}

const MEETING_PAST_GRACE_MS = 5 * 60 * 1000;

async function createZoomMeetingForConsultation(item, reservation) {
  if (!isZoomConfigured()) {
    console.warn(`Zoom is not configured; consultation ${reservation.id} scheduled without a meeting.`);
    return null;
  }

  try {
    return await createConsultationMeeting({
      topic: `ARL consultation: ${consultationTitle(item)}`,
      startTime: reservation.meetingAt,
    });
  } catch (error) {
    console.error(`Zoom meeting creation failed for consultation ${reservation.id}:`, error);
    const wrapped = new Error('Could not create the Zoom meeting.');
    wrapped.zoomFailed = true;
    throw wrapped;
  }
}

async function removeZoomMeeting(reservation) {
  if (!reservation?.zoomMeetingId || !isZoomConfigured()) {
    return;
  }

  try {
    await deleteConsultationMeeting(reservation.zoomMeetingId);
  } catch (error) {
    console.error(
      `Could not delete Zoom meeting ${reservation.zoomMeetingId} for consultation ${reservation.id}:`,
      error,
    );
  }
}

/** Deletes the Zoom meeting (if any) and emails member + expert about a cancellation. */
async function handleConsultationCancelled(item, reservation, previousStatus) {
  if (previousStatus === 'reserved') {
    await removeZoomMeeting(reservation);
  }

  sendEmailPayloads(
    buildConsultationCancelledEmailPayloads(item, reservation, previousStatus),
    'Consultation cancelled',
  ).catch((error) => console.error('Consultation cancelled emails failed:', error));
}

function validateMeetingAt(meetingAt) {
  const parsed = typeof meetingAt === 'string' && meetingAt.trim() ? Date.parse(meetingAt.trim()) : NaN;

  if (Number.isNaN(parsed)) {
    return 'A valid meeting date and time is required to schedule a consultation.';
  }

  if (parsed < Date.now() - MEETING_PAST_GRACE_MS) {
    return 'The meeting time must be in the future.';
  }

  return null;
}

/**
 * Shared by the expert account panel and the admin approve route. Returns
 * `{ status, body, result }` so each route can shape its own success payload.
 */
async function runScheduleConsultation({ itemId, reservationId, meetingAt }) {
  const meetingError = validateMeetingAt(meetingAt);
  if (meetingError) {
    return { status: 400, body: { error: meetingError } };
  }

  let result;
  try {
    result = await scheduleConsultation(itemId, reservationId, {
      meetingAt: meetingAt.trim(),
      createMeeting: createZoomMeetingForConsultation,
      deleteMeeting: deleteConsultationMeeting,
    });
  } catch (error) {
    if (error.zoomFailed) {
      return {
        status: 502,
        body: { error: 'Could not create the Zoom meeting. Please try again in a moment.' },
      };
    }
    throw error;
  }

  if (result.notFound || result.reservationNotFound) {
    return { status: 404, body: { error: 'Consultation not found.' } };
  }

  if (result.invalidStatus) {
    return { status: 400, body: { error: 'Only pending consultation requests can be scheduled.' } };
  }

  if (result.meetingTimeRequired) {
    return {
      status: 400,
      body: { error: 'A valid meeting date and time is required to schedule a consultation.' },
    };
  }

  sendEmailPayloads(
    buildConsultationScheduledEmailPayloads(result.item, result.reservation),
    'Consultation scheduled',
  ).catch((error) => console.error('Consultation scheduled emails failed:', error));

  return { status: 200, result };
}

/** Account-panel view of one consultation; each role only sees the other party's email. */
function serializeConsultationForUser({ item, reservation }, role) {
  const active = reservation.status === 'reserved';

  return {
    id: reservation.id,
    role,
    itemId: item.id,
    itemTitle: item.title,
    itemPath: itemPagePath(item),
    status: reservation.status,
    requestedOn: reservation.startDate,
    timeSlots: reservation.timeSlots ?? null,
    requestSummary: reservation.requestSummary ?? null,
    meetingAt: reservation.meetingAt ?? null,
    zoomJoinUrl: active ? reservation.zoomJoinUrl ?? null : null,
    zoomPassword: active ? reservation.zoomPassword ?? null : null,
    cancelledBy: reservation.cancelledBy ?? null,
    memberEmail: role === 'expert' ? reservation.userEmail ?? null : null,
    expertEmail: role === 'member' ? item.expertEmail ?? null : null,
  };
}

/** Resolves the caller's relationship to a consultation (member, expert, admin). */
async function loadConsultationForUser(user, reservationId) {
  const found = await findReservationWithItem(reservationId);

  if (!found || found.item.tag !== 'expertise') {
    return null;
  }

  const email = user?.email ?? '';
  const isMember = isConsultationMember(found.reservation, email);
  const isExpert = isConfirmedUser(user) && isConsultationExpert(found.item, email);
  const isAdmin = isAdminUser(user);

  if (!isMember && !isExpert && !isAdmin) {
    return null;
  }

  return { ...found, isMember, isExpert, isAdmin };
}

function reservationItemPayload(item) {
  const sanitized = sanitizeItemForPublic(item);
  return { id: sanitized.id, reservations: sanitized.reservations };
}

async function notifySlackReservation({ item, reservation }) {
  if (!SLACK_RESERVATION_WEBHOOK_URL) {
    return;
  }

  const payload = {
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

  try {
    const response = await fetch(SLACK_RESERVATION_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error(
        `Slack reservation webhook failed (${response.status}): ${body || response.statusText}`,
      );
    }
  } catch (error) {
    console.error('Slack reservation webhook error:', error);
  }
}

const INVENTORY_ASSETS_DIR = path.join(__dirname, 'src', 'assets', 'inventory');
const INVENTORY_IMAGE_BASE = '/assets/inventory';

/** Public client config — anon key only; loaded before the SPA bundle in production. */
function getPublicClientConfig() {
  return {
    SUPABASE_URL: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '',
    SUPABASE_API:
      process.env.SUPABASE_API ||
      process.env.SUPABASE_ANON_KEY ||
      process.env.VITE_SUPABASE_ANON_KEY ||
      '',
    SITE_URL: (process.env.SITE_URL || process.env.VITE_SITE_URL || '').replace(/\/$/, ''),
  };
}

app.get('/config.js', (_req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store');
  res.send(`window.__ARL_ENV__=${JSON.stringify(getPublicClientConfig())};`);
});

const connectSrc = ["'self'"];
if (SUPABASE_URL) {
  connectSrc.push(SUPABASE_URL);
}
if (PLAUSIBLE_DOMAIN) {
  connectSrc.push('https://plausible.io');
}
connectSrc.push(
  'https://*.google-analytics.com',
  'https://analytics.google.com',
  'https://*.analytics.google.com',
  'https://*.googletagmanager.com',
);

// No 'unsafe-inline': inline scripts are allowed only by hash (see
// extractInlineScriptHashes). Add new inline scripts to index.html and rebuild;
// the hash list refreshes on server start.
const scriptSrc = ["'self'", ...INLINE_SCRIPT_HASHES];
if (PLAUSIBLE_DOMAIN) {
  scriptSrc.push('https://plausible.io');
}
scriptSrc.push('https://*.googletagmanager.com');

// GA can fall back to image beacons when sendBeacon/fetch is unavailable.
const imgSrc = ["'self'", 'data:', 'https://*.google-analytics.com', 'https://*.googletagmanager.com'];

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc,
        connectSrc,
        scriptSrc,
        styleSrc: ["'self'", "'unsafe-inline'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  }),
);

app.post('/api/inventory', express.json({ limit: '10mb' }), requireAuth, requireAdmin, async (req, res) => {
  const tagProvided =
    req.body?.tag !== undefined && req.body?.tag !== null && String(req.body.tag).trim() !== '';

  if (tagProvided && !isValidTag(req.body.tag)) {
    return res.status(400).json({ error: 'Tag must be equipment, books, rooms, or expertise.' });
  }

  const image = typeof req.body?.image === 'string' ? req.body.image.trim() : '';
  if (!isValidInventoryImage(image)) {
    return res.status(400).json({
      error: 'Image must be a JPEG or WebP data URL or a path under /assets/inventory/.',
    });
  }

  const expertEmail =
    typeof req.body?.expertEmail === 'string' ? req.body.expertEmail.trim() : '';

  if (expertEmail && !isValidEmailAddress(expertEmail)) {
    return res.status(400).json({ error: 'Expert email must be a valid email address.' });
  }

  const isExpertiseCreate = tagProvided && String(req.body.tag).trim().toLowerCase() === 'expertise';
  const shortText = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  const longText = typeof req.body?.longBody === 'string' ? req.body.longBody.trim() : '';

  if (isExpertiseCreate) {
    const titleText = typeof req.body?.title === 'string' ? req.body.title.trim() : '';

    if (!titleText || !shortText || !longText) {
      return res.status(400).json({
        error: 'Name, short text, long text, and image are required for an expertise item.',
      });
    }

    if (shortText.length > EXPERT_SHORT_TEXT_MAX) {
      return res.status(400).json({
        error: `Short text must be ${EXPERT_SHORT_TEXT_MAX} characters or fewer.`,
      });
    }

    if (longText.length > EXPERT_LONG_TEXT_MAX) {
      return res.status(400).json({
        error: `Long text must be ${EXPERT_LONG_TEXT_MAX} characters or fewer.`,
      });
    }
  }

  const item = normalizeInventoryItem(req.body);

  if (!item) {
    return res.status(400).json({ error: 'Title, body, and image are required.' });
  }

  try {
    await ensureInventory();
    const savedItem = await createInventoryItem(item);
    auditAdminAction(req, 'create_inventory_item', { itemId: savedItem.id });
    res.status(201).json({ item: savedItem });
  } catch (error) {
    console.error('Failed to save inventory item:', error);
    const detail = error?.message || '';
    res.status(500).json({
      error: isReservationSchemaError(detail)
        ? reservationSchemaErrorMessage()
        : 'Could not save inventory item.',
    });
  }
});

app.patch(
  '/api/inventory/:id',
  express.json({ limit: '10mb' }),
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';

    if (!id) {
      return res.status(400).json({ error: 'Item id is required.' });
    }

    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const shortText = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    const longText = typeof req.body?.longBody === 'string' ? req.body.longBody.trim() : '';
    const expertEmail =
      typeof req.body?.expertEmail === 'string' ? req.body.expertEmail.trim() : '';
    const imageProvided = typeof req.body?.image === 'string' && req.body.image.trim() !== '';
    const image = imageProvided ? req.body.image.trim() : '';

    if (!title || !shortText || !longText) {
      return res.status(400).json({
        error: 'Name, short text, and long text are required.',
      });
    }

    if (shortText.length > EXPERT_SHORT_TEXT_MAX) {
      return res.status(400).json({
        error: `Short text must be ${EXPERT_SHORT_TEXT_MAX} characters or fewer.`,
      });
    }

    if (longText.length > EXPERT_LONG_TEXT_MAX) {
      return res.status(400).json({
        error: `Long text must be ${EXPERT_LONG_TEXT_MAX} characters or fewer.`,
      });
    }

    if (expertEmail && !isValidEmailAddress(expertEmail)) {
      return res.status(400).json({ error: 'Expert email must be a valid email address.' });
    }

    if (imageProvided && !isValidInventoryImage(image)) {
      return res.status(400).json({
        error: 'Image must be a JPEG or WebP data URL or a path under /assets/inventory/.',
      });
    }

    try {
      const result = await updateExpertiseItem(id, {
        title,
        body: shortText,
        longBody: longText,
        expertEmail: expertEmail || null,
        ...(imageProvided ? { image } : {}),
      });

      if (result.notFound) {
        return res.status(404).json({ error: 'Item not found.' });
      }

      if (result.notExpertise) {
        return res.status(400).json({ error: 'Only expertise mentors can be edited here.' });
      }

      auditAdminAction(req, 'update_expertise_item', { itemId: id });
      res.json({ item: result.item });
    } catch (error) {
      console.error('Failed to update mentor:', error);
      const detail = error?.message || '';
      res.status(500).json({
        error: isReservationSchemaError(detail)
          ? reservationSchemaErrorMessage()
          : 'Could not update mentor.',
      });
    }
  },
);

function serializeMentorProfile(item) {
  return {
    id: item.id,
    title: item.title,
    body: item.body,
    longBody: item.longBody ?? null,
    image: item.image,
    tag: item.tag,
    slug: item.slug ?? null,
    createdAt: item.createdAt,
    expertEmail: item.expertEmail ?? null,
  };
}

function readMentorProfileInput(body, { imageRequired }) {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const shortText = typeof body?.body === 'string' ? body.body.trim() : '';
  const longText = typeof body?.longBody === 'string' ? body.longBody.trim() : '';
  const image = typeof body?.image === 'string' ? body.image.trim() : '';

  if (!title || !shortText || !longText || (imageRequired && !image)) {
    return { error: 'Name, short text, long text, and a photo are required.' };
  }

  if (title.length > EXPERT_NAME_MAX) {
    return { error: `Name must be ${EXPERT_NAME_MAX} characters or fewer.` };
  }

  if (shortText.length > EXPERT_SHORT_TEXT_MAX) {
    return { error: `Short text must be ${EXPERT_SHORT_TEXT_MAX} characters or fewer.` };
  }

  if (longText.length > EXPERT_LONG_TEXT_MAX) {
    return { error: `Long text must be ${EXPERT_LONG_TEXT_MAX} characters or fewer.` };
  }

  if (image && !isValidInventoryImage(image)) {
    return {
      error: 'Image must be a JPEG or WebP data URL or a path under /assets/inventory/.',
    };
  }

  return {
    fields: {
      title,
      body: shortText,
      longBody: longText,
      image,
    },
  };
}

function confirmedAccountEmail(req, res) {
  const email = req.user?.email?.trim() ?? '';

  if (!email) {
    res.status(400).json({ error: 'Your account has no email address.' });
    return '';
  }

  if (!isConfirmedUser(req.user)) {
    res.status(403).json({ error: 'Confirm your email address before sharing expertise.' });
    return '';
  }

  return email;
}

function sendMentorProfileError(res, error, fallback) {
  console.error(fallback, error);
  const detail = error?.message || '';
  res.status(500).json({
    error: isReservationSchemaError(detail) ? reservationSchemaErrorMessage() : fallback,
  });
}

const mentorProfileJson = express.json({ limit: '10mb' });

const mentorProfileLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many mentor profile updates. Please try again later.' },
});

app.get('/api/account/mentor-profile', requireAuth, async (req, res) => {
  const email = req.user?.email?.trim() ?? '';

  if (!isConfirmedUser(req.user)) {
    res.set('Cache-Control', 'no-store');
    return res.json({ profile: null, emailConfirmed: false });
  }

  try {
    await ensureInventory();
    const item = await findMentorProfileByEmail(email);
    res.set('Cache-Control', 'no-store');
    res.json({
      profile: item ? serializeMentorProfile(item) : null,
      emailConfirmed: true,
    });
  } catch (error) {
    sendMentorProfileError(res, error, 'Could not load your mentor profile.');
  }
});

app.post(
  '/api/account/mentor-profile',
  mentorProfileJson,
  mentorProfileLimiter,
  requireAuth,
  async (req, res) => {
    const email = confirmedAccountEmail(req, res);

    if (!email) {
      return;
    }

    const input = readMentorProfileInput(req.body, { imageRequired: true });

    if (input.error) {
      return res.status(400).json({ error: input.error });
    }

    try {
      await ensureInventory();
      const result = await createMentorProfileForEmail(email, input.fields);

      if (result.invalid) {
        return res.status(400).json({ error: 'Name, short text, long text, and a photo are required.' });
      }

      if (result.alreadyExists) {
        return res.status(409).json({
          error: 'You already have a mentor profile.',
          profile: serializeMentorProfile(result.item),
        });
      }

      console.log('[mentor-profile]', { action: 'create', email, itemId: result.item.id });
      res.status(201).json({ profile: serializeMentorProfile(result.item) });
    } catch (error) {
      sendMentorProfileError(res, error, 'Could not save your mentor profile.');
    }
  },
);

app.patch(
  '/api/account/mentor-profile',
  mentorProfileJson,
  mentorProfileLimiter,
  requireAuth,
  async (req, res) => {
    const email = confirmedAccountEmail(req, res);

    if (!email) {
      return;
    }

    const input = readMentorProfileInput(req.body, { imageRequired: false });

    if (input.error) {
      return res.status(400).json({ error: input.error });
    }

    try {
      await ensureInventory();
      const result = await updateMentorProfileForEmail(email, input.fields);

      if (result.invalid) {
        return res.status(400).json({ error: 'Name, short text, and long text are required.' });
      }

      if (result.notFound) {
        return res.status(404).json({ error: 'You do not have a mentor profile yet.' });
      }

      console.log('[mentor-profile]', { action: 'update', email, itemId: result.item.id });
      res.json({ profile: serializeMentorProfile(result.item) });
    } catch (error) {
      sendMentorProfileError(res, error, 'Could not save your mentor profile.');
    }
  },
);

app.use(express.json({ limit: '100kb' }));

const SITEMAP_STATIC_PATHS = [
  '/',
  '/howthisworks',
  '/about',
  '/privacy',
  '/equipment',
  '/books',
  '/rooms',
  '/expertise',
];

function formatSitemapLastmod(timestamp) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return new Date().toISOString().slice(0, 10);
  }

  return new Date(timestamp).toISOString().slice(0, 10);
}

app.get('/sitemap.xml', async (_req, res) => {
  try {
    const origin = SITE_URL || PRODUCTION_SITE_ORIGIN;
    await ensureInventory();
    const items = await fetchInventoryItems();

    const staticUrls = SITEMAP_STATIC_PATHS.map((routePath) => {
      const loc = routePath === '/' ? `${origin}/` : `${origin}${routePath}`;
      return `  <url>\n    <loc>${loc}</loc>\n  </url>`;
    });

    const itemUrls = items
      .filter((item) => item.slug && item.tag)
      .map((item) => {
        const loc = `${origin}/${item.tag}/${encodeURIComponent(item.slug)}`;
        const lastmod = formatSitemapLastmod(item.createdAt);
        return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`;
      });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...staticUrls, ...itemUrls].join('\n')}\n</urlset>\n`;

    res.type('application/xml');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(xml);
  } catch (error) {
    console.error('Failed to build sitemap:', error);
    res.status(500).type('text/plain').send('Could not generate sitemap.');
  }
});

app.use('/assets/fonts', express.static(path.join(__dirname, 'src', 'assets', 'fonts')));
app.use('/assets/brand', express.static(path.join(__dirname, 'src', 'assets', 'brand')));
app.use(INVENTORY_IMAGE_BASE, express.static(INVENTORY_ASSETS_DIR));
// Hashed JS/CSS and robots.txt only. `index: false` + `redirect: false` keep
// every HTML route (including `/`) on the catch-all below so it receives
// per-request SEO injection (locale-aware title/description/canonical/hreflang/
// JSON-LD) instead of the raw template, and so `/about` is never 301'd to
// `/about/` (which broke canonical URLs and sitemap entries).
app.use(express.static(path.join(__dirname, 'dist'), { index: false, redirect: false }));

app.get('/api/inventory/by-slug/:tag/:slug', async (req, res) => {
  const tag = typeof req.params.tag === 'string' ? req.params.tag.trim() : '';
  const slug = typeof req.params.slug === 'string' ? req.params.slug.trim() : '';

  if (!isValidTag(tag)) {
    return res.status(400).json({ error: 'Tag must be equipment, books, rooms, or expertise.' });
  }

  if (!slug) {
    return res.status(400).json({ error: 'Slug is required.' });
  }

  try {
    await ensureInventory();
    const item = await findInventoryItemBySlug(tag, slug);

    if (!item) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    res.set('Cache-Control', 'public, max-age=300');
    res.json({ item: sanitizeItemForPublic(item) });
  } catch (error) {
    console.error('Failed to read inventory item by slug:', error);
    res.status(500).json({ error: 'Could not load inventory item.' });
  }
});

app.get('/api/inventory', async (_req, res) => {
  try {
    const items = await ensureInventory();
    res.set('Cache-Control', 'no-store');
    res.json({ items: items.map(sanitizeItemForPublic) });
  } catch (error) {
    console.error('Failed to read inventory:', error);
    res.status(500).json({ error: 'Could not load inventory.' });
  }
});

app.get('/api/admin/inventory', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const items = await ensureInventory();
    res.set('Cache-Control', 'no-store');
    res.json({ items });
  } catch (error) {
    console.error('Failed to read admin inventory:', error);
    res.status(500).json({ error: 'Could not load inventory.' });
  }
});

const CONSULTATION_TIME_SLOTS_MAX = 500;
const CONSULTATION_SUMMARY_MAX = 2000;

app.post('/api/inventory/:id/reservations', reservationCreateLimiter, requireAuth, async (req, res) => {
  const itemId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
  const userEmail = req.user?.email?.trim() || null;

  if (!itemId) {
    return res.status(400).json({ error: 'Item id is required.' });
  }

  try {
    await ensureInventory();
    const item = await findInventoryItem(itemId);

    if (!item) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    const isExpertise = item.tag === 'expertise';
    let startDate;
    let endDate;
    let timeSlots = null;
    let requestSummary = null;

    if (isExpertise) {
      // Consultation request: free-text availability + summary, no calendar dates.
      timeSlots = typeof req.body?.timeSlots === 'string' ? req.body.timeSlots.trim() : '';
      requestSummary = typeof req.body?.summary === 'string' ? req.body.summary.trim() : '';

      if (!timeSlots || !requestSummary) {
        return res.status(400).json({
          error: 'Please include your available time slots and a summary of your request.',
        });
      }

      if (timeSlots.length > CONSULTATION_TIME_SLOTS_MAX) {
        return res.status(400).json({
          error: `Time slots must be ${CONSULTATION_TIME_SLOTS_MAX} characters or fewer.`,
        });
      }

      if (requestSummary.length > CONSULTATION_SUMMARY_MAX) {
        return res.status(400).json({
          error: `Summary must be ${CONSULTATION_SUMMARY_MAX} characters or fewer.`,
        });
      }

      // Reservations require dates; store the submission date for consultations.
      startDate = toDateKey(new Date());
      endDate = startDate;
    } else {
      startDate = typeof req.body?.startDate === 'string' ? req.body.startDate.trim() : '';
      endDate = typeof req.body?.endDate === 'string' ? req.body.endDate.trim() : '';

      if (!startDate || !endDate) {
        return res.status(400).json({ error: 'startDate and endDate are required.' });
      }

      if (!parseDateKey(startDate) || !parseDateKey(endDate)) {
        return res.status(400).json({ error: 'Dates must be valid YYYY-MM-DD values.' });
      }

      if (compareDateKeys(startDate, endDate) > 0) {
        return res.status(400).json({ error: 'startDate must be on or before endDate.' });
      }

      const tagValidation = validateReservationDates(item.tag, startDate, endDate);

      if (!tagValidation.ok) {
        return res.status(400).json({ error: tagValidation.error });
      }
    }

    const pendingCount = await countPendingReservationsByEmail(userEmail);

    if (pendingCount >= MAX_PENDING_RESERVATIONS_PER_USER) {
      return res.status(429).json({
        error: 'Too many pending reservations. Please wait for admin review before submitting more.',
      });
    }

    const result = await addReservation(itemId, {
      startDate,
      endDate,
      userEmail,
      timeSlots,
      requestSummary,
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    if (result.collision) {
      return res.status(409).json({ error: 'Selected dates overlap an existing reservation.' });
    }

    const { item: updatedItem, reservation } = result;
    notifySlackReservation({ item: updatedItem, reservation });

    if (isExpertise) {
      sendConsultationRequestEmails(updatedItem, reservation).catch((emailError) => {
        console.error('Consultation request emails failed:', emailError);
      });
    }

    res.status(201).json({
      reservation: sanitizeReservationForPublic(reservation),
      item: reservationItemPayload(updatedItem),
    });
  } catch (error) {
    console.error('Failed to create reservation:', error);
    const detail = error?.message || '';
    res.status(500).json({
      error: isReservationSchemaError(detail)
        ? reservationSchemaErrorMessage()
        : 'Could not create reservation.',
    });
  }
});

app.delete('/api/inventory/:id/reservations/:reservationId', requireAuth, requireAdmin, async (req, res) => {
  const itemId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
  const reservationId =
    typeof req.params.reservationId === 'string' ? req.params.reservationId.trim() : '';

  if (!itemId || !reservationId) {
    return res.status(400).json({ error: 'Item id and reservation id are required.' });
  }

  try {
    const result = await removeReservation(itemId, reservationId);

    if (result.notFound) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    if (result.reservationNotFound) {
      return res.status(404).json({ error: 'Reservation not found.' });
    }

    const { removed } = result;
    if (
      result.item.tag === 'expertise' &&
      (removed.status === 'pending' || removed.status === 'reserved')
    ) {
      await handleConsultationCancelled(
        result.item,
        { ...removed, cancelledBy: 'admin' },
        removed.status,
      );
    }

    auditAdminAction(req, 'delete_reservation', { itemId, reservationId });
    res.json({ success: true, item: result.item });
  } catch (error) {
    console.error('Failed to delete reservation:', error);
    res.status(500).json({ error: 'Could not delete reservation.' });
  }
});

app.patch('/api/inventory/:id/reservations/:reservationId', requireAuth, requireAdmin, async (req, res) => {
  const itemId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
  const reservationId =
    typeof req.params.reservationId === 'string' ? req.params.reservationId.trim() : '';

  if (!itemId || !reservationId) {
    return res.status(400).json({ error: 'Item id and reservation id are required.' });
  }

  if (req.body?.status !== undefined) {
    const status =
      typeof req.body.status === 'string' ? req.body.status.trim().toLowerCase() : '';
    if (!VALID_RESERVATION_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid reservation status.' });
    }
  }

  const updates = {};
  if (typeof req.body?.startDate === 'string') {
    updates.startDate = req.body.startDate.trim();
  }
  if (typeof req.body?.endDate === 'string') {
    updates.endDate = req.body.endDate.trim();
  }
  if (typeof req.body?.status === 'string') {
    updates.status = req.body.status.trim().toLowerCase();
  }

  try {
    const result = await patchReservation(itemId, reservationId, updates);

    if (result.notFound) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    if (result.isConsultation) {
      return res.status(400).json({
        error: 'Consultations can only be scheduled, cancelled, or refused, not edited directly.',
      });
    }

    if (result.reservationNotFound) {
      return res.status(404).json({ error: 'Reservation not found.' });
    }

    if (result.invalidUpdate) {
      return res.status(400).json({ error: result.validationError || 'Invalid reservation update.' });
    }

    if (result.collision) {
      return res.status(409).json({ error: 'Updated dates overlap an existing reservation.' });
    }

    auditAdminAction(req, 'patch_reservation', { itemId, reservationId, updates });
    res.json({ item: result.item, reservation: result.reservation });
  } catch (error) {
    console.error('Failed to update reservation:', error);
    res.status(500).json({ error: 'Could not update reservation.' });
  }
});

app.post('/api/inventory/:id/reservations/:reservationId/approve', requireAuth, requireAdmin, async (req, res) => {
  const itemId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
  const reservationId =
    typeof req.params.reservationId === 'string' ? req.params.reservationId.trim() : '';

  if (!itemId || !reservationId) {
    return res.status(400).json({ error: 'Item id and reservation id are required.' });
  }

  try {
    const result = await approveReservation(itemId, reservationId);

    if (result.isConsultation) {
      const scheduled = await runScheduleConsultation({
        itemId,
        reservationId,
        meetingAt: typeof req.body?.meetingAt === 'string' ? req.body.meetingAt : '',
      });

      if (scheduled.status !== 200) {
        return res.status(scheduled.status).json(scheduled.body);
      }

      auditAdminAction(req, 'schedule_consultation', { itemId, reservationId });
      return res.json({ item: scheduled.result.item, reservation: scheduled.result.reservation });
    }

    if (result.notFound) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    if (result.reservationNotFound) {
      return res.status(404).json({ error: 'Reservation not found.' });
    }

    if (result.invalidStatus) {
      return res.status(400).json({ error: 'Only pending reservations can be approved.' });
    }

    if (result.collision) {
      return res.status(409).json({ error: 'Approved dates overlap an existing reservation.' });
    }

    sendMemberDecisionEmail(result.item, result.reservation, 'approved').catch((emailError) => {
      console.error('Reservation approval email failed:', emailError);
    });

    auditAdminAction(req, 'approve_reservation', { itemId, reservationId });
    res.json({ item: result.item, reservation: result.reservation });
  } catch (error) {
    console.error('Failed to approve reservation:', error);
    res.status(500).json({ error: 'Could not approve reservation.' });
  }
});

app.post('/api/inventory/:id/reservations/:reservationId/refuse', requireAuth, requireAdmin, async (req, res) => {
  const itemId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
  const reservationId =
    typeof req.params.reservationId === 'string' ? req.params.reservationId.trim() : '';

  if (!itemId || !reservationId) {
    return res.status(400).json({ error: 'Item id and reservation id are required.' });
  }

  try {
    const result = await refuseReservation(itemId, reservationId);

    if (result.notFound) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    if (result.reservationNotFound) {
      return res.status(404).json({ error: 'Reservation not found.' });
    }

    if (result.invalidStatus) {
      return res.status(400).json({ error: 'Only pending reservations can be refused.' });
    }

    sendMemberDecisionEmail(result.item, result.reservation, 'refused').catch((emailError) => {
      console.error('Reservation refusal email failed:', emailError);
    });

    auditAdminAction(req, 'refuse_reservation', { itemId, reservationId });
    res.json({ item: result.item, reservation: result.reservation });
  } catch (error) {
    console.error('Failed to refuse reservation:', error);
    res.status(500).json({ error: 'Could not refuse reservation.' });
  }
});

app.delete('/api/inventory/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';

  if (!id) {
    return res.status(400).json({ error: 'Item id is required.' });
  }

  try {
    const result = await deleteInventoryItem(id);
    const existingItem = result.item;

    if (result.notFound) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    if (existingItem?.tag === 'expertise') {
      const activeConsultations = existingItem.reservations.filter(
        (entry) => entry.status === 'pending' || entry.status === 'reserved',
      );
      for (const reservation of activeConsultations) {
        await handleConsultationCancelled(
          existingItem,
          { ...reservation, cancelledBy: 'admin' },
          reservation.status,
        );
      }
    }

    auditAdminAction(req, 'delete_inventory_item', { itemId: id });
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete inventory item:', error);
    res.status(500).json({ error: 'Could not delete inventory item.' });
  }
});

app.post('/api/auth/welcome-email', welcomeEmailLimiter, requireAuth, async (req, res) => {
  try {
    const result = await sendWelcomeEmailIfNeeded(req.user);
    res.json({ success: true, sent: result.sent, reason: result.reason ?? null });
  } catch (error) {
    console.error('Welcome email failed:', error);
    res.status(500).json({ error: 'Could not send welcome email.' });
  }
});

app.post('/api/contact', contactFormLimiter, async (req, res) => {
  const honeypot = typeof req.body?.website === 'string' ? req.body.website.trim() : '';
  if (honeypot) {
    return res.json({ success: true });
  }

  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email, and message are required.' });
  }

  if (name.length > CONTACT_NAME_MAX) {
    return res.status(400).json({ error: `Name must be ${CONTACT_NAME_MAX} characters or fewer.` });
  }

  if (message.length > CONTACT_MESSAGE_MAX) {
    return res.status(400).json({
      error: `Message must be ${CONTACT_MESSAGE_MAX} characters or fewer.`,
    });
  }

  if (!isValidEmailAddress(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  try {
    const { error } = await getResend().emails.send(
      buildContactEmailPayload({ name, email, message }),
    );

    if (error) {
      throw new Error(error.message || 'Failed to send message.');
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Contact form email failed:', error);
    res.status(500).json({ error: 'Could not send your message. Please try again later.' });
  }
});

const consultationActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many consultation updates. Please try again later.' },
});

app.get('/api/account/consultations', requireAuth, async (req, res) => {
  const email = req.user?.email?.trim() ?? '';

  try {
    const { asMember, asExpert } = await listConsultationsForUser(email, {
      includeExpert: isConfirmedUser(req.user),
    });

    res.set('Cache-Control', 'no-store');
    res.json({
      asMember: asMember.map((entry) => serializeConsultationForUser(entry, 'member')),
      asExpert: asExpert.map((entry) => serializeConsultationForUser(entry, 'expert')),
    });
  } catch (error) {
    console.error('Failed to load account consultations:', error);
    const detail = error?.message || '';
    res.status(500).json({
      error: isReservationSchemaError(detail)
        ? reservationSchemaErrorMessage()
        : 'Could not load your consultations.',
    });
  }
});

app.post(
  '/api/consultations/:reservationId/schedule',
  consultationActionLimiter,
  requireAuth,
  async (req, res) => {
    const reservationId =
      typeof req.params.reservationId === 'string' ? req.params.reservationId.trim() : '';

    try {
      const found = await loadConsultationForUser(req.user, reservationId);

      if (!found) {
        return res.status(404).json({ error: 'Consultation not found.' });
      }

      if (!found.isExpert && !found.isAdmin) {
        return res.status(403).json({ error: 'Only the expert can schedule this consultation.' });
      }

      const scheduled = await runScheduleConsultation({
        itemId: found.item.id,
        reservationId,
        meetingAt: typeof req.body?.meetingAt === 'string' ? req.body.meetingAt : '',
      });

      if (scheduled.status !== 200) {
        return res.status(scheduled.status).json(scheduled.body);
      }

      const role = found.isExpert ? 'expert' : 'admin';
      console.log('[consultation]', { action: 'schedule', reservationId, by: role });
      res.json({
        consultation: serializeConsultationForUser(scheduled.result, 'expert'),
      });
    } catch (error) {
      console.error('Failed to schedule consultation:', error);
      res.status(500).json({ error: 'Could not schedule the consultation.' });
    }
  },
);

app.post(
  '/api/consultations/:reservationId/cancel',
  consultationActionLimiter,
  requireAuth,
  async (req, res) => {
    const reservationId =
      typeof req.params.reservationId === 'string' ? req.params.reservationId.trim() : '';

    try {
      const found = await loadConsultationForUser(req.user, reservationId);

      if (!found) {
        return res.status(404).json({ error: 'Consultation not found.' });
      }

      const cancelledBy = found.isMember ? 'member' : found.isExpert ? 'expert' : 'admin';
      const result = await cancelConsultation(found.item.id, reservationId, { cancelledBy });

      if (result.notFound || result.reservationNotFound) {
        return res.status(404).json({ error: 'Consultation not found.' });
      }

      if (result.invalidStatus) {
        return res.status(400).json({ error: 'This consultation is no longer active.' });
      }

      await handleConsultationCancelled(result.item, result.reservation, result.previousStatus);

      console.log('[consultation]', { action: 'cancel', reservationId, by: cancelledBy });
      res.json({
        consultation: serializeConsultationForUser(
          result,
          cancelledBy === 'member' ? 'member' : 'expert',
        ),
      });
    } catch (error) {
      console.error('Failed to cancel consultation:', error);
      const detail = error?.message || '';
      res.status(500).json({
        error: isReservationSchemaError(detail)
          ? reservationSchemaErrorMessage()
          : 'Could not cancel the consultation.',
      });
    }
  },
);

// Unknown API paths must not fall through to the SPA shell as HTML 200.
app.all('/api/*', (_req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

app.get('*', async (req, res) => {
  const pathname = req.path || '/';

  if (normalizeSeoPath(pathname) === '/admin' || normalizeSeoPath(pathname) === '/account') {
    res.set('X-Robots-Tag', 'noindex, nofollow');
  }

  if (!indexHtmlTemplate) {
    return res.sendFile(INDEX_HTML_PATH);
  }

  const localeCode = resolveRequestLocale(req);
  const origin = SITE_URL || `${req.protocol}://${req.get('host')}`;

  try {
    const html = await injectSeoIntoHtml(
      indexHtmlTemplate,
      pathname,
      localeCode,
      origin,
      escapeHtml,
      {
        includeJsonLd: !['/admin', '/account'].includes(normalizeSeoPath(pathname)),
        plausibleDomain: PLAUSIBLE_DOMAIN,
        findItemBySlug: findInventoryItemBySlug,
      },
    );

    res.type('html').send(html);
  } catch (error) {
    console.error('Failed to inject SEO into HTML:', error);
    res.type('html').send(indexHtmlTemplate);
  }
});

const MAX_PORT_ATTEMPTS = 20;

function startServer(port, attempt = 1) {
  const server = app.listen(port);

  server.once('listening', () => {
    const actualPort = server.address().port;
    if (actualPort !== Number(PORT)) {
      console.warn(`Port ${PORT} is in use, using ${actualPort} instead.`);
    }
    console.log(`ARL Online server running at http://localhost:${actualPort}`);
    if (SITE_URL) {
      console.log(`Public site URL → ${SITE_URL}`);
    }
    if (apiKey) {
      console.log(`Member decision emails from → ${FROM}`);
      console.log(`Email links → ${EMAIL_SITE_ORIGIN}`);
    }
    if (SLACK_RESERVATION_WEBHOOK_URL) {
      console.log('Slack reservation webhook → configured');
    }
    console.log(
      isZoomConfigured()
        ? 'Zoom consultation meetings → configured'
        : 'Zoom consultation meetings → not configured (consultations schedule without a meeting link)',
    );

    checkReservationSchema().then((result) => {
      if (!result.ok) {
        console.error('Reservation schema check failed:', result.message);
        if (result.detail) {
          console.error(result.detail);
        }
      }
    });
  });

  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && !STRICT_PORT && attempt < MAX_PORT_ATTEMPTS) {
      server.close(() => startServer(port + 1, attempt + 1));
      return;
    }

    if (err.code === 'EADDRINUSE') {
      if (STRICT_PORT) {
        console.error(`Port ${port} is in use. Stop the existing server or set PORT to an open port.`);
      } else {
        console.error(`No available port found between ${PORT} and ${port}.`);
      }
      process.exit(1);
    }

    throw err;
  });
}

startServer(Number(PORT));
