import 'dotenv/config';
import compression from 'compression';
import express from 'express';
import rateLimit, { ipKeyGenerator, MemoryStore } from 'express-rate-limit';
import helmet from 'helmet';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';
import { fileURLToPath } from 'url';
import { Resend } from 'resend';
import { compareDateKeys, libraryTodayKey, parseDateKey, toDateKey } from './src/lib/calendar.js';
import {
  CONFIRMATION_MESSAGE_MAX,
  EXPERT_LONG_TEXT_MAX,
  EXPERT_NAME_MAX,
  EXPERT_SHORT_TEXT_MAX,
  FOLLOW_UP_NOTE_MAX,
} from './src/lib/expertise-fields.js';
import {
  addDays,
  formatTimeOfDay,
  isConsultationHeld,
  isReminderDue,
  isTestCancellation,
  parseRoomTimes,
  RESERVATION_MESSAGE_MAX,
  reservationStartsAt,
  TEST_CANCEL_WINDOW_MS,
  validateReservationDates,
  validateRoomRequest,
  validateRoomTimes,
} from './src/lib/reservation-rules.js';
import {
  addReservation,
  anonymizeReservationsForEmail,
  approveReservation,
  cancelConsultation,
  bookFollowUpConsultation,
  cancelReservationByAdmin,
  cancelReservationForMember,
  checkReservationSchema,
  claimReminder,
  countPendingReservationsByEmail,
  createInventoryItem,
  createMentorProfileForEmail,
  deleteInventoryItem,
  emailsMatch,
  updateExpertiseItem,
  ensureInventory,
  fetchInventoryItems,
  findInventoryItem,
  findInventoryItemBySlug,
  findInventoryItemImage,
  findMentorProfileByEmail,
  findReservationWithItem,
  isConsultationExpert,
  isConsultationMember,
  isItemOwner,
  isReservationSchemaError,
  isValidInventoryImage,
  isValidTag,
  itemOwnerEmail,
  listConsultationsForUser,
  listHostedReservationsForOwner,
  listPendingGaEvents,
  listReminderCandidates,
  listReservationsForMember,
  loadItemViewStats,
  moveGaEvent,
  normalizeInventoryItem,
  reservationSchemaErrorMessage,
  patchReservation,
  recordItemView,
  refuseReservation,
  removeReservation,
  rescheduleConsultation,
  rescheduleReservation,
  scheduleConsultation,
  setReminderState,
  releaseStaleReminderClaims,
  reassignItemsOwnedBy,
  settleReminder,
  updateMentorProfileForEmail,
} from './src/lib/inventory-store.js';
import {
  CONSULTATION_DURATION_MINUTES,
  CONSULTATION_TIMEZONE,
  createConsultationMeeting,
  deleteConsultationMeeting,
  isZoomConfigured,
  moveConsultationMeeting,
} from './src/lib/zoom.js';
import {
  GA_BACKDATE_LIMIT_MS,
  isGaMeasurementProtocolConfigured,
  sendStaffBookingEvent,
} from './src/lib/ga-measurement-protocol.js';
import { assertSupabaseAdminConfigured, getSupabaseAdmin } from './src/lib/supabase-server.js';
import {
  addReservationMessage,
  countUnreadMessages,
  listReservationMessages,
  markThreadRead,
  releaseNotification,
  ThreadUnavailableError,
} from './src/lib/reservation-messages-store.js';
import {
  ITEM_MEDIA_BASE,
  isItemMediaUrl,
  isItemMediaUrlForItem,
  isOversizedImageDataUrl,
  isStorableImageDataUrl,
  itemMediaFileName,
  parseImageDataUrl,
  publicItemImageUrl,
  withPublicItemImage,
} from './src/lib/item-media.js';
import {
  hasPhysicalLocation,
  locationAreaLine,
  memberLocation,
  publicLocation,
  toPublicItem,
} from './src/lib/item-location.js';
import { isItemDetailRoute } from './src/lib/item-routes.js';
import { bikeShareNear } from './src/lib/bike-share.js';
import { MAP_TILE_HOSTS } from './src/lib/map-tiles.js';
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
// The contact form's inbox. activistresourcelibrary.com receives no mail, so every other app
// email sets Reply-To to EMAIL_REPLY_TO (default: this inbox).
const CONTACT_TO = 'samuel@apathyisboring.com';
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO?.trim() || CONTACT_TO;
// Routes wait for their emails before responding, so a hung Resend call must not hold the response.
const EMAIL_SEND_TIMEOUT_MS = 10_000;
// Resend's default rate limit is 2 requests per second per team. A 429 is retried once after
// EMAIL_RATE_LIMIT_RETRY_MS; bulk notifications (admin item delete) also leave
// EMAIL_PACING_MS_PER_EMAIL per email between rounds.
const EMAIL_RATE_LIMIT_RETRY_MS = 1_000;
const EMAIL_PACING_MS_PER_EMAIL = 500;
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
 * `<link rel="modulepreload">` for the lazy `ItemDetailPage` chunk, added to the
 * shell on item routes so a deep link fetches the overlay alongside the entry
 * instead of after it runs. Found by Vite's default `[name]-[hash].js` chunk
 * name; when no file matches (renamed chunk, no build), the hint is left out.
 */
function findItemDetailChunkPreload() {
  try {
    const chunk = fs
      .readdirSync(path.join(__dirname, 'dist', 'assets'))
      .find((name) => /^ItemDetailPage-[\w-]+\.js$/.test(name));
    return chunk ? `<link rel="modulepreload" crossorigin href="/assets/${chunk}">` : '';
  } catch {
    return '';
  }
}

const ITEM_DETAIL_CHUNK_PRELOAD = findItemDetailChunkPreload();

/**
 * Ringold is the title face of every page's band (`.page-header h1`), so the font is
 * preloaded on every HTML response.
 */
const BRAND_FONT_PRELOAD =
  '<link rel="preload" href="/assets/fonts/ringold/Ringold-Sans.woff2" as="font" type="font/woff2" crossorigin>';

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

    // Supabase stops a banned account from signing in or refreshing, but an access token issued
    // before the ban may keep working until it expires; this makes an admin suspension immediate.
    if (error?.code === 'user_banned' || (!error && isUserSuspended(data.user))) {
      return res.status(403).json({ error: 'This account is suspended.', code: 'account_suspended' });
    }

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

/** True while a Supabase ban (`banned_until`, set by the admin Suspend action) is in force. */
function isUserSuspended(user) {
  const until = Date.parse(user?.banned_until ?? '');
  return !Number.isNaN(until) && until > Date.now();
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

/**
 * A whitelist (toPublicItem): never expertEmail, the full location or the members' details.
 * The location is only the city, province, postal code and an approximate area.
 */
function sanitizeItemForPublic(item) {
  return { ...toPublicItem(item), image: publicItemImageUrl(item) };
}

/**
 * Item lookup for the SSR head: og:image, twitter:image and Product JSON-LD get the /media URL.
 * The public item, so the server's head and the client's JSON-LD start from the same fields.
 */
async function findPublicItemBySlug(tag, slug) {
  const item = await findInventoryItemBySlug(tag, slug);
  return item ? sanitizeItemForPublic(item) : null;
}

const reservationCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many reservation requests. Please try again later.',
    code: 'reservation_rate_limited',
  },
});

const RESERVATION_CREATES_PER_ACCOUNT_PER_DAY = 10;
const reservationAccountStore = new MemoryStore();
const reservationAccountKey = (req) => `user:${req.user.id}`;

// Runs after requireAuth, keyed by account, so a member can't loop request → cancel and email a
// mentor (and post to Slack) from many IPs. Only saved creates count: the limiter counts every
// request it lets through and countSavedReservationCreates hands the hit back when the route saves
// nothing. In-memory: it relies on the single Cloud Run instance and resets on deploy.
const reservationAccountLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: RESERVATION_CREATES_PER_ACCOUNT_PER_DAY,
  keyGenerator: reservationAccountKey,
  store: reservationAccountStore,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: `You can send up to ${RESERVATION_CREATES_PER_ACCOUNT_PER_DAY} requests in 24 hours. Please try again tomorrow.`,
    code: 'daily_request_limit',
  },
});

/**
 * Wraps the create route so the daily cap keeps a hit only when the route saved a reservation
 * (`res.locals.reservationSaved`). It decides once the route has finished, not when the response
 * closes: a client that disconnects while the route awaits Slack and the emails still used one of
 * its creates (express-rate-limit's skipFailedRequests hands the hit back on any early 'close').
 */
function countSavedReservationCreates(handler) {
  return async (req, res) => {
    res.locals.reservationSaved = false;
    try {
      await handler(req, res);
    } finally {
      if (!res.locals.reservationSaved) {
        await reservationAccountStore.decrement(reservationAccountKey(req));
      }
    }
  };
}

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

const READABLE_DATE_FORMAT = new Intl.DateTimeFormat('en-CA', { dateStyle: 'full', timeZone: 'UTC' });

/** `YYYY-MM-DD` → "Tuesday, October 13, 2026" (emails are English). Anything else comes back as given. */
function formatReadableDate(dateKey) {
  const date = parseDateKey(dateKey);
  if (!date) {
    return dateKey ?? '';
  }

  return READABLE_DATE_FORMAT.format(
    new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12)),
  );
}

/** A reservation's date range for emails and Slack; one date when it starts and ends the same day. */
function formatReservationDates(reservation) {
  const start = trimmedOrNull(reservation?.startDate);
  const end = trimmedOrNull(reservation?.endDate);

  if (start && end && start !== end) {
    return `${formatReadableDate(start)} to ${formatReadableDate(end)}`;
  }

  return formatReadableDate(start || end || '');
}

/**
 * A room request's hours for emails and Slack ("6:00 p.m. to 9:00 p.m.", "… each day" over
 * several days), or '' when it has none (other items, staff bookings, older requests).
 */
function formatRoomTimes(item, reservation) {
  const times = item?.tag === 'rooms' ? parseRoomTimes(reservation?.timeSlots) : null;
  if (!times) {
    return '';
  }

  const range = `${formatTimeOfDay(times.start)} to ${formatTimeOfDay(times.end)}`;
  return reservation.startDate !== reservation.endDate ? `${range}, each day` : range;
}

function consultationTitle(item) {
  return trimmedOrNull(item?.title) ?? 'Consultation';
}

/**
 * A subject line from text that may hold a title or an address someone typed: control characters
 * (a line break above all) become spaces, so the subject stays one line.
 */
function emailSubject(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
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
    replyTo: EMAIL_REPLY_TO,
    to,
    subject,
    text: rendered.text,
    html: rendered.html,
    attachments,
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

/**
 * RFC 5545 invite (METHOD:REQUEST) or cancellation (METHOD:CANCEL) for a consultation. The UID is
 * the reservation's, so a new time, a handover or a cancellation updates the same calendar event.
 * SEQUENCE is the time it was built, in seconds since 1970 (nothing stores a revision number):
 * calendars apply the highest one for a UID, so a later invite or cancellation always replaces an
 * earlier one, and an old email opened late can't undo it. It fits RFC 5545's integer until 2038.
 */
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
function buildConsultationScheduledEmailPayloads(
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
function buildConsultationRescheduledEmailPayloads(
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

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sendEmailPayload(payload) {
  return withTimeout(
    getResend().emails.send(payload),
    EMAIL_SEND_TIMEOUT_MS,
    `Resend did not answer within ${EMAIL_SEND_TIMEOUT_MS / 1000}s.`,
  );
}

/** Resend refused the email over its rate limit, so it wasn't sent and is safe to try again. */
function isResendRateLimitError(error) {
  return error?.name === 'rate_limit_exceeded' || error?.statusCode === 429;
}

/** Logs failures and never throws. Resolves true only when there was an email and Resend accepted every one. */
async function sendEmailPayloads(payloads, label) {
  const toSend = payloads.filter(Boolean);
  const results = await Promise.allSettled(
    toSend.map(async (payload) => {
      let { error } = await sendEmailPayload(payload);
      if (isResendRateLimitError(error)) {
        await delay(EMAIL_RATE_LIMIT_RETRY_MS);
        ({ error } = await sendEmailPayload(payload));
      }
      if (error) {
        throw new Error(error.message || `Failed to send ${label} email.`);
      }
    }),
  );

  let allSent = toSend.length > 0;
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error(`${label} email failed:`, result.reason);
      allSent = false;
    }
  }
  return allSent;
}

/**
 * Routes await a saved action's emails and Slack post before responding: once the response is
 * out, Cloud Run can throttle CPU and stall sends still in flight. Never throws, so a failed send
 * can't turn a saved action into an error. Email senders resolve true/false; the result (the
 * response's `emailSent`) is false if any of them resolved false or threw. Slack resolves
 * undefined and doesn't count.
 */
async function settleNotifications(label, tasks) {
  const results = await Promise.allSettled(tasks);
  let emailSent = true;
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error(`${label} notifications failed:`, result.reason);
      emailSent = false;
    } else if (result.value === false) {
      emailSent = false;
    }
  }
  return emailSent;
}

/**
 * Bulk version of settleNotifications: one round per entry, in order, each round taking at least
 * `emailsPerRound` × EMAIL_PACING_MS_PER_EMAIL so the batch stays under Resend's rate limit.
 * Resolves false if any round's email failed, or undefined when there were no entries.
 */
async function settleNotificationRounds(label, entries, emailsPerRound, notify) {
  let emailSent;
  for (const [index, entry] of entries.entries()) {
    const startedAt = Date.now();
    const sent = await settleNotifications(label, [notify(entry)]);
    emailSent = (emailSent ?? true) && sent;
    const wait = emailsPerRound * EMAIL_PACING_MS_PER_EMAIL - (Date.now() - startedAt);
    if (index < entries.length - 1 && wait > 0) {
      await delay(wait);
    }
  }
  return emailSent;
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

  return sendEmailPayloads(
    [
      buildConsultationRequestEmailPayload(item, reservation),
      buildExpertRequestEmailPayload(item, reservation),
    ],
    'Consultation request',
  );
}

/** Member "confirmed" + expert "scheduled", each with the Zoom link and `.ics`. */
async function sendConsultationScheduledEmails(item, reservation, messageOptions) {
  return sendEmailPayloads(
    buildConsultationScheduledEmailPayloads(item, reservation, messageOptions),
    'Consultation scheduled',
  );
}

/** Member and expert "moved", each with the new time and the updated `.ics`. */
async function sendConsultationRescheduledEmails(item, reservation, previousMeetingAt, messageOptions) {
  return sendEmailPayloads(
    buildConsultationRescheduledEmailPayloads(item, reservation, previousMeetingAt, messageOptions),
    'Consultation moved',
  );
}

/**
 * Staff gave a mentor a new email address (`/admin` → Mentors → Edit). Their consultations
 * follow the item, but the emails about them went to the old address, or nowhere. The new
 * address gets those emails again: "New consultation request" for each pending request, and
 * the expert's "Consultation scheduled" (Zoom link and `.ics`) for each meeting not yet held.
 * Members are not emailed. Returns null when the address didn't change (case-insensitive), was
 * cleared, or nothing is open; otherwise `{ count, emailSent }`.
 */
async function sendMentorEmailHandover(item, previousExpertEmail) {
  const expertEmail = trimmedOrNull(item?.expertEmail);
  if (!expertEmail || emailsMatch(expertEmail, previousExpertEmail)) {
    return null;
  }

  const open = (item.reservations ?? []).filter(
    (reservation) =>
      reservation.status === 'pending' ||
      (reservation.status === 'reserved' && reservation.meetingAt && !isConsultationHeld(reservation)),
  );
  if (open.length === 0) {
    return null;
  }

  // Paced rounds, as for an admin item delete, so a busy mentor doesn't hit Resend's rate limit.
  // The callback is async so a builder that throws fails its round, not the saved edit.
  const emailSent = await settleNotificationRounds('Mentor email handover', open, 1, async (reservation) =>
    sendEmailPayloads(
      reservation.status === 'pending'
        ? [buildExpertRequestEmailPayload(item, reservation)]
        : buildConsultationScheduledEmailPayloads(item, reservation, { onlyExpert: true }),
      'Mentor email handover',
    ),
  );
  return { count: open.length, emailSent: emailSent === true };
}

/** "Apathy is Boring\n5310 Boulevard Saint-Laurent\nMontréal QC H2T 1S1": the email's Where row. */
function itemPlaceLines(location) {
  return [location.name, location.streetAddress, locationAreaLine(location)]
    .filter((line) => typeof line === 'string' && line.trim())
    .join('\n');
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
function buildMemberDecisionEmailPayload(item, reservation, decision, message = '') {
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

/** Resolves false when the reservation has no member email or the send failed (logged). */
async function sendMemberDecisionEmail(item, reservation, decision, message = '') {
  const emailPayload = buildMemberDecisionEmailPayload(item, reservation, decision, message);

  if (!emailPayload) {
    console.warn(`Skipping ${decision} email: no member email on reservation ${reservation?.id}.`);
    return false;
  }

  return sendEmailPayloads(
    [emailPayload],
    decision === 'approved' ? 'Reservation approval' : 'Reservation refusal',
  );
}

/**
 * Staff booked an equipment, book or room reservation for this address (admin **Create
 * Reservation**), member or not. `account`: 'member' (a confirmed account uses the address),
 * 'new' (none, or one never confirmed) or 'unknown' (the lookup failed). The account page
 * lists reservations by email, so the invitation is to sign in or register with this one.
 * `today` is a libraryTodayKey(): members can cancel online only before the first day.
 */
function buildStaffReservationEmailPayload(item, reservation, { account, message = '', today }) {
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

/** Resolves false when the send failed (logged). */
async function sendStaffReservationEmail(item, reservation, options) {
  const emailPayload = buildStaffReservationEmailPayload(item, reservation, options);

  if (!emailPayload) {
    console.warn(`Skipping staff reservation email: no email on reservation ${reservation?.id}.`);
    return false;
  }

  return sendEmailPayloads([emailPayload], 'Staff reservation');
}

/**
 * An equipment, book or room reservation that still matters to the member: pending, or
 * approved and not yet over (`endDate` on or after `today`, a libraryTodayKey()). Admin
 * deletes email these members.
 */
function isUpcomingMemberReservation(reservation, today) {
  return (
    (reservation?.status === 'pending' || reservation?.status === 'reserved') &&
    compareDateKeys(reservation.endDate ?? '', today) >= 0
  );
}

/**
 * Admin deleted the reservation, or its whole item, or the item's host cancelled it from /account
 * → the member. `today` (a libraryTodayKey()) tells a booking still ahead of its pickup from a
 * loan already under way; `reservation.status` is the one it had before. `message`: the host's
 * optional note (staff deletes have none).
 */
function buildReservationCancelledByTeamEmailPayload(item, reservation, today, message = '') {
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

/** Resolves false when the reservation has no member email or the send failed (logged). */
async function sendReservationCancelledByTeamEmail(item, reservation, today, message = '') {
  const emailPayload = buildReservationCancelledByTeamEmailPayload(item, reservation, today, message);

  if (!emailPayload) {
    console.warn(`Skipping cancellation email: no member email on reservation ${reservation?.id}.`);
    return false;
  }

  return sendEmailPayloads([emailPayload], 'Reservation cancelled');
}

/**
 * The host of a room, equipment or book moved a booking from /account → the member. A pending
 * request stays a request; a confirmed booking shows where to go again, as its approval did.
 * `previous` is `{ startDate, endDate, timeSlots }` before the move, `message` the host's optional
 * note, and `today` a libraryTodayKey(): members can cancel online only before the first day.
 * Hosts are staff today, so the email speaks for the library team.
 */
function buildReservationRescheduledEmailPayload(item, reservation, previous, { message = '', today } = {}) {
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

/** Resolves false when the reservation has no member email or the send failed (logged). */
async function sendReservationRescheduledEmail(item, reservation, previous, options) {
  const emailPayload = buildReservationRescheduledEmailPayload(item, reservation, previous, options);

  if (!emailPayload) {
    console.warn(`Skipping new dates email: no member email on reservation ${reservation?.id}.`);
    return false;
  }

  return sendEmailPayloads([emailPayload], 'Reservation moved');
}

/**
 * The day-before reminder of a confirmed booking (sendDueReservationReminders, about 24 hours
 * before reservationStartsAt). Equipment, books and rooms → the member, with where and when as in
 * the approval. Consultations → member and expert, with the Zoom link; no `.ics`, the invite went
 * out when it was scheduled. Each only with an address: an empty array when nobody has one.
 */
function buildReservationReminderEmailPayloads(item, reservation) {
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

/** Adds the closing period unless the sentence already ends with one ("… 12:00 p.m."). */
function endSentence(text) {
  return text.endsWith('.') ? text : `${text}.`;
}

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
function buildReservationMessageEmailPayload({
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
    replyTo: EMAIL_REPLY_TO,
    to,
    subject,
    text: rendered.text,
    html: rendered.html,
  };
}

/** Admin "Send password reset" → the member, with Supabase's one-time recovery link as the CTA. */
function buildPasswordResetEmailPayload(email, actionLink) {
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

    // The claim above makes this once per account, so it doubles as the new-member alert.
    // postSlackWorkflow never throws; it runs alongside the email and is awaited either way.
    const slackPosted = notifySlackAlert({
      status: 'member_signed_up',
      userEmail: email,
      summary: `New member account: ${email}.`,
    });
    const { error } = await getResend()
      .emails.send(emailPayload)
      .finally(() => slackPosted);

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

/**
 * rescheduleConsultation's `moveMeeting`: moves the consultation's Zoom meeting to `meetingIso`
 * and resolves null (same id, link and passcode). With no meeting yet (scheduled while Zoom was
 * off) or one Zoom no longer has, it makes a new one and resolves its `{ id, joinUrl, password }`.
 * Without Zoom, null: the time moves and the meeting, if any, stays. A Zoom error throws
 * `zoomFailed`, and nothing is saved.
 */
async function moveZoomMeetingForConsultation(item, reservation, meetingIso) {
  if (!isZoomConfigured()) {
    console.warn(`Zoom is not configured; consultation ${reservation.id} moved without its meeting.`);
    return null;
  }

  let moved;
  try {
    moved = await moveConsultationMeeting(reservation.zoomMeetingId, { startTime: meetingIso });
  } catch (error) {
    console.error(`Zoom meeting move failed for consultation ${reservation.id}:`, error);
    const wrapped = new Error('Could not move the Zoom meeting.');
    wrapped.zoomFailed = true;
    throw wrapped;
  }

  return moved ? null : createZoomMeetingForConsultation(item, { ...reservation, meetingAt: meetingIso });
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

/**
 * Deletes the Zoom meeting (if any) and emails member + expert about a cancellation.
 * Resolves true when every email went out (see sendEmailPayloads).
 */
async function handleConsultationCancelled(item, reservation, previousStatus) {
  if (previousStatus === 'reserved') {
    await removeZoomMeeting(reservation);
  }

  return sendEmailPayloads(
    buildConsultationCancelledEmailPayloads(item, reservation, previousStatus),
    'Consultation cancelled',
  );
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
 * The optional confirmation message from a request body: `{ message }` trimmed, or `{ error }`
 * when it is too long. Anything that isn't a string counts as no message.
 */
function readConfirmationMessage(body) {
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (message.length > CONFIRMATION_MESSAGE_MAX) {
    return { error: `The message must be ${CONFIRMATION_MESSAGE_MAX} characters or fewer.` };
  }
  return { message };
}

/**
 * Shared by the expert account panel and the admin approve route. Returns
 * `{ status, body, result, emailSent }` so each route can shape its own success payload.
 * `message` / `messageFrom` go into the scheduled emails (see buildConsultationScheduledEmailPayloads).
 */
async function runScheduleConsultation({ itemId, reservationId, meetingAt, message = '', messageFrom = 'expert' }) {
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

  // Scheduled within a day of the meeting: this email is its reminder.
  await setReminderState(result.reservation.id, reservationStartsAt(result.reservation, result.item.tag));
  const emailSent = await settleNotifications('Consultation scheduled', [
    sendConsultationScheduledEmails(result.item, result.reservation, { message, messageFrom }),
  ]);
  await restoreReminderIfNotEmailed(result.reservation, result.item.tag, emailSent);

  return { status: 200, result, emailSent };
}

/**
 * setReminderState marks a booking confirmed or moved less than a day ahead 'skipped', because
 * the email about it stands in for the reminder. When that email didn't all go out, the reminder
 * is due again instead, so the member still hears about it before it starts.
 */
async function restoreReminderIfNotEmailed(reservation, tag, emailSent) {
  if (emailSent !== true && reservation?.status === 'reserved') {
    await setReminderState(reservation.id, reservationStartsAt(reservation, tag), Date.now(), {
      notified: false,
    });
  }
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
    isFollowUp: Boolean(reservation.followUpOf),
    memberEmail: role === 'expert' ? reservation.userEmail ?? null : null,
    expertEmail: role === 'member' ? item.expertEmail ?? null : null,
  };
}

/**
 * Resolves the caller's relationship to a consultation (member, expert, owner, admin). `isOwner`:
 * the item's owner (015) when the mentor has no address of their own (itemOwnerEmail), who
 * manages its consultations as the mentor would, with the library team's wording.
 */
async function loadConsultationForUser(user, reservationId) {
  const found = await findReservationWithItem(reservationId);

  if (!found || found.item.tag !== 'expertise') {
    return null;
  }

  const email = user?.email ?? '';
  const isMember = isConsultationMember(found.reservation, email);
  const isExpert = isConfirmedUser(user) && isConsultationExpert(found.item, email);
  const isOwner = isConfirmedUser(user) && !isExpert && isItemOwner(found.item, email);
  const isAdmin = isAdminUser(user);

  if (!isMember && !isExpert && !isOwner && !isAdmin) {
    return null;
  }

  return { ...found, isMember, isExpert, isOwner, isAdmin };
}

/** Who acted for the mentor (a loadConsultationForUser result), for logs and Slack. */
function consultationHostRole(found) {
  if (found.isExpert) {
    return 'expert';
  }
  return found.isOwner ? 'owner' : 'admin';
}

/**
 * How emails word an action taken for the mentor: 'expert' (in the mentor's name) or 'admin'
 * (the library team), as `messageFrom` and `cancelledBy`. Staff speak for the library; an owner
 * who isn't staff (a member whose own profile lost its expert email) speaks as the mentor.
 */
function consultationHostVoice(found) {
  return found.isExpert || (found.isOwner && !found.isAdmin) ? 'expert' : 'admin';
}

function reservationItemPayload(item) {
  const sanitized = sanitizeItemForPublic(item);
  return { id: sanitized.id, reservations: sanitized.reservations };
}

/**
 * Posts to the Slack workflow trigger. Logs failures and never throws; the 5s timeout bounds
 * how long the calling route waits.
 */
async function postSlackWorkflow(payload) {
  if (!SLACK_RESERVATION_WEBHOOK_URL) {
    return;
  }

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

async function notifySlackReservation({ item, reservation }) {
  return postSlackWorkflow({
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
  });
}

/**
 * A staff alert through the same Slack workflow trigger, so it sends exactly the
 * notifySlackReservation keys (unused ones ''). `status` names the event (e.g.
 * 'mentor_profile_published') and `summary` is the sentence staff read, sent as `message`
 * (after the event's emoji) and as `request_summary`. Pass `reservation` when the alert is about
 * one reservation or consultation; its id and dates fill `reservation_id`, `start_date` and
 * `end_date` (otherwise both dates are today).
 */
async function notifySlackAlert({ status, item, userEmail, summary, reservation = null }) {
  const today = toDateKey(new Date());

  return postSlackWorkflow({
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
  });
}

const MENTOR_PROFILE_FIELD_LABELS = [
  ['title', 'name'],
  ['body', 'short text'],
  ['longBody', 'long text'],
  ['image', 'photo'],
];

/**
 * Slack alert after a member publishes or edits their mentor profile, which goes live at once.
 * An edit that changed nothing sends no alert. Async so a throw can't escape settleNotifications.
 */
async function notifyMentorProfileChange(action, email, item, previous = null) {
  const pageUrl = itemPageUrl(item);

  if (action === 'published') {
    return notifySlackAlert({
      status: 'mentor_profile_published',
      item,
      userEmail: email,
      summary: `New mentor profile "${item.title}" published by ${email} (${pageUrl}). Review it in /admin > Mentors.`,
    });
  }

  const changed = previous
    ? MENTOR_PROFILE_FIELD_LABELS.filter(([key]) => (previous[key] ?? '') !== (item[key] ?? '')).map(
        ([, label]) => label,
      )
    : null;

  if (changed?.length === 0) {
    return undefined;
  }

  const renamed = previous && previous.title !== item.title ? ` (previously "${previous.title}")` : '';
  const what = changed ? `, changed: ${changed.join(', ')}` : '';
  return notifySlackAlert({
    status: 'mentor_profile_updated',
    item,
    userEmail: email,
    summary: `Mentor profile "${item.title}"${renamed} updated by ${email}${what} (${pageUrl}). Review it in /admin > Mentors.`,
  });
}

/** Slack alert when a member cancels an approved equipment, book or room reservation from /account. */
async function notifyMemberReservationCancelled(item, reservation) {
  const email = reservation.userEmail ?? '';

  return notifySlackAlert({
    status: 'reservation_cancelled_by_member',
    item,
    userEmail: email,
    reservation,
    summary: `${email} cancelled their approved reservation of "${item.title}" (${formatReservationDates(reservation)}) from their account. Those dates are free again (${itemPageUrl(item)}).`,
  });
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
    // Public by design: it sits in every Transit map tile URL (src/lib/map-tiles.js).
    THUNDERFOREST_API_KEY: process.env.THUNDERFOREST_API_KEY?.trim() || '',
  };
}

// www.<site host> → apex, same path and query. The www host needs its own Cloud Run
// domain mapping + DNS record to reach this; other hosts (localhost, *.run.app) pass.
function wwwRedirectEntry(origin) {
  try {
    const { hostname, origin: apexOrigin } = new URL(origin);
    return hostname.startsWith('www.') ? null : [`www.${hostname}`, apexOrigin];
  } catch {
    return null;
  }
}

const WWW_REDIRECT_ORIGINS = new Map(
  [SITE_URL, PRODUCTION_SITE_ORIGIN].map(wwwRedirectEntry).filter(Boolean),
);

app.use((req, res, next) => {
  const apexOrigin = WWW_REDIRECT_ORIGINS.get((req.hostname || '').toLowerCase());
  if (!apexOrigin) {
    return next();
  }

  res.redirect(301, `${apexOrigin}${req.originalUrl}`);
});

// Staff bookings' GA event (013): Create Reservation queues it, and the server sends it about an
// hour after the booking, unless the booking was a test (cancelled within the hour, as /admin
// Stats counts) or deleted. Needs GA_MEASUREMENT_ID and GA_API_SECRET, and only the deployed
// service does it (as with item views, local .env is production): otherwise nothing is queued
// and the form sends the event from the browser at once, as before.
const STAFF_BOOKING_GA_EVENTS_HERE =
  isGaMeasurementProtocolConfigured() &&
  (process.env.NODE_ENV === 'production' || Boolean(process.env.K_SERVICE));
const GA_EVENT_PASS_INTERVAL_MS = 10 * 60 * 1000;
// How long a request waits for the passes it started (GA events and reminders, together).
const PASS_REQUEST_WAIT_MS = 3000;
let gaEventPassStartedAt = 0;
let gaEventPass = null;

/**
 * One pass over the queued staff bookings made at least an hour ago. Each is expired (past GA's
 * 72-hour backdating limit), skipped (a test cancellation) or claimed (`pending` → `sending`, so
 * a second instance can't send it too), sent dated when it was made, and marked `sent`; a failed
 * send goes back to `pending` for the next pass.
 */
async function sendDueStaffBookingEvents(now = Date.now()) {
  const due = await listPendingGaEvents(new Date(now - TEST_CANCEL_WINDOW_MS).toISOString());

  for (const booking of due) {
    const madeAt = Date.parse(booking.createdAt ?? '');
    if (Number.isNaN(madeAt) || now - madeAt > GA_BACKDATE_LIMIT_MS) {
      if (await moveGaEvent(booking.id, 'pending', 'expired')) {
        console.warn(
          `[ga] Staff booking ${booking.id} wasn't sent in time: GA takes events up to 72 hours old.`,
        );
      }
      continue;
    }

    if (isTestCancellation(booking)) {
      await moveGaEvent(booking.id, 'pending', 'skipped');
      continue;
    }

    if (!(await moveGaEvent(booking.id, 'pending', 'sending'))) {
      continue;
    }

    try {
      await sendStaffBookingEvent(booking);
    } catch (error) {
      console.error(`[ga] Could not send staff booking ${booking.id}, will retry:`, error.message);
      await moveGaEvent(booking.id, 'sending', 'pending');
      continue;
    }

    await moveGaEvent(booking.id, 'sending', 'sent');
    console.info(`[ga] Sent booking_request_sent for staff booking ${booking.id}.`);
  }
}

// Day-before reminders (015): about 24 hours before a confirmed booking starts
// (reservationStartsAt), the member gets "Your reservation is coming up!", and for a consultation
// the mentor too. A booking confirmed or moved less than a day ahead gets none (setReminderState:
// that email was its reminder). Only the deployed service sends them, as with the GA events
// (local .env is production), and only with Resend configured.
const RESERVATION_REMINDERS_HERE =
  Boolean(apiKey) && (process.env.NODE_ENV === 'production' || Boolean(process.env.K_SERVICE));
const REMINDER_PASS_INTERVAL_MS = 10 * 60 * 1000;
// No new claim after this much of a pass: a consultation's two paced emails still fit in the
// request's 3 s wait.
const REMINDER_PASS_CLAIM_WINDOW_MS = 1500;
let reminderPassStartedAt = 0;
let reminderPass = null;

/**
 * One pass over the confirmed bookings whose reminder is due. Each is claimed (`reminder_email`
 * null → 'sending', so two passes can't both send it), then read again in full: no longer
 * confirmed, or moved out of the window, → released (null; a new time is picked up when it is
 * due); already started → 'skipped'. Its emails go one at a time, paced for Resend's rate limit:
 * any accepted → 'sent'; none → released for the next pass; nobody to email → 'skipped'.
 */
async function sendDueReservationReminders(now = Date.now()) {
  await releaseStaleReminderClaims(now);
  const due = await listReminderCandidates(now);
  let lastSentAt = 0;

  for (const candidate of due) {
    // Time-boxed so the pass ends inside the request that waits for it (Cloud Run throttles CPU
    // once the response is out); the rest stay unclaimed for the next pass, 10 minutes later.
    if (Date.now() - now > REMINDER_PASS_CLAIM_WINDOW_MS) {
      break;
    }

    if (!(await claimReminder(candidate.id))) {
      continue;
    }

    let outcome = null;
    try {
      const found = await findReservationWithItem(candidate.id);
      const startsAt =
        found?.reservation.status === 'reserved'
          ? reservationStartsAt(found.reservation, found.item.tag)
          : NaN;

      if (startsAt <= now) {
        outcome = 'skipped';
      } else if (isReminderDue(startsAt, now)) {
        const payloads = buildReservationReminderEmailPayloads(found.item, found.reservation);
        let accepted = 0;
        for (const payload of payloads) {
          const wait = lastSentAt + EMAIL_PACING_MS_PER_EMAIL - Date.now();
          if (wait > 0) {
            await delay(wait);
          }
          lastSentAt = Date.now();
          if (await sendEmailPayloads([payload], 'Reservation reminder')) {
            accepted += 1;
          }
        }

        if (payloads.length === 0) {
          outcome = 'skipped';
        } else if (accepted > 0) {
          outcome = 'sent';
        }
      }
    } catch (error) {
      console.error(`[reminder] Could not send the reminder for reservation ${candidate.id}, will retry:`, error);
    }

    try {
      await settleReminder(candidate.id, outcome);
    } catch (error) {
      // Left at 'sending': releaseStaleReminderClaims hands it back after half an hour.
      console.error(`[reminder] Could not settle the reminder for reservation ${candidate.id}:`, error);
    }
    if (outcome === 'sent') {
      console.info(`[reminder] Sent reminder for reservation ${candidate.id}.`);
    }
  }
}

/**
 * No timers: Cloud Run throttles CPU between requests, so each pass runs on whatever request comes
 * in, at most every 10 minutes, and that request waits for the passes it started (3 s at most in
 * all; a longer pass carries on, and the claims make it safe to cut short).
 */
app.use(async (_req, _res, next) => {
  const now = Date.now();
  const started = [];

  if (
    STAFF_BOOKING_GA_EVENTS_HERE &&
    !gaEventPass &&
    now - gaEventPassStartedAt >= GA_EVENT_PASS_INTERVAL_MS
  ) {
    gaEventPassStartedAt = now;
    gaEventPass = sendDueStaffBookingEvents()
      .catch((error) => console.error('[ga] Staff booking events pass failed:', error))
      .finally(() => {
        gaEventPass = null;
      });
    started.push(gaEventPass);
  }

  if (
    RESERVATION_REMINDERS_HERE &&
    !reminderPass &&
    now - reminderPassStartedAt >= REMINDER_PASS_INTERVAL_MS
  ) {
    reminderPassStartedAt = now;
    reminderPass = sendDueReservationReminders()
      .catch((error) => console.error('[reminder] Reservation reminders pass failed:', error))
      .finally(() => {
        reminderPass = null;
      });
    started.push(reminderPass);
  }

  if (started.length > 0) {
    await Promise.race([Promise.allSettled(started), delay(PASS_REQUEST_WAIT_MS, undefined, { ref: false })]);
  }
  next();
});

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

// GA can fall back to image beacons when sendBeacon/fetch is unavailable. Map tiles are <img>s
// (OpenStreetMap and Thunderforest, src/lib/map-tiles.js), loaded only once someone opens a map.
const imgSrc = [
  "'self'",
  'data:',
  'https://*.google-analytics.com',
  'https://*.googletagmanager.com',
  ...MAP_TILE_HOSTS,
];

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

// Cloud Run's front end adds no Content-Encoding, so compress here (Brotli or
// gzip for JSON, HTML, JS, CSS; images and WOFF2 are skipped by type).
app.use(compression());

// Photo uploads: `code` lets the client show its own EN/FR message.
const IMAGE_TOO_LARGE_ERROR = {
  status: 413,
  body: { error: 'This photo is too large. Please choose a smaller image.', code: 'image_too_large' },
};

const IMAGE_INVALID_ERROR = {
  status: 400,
  body: {
    error: 'Image must be a JPEG, PNG, WebP, or GIF data URL or a path under /assets/inventory/.',
    code: 'image_invalid',
  },
};

const MEMBER_IMAGE_INVALID_ERROR = {
  status: 400,
  body: { error: 'Photo must be a JPEG, PNG, WebP, or GIF image.', code: 'image_invalid' },
};

/** null when `image` may be stored; otherwise the `{ status, body }` to send. */
function inventoryImageError(image) {
  if (isValidInventoryImage(image)) {
    return null;
  }

  return isOversizedImageDataUrl(image) ? IMAGE_TOO_LARGE_ERROR : IMAGE_INVALID_ERROR;
}

/** Same for member uploads, which must be a photo: /assets/inventory/ seed paths are admin-only. */
function memberImageError(image) {
  if (isStorableImageDataUrl(image)) {
    return null;
  }

  return isOversizedImageDataUrl(image) ? IMAGE_TOO_LARGE_ERROR : MEMBER_IMAGE_INVALID_ERROR;
}

// Room for one capped data URL plus the text fields. A larger body gets the same
// JSON 413 as an oversized photo instead of Express's HTML error page.
const imageUploadJsonParser = express.json({ limit: '3mb' });

function imageUploadJson(req, res, next) {
  imageUploadJsonParser(req, res, (error) => {
    if (error?.type === 'entity.too.large') {
      return res.status(IMAGE_TOO_LARGE_ERROR.status).json(IMAGE_TOO_LARGE_ERROR.body);
    }
    next(error);
  });
}

app.post('/api/inventory', imageUploadJson, requireAuth, requireAdmin, async (req, res) => {
  const tagProvided =
    req.body?.tag !== undefined && req.body?.tag !== null && String(req.body.tag).trim() !== '';

  if (tagProvided && !isValidTag(req.body.tag)) {
    return res.status(400).json({ error: 'Tag must be equipment, books, rooms, or expertise.' });
  }

  const image = typeof req.body?.image === 'string' ? req.body.image.trim() : '';
  // A missing image is reported with the other required fields below.
  const imageError = image ? inventoryImageError(image) : null;
  if (imageError) {
    return res.status(imageError.status).json(imageError.body);
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
    // The admin who adds it owns it (015): its bookings are theirs to manage on /account.
    const savedItem = await createInventoryItem({ ...item, ownerEmail: req.user.email.trim() });
    auditAdminAction(req, 'create_inventory_item', { itemId: savedItem.id });
    res.status(201).json({ item: withPublicItemImage(savedItem) });
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
  imageUploadJson,
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
    const rawImage = typeof req.body?.image === 'string' ? req.body.image.trim() : '';
    // The mentor's own /media URL sent back means the photo did not change.
    const image = isItemMediaUrlForItem(rawImage, id) ? '' : rawImage;
    const imageProvided = image !== '';

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

    const imageError = imageProvided ? inventoryImageError(image) : null;
    if (imageError) {
      return res.status(imageError.status).json(imageError.body);
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

      const handover = await sendMentorEmailHandover(result.item, result.previousExpertEmail);
      auditAdminAction(req, 'update_expertise_item', {
        itemId: id,
        ...(handover ? { handedOver: handover.count } : {}),
      });
      res.json({ item: withPublicItemImage(result.item), handover });
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
    image: publicItemImageUrl(item),
    tag: item.tag,
    slug: item.slug ?? null,
    createdAt: item.createdAt,
    expertEmail: item.expertEmail ?? null,
  };
}

/**
 * `allowMediaUrl` (updates only) passes a `/media/items/...` URL through so the
 * route can check it is the member's own photo, which means "unchanged".
 */
function readMentorProfileInput(body, { imageRequired, allowMediaUrl = false }) {
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

  const imageError =
    image && !(allowMediaUrl && isItemMediaUrl(image)) ? memberImageError(image) : null;
  if (imageError) {
    return { status: imageError.status, ...imageError.body };
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
  imageUploadJson,
  mentorProfileLimiter,
  requireAuth,
  async (req, res) => {
    const email = confirmedAccountEmail(req, res);

    if (!email) {
      return;
    }

    const input = readMentorProfileInput(req.body, { imageRequired: true });

    if (input.error) {
      return res.status(input.status ?? 400).json({ error: input.error, code: input.code });
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
      await settleNotifications('Mentor profile published', [
        notifyMentorProfileChange('published', email, result.item),
      ]);
      res.status(201).json({ profile: serializeMentorProfile(result.item) });
    } catch (error) {
      sendMentorProfileError(res, error, 'Could not save your mentor profile.');
    }
  },
);

app.patch(
  '/api/account/mentor-profile',
  imageUploadJson,
  mentorProfileLimiter,
  requireAuth,
  async (req, res) => {
    const email = confirmedAccountEmail(req, res);

    if (!email) {
      return;
    }

    const input = readMentorProfileInput(req.body, { imageRequired: false, allowMediaUrl: true });

    if (input.error) {
      return res.status(input.status ?? 400).json({ error: input.error, code: input.code });
    }

    try {
      await ensureInventory();
      let fields = input.fields;

      if (isItemMediaUrl(fields.image)) {
        // Only the member's own photo URL counts as "unchanged"; it is never stored.
        const existing = await findMentorProfileByEmail(email);

        if (!existing) {
          return res.status(404).json({ error: 'You do not have a mentor profile yet.' });
        }

        if (!isItemMediaUrlForItem(fields.image, existing.id)) {
          return res.status(MEMBER_IMAGE_INVALID_ERROR.status).json(MEMBER_IMAGE_INVALID_ERROR.body);
        }

        fields = { ...fields, image: '' };
      }

      const result = await updateMentorProfileForEmail(email, fields);

      if (result.invalid) {
        return res.status(400).json({ error: 'Name, short text, and long text are required.' });
      }

      if (result.notFound) {
        return res.status(404).json({ error: 'You do not have a mentor profile yet.' });
      }

      console.log('[mentor-profile]', { action: 'update', email, itemId: result.item.id });
      await settleNotifications('Mentor profile updated', [
        notifyMentorProfileChange('updated', email, result.item, result.previous),
      ]);
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

// Fonts, brand images and inventory photos keep stable file names, so they are
// cached for a week: to change one, give the new file a new name.
const STABLE_ASSET_STATIC_OPTIONS = { maxAge: '7d' };
app.use('/assets/fonts', express.static(path.join(__dirname, 'src', 'assets', 'fonts'), STABLE_ASSET_STATIC_OPTIONS));
app.use('/assets/brand', express.static(path.join(__dirname, 'src', 'assets', 'brand'), STABLE_ASSET_STATIC_OPTIONS));
app.use(INVENTORY_IMAGE_BASE, express.static(INVENTORY_ASSETS_DIR, STABLE_ASSET_STATIC_OPTIONS));

const DIST_DIR = path.join(__dirname, 'dist');
// Vite writes content-hashed files directly into dist/assets; subfolders there
// are copies from public/ with stable names.
const DIST_HASHED_ASSETS_DIR = path.join(DIST_DIR, 'assets');

// Hashed JS/CSS/images, robots.txt and the site icons only. `index: false` + `redirect: false` keep
// every HTML route (including `/`) on the catch-all below so it receives
// per-request SEO injection (locale-aware title/description/canonical/hreflang/
// JSON-LD) instead of the raw template, and so `/about` is never 301'd to
// `/about/` (which broke canonical URLs and sitemap entries).
app.use(
  express.static(DIST_DIR, {
    index: false,
    redirect: false,
    setHeaders(res, filePath) {
      if (path.dirname(filePath) === DIST_HASHED_ASSETS_DIR) {
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (filePath.endsWith('.html')) {
        res.set('Cache-Control', 'no-cache');
      } else {
        res.set('Cache-Control', 'public, max-age=3600');
      }
    },
  }),
);

// Unknown /assets/* paths (a chunk from an earlier deploy, a renamed font) must
// 404 instead of falling through to the SPA shell as HTML 200.
app.use('/assets', (_req, res) => {
  res.status(404).type('text/plain').send('Not found.');
});

// Uploaded photos (stored as data URLs) by content hash. Outside /api/ so crawlers
// and link previews can fetch og:image. A stale hash redirects to the current photo.
app.get(`${ITEM_MEDIA_BASE}/:id/:file`, async (req, res) => {
  const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';

  if (!id) {
    return res.status(404).type('text/plain').send('Not found.');
  }

  try {
    const image = await findInventoryItemImage(id);
    const fileName = itemMediaFileName(image);
    const parsed = fileName ? parseImageDataUrl(image) : null;

    if (!parsed) {
      return res.status(404).type('text/plain').send('Not found.');
    }

    if (req.params.file !== fileName) {
      res.set('Cache-Control', 'no-cache');
      return res.redirect(302, publicItemImageUrl({ id, image }));
    }

    res.set({
      'Content-Type': parsed.mime,
      'Cache-Control': 'public, max-age=31536000, immutable',
      // Helmet's default is same-origin; link previews and other sites may embed og:image.
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    res.send(Buffer.from(parsed.base64, 'base64'));
  } catch (error) {
    console.error('Failed to serve item image:', error);
    res.status(500).type('text/plain').send('Could not load image.');
  }
});

app.use('/media', (_req, res) => {
  res.status(404).type('text/plain').send('Not found.');
});

// robots.txt lets crawlers fetch these two (rendered item and category pages need
// them); the JSON itself stays out of the index.
const PUBLIC_INVENTORY_ROBOTS_TAG = 'noindex';

app.get('/api/inventory/by-slug/:tag/:slug', async (req, res) => {
  res.set('X-Robots-Tag', PUBLIC_INVENTORY_ROBOTS_TAG);
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
  res.set('X-Robots-Tag', PUBLIC_INVENTORY_ROBOTS_TAG);
  try {
    const items = await ensureInventory();
    res.set('Cache-Control', 'no-store');
    res.json({ items: items.map(sanitizeItemForPublic) });
  } catch (error) {
    console.error('Failed to read inventory:', error);
    res.status(500).json({ error: 'Could not load inventory.' });
  }
});

const bikeShareLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many map requests. Please try again later.', code: 'bike_share_limit' },
});

// Live bike-share docks near a point, for the item and booking maps (src/lib/bike-share.js).
// Public: the item window sends its approximate area's centre, never the address. Always 200
// with `{ system, updatedAt, docks }`; a feed that fails gives no docks.
app.get('/api/bike-share', bikeShareLimiter, async (req, res) => {
  const decimal = (value) => (typeof value === 'string' && /^-?\d{1,3}(\.\d{1,10})?$/.test(value) ? Number(value) : NaN);
  const lat = decimal(req.query.lat);
  const lon = decimal(req.query.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return res.status(400).json({ error: 'lat and lon are required.', code: 'bike_share_invalid' });
  }

  const result = await bikeShareNear(lat, lon);
  res.set('X-Robots-Tag', PUBLIC_INVENTORY_ROBOTS_TAG);
  res.set('Cache-Control', 'public, max-age=60');
  res.json(result);
});

// View counter for /admin Stats. Every outcome is a bare 204, so the client never retries or
// learns what was counted. Seed ids (myturn-123) and UUIDs both match the id pattern.
const ITEM_VIEW_ID_PATTERN = /^[\w-]{1,200}$/;
// Crawlers, link previews and audit tools. `(?<!cu)` keeps CUBOT phones (their Android
// user agent names the model) out of the `bot` match; normal browsers match none of these.
const ITEM_VIEW_BOT_PATTERN =
  /(?<!cu)bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|embedly|whatsapp|inspectiontool/i;
const ITEM_VIEW_DEDUPE_MAX = 50_000;
// One view per address, item and library day. In-memory: single Cloud Run instance, reset on deploy.
const itemViewDedupe = new Set();
let itemViewDedupeDay = '';
let itemViewDedupeFullDay = '';
// Local .env is the production database, so only the deployed service counts views: the
// Dockerfile sets NODE_ENV=production and Cloud Run sets K_SERVICE. `npm run dev`, `npm start`
// and `npm run preview` on a laptop never write a count.
const ITEM_VIEWS_RECORDED_HERE =
  process.env.NODE_ENV === 'production' || Boolean(process.env.K_SERVICE);
let itemViewLocalNoticeLogged = false;
let itemViewSchemaNoticeLogged = false;

const itemViewLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(204).end();
  },
});

/**
 * False when this key was already counted today, or when today's set is full: counting then
 * stops until the next library day, since clearing early would count everyone again. The set
 * starts over each day.
 */
function claimItemView(key, day) {
  if (day !== itemViewDedupeDay) {
    itemViewDedupe.clear();
    itemViewDedupeDay = day;
  }

  if (itemViewDedupe.has(key)) {
    return false;
  }

  if (itemViewDedupe.size >= ITEM_VIEW_DEDUPE_MAX) {
    if (itemViewDedupeFullDay !== day) {
      itemViewDedupeFullDay = day;
      console.warn('[item-views] Views are not recorded for the rest of the day: the dedupe list is full.');
    }
    return false;
  }

  itemViewDedupe.add(key);
  return true;
}

app.post('/api/inventory/:id/view', itemViewLimiter, async (req, res) => {
  const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
  const userAgent = req.get('user-agent') ?? '';
  const fetchSite = req.get('sec-fetch-site');

  if (!ITEM_VIEW_ID_PATTERN.test(id) || !userAgent || ITEM_VIEW_BOT_PATTERN.test(userAgent)) {
    return res.status(204).end();
  }

  // Browsers send Sec-Fetch-Site; only the site's own pages may count a view.
  if (fetchSite && fetchSite !== 'same-origin') {
    return res.status(204).end();
  }

  if (!ITEM_VIEWS_RECORDED_HERE) {
    if (!itemViewLocalNoticeLogged) {
      itemViewLocalNoticeLogged = true;
      console.log(
        '[item-views] Views are not recorded here: only the deployed service counts them (local .env is production).',
      );
    }
    return res.status(204).end();
  }

  const day = libraryTodayKey();
  const dedupeKey = `${ipKeyGenerator(req.ip)}|${id}|${day}`;
  if (!claimItemView(dedupeKey, day)) {
    return res.status(204).end();
  }

  // Awaited before responding: Cloud Run throttles CPU once the response is out.
  try {
    const result = await recordItemView(id, day);
    // Ids that aren't items give their slot back, so made-up ids can't fill the dedupe list.
    if (result.unknownItem) {
      itemViewDedupe.delete(dedupeKey);
    }
    if (result.schemaMissing && !itemViewSchemaNoticeLogged) {
      itemViewSchemaNoticeLogged = true;
      console.warn(
        '[item-views] Views are not recorded: apply supabase/migrations/009_admin_stats.sql in the Supabase SQL Editor.',
      );
    }
  } catch (error) {
    // Not counted, so a later open by the same address may try again.
    itemViewDedupe.delete(dedupeKey);
    console.error('Failed to record item view:', error);
  }

  res.status(204).end();
});

app.get('/api/admin/inventory', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const items = await ensureInventory();
    res.set('Cache-Control', 'no-store');
    res.json({ items: items.map(withPublicItemImage) });
  } catch (error) {
    console.error('Failed to read admin inventory:', error);
    res.status(500).json({ error: 'Could not load inventory.' });
  }
});

const ITEM_VIEW_DAILY_DAYS = 30;

/**
 * View counts for /admin Stats. `daily` always has 30 entries, `since30` through `today`
 * (Montréal days), zero-filled. `{ available: false, today }` until migration 009 is applied.
 */
app.get('/api/admin/item-views', requireAuth, requireAdmin, async (_req, res) => {
  const today = libraryTodayKey();
  const since30 = addDays(today, -(ITEM_VIEW_DAILY_DAYS - 1));
  const since60 = addDays(today, -59);

  try {
    const stats = await loadItemViewStats({ since30, since60, dailySince: since30 });
    res.set('Cache-Control', 'no-store');

    if (!stats.available) {
      return res.json({ available: false, today });
    }

    const viewsByDay = new Map(stats.daily.map((entry) => [entry.day, entry.views]));
    const daily = Array.from({ length: ITEM_VIEW_DAILY_DAYS }, (_, index) => {
      const day = addDays(since30, index);
      return { day, views: viewsByDay.get(day) ?? 0 };
    });

    res.json({
      available: true,
      today,
      since30,
      since60,
      firstDay: stats.firstDay,
      items: stats.items,
      daily,
    });
  } catch (error) {
    console.error('Failed to load item views:', error);
    res.status(500).json({ error: 'Could not load view counts.' });
  }
});

const CONSULTATION_TIME_SLOTS_MAX = 500;
const CONSULTATION_SUMMARY_MAX = 2000;

// IP limiter first (it also shields Supabase auth from token floods), then the per-account cap.
app.post('/api/inventory/:id/reservations', reservationCreateLimiter, requireAuth, reservationAccountLimiter, countSavedReservationCreates(async (req, res) => {
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

      if (item.tag === 'rooms') {
        // The hours and what the room is for, kept in the consultation columns (staff only).
        const room = validateRoomRequest({
          startTime: req.body?.startTime,
          endTime: req.body?.endTime,
          purpose: req.body?.purpose,
        });

        if (!room.ok) {
          return res.status(400).json({ error: room.error, code: room.code });
        }

        timeSlots = room.timeSlots;
        requestSummary = room.purpose;
      }
    }

    const pendingCount = await countPendingReservationsByEmail(userEmail);

    if (pendingCount >= MAX_PENDING_RESERVATIONS_PER_USER) {
      return res.status(429).json({
        error: 'Too many pending reservations. Please wait for admin review before submitting more.',
        code: 'pending_request_limit',
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

    if (result.consultationAlreadyOpen) {
      return res.status(409).json({
        error:
          'You already have an open consultation request with this expert. Follow or cancel it from your account page.',
        code: 'consultation_already_open',
      });
    }

    const { item: updatedItem, reservation } = result;
    // Counts against the daily cap from here, even if the client leaves before the response.
    res.locals.reservationSaved = true;
    const emailSent = await settleNotifications('New reservation', [
      notifySlackReservation({ item: updatedItem, reservation }),
      isExpertise ? sendConsultationRequestEmails(updatedItem, reservation) : null,
    ]);

    res.status(201).json({
      reservation: sanitizeReservationForPublic(reservation),
      item: reservationItemPayload(updatedItem),
      ...(isExpertise ? { emailSent } : {}),
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
}));

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
    const today = libraryTodayKey();
    let emailSent;
    // A meeting already held is only a record: removing it deletes no Zoom meeting and emails nobody.
    if (
      result.item.tag === 'expertise' &&
      (removed.status === 'pending' || removed.status === 'reserved') &&
      !isConsultationHeld(removed)
    ) {
      emailSent = await settleNotifications('Consultation cancelled', [
        handleConsultationCancelled(result.item, { ...removed, cancelledBy: 'admin' }, removed.status),
      ]);
    } else if (
      result.item.tag !== 'expertise' &&
      isUpcomingMemberReservation(removed, today)
    ) {
      // The member may be counting on this booking (or still waiting on the request).
      emailSent = await settleNotifications('Reservation cancelled', [
        sendReservationCancelledByTeamEmail(result.item, removed, today),
      ]);
    }

    auditAdminAction(req, 'delete_reservation', { itemId, reservationId });
    res.json({
      success: true,
      item: withPublicItemImage(result.item),
      ...(emailSent === undefined ? {} : { emailSent }),
    });
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

    // Confirmed, or confirmed with new dates: the reminder follows the start. No email goes out
    // here, so it stays due even less than a day ahead (the reminder is the member's notice).
    if (result.reservation.status === 'reserved' && Object.keys(updates).length > 0) {
      await setReminderState(
        result.reservation.id,
        reservationStartsAt(result.reservation, result.item.tag),
        Date.now(),
        { notified: false },
      );
    }

    auditAdminAction(req, 'patch_reservation', { itemId, reservationId, updates });
    res.json({ item: withPublicItemImage(result.item), reservation: result.reservation });
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

  const { message, error: messageError } = readConfirmationMessage(req.body);
  if (messageError) {
    return res.status(400).json({ error: messageError });
  }

  try {
    const result = await approveReservation(itemId, reservationId);

    if (result.isConsultation) {
      const scheduled = await runScheduleConsultation({
        itemId,
        reservationId,
        meetingAt: typeof req.body?.meetingAt === 'string' ? req.body.meetingAt : '',
        message,
        messageFrom: 'admin',
      });

      if (scheduled.status !== 200) {
        return res.status(scheduled.status).json(scheduled.body);
      }

      auditAdminAction(req, 'schedule_consultation', { itemId, reservationId });
      return res.json({
        item: withPublicItemImage(scheduled.result.item),
        reservation: scheduled.result.reservation,
        emailSent: scheduled.emailSent,
      });
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

    await setReminderState(result.reservation.id, reservationStartsAt(result.reservation, result.item.tag));
    const emailSent = await settleNotifications('Reservation approval', [
      sendMemberDecisionEmail(result.item, result.reservation, 'approved', message),
    ]);
    await restoreReminderIfNotEmailed(result.reservation, result.item.tag, emailSent);

    auditAdminAction(req, 'approve_reservation', { itemId, reservationId });
    res.json({ item: withPublicItemImage(result.item), reservation: result.reservation, emailSent });
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

    const emailSent = await settleNotifications('Reservation refusal', [
      sendMemberDecisionEmail(result.item, result.reservation, 'refused'),
    ]);

    auditAdminAction(req, 'refuse_reservation', { itemId, reservationId });
    res.json({ item: withPublicItemImage(result.item), reservation: result.reservation, emailSent });
  } catch (error) {
    console.error('Failed to refuse reservation:', error);
    res.status(500).json({ error: 'Could not refuse reservation.' });
  }
});

// Staff bookings: any dates (members' Tuesday blocks don't apply), up to a year long.
const STAFF_RESERVATION_MAX_DAYS = 366;
const EMAIL_ADDRESS_MAX = 254;

/**
 * An equipment, book or room booking's dates from the request body: `{ startDate, endDate }`,
 * or `{ error }` with the 400 body.
 */
function readStaffBookingDates(body, today) {
  const startDate = typeof body?.startDate === 'string' ? body.startDate.trim() : '';
  const endDate = typeof body?.endDate === 'string' ? body.endDate.trim() : '';

  if (!parseDateKey(startDate) || !parseDateKey(endDate) || compareDateKeys(startDate, endDate) > 0) {
    return { error: { error: 'Choose a start date on or before the end date.', code: 'reservation_dates_invalid' } };
  }

  if (compareDateKeys(endDate, today) < 0) {
    return { error: { error: 'These dates are in the past.', code: 'reservation_dates_past' } };
  }

  if (compareDateKeys(endDate, addDays(startDate, STAFF_RESERVATION_MAX_DAYS - 1)) > 0) {
    return {
      error: {
        error: `A reservation can be at most ${STAFF_RESERVATION_MAX_DAYS} days long.`,
        code: 'reservation_dates_too_long',
      },
    };
  }

  return { startDate, endDate };
}

/**
 * A consultation's meeting time and optional topic (`summary`) from the request body:
 * `{ meetingAt, summary }`, or `{ error }` with the 400 body. Same time rule as scheduling.
 */
function readStaffBookingMeeting(body) {
  const meetingAt = typeof body?.meetingAt === 'string' ? body.meetingAt.trim() : '';
  const summary = typeof body?.summary === 'string' ? body.summary.trim() : '';
  const meetingError = validateMeetingAt(meetingAt);

  if (meetingError) {
    const code = Number.isNaN(Date.parse(meetingAt)) ? 'reservation_meeting_required' : 'reservation_meeting_past';
    return { error: { error: meetingError, code } };
  }

  if (summary.length > CONSULTATION_SUMMARY_MAX) {
    return { error: { error: `Summary must be ${CONSULTATION_SUMMARY_MAX} characters or fewer.` } };
  }

  return { meetingAt, summary };
}

/**
 * Admin **Create Reservation**: books an item for any email address, member or not, as confirmed
 * (`reserved`), and emails them with an invitation to sign in or register with that address.
 * Equipment, books and rooms take `startDate` and `endDate` (no member date rules). A mentor
 * (expertise) takes `meetingAt` and an optional `summary`: the consultation is scheduled at once,
 * with its Zoom meeting and the scheduled emails to the member and the mentor, and a member can
 * still have only one open consultation per mentor. No caps or Slack post.
 */
app.post('/api/admin/inventory/:id/reservations', requireAuth, requireAdmin, async (req, res) => {
  const itemId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const today = libraryTodayKey();

  if (!itemId) {
    return res.status(400).json({ error: 'Item id is required.' });
  }

  if (!email || email.length > EMAIL_ADDRESS_MAX || !isValidEmailAddress(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.', code: 'reservation_email_invalid' });
  }

  const { message, error: messageError } = readConfirmationMessage(req.body);
  if (messageError) {
    return res.status(400).json({ error: messageError });
  }

  try {
    await ensureInventory();
    const item = await findInventoryItem(itemId);

    if (!item) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    const isConsultation = item.tag === 'expertise';
    const booking = isConsultation ? readStaffBookingMeeting(req.body) : readStaffBookingDates(req.body, today);
    if (booking.error) {
      return res.status(400).json(booking.error);
    }

    // Decides the email's wording only; a failed lookup still books, with neutral wording.
    let account = 'unknown';
    try {
      const user = await findAuthUserByEmail(email);
      if (user && isUserSuspended(user)) {
        return res.status(409).json({
          error: 'This account is suspended. Lift the suspension in Members first.',
          code: 'reservation_account_suspended',
        });
      }
      account = user && isConfirmedUser(user) ? 'member' : 'new';
    } catch (error) {
      console.error('Could not look up the account for a staff reservation:', error);
    }

    let result;
    try {
      result = await addReservation(itemId, {
        // A consultation is dated the day it was booked, like a member's request or a follow-up.
        startDate: isConsultation ? today : booking.startDate,
        endDate: isConsultation ? today : booking.endDate,
        userEmail: email,
        status: 'reserved',
        bookedByStaff: true,
        queueGaEvent: STAFF_BOOKING_GA_EVENTS_HERE,
        ...(isConsultation
          ? {
              requestSummary: booking.summary,
              meetingAt: booking.meetingAt,
              createMeeting: createZoomMeetingForConsultation,
              deleteMeeting: deleteConsultationMeeting,
            }
          : {}),
      });
    } catch (error) {
      if (error.zoomFailed) {
        return res.status(502).json({
          error: 'Could not create the Zoom meeting. Please try again in a moment.',
          code: 'reservation_zoom_failed',
        });
      }
      throw error;
    }

    if (result.notFound) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    if (result.collision) {
      return res.status(409).json({
        error: 'These dates overlap a reservation or a pending request on this item.',
        code: 'reservation_collision',
      });
    }

    if (result.consultationAlreadyOpen) {
      return res.status(409).json({
        error: 'This person already has a pending request or an upcoming meeting with this mentor. Schedule or cancel that one instead.',
        code: 'reservation_consultation_open',
      });
    }

    if (result.meetingTimeRequired) {
      return res.status(400).json({
        error: 'A valid meeting date and time is required to schedule a consultation.',
        code: 'reservation_meeting_required',
      });
    }

    // New rows start without a reminder state; one booked less than a day ahead needs 'skipped'.
    await setReminderState(result.reservation.id, reservationStartsAt(result.reservation, result.item.tag));
    const emailSent = isConsultation
      ? await settleNotifications('Staff consultation', [
          sendConsultationScheduledEmails(result.item, result.reservation, { message, messageFrom: 'admin', account }),
        ])
      : await settleNotifications('Staff reservation', [
          sendStaffReservationEmail(result.item, result.reservation, { account, message, today }),
        ]);
    await restoreReminderIfNotEmailed(result.reservation, result.item.tag, emailSent);

    auditAdminAction(req, isConsultation ? 'create_consultation' : 'create_reservation', {
      itemId,
      reservationId: result.reservation.id,
      account,
    });
    res.status(201).json({
      item: withPublicItemImage(result.item),
      reservation: result.reservation,
      emailSent,
      hasAccount: account === 'unknown' ? null : account === 'member',
      // The server sends GA's event an hour from now; when false the form sends it at once.
      gaEventQueued: result.gaEventQueued === true,
    });
  } catch (error) {
    console.error('Failed to create staff reservation:', error);
    res.status(500).json({ error: 'Could not create the reservation.' });
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

    let emailSent;
    if (existingItem?.tag === 'expertise') {
      // Held meetings are deleted with the item but not cancelled (no Zoom delete, no emails).
      const activeConsultations = existingItem.reservations.filter(
        (entry) =>
          (entry.status === 'pending' || entry.status === 'reserved') && !isConsultationHeld(entry),
      );
      // Paced rounds, so a mentor with many requests doesn't hit Resend's rate limit. Each
      // cancellation emails the member and the expert.
      emailSent = await settleNotificationRounds('Consultation cancelled', activeConsultations, 2, (reservation) =>
        handleConsultationCancelled(
          existingItem,
          { ...reservation, cancelledBy: 'admin' },
          reservation.status,
        ),
      );
    } else if (existingItem) {
      // Equipment, books and rooms: tell each member whose request or booking went with the item.
      const today = libraryTodayKey();
      const upcoming = existingItem.reservations.filter((entry) =>
        isUpcomingMemberReservation(entry, today),
      );
      emailSent = await settleNotificationRounds('Reservation cancelled', upcoming, 1, (reservation) =>
        sendReservationCancelledByTeamEmail(existingItem, reservation, today),
      );
    }

    auditAdminAction(req, 'delete_inventory_item', { itemId: id });
    res.json({ success: true, ...(emailSent === undefined ? {} : { emailSent }) });
  } catch (error) {
    console.error('Failed to delete inventory item:', error);
    res.status(500).json({ error: 'Could not delete inventory item.' });
  }
});

// ---------------------------------------------------------------------------------------------
// /admin Users: member accounts from Supabase Auth (list, name, suspend, password reset, delete).

// Supabase user ids are lowercase UUIDs. auth.admin.getUserById, updateUserById and deleteUser
// throw (rather than return an error) on anything else, so ids are checked first.
const AUTH_USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ADMIN_USERS_PAGE_SIZE = 1000;
const ADMIN_USERS_MAX_PAGES = 50;
// About 100 years. GoTrue durations go up to hours (no d or y); 'none' lifts the ban.
const SUSPEND_BAN_DURATION = '876000h';
// Same flag as PASSWORD_RESET_RETURN_PARAM in src/lib/supabase.js (browser-only module): it tells
// the client an expired link came from a reset email.
const PASSWORD_RESET_RETURN_PARAM = 'password_reset';

function parseAuthUserId(raw) {
  const id = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return AUTH_USER_ID_PATTERN.test(id) ? id : '';
}

/** GoTrue timestamps (microseconds) as `toISOString()`, or null when missing. */
function isoTimestampOrNull(value) {
  const ms = typeof value === 'string' && value ? Date.parse(value) : NaN;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Same rule as userHasPasswordLogin in src/lib/auth.js: the account has an email/password login. */
function userHasPasswordLogin(user) {
  const providers = user?.app_metadata?.providers ?? [user?.app_metadata?.provider];
  return (
    (Array.isArray(providers) && providers.includes('email')) ||
    (user?.identities ?? []).some((identity) => identity?.provider === 'email')
  );
}

/** The staff-set name first, then what Google or Discord sent. */
function adminUserName(metadata) {
  return (
    trimmedOrNull(metadata.display_name) ??
    trimmedOrNull(metadata.full_name) ??
    trimmedOrNull(metadata.name) ??
    trimmedOrNull(metadata.custom_claims?.global_name) ??
    null
  );
}

/** Staff can't suspend or delete their own account or any @apathyisboring.com one (confirmed or not). */
function isProtectedAccount(user, currentUser) {
  const email = user?.email?.trim().toLowerCase() ?? '';
  return user?.id === currentUser?.id || email.endsWith(APATHY_ADMIN_DOMAIN);
}

/** The /admin Users row for a Supabase user (camelCase, no tokens or raw metadata). */
function serializeAdminUser(user, currentUserId) {
  const metadata = user?.user_metadata && typeof user.user_metadata === 'object' ? user.user_metadata : {};
  const appMetadata = user?.app_metadata && typeof user.app_metadata === 'object' ? user.app_metadata : {};
  const email = trimmedOrNull(user?.email);

  return {
    id: user.id,
    email,
    name: adminUserName(metadata),
    createdAt: isoTimestampOrNull(user.created_at),
    lastSignInAt: isoTimestampOrNull(user.last_sign_in_at),
    provider: trimmedOrNull(appMetadata.provider) ?? 'email',
    providers: Array.isArray(appMetadata.providers)
      ? appMetadata.providers.filter((provider) => typeof provider === 'string')
      : [],
    confirmed: isConfirmedUser(user),
    suspended: isUserSuspended(user),
    bannedUntil: isoTimestampOrNull(user.banned_until),
    passwordLogin: userHasPasswordLogin(user),
    isAdmin: (email ?? '').toLowerCase().endsWith(APATHY_ADMIN_DOMAIN),
    isSelf: user.id === currentUserId,
  };
}

/**
 * Every Supabase Auth user. auth-js reads nextPage from only the first digit of the Link header,
 * so this pages until a short page instead of trusting it.
 */
async function listAllAuthUsers() {
  const users = [];

  for (let page = 1; page <= ADMIN_USERS_MAX_PAGES; page += 1) {
    const { data, error } = await getSupabaseAdmin().auth.admin.listUsers({
      page,
      perPage: ADMIN_USERS_PAGE_SIZE,
    });

    if (error) {
      throw new Error(error.message || 'Could not list users.');
    }

    const batch = data?.users ?? [];
    users.push(...batch);

    if (batch.length < ADMIN_USERS_PAGE_SIZE) {
      return users;
    }
  }

  console.warn(`Admin users list stopped at ${ADMIN_USERS_MAX_PAGES * ADMIN_USERS_PAGE_SIZE} accounts.`);
  return users;
}

/** The account using `email` (case-insensitive), or null. Throws when the list fails. */
async function findAuthUserByEmail(email) {
  const users = await listAllAuthUsers();
  return users.find((user) => emailsMatch(user.email, email)) ?? null;
}

/** A fresh copy of the user, or null when the id doesn't exist. `id` must pass parseAuthUserId. */
async function loadAuthUser(id) {
  const { data, error } = await getSupabaseAdmin().auth.admin.getUserById(id);

  if (error) {
    if (error.status === 404 || error.code === 'user_not_found') {
      return null;
    }
    throw new Error(error.message || 'Could not load the user.');
  }

  return data?.user ?? null;
}

/**
 * One admin action per account at a time, so a double click can't suspend, email or delete
 * twice. In-process — safe for single-instance Cloud Run only, not across replicas.
 */
const adminUserLocks = new Map();

async function withAdminUserLock(userId, fn) {
  const waitFor = adminUserLocks.get(userId) ?? Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  const tail = waitFor.then(() => next);
  adminUserLocks.set(userId, tail);

  await waitFor;
  try {
    return await fn();
  } finally {
    release();
    // The last action queued for this account clears the entry.
    if (adminUserLocks.get(userId) === tail) {
      adminUserLocks.delete(userId);
    }
  }
}

const USER_NOT_FOUND_BODY = { error: 'User not found.' };
const INVALID_USER_ID_BODY = { error: 'A valid user id is required.' };
const PROTECTED_USER_BODY = {
  error: "Staff accounts can't be suspended or deleted here.",
  code: 'user_protected',
};

/** 409 for suspending or deleting a member who mentors an expertise item. */
function userIsMentorBody(title) {
  return {
    error: `This member is the mentor on "${title}". Change or remove that mentor profile first.`,
    code: 'user_is_mentor',
    title,
  };
}

/** The expertise item this auth user mentors (matched on their email), or null. */
async function findMentorItemForUser(user) {
  const email = trimmedOrNull(user?.email);
  return email ? findMentorProfileByEmail(email) : null;
}

app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = (await listAllAuthUsers())
      .map((user) => serializeAdminUser(user, req.user.id))
      .sort((a, b) => (Date.parse(b.createdAt ?? '') || 0) - (Date.parse(a.createdAt ?? '') || 0));

    res.set('Cache-Control', 'no-store');
    res.json({ users });
  } catch (error) {
    console.error('Failed to list users:', error);
    res.status(500).json({ error: 'Could not load members.' });
  }
});

// The name is staff-facing only. It lives in user_metadata.display_name: Google and Discord
// fill full_name and name, so a later sign-in with them leaves it alone. An empty name clears it.
app.patch('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = parseAuthUserId(req.params.id);
  const rawName = req.body?.name;

  if (!id) {
    return res.status(400).json(INVALID_USER_ID_BODY);
  }

  if (rawName !== null && typeof rawName !== 'string') {
    return res.status(400).json({ error: 'Name must be text.' });
  }

  const name = typeof rawName === 'string' ? rawName.trim() : '';

  if (name.length > EXPERT_NAME_MAX) {
    return res.status(400).json({
      error: `Name must be ${EXPERT_NAME_MAX} characters or fewer.`,
      code: 'user_name_too_long',
    });
  }

  try {
    const result = await withAdminUserLock(id, async () => {
      const user = await loadAuthUser(id);

      if (!user) {
        return { notFound: true };
      }

      const existingMetadata =
        user.user_metadata && typeof user.user_metadata === 'object' ? user.user_metadata : {};
      const { data, error } = await getSupabaseAdmin().auth.admin.updateUserById(id, {
        user_metadata: { ...existingMetadata, display_name: name || null },
      });

      if (error) {
        throw new Error(error.message || 'Could not update the user.');
      }

      return { user: data.user };
    });

    if (result.notFound) {
      return res.status(404).json(USER_NOT_FOUND_BODY);
    }

    auditAdminAction(req, 'update_user_name', { userId: id });
    res.json({ user: serializeAdminUser(result.user, req.user.id) });
  } catch (error) {
    console.error('Failed to update user:', error);
    res.status(500).json({ error: 'Could not save the member.' });
  }
});

// A Supabase ban: the member can't sign in or refresh, and requireAuth refuses their current token.
// A mentor can't be suspended (as with delete): their profile would keep taking requests that
// they could no longer schedule. Lifting a suspension is always allowed.
app.post('/api/admin/users/:id/suspend', requireAuth, requireAdmin, async (req, res) => {
  const id = parseAuthUserId(req.params.id);
  const suspended = req.body?.suspended;

  if (!id) {
    return res.status(400).json(INVALID_USER_ID_BODY);
  }

  if (typeof suspended !== 'boolean') {
    return res.status(400).json({ error: 'suspended must be true or false.' });
  }

  try {
    const result = await withAdminUserLock(id, async () => {
      const user = await loadAuthUser(id);

      if (!user) {
        return { notFound: true };
      }

      if (isProtectedAccount(user, req.user)) {
        return { isProtected: true };
      }

      if (suspended) {
        const mentorItem = await findMentorItemForUser(user);

        if (mentorItem) {
          return { mentorTitle: mentorItem.title };
        }
      }

      const { data, error } = await getSupabaseAdmin().auth.admin.updateUserById(id, {
        ban_duration: suspended ? SUSPEND_BAN_DURATION : 'none',
      });

      if (error) {
        throw new Error(error.message || 'Could not update the user.');
      }

      return { user: data.user };
    });

    if (result.notFound) {
      return res.status(404).json(USER_NOT_FOUND_BODY);
    }

    if (result.isProtected) {
      return res.status(403).json(PROTECTED_USER_BODY);
    }

    if (result.mentorTitle !== undefined) {
      return res.status(409).json(userIsMentorBody(result.mentorTitle));
    }

    auditAdminAction(req, suspended ? 'suspend_user' : 'unsuspend_user', { userId: id });
    res.json({ user: serializeAdminUser(result.user, req.user.id) });
  } catch (error) {
    console.error('Failed to change user suspension:', error);
    res.status(500).json({
      error: suspended ? 'Could not suspend the member.' : 'Could not lift the suspension.',
    });
  }
});

// Per target account, so staff can't flood one inbox. Failed attempts (unavailable, send failed)
// are handed back. In-memory: single Cloud Run instance, reset on deploy.
const adminPasswordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: (req) => `user:${parseAuthUserId(req.params.id) || 'invalid'}`,
  store: new MemoryStore(),
  skipFailedRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'This member already got 3 password reset emails in the last hour. Please try again later.',
    code: 'password_reset_limited',
  },
});

const PASSWORD_RESET_FAILED_BODY = {
  error: 'Could not send the password reset email.',
  code: 'password_reset_failed',
};

// Supabase makes the one-time recovery link (generating one invalidates the previous link);
// the email itself is ours, through Resend, like every other member email.
app.post(
  '/api/admin/users/:id/password-reset',
  requireAuth,
  requireAdmin,
  adminPasswordResetLimiter,
  async (req, res) => {
    const id = parseAuthUserId(req.params.id);

    if (!id) {
      return res.status(400).json(INVALID_USER_ID_BODY);
    }

    try {
      const result = await withAdminUserLock(id, async () => {
        const user = await loadAuthUser(id);

        if (!user) {
          return { notFound: true };
        }

        const email = trimmedOrNull(user.email);

        if (!email || !userHasPasswordLogin(user) || isUserSuspended(user)) {
          return { unavailable: true };
        }

        // Without Resend the link could never be delivered, so don't make one.
        if (!apiKey) {
          console.error('Password reset email not sent: RESEND_API_KEY is not configured.');
          return { sendFailed: true };
        }

        const { data, error } = await getSupabaseAdmin().auth.admin.generateLink({
          type: 'recovery',
          email,
          options: { redirectTo: `${EMAIL_SITE_ORIGIN}/?${PASSWORD_RESET_RETURN_PARAM}=1` },
        });
        const actionLink = data?.properties?.action_link;

        if (error || !actionLink) {
          console.error('Password reset link failed:', error ?? 'no action_link returned');
          return { sendFailed: true };
        }

        const emailSent = await sendEmailPayloads(
          [buildPasswordResetEmailPayload(email, actionLink)],
          'Password reset',
        );
        return emailSent ? { emailSent } : { sendFailed: true };
      });

      if (result.notFound) {
        return res.status(404).json(USER_NOT_FOUND_BODY);
      }

      if (result.unavailable) {
        return res.status(400).json({
          error: 'This member has no password login, or the account is suspended.',
          code: 'password_reset_unavailable',
        });
      }

      if (result.sendFailed) {
        return res.status(502).json(PASSWORD_RESET_FAILED_BODY);
      }

      auditAdminAction(req, 'send_password_reset', { userId: id });
      res.json({ emailSent: true });
    } catch (error) {
      console.error('Failed to send password reset:', error);
      res.status(500).json(PASSWORD_RESET_FAILED_BODY);
    }
  },
);

/**
 * Deletes a member account. Order: suspend (no new requests mid-way), cancel their active
 * bookings and email them as an admin cancel does, strip their email from every reservation row,
 * then hard-delete the auth user. Held consultations and past bookings stay as history.
 * Equipment, book and room requests still pending after their dates passed are cancelled too,
 * without an email and outside `cancelled` (`staleCancelled`), so no open request is left
 * without a member.
 * Results: `{ notFound }`, `{ isProtected }`, `{ mentorTitle }` (they mentor an expertise item;
 * nothing changed), `{ incomplete, cancelled, staleCancelled }` (a store call or the delete
 * failed; the account stays suspended and a retry skips rows already cancelled), or
 * `{ deleted, cancelled, staleCancelled, emailSent }`.
 */
async function deleteMemberAccount(id, currentUser) {
  const user = await loadAuthUser(id);

  if (!user) {
    return { notFound: true };
  }

  if (isProtectedAccount(user, currentUser)) {
    return { isProtected: true };
  }

  const email = trimmedOrNull(user.email);
  const mentorItem = await findMentorItemForUser(user);

  if (mentorItem) {
    return { mentorTitle: mentorItem.title };
  }

  const { error: suspendError } = await getSupabaseAdmin().auth.admin.updateUserById(id, {
    ban_duration: SUSPEND_BAN_DURATION,
  });

  if (suspendError) {
    throw new Error(suspendError.message || 'Could not suspend the user before deleting.');
  }

  // Store calls run one at a time (each takes its item's lock) and the first one that throws
  // stops the pass. Flag results (notFound, invalidStatus, alreadyHeld) mean someone got there
  // first: skipped, not failed.
  const today = libraryTodayKey();
  const cancelledConsultations = [];
  const cancelledReservations = [];
  let staleCancelled = 0;
  let failure = null;

  if (email) {
    try {
      const items = await fetchInventoryItems();

      for (const item of items) {
        for (const reservation of item.reservations) {
          if (!emailsMatch(reservation.userEmail, email)) {
            continue;
          }

          if (item.tag === 'expertise') {
            if (
              (reservation.status === 'pending' || reservation.status === 'reserved') &&
              !isConsultationHeld(reservation)
            ) {
              const result = await cancelConsultation(item.id, reservation.id, { cancelledBy: 'admin' });
              if (result.reservation) {
                cancelledConsultations.push(result);
              }
            }
          } else if (isUpcomingMemberReservation(reservation, today)) {
            const result = await cancelReservationByAdmin(item.id, reservation.id);
            if (result.reservation) {
              cancelledReservations.push(result);
            }
          } else if (reservation.status === 'pending') {
            // Its dates are over: nothing to tell the member, but it must not stay open.
            const result = await cancelReservationByAdmin(item.id, reservation.id);
            if (result.reservation) {
              staleCancelled += 1;
            }
          }
        }
      }
    } catch (error) {
      failure = error;
    }
  }

  // Everyone whose booking was cancelled is told, even when a later store call failed: a retry
  // won't see those rows as active again. Paced rounds keep the batch under Resend's rate limit.
  const consultationEmailSent = await settleNotificationRounds(
    'Consultation cancelled',
    cancelledConsultations,
    2,
    (result) => handleConsultationCancelled(result.item, result.reservation, result.previousStatus),
  );
  // The team email words itself from the status before the cancel (request vs. booking, pickup).
  const reservationEmailSent = await settleNotificationRounds(
    'Reservation cancelled',
    cancelledReservations,
    1,
    (result) =>
      sendReservationCancelledByTeamEmail(
        result.item,
        { ...result.reservation, status: result.previousStatus },
        today,
      ),
  );
  const settled = [consultationEmailSent, reservationEmailSent].filter((sent) => sent !== undefined);
  const emailSent = settled.length ? settled.every(Boolean) : undefined;
  const cancelled = cancelledConsultations.length + cancelledReservations.length;

  if (failure) {
    console.error('Delete user: cancelling bookings failed:', failure);
    return { incomplete: true, cancelled, staleCancelled };
  }

  try {
    await anonymizeReservationsForEmail(email ?? '');
    // Items this address owns (015; a member's own mentor profile whose expert email staff
    // cleared) go to the library inbox, so a new account with the address can't host them and
    // members' messages about them reach the team. Before the delete, so a retry redoes it.
    const reassigned = await reassignItemsOwnedBy(email ?? '', CONTACT_TO);
    if (reassigned > 0) {
      console.log('[admin-audit]', { action: 'reassign_owned_items', userId: id, count: reassigned });
    }

    const { error: deleteError } = await getSupabaseAdmin().auth.admin.deleteUser(id);

    if (deleteError) {
      throw new Error(deleteError.message || 'Could not delete the user.');
    }
  } catch (error) {
    console.error('Delete user: removing the account failed:', error);
    return { incomplete: true, cancelled, staleCancelled };
  }

  return { deleted: true, cancelled, staleCancelled, emailSent };
}

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = parseAuthUserId(req.params.id);

  if (!id) {
    return res.status(400).json(INVALID_USER_ID_BODY);
  }

  try {
    const result = await withAdminUserLock(id, () => deleteMemberAccount(id, req.user));

    if (result.notFound) {
      return res.status(404).json(USER_NOT_FOUND_BODY);
    }

    if (result.isProtected) {
      return res.status(403).json(PROTECTED_USER_BODY);
    }

    if (result.mentorTitle !== undefined) {
      return res.status(409).json(userIsMentorBody(result.mentorTitle));
    }

    if (result.incomplete) {
      auditAdminAction(req, 'delete_user_incomplete', {
        userId: id,
        cancelled: result.cancelled,
        staleCancelled: result.staleCancelled,
      });
      return res.status(500).json({
        error: 'The account is suspended, but deleting it did not finish. Please try again.',
        code: 'user_delete_incomplete',
      });
    }

    auditAdminAction(req, 'delete_user', {
      userId: id,
      cancelled: result.cancelled,
      staleCancelled: result.staleCancelled,
    });
    res.json({
      success: true,
      cancelled: result.cancelled,
      ...(result.emailSent === undefined ? {} : { emailSent: result.emailSent }),
    });
  } catch (error) {
    console.error('Failed to delete user:', error);
    res.status(500).json({ error: 'Could not delete the member.' });
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

/**
 * Adds `unreadMessages` (016: messages from the other side the viewer hasn't opened) to each
 * serialized booking for `side` ('member' or 'host'). 0 everywhere when the count fails or 016
 * isn't applied, so the agenda still loads.
 */
async function withUnreadMessages(rows, side) {
  const counts = await countUnreadMessages(
    rows.map((row) => row.id),
    side,
  );
  return rows.map((row) => ({ ...row, unreadMessages: counts.get(row.id) ?? 0 }));
}

app.get('/api/account/consultations', requireAuth, async (req, res) => {
  const email = req.user?.email?.trim() ?? '';

  try {
    const { asMember, asExpert } = await listConsultationsForUser(email, {
      includeExpert: isConfirmedUser(req.user),
    });

    const [memberRows, expertRows] = await Promise.all([
      withUnreadMessages(
        asMember.map((entry) => serializeConsultationForUser(entry, 'member')),
        'member',
      ),
      withUnreadMessages(
        asExpert.map((entry) => serializeConsultationForUser(entry, 'expert')),
        'host',
      ),
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({ asMember: memberRows, asExpert: expertRows });
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

const accountReservationActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many reservation updates. Please try again later.',
    code: 'reservation_action_limit',
  },
});

// A host working through a backlog from the office shares its IP with members, so the host
// actions on /account count per account (after requireAuth); the IP limit before it is looser
// and only stops floods of unauthenticated calls. In-memory, single instance.
const hostedReservationIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many reservation updates. Please try again later.',
    code: 'reservation_action_limit',
  },
});

const hostedReservationActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: reservationAccountKey,
  store: new MemoryStore(),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many reservation updates. Please try again later.',
    code: 'reservation_action_limit',
  },
});

/**
 * Where the member goes, by status: a confirmed reservation that hasn't ended gets the full
 * address, exact point, transit note and directions (as in its approval email); a pending one
 * only what the item window shows; refused, cancelled and ended ones nothing. Decided here, not
 * in the page, because the location is the item's current one, not a copy kept with the booking.
 */
function memberReservationLocation(item, reservation, today) {
  if (!hasPhysicalLocation(item.tag) || !item.location) {
    return null;
  }

  if (reservation.status === 'reserved' && compareDateKeys(reservation.endDate, today) >= 0) {
    return memberLocation(item.location);
  }

  return reservation.status === 'pending' ? publicLocation(item.location, { withArea: false }) : null;
}

/**
 * Account-panel view of one equipment, book or room reservation (whitelisted fields only).
 * `today`: libraryTodayKey(), for memberReservationLocation.
 */
function serializeReservationForMember({ item, reservation }, today) {
  return {
    id: reservation.id,
    itemId: item.id,
    title: item.title,
    slug: item.slug ?? null,
    tag: item.tag,
    startDate: reservation.startDate,
    endDate: reservation.endDate,
    status: reservation.status,
    // Rooms: the hours (`HH:MM-HH:MM`) and what it's for, as the member wrote them.
    timeSlots: item.tag === 'rooms' ? reservation.timeSlots ?? null : null,
    purpose: item.tag === 'rooms' ? reservation.requestSummary ?? null : null,
    location: memberReservationLocation(item, reservation, today),
  };
}

app.get('/api/account/reservations', requireAuth, async (req, res) => {
  const email = req.user?.email?.trim() ?? '';

  try {
    const entries = await listReservationsForMember(email);
    const today = libraryTodayKey();
    const reservations = await withUnreadMessages(
      entries.map((entry) => serializeReservationForMember(entry, today)),
      'member',
    );
    res.set('Cache-Control', 'no-store');
    res.json({ reservations });
  } catch (error) {
    console.error('Failed to load account reservations:', error);
    res.status(500).json({ error: 'Could not load your reservations.' });
  }
});

// "Today" is Montréal's date (libraryTodayKey), not the container's UTC one, so the cutoff falls at
// midnight Montréal time, the same moment the account panel hides its Cancel button.
app.post(
  '/api/account/reservations/:reservationId/cancel',
  accountReservationActionLimiter,
  requireAuth,
  async (req, res) => {
    const reservationId =
      typeof req.params.reservationId === 'string' ? req.params.reservationId.trim() : '';
    const email = req.user?.email?.trim() ?? '';

    try {
      const today = libraryTodayKey();
      const result = await cancelReservationForMember(reservationId, email, { today });

      if (result.notFound) {
        return res.status(404).json({ error: 'Reservation not found.' });
      }

      if (result.alreadyStarted) {
        return res.status(400).json({
          error:
            'This reservation has already started, so it can no longer be cancelled here. Reply to your confirmation email if anything changes.',
          code: 'reservation_already_started',
        });
      }

      if (result.invalidStatus) {
        return res.status(400).json({
          error: 'This reservation is no longer active.',
          code: 'reservation_not_active',
        });
      }

      // Withdrawing a pending request needs nobody's attention; a freed approved booking does.
      if (result.previousStatus === 'reserved') {
        await settleNotifications('Reservation cancelled by member', [
          notifyMemberReservationCancelled(result.item, result.reservation),
        ]);
      }

      console.log('[reservation]', {
        action: 'member_cancel',
        reservationId,
        previousStatus: result.previousStatus,
      });
      res.json({ reservation: serializeReservationForMember(result, today) });
    } catch (error) {
      console.error('Failed to cancel reservation:', error);
      const detail = error?.message || '';
      res.status(500).json({
        error: isReservationSchemaError(detail)
          ? reservationSchemaErrorMessage()
          : 'Could not cancel the reservation.',
      });
    }
  },
);

/**
 * /account view of one booking of a room, equipment or book the account owns (015): the member's
 * email, the room's hours and purpose, and how it was booked and cancelled. Whitelisted: never
 * the item itself (withPublicItemImage would carry every booking) or the location.
 */
function serializeHostedReservation({ item, reservation }) {
  return {
    id: reservation.id,
    itemId: item.id,
    title: item.title,
    slug: item.slug ?? null,
    tag: item.tag,
    startDate: reservation.startDate,
    endDate: reservation.endDate,
    status: reservation.status,
    timeSlots: item.tag === 'rooms' ? reservation.timeSlots ?? null : null,
    purpose: item.tag === 'rooms' ? reservation.requestSummary ?? null : null,
    memberEmail: reservation.userEmail ?? null,
    bookedByStaff: reservation.bookedByStaff === true,
    cancelledBy: reservation.cancelledBy ?? null,
    createdAt: reservation.createdAt ?? null,
  };
}

/**
 * A room, equipment or book booking with its item, when the item's owner is this confirmed
 * account; otherwise null (missing, a consultation, or not theirs: the same 404 for all three).
 * Mentors' consultations go through loadConsultationForUser instead.
 */
async function loadHostedReservation(user, reservationId) {
  if (!isConfirmedUser(user)) {
    return null;
  }

  const found = await findReservationWithItem(reservationId);
  if (!found || found.item.tag === 'expertise' || !emailsMatch(found.item.ownerEmail, user?.email)) {
    return null;
  }

  return found;
}

const HOSTED_RESERVATION_COLLISION = {
  error: 'These dates overlap another reservation of this item.',
  code: 'reservation_collision',
};

// Bookings of the rooms, equipment and books this account owns. Most accounts own none, and an
// unconfirmed one owns nothing, so both get an empty list.
app.get('/api/account/hosted-reservations', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');

  if (!isConfirmedUser(req.user)) {
    return res.json({ reservations: [] });
  }

  try {
    const entries = await listHostedReservationsForOwner(req.user?.email?.trim() ?? '');
    res.json({ reservations: await withUnreadMessages(entries.map(serializeHostedReservation), 'host') });
  } catch (error) {
    console.error('Failed to load hosted reservations:', error);
    res.status(500).json({ error: 'Could not load the bookings of your items.' });
  }
});

// The owner approves a pending request: the same confirmation email (and optional message) as
// /admin's approve.
app.post(
  '/api/account/hosted-reservations/:reservationId/approve',
  hostedReservationIpLimiter,
  requireAuth,
  hostedReservationActionLimiter,
  async (req, res) => {
    const reservationId =
      typeof req.params.reservationId === 'string' ? req.params.reservationId.trim() : '';

    const { message, error: messageError } = readConfirmationMessage(req.body);
    if (messageError) {
      return res.status(400).json({ error: messageError });
    }

    try {
      const found = await loadHostedReservation(req.user, reservationId);

      if (!found) {
        return res.status(404).json({ error: 'Reservation not found.' });
      }

      const result = await approveReservation(found.item.id, reservationId);

      if (result.notFound || result.isConsultation || result.reservationNotFound) {
        return res.status(404).json({ error: 'Reservation not found.' });
      }

      if (result.invalidStatus) {
        return res.status(400).json({
          error: 'Only pending requests can be approved.',
          code: 'reservation_not_pending',
        });
      }

      if (result.collision) {
        return res.status(409).json(HOSTED_RESERVATION_COLLISION);
      }

      await setReminderState(result.reservation.id, reservationStartsAt(result.reservation, result.item.tag));
      const emailSent = await settleNotifications('Reservation approval', [
        sendMemberDecisionEmail(result.item, result.reservation, 'approved', message),
      ]);
      await restoreReminderIfNotEmailed(result.reservation, result.item.tag, emailSent);

      console.log('[hosted-reservation]', { action: 'approve', reservationId });
      res.json({ reservation: serializeHostedReservation(result), emailSent });
    } catch (error) {
      console.error('Failed to approve hosted reservation:', error);
      res.status(500).json({ error: 'Could not approve the reservation.' });
    }
  },
);

// The owner declines a pending request: the same "not available" email as /admin's refuse.
app.post(
  '/api/account/hosted-reservations/:reservationId/refuse',
  hostedReservationIpLimiter,
  requireAuth,
  hostedReservationActionLimiter,
  async (req, res) => {
    const reservationId =
      typeof req.params.reservationId === 'string' ? req.params.reservationId.trim() : '';

    try {
      const found = await loadHostedReservation(req.user, reservationId);

      if (!found) {
        return res.status(404).json({ error: 'Reservation not found.' });
      }

      const result = await refuseReservation(found.item.id, reservationId);

      if (result.notFound || result.reservationNotFound) {
        return res.status(404).json({ error: 'Reservation not found.' });
      }

      if (result.invalidStatus) {
        return res.status(400).json({
          error: 'Only pending requests can be declined.',
          code: 'reservation_not_pending',
        });
      }

      const emailSent = await settleNotifications('Reservation refusal', [
        sendMemberDecisionEmail(result.item, result.reservation, 'refused'),
      ]);

      console.log('[hosted-reservation]', { action: 'refuse', reservationId });
      res.json({ reservation: serializeHostedReservation(result), emailSent });
    } catch (error) {
      console.error('Failed to refuse hosted reservation:', error);
      res.status(500).json({ error: 'Could not decline the request.' });
    }
  },
);

/**
 * The owner moves a pending request, or a confirmed booking that hasn't ended, to new dates
 * (staff rules: any days, up to a year, not over yet), and a room to new hours. It applies at
 * once and the member is emailed. A room's hours come as both `startTime` and `endTime`; neither
 * keeps a booking that has no hours (staff bookings) as it is.
 */
app.post(
  '/api/account/hosted-reservations/:reservationId/reschedule',
  hostedReservationIpLimiter,
  requireAuth,
  hostedReservationActionLimiter,
  async (req, res) => {
    const reservationId =
      typeof req.params.reservationId === 'string' ? req.params.reservationId.trim() : '';
    const today = libraryTodayKey();

    const dates = readStaffBookingDates(req.body, today);
    if (dates.error) {
      return res.status(400).json(dates.error);
    }

    const { message, error: messageError } = readConfirmationMessage(req.body);
    if (messageError) {
      return res.status(400).json({ error: messageError });
    }

    try {
      const found = await loadHostedReservation(req.user, reservationId);

      if (!found) {
        return res.status(404).json({ error: 'Reservation not found.' });
      }

      // Undefined keeps the current hours (rescheduleReservation); other items have none.
      let timeSlots;
      if (found.item.tag === 'rooms') {
        const startTime = typeof req.body?.startTime === 'string' ? req.body.startTime.trim() : '';
        const endTime = typeof req.body?.endTime === 'string' ? req.body.endTime.trim() : '';

        if (startTime || endTime || parseRoomTimes(found.reservation.timeSlots)) {
          const times = validateRoomTimes({ startTime, endTime });
          if (!times.ok) {
            return res.status(400).json({ error: times.error, code: times.code });
          }
          timeSlots = times.timeSlots;
        }
      }

      const result = await rescheduleReservation(found.item.id, reservationId, {
        startDate: dates.startDate,
        endDate: dates.endDate,
        timeSlots,
        today,
      });

      if (result.notFound || result.isConsultation || result.reservationNotFound) {
        return res.status(404).json({ error: 'Reservation not found.' });
      }

      if (result.invalidStatus) {
        return res.status(400).json({
          error: 'This reservation is no longer active.',
          code: 'reservation_not_active',
        });
      }

      if (result.unchanged) {
        return res.status(400).json({
          error: 'The reservation already has those dates and times.',
          code: 'reservation_time_unchanged',
        });
      }

      if (result.collision) {
        return res.status(409).json(HOSTED_RESERVATION_COLLISION);
      }

      const { item, reservation, previous } = result;
      // A request gets its reminder state when it is approved.
      if (reservation.status === 'reserved') {
        await setReminderState(reservation.id, reservationStartsAt(reservation, item.tag));
      }
      const emailSent = await settleNotifications('Reservation moved', [
        sendReservationRescheduledEmail(item, reservation, previous, { message, today }),
      ]);
      await restoreReminderIfNotEmailed(reservation, item.tag, emailSent);

      console.log('[hosted-reservation]', { action: 'reschedule', reservationId });
      res.json({ reservation: serializeHostedReservation(result), emailSent });
    } catch (error) {
      console.error('Failed to move hosted reservation:', error);
      res.status(500).json({ error: 'Could not move the reservation.' });
    }
  },
);

// The owner cancels a confirmed booking that hasn't ended (a pending request is declined
// instead): recorded as cancelled_by 'owner', and the member gets the library team's email.
app.post(
  '/api/account/hosted-reservations/:reservationId/cancel',
  hostedReservationIpLimiter,
  requireAuth,
  hostedReservationActionLimiter,
  async (req, res) => {
    const reservationId =
      typeof req.params.reservationId === 'string' ? req.params.reservationId.trim() : '';
    const notActive = {
      error: 'Only a confirmed reservation that has not ended can be cancelled here.',
      code: 'reservation_not_active',
    };

    const { message, error: messageError } = readConfirmationMessage(req.body);
    if (messageError) {
      return res.status(400).json({ error: messageError });
    }

    try {
      const found = await loadHostedReservation(req.user, reservationId);

      if (!found) {
        return res.status(404).json({ error: 'Reservation not found.' });
      }

      const today = libraryTodayKey();
      if (found.reservation.status !== 'reserved' || compareDateKeys(found.reservation.endDate, today) < 0) {
        return res.status(400).json(notActive);
      }

      const result = await cancelReservationByAdmin(found.item.id, reservationId, { cancelledBy: 'owner' });

      if (result.notFound || result.isConsultation || result.reservationNotFound) {
        return res.status(404).json({ error: 'Reservation not found.' });
      }

      if (result.invalidStatus) {
        return res.status(400).json(notActive);
      }

      // The email reads the status the booking had (pickup lines), as an admin delete's does.
      const emailSent = await settleNotifications('Reservation cancelled', [
        sendReservationCancelledByTeamEmail(
          result.item,
          { ...result.reservation, status: result.previousStatus },
          today,
          message,
        ),
      ]);

      console.log('[hosted-reservation]', { action: 'cancel', reservationId });
      res.json({ reservation: serializeHostedReservation(result), emailSent });
    } catch (error) {
      console.error('Failed to cancel hosted reservation:', error);
      const detail = error?.message || '';
      res.status(500).json({
        error: isReservationSchemaError(detail)
          ? reservationSchemaErrorMessage()
          : 'Could not cancel the reservation.',
      });
    }
  },
);

const RESERVATION_MESSAGE_LIMIT_BODY = {
  error: 'Too many messages in a short time. Please try again later.',
  code: 'message_rate_limited',
};

// Per IP, before requireAuth, and loose (members share the office's IP); the per-account limit
// below is the real one.
const reservationMessageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: RESERVATION_MESSAGE_LIMIT_BODY,
});

// Messages are stored and emails are batched (one until the other side has read the
// conversation), so this caps writing, not email.
const RESERVATION_MESSAGES_PER_ACCOUNT_PER_HOUR = 30;
const reservationMessageAccountStore = new MemoryStore();

// Runs after requireAuth, keyed by account, so nobody can flood a conversation from many IPs.
// Only messages that were saved count: the route hands the hit back otherwise, once it has
// finished (skipFailedRequests would also hand it back when the client hangs up while the email
// is on its way; see countSavedReservationCreates). In-memory, single instance.
const reservationMessageAccountLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: RESERVATION_MESSAGES_PER_ACCOUNT_PER_HOUR,
  keyGenerator: reservationAccountKey,
  store: reservationMessageAccountStore,
  standardHeaders: true,
  legacyHeaders: false,
  message: RESERVATION_MESSAGE_LIMIT_BODY,
});

// Opening a conversation (per IP, before requireAuth; loose, as members share the office's IP).
const reservationThreadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.', code: 'thread_rate_limited' },
});

const RESERVATION_MESSAGE_KINDS = ['message', 'new_time'];
const RESERVATION_MESSAGE_SENDERS = ['member', 'owner'];
// `as` on the wire → the side stored in 016's tables.
const THREAD_SIDE_FOR = { member: 'member', owner: 'host' };
const THREAD_UNAVAILABLE = {
  error: 'Messages are not available yet. Please try again later.',
  code: 'thread_unavailable',
};

/**
 * The booking (with its item) when the caller is on the `as` side of its conversation: 'member',
 * the person who booked; 'owner', the item's host (itemOwnerEmail), a confirmed account. Null
 * otherwise, so missing and not theirs get the same 404.
 */
async function loadThreadParticipant(req, reservationId, as) {
  const email = req.user?.email?.trim() ?? '';
  const found = reservationId ? await findReservationWithItem(reservationId) : null;
  const allowed =
    found &&
    (as === 'member'
      ? emailsMatch(found.reservation.userEmail, email)
      : isConfirmedUser(req.user) && isItemOwner(found.item, email));
  return allowed ? found : null;
}

/** A message as `side` sees it: whose it is, never an address. */
function serializeThreadMessage(message, side) {
  return {
    id: message.id,
    mine: message.sender === side,
    byStaff: message.byStaff,
    kind: message.kind,
    body: message.body,
    createdAt: message.createdAt,
  };
}

/**
 * The conversation on a booking, oldest first, for the `as` side (?as=member|owner), on /account
 * when a message panel opens. Opening it marks it read for that side: its unread count goes to 0
 * and the next message from the other side emails it again.
 */
app.get('/api/reservations/:reservationId/messages', reservationThreadLimiter, requireAuth, async (req, res) => {
  const reservationId =
    typeof req.params.reservationId === 'string' ? req.params.reservationId.trim() : '';
  const as = typeof req.query.as === 'string' ? req.query.as : 'member';
  res.set('Cache-Control', 'no-store');

  if (!RESERVATION_MESSAGE_SENDERS.includes(as)) {
    return res.status(400).json({ error: 'This kind of message is not available.', code: 'message_kind_invalid' });
  }

  try {
    const found = await loadThreadParticipant(req, reservationId, as);
    if (!found) {
      return res.status(404).json({ error: 'Reservation not found.' });
    }

    const side = THREAD_SIDE_FOR[as];
    const messages = await listReservationMessages(found.reservation.id);
    await markThreadRead(found.reservation.id, side);
    res.json({ messages: messages.map((message) => serializeThreadMessage(message, side)) });
  } catch (error) {
    if (error instanceof ThreadUnavailableError) {
      return res.status(503).json(THREAD_UNAVAILABLE);
    }
    console.error('Failed to load reservation messages:', error);
    res.status(500).json({ error: 'Could not load the messages.' });
  }
});

/**
 * "Message the host" and "Suggest a new time" (`as` 'member', the person who booked) and "Message
 * the member" (`as` 'owner', the item's host: itemOwnerEmail, a confirmed account) on /account,
 * for every kind of booking. The message joins the booking's conversation (016) and the other
 * side gets buildReservationMessageEmailPayload only when they've read the conversation since the
 * last one (addReservationMessage decides). Nothing about the booking changes. Anyone else gets
 * the 404 of a missing booking.
 */
app.post(
  '/api/reservations/:reservationId/message',
  reservationMessageLimiter,
  requireAuth,
  reservationMessageAccountLimiter,
  async (req, res) => {
    const reservationId =
      typeof req.params.reservationId === 'string' ? req.params.reservationId.trim() : '';
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    const kind = req.body?.kind ?? 'message';
    const as = req.body?.as ?? 'member';
    const senderEmail = req.user?.email?.trim() ?? '';
    let saved = false;

    try {
      if (!message) {
        return res.status(400).json({ error: 'Write a message first.', code: 'message_required' });
      }

      if (message.length > RESERVATION_MESSAGE_MAX) {
        return res.status(400).json({
          error: `The message must be ${RESERVATION_MESSAGE_MAX} characters or fewer.`,
          code: 'message_too_long',
        });
      }

      if (
        !RESERVATION_MESSAGE_KINDS.includes(kind) ||
        !RESERVATION_MESSAGE_SENDERS.includes(as) ||
        (as === 'owner' && kind === 'new_time')
      ) {
        return res.status(400).json({ error: 'This kind of message is not available.', code: 'message_kind_invalid' });
      }

      const found = await loadThreadParticipant(req, reservationId, as);

      if (!found) {
        return res.status(404).json({ error: 'Reservation not found.' });
      }

      const { item, reservation } = found;
      const active = reservation.status === 'pending' || reservation.status === 'reserved';
      // A new time only for a booking that hasn't started (a request has no start yet).
      const notStarted =
        reservation.status === 'pending' || reservationStartsAt(reservation, item.tag) > Date.now();

      if (!active || (kind === 'new_time' && !notStarted)) {
        return res.status(400).json({
          error: 'This reservation can no longer be changed here.',
          code: 'message_not_available',
        });
      }

      // The host, or the library inbox for an item with no owner yet (before 015).
      const to = as === 'member' ? itemOwnerEmail(item) ?? CONTACT_TO : trimmedOrNull(reservation.userEmail);

      if (!to) {
        return res.status(400).json({
          error: "This member's account was deleted, so there is no one to email.",
          code: 'message_no_recipient',
        });
      }

      const side = THREAD_SIDE_FOR[as];
      const senderIsStaff = isAdminUser(req.user);
      const stored = await addReservationMessage({
        reservationId: reservation.id,
        sender: side,
        byStaff: side === 'host' && senderIsStaff,
        kind,
        body: message,
      });
      saved = true;

      let emailSent = false;
      if (stored.notify) {
        emailSent = await sendEmailPayloads(
          [
            buildReservationMessageEmailPayload({
              item,
              reservation,
              kind,
              from: as,
              senderEmail,
              to,
              message,
              senderIsExpert: isConsultationExpert(item, senderEmail),
              senderIsStaff,
            }),
          ],
          'Reservation message',
        );
        if (!emailSent) {
          // The next message tries again.
          await releaseNotification(reservation.id, side === 'member' ? 'host' : 'member', stored.previousNotifiedAt);
        }
      }

      // No content and no addresses in the log.
      console.log('[reservation-message]', { reservationId, kind, as, emailed: emailSent });
      res.json({
        message: serializeThreadMessage(stored.message, side),
        emailSent,
        // false: the other side already has an unread email about this conversation.
        notified: stored.notify,
      });
    } catch (error) {
      if (error instanceof ThreadUnavailableError) {
        return res.status(503).json(THREAD_UNAVAILABLE);
      }
      console.error('Failed to send reservation message:', error);
      res.status(500).json({ error: 'Could not send your message.' });
    } finally {
      if (!saved) {
        await reservationMessageAccountStore.decrement(reservationAccountKey(req));
      }
    }
  },
);

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

      if (!found.isExpert && !found.isOwner && !found.isAdmin) {
        return res.status(403).json({ error: 'Only the expert can schedule this consultation.' });
      }

      const { message, error: messageError } = readConfirmationMessage(req.body);
      if (messageError) {
        return res.status(400).json({ error: messageError });
      }

      const scheduled = await runScheduleConsultation({
        itemId: found.item.id,
        reservationId,
        meetingAt: typeof req.body?.meetingAt === 'string' ? req.body.meetingAt : '',
        message,
        messageFrom: consultationHostVoice(found),
      });

      if (scheduled.status !== 200) {
        return res.status(scheduled.status).json(scheduled.body);
      }

      console.log('[consultation]', { action: 'schedule', reservationId, by: consultationHostRole(found) });
      res.json({
        consultation: serializeConsultationForUser(scheduled.result, 'expert'),
        emailSent: scheduled.emailSent,
      });
    } catch (error) {
      console.error('Failed to schedule consultation:', error);
      res.status(500).json({ error: 'Could not schedule the consultation.' });
    }
  },
);

// The expert (or the owner of a mentor with no address, or an admin) moves a scheduled meeting
// that hasn't started. It applies at once: the Zoom meeting moves (or is replaced), and member
// and expert get the new time with an updated invite.
app.post(
  '/api/consultations/:reservationId/reschedule',
  consultationActionLimiter,
  requireAuth,
  async (req, res) => {
    const reservationId =
      typeof req.params.reservationId === 'string' ? req.params.reservationId.trim() : '';
    const meetingAt = typeof req.body?.meetingAt === 'string' ? req.body.meetingAt : '';

    try {
      const found = await loadConsultationForUser(req.user, reservationId);

      if (!found) {
        return res.status(404).json({ error: 'Consultation not found.' });
      }

      if (!found.isExpert && !found.isOwner && !found.isAdmin) {
        return res.status(403).json({ error: 'Only the expert can move this consultation.' });
      }

      const { message, error: messageError } = readConfirmationMessage(req.body);
      if (messageError) {
        return res.status(400).json({ error: messageError });
      }

      const meetingError = validateMeetingAt(meetingAt);
      if (meetingError) {
        return res.status(400).json({ error: meetingError });
      }

      let result;
      try {
        result = await rescheduleConsultation(found.item.id, reservationId, {
          meetingAt: meetingAt.trim(),
          moveMeeting: moveZoomMeetingForConsultation,
          deleteMeeting: deleteConsultationMeeting,
        });
      } catch (error) {
        if (error.zoomFailed) {
          return res.status(502).json({
            error: 'Could not move the Zoom meeting. Please try again in a moment.',
            code: 'consultation_zoom_failed',
          });
        }
        throw error;
      }

      if (result.notFound || result.reservationNotFound) {
        return res.status(404).json({ error: 'Consultation not found.' });
      }

      if (result.invalidStatus) {
        return res.status(400).json({
          error: 'Only a scheduled meeting that has not started can be moved.',
          code: 'consultation_reschedule_unavailable',
        });
      }

      if (result.unchanged) {
        return res.status(400).json({
          error: 'The meeting is already at that time.',
          code: 'consultation_time_unchanged',
        });
      }

      if (result.followUpBeforeSource) {
        return res.status(400).json({
          error: 'A follow-up must start after the meeting it follows.',
          code: 'follow_up_before_meeting',
        });
      }

      if (result.meetingTimeRequired) {
        return res.status(400).json({
          error: 'A valid meeting date and time is required to schedule a consultation.',
        });
      }

      const { item, reservation, previousMeetingAt } = result;
      // Moved to within a day of the meeting: this email is its reminder; otherwise a new one is due.
      await setReminderState(reservation.id, reservationStartsAt(reservation, item.tag));
      const emailSent = await settleNotifications('Consultation moved', [
        sendConsultationRescheduledEmails(item, reservation, previousMeetingAt, {
          message,
          messageFrom: consultationHostVoice(found),
        }),
      ]);
      await restoreReminderIfNotEmailed(reservation, item.tag, emailSent);

      console.log('[consultation]', { action: 'reschedule', reservationId, by: consultationHostRole(found) });
      res.json({ consultation: serializeConsultationForUser(result, 'expert'), emailSent });
    } catch (error) {
      console.error('Failed to move consultation:', error);
      const detail = error?.message || '';
      res.status(500).json({
        error: isReservationSchemaError(detail)
          ? reservationSchemaErrorMessage()
          : 'Could not move the consultation.',
      });
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

      const cancelledBy = found.isMember ? 'member' : consultationHostVoice(found);
      const result = await cancelConsultation(found.item.id, reservationId, { cancelledBy });

      if (result.notFound || result.reservationNotFound) {
        return res.status(404).json({ error: 'Consultation not found.' });
      }

      if (result.invalidStatus) {
        return res.status(400).json({ error: 'This consultation is no longer active.' });
      }

      if (result.alreadyHeld) {
        return res.status(400).json({
          error: 'This consultation has already taken place, so it can no longer be cancelled.',
          code: 'consultation_already_held',
        });
      }

      const emailSent = await settleNotifications('Consultation cancelled', [
        handleConsultationCancelled(result.item, result.reservation, result.previousStatus),
      ]);
      // Whether the other side was told by email: a mentor with no address on file is skipped
      // while the member's email still goes out (emailSent stays true). Whoever cancels for the
      // mentor (the mentor, the owner of a mentor with no email, staff) told the member when the
      // member has an address; a mentor with one is emailed as well.
      const memberEmail = trimmedOrNull(result.reservation.userEmail);
      const expertEmail = trimmedOrNull(result.item.expertEmail);
      const otherPartyHasEmail = cancelledBy === 'member' ? Boolean(expertEmail) : Boolean(memberEmail);

      console.log('[consultation]', { action: 'cancel', reservationId, by: cancelledBy });
      res.json({
        consultation: serializeConsultationForUser(
          result,
          cancelledBy === 'member' ? 'member' : 'expert',
        ),
        emailSent,
        otherPartyEmailed: emailSent && otherPartyHasEmail,
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

// The expert (or the owner of a mentor with no address, or an admin) books the next meeting, from
// the day of one that is scheduled (Montréal dates), to start after it. The follow-up is
// scheduled at once: Zoom meeting, invitations to both, and a Slack note for staff.
app.post(
  '/api/consultations/:reservationId/follow-up',
  consultationActionLimiter,
  requireAuth,
  async (req, res) => {
    const reservationId =
      typeof req.params.reservationId === 'string' ? req.params.reservationId.trim() : '';
    const meetingAt = typeof req.body?.meetingAt === 'string' ? req.body.meetingAt : '';
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';

    try {
      const found = await loadConsultationForUser(req.user, reservationId);

      if (!found) {
        return res.status(404).json({ error: 'Consultation not found.' });
      }

      if (!found.isExpert && !found.isOwner && !found.isAdmin) {
        return res.status(403).json({ error: 'Only the expert can book a follow-up.' });
      }

      if (note.length > FOLLOW_UP_NOTE_MAX) {
        return res.status(400).json({ error: `The note must be ${FOLLOW_UP_NOTE_MAX} characters or fewer.` });
      }

      const meetingError = validateMeetingAt(meetingAt);
      if (meetingError) {
        return res.status(400).json({ error: meetingError });
      }

      let result;
      try {
        result = await bookFollowUpConsultation(found.item.id, reservationId, {
          meetingAt: meetingAt.trim(),
          note,
          today: libraryTodayKey(),
          createMeeting: createZoomMeetingForConsultation,
          deleteMeeting: deleteConsultationMeeting,
        });
      } catch (error) {
        if (error.zoomFailed) {
          return res.status(502).json({ error: 'Could not create the Zoom meeting. Please try again in a moment.' });
        }
        throw error;
      }

      if (result.notFound || result.reservationNotFound) {
        return res.status(404).json({ error: 'Consultation not found.' });
      }

      if (result.invalidStatus) {
        return res.status(400).json({
          error: 'A follow-up can be booked from the day of the meeting.',
          code: 'follow_up_not_available',
        });
      }

      if (result.followUpAlreadyOpen) {
        return res.status(409).json({
          error: 'This member already has an open consultation with this expert. Schedule or cancel it first.',
          code: 'follow_up_already_open',
        });
      }

      if (result.meetingTimeRequired) {
        return res.status(400).json({
          error: 'A valid meeting date and time is required to schedule a consultation.',
        });
      }

      if (result.followUpBeforeSource) {
        return res.status(400).json({
          error: 'The follow-up must start after the meeting it follows.',
          code: 'follow_up_before_meeting',
        });
      }

      const { item, reservation } = result;
      const role = consultationHostRole(found);
      // Booked less than a day ahead: the invitation is its reminder.
      await setReminderState(reservation.id, reservationStartsAt(reservation, item.tag));
      const emailSent = await settleNotifications('Follow-up consultation', [
        sendConsultationScheduledEmails(item, reservation, { messageFrom: consultationHostVoice(found) }),
        notifySlackAlert({
          status: 'consultation_follow_up',
          item,
          userEmail: reservation.userEmail,
          reservation,
          summary: `Follow-up consultation "${item.title}" with ${reservation.userEmail ?? 'a member'} booked by the ${role} for ${formatMeetingDateTime(reservation.meetingAt)}.`,
        }),
      ]);
      await restoreReminderIfNotEmailed(reservation, item.tag, emailSent);

      console.log('[consultation]', { action: 'follow_up', reservationId, followUpId: reservation.id, by: role });
      res.status(201).json({
        consultation: serializeConsultationForUser(result, 'expert'),
        // /admin replaces the item's reservations from this, as it does after approve.
        ...(found.isAdmin ? { item: withPublicItemImage(item) } : {}),
        emailSent,
      });
    } catch (error) {
      console.error('Failed to book follow-up consultation:', error);
      const detail = error?.message || '';
      res.status(500).json({
        error: isReservationSchemaError(detail)
          ? reservationSchemaErrorMessage()
          : 'Could not book the follow-up consultation.',
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
  // The shell names the current hashed bundles, so browsers revalidate it on every load.
  res.set('Cache-Control', 'no-cache');

  if (normalizeSeoPath(pathname) === '/admin' || normalizeSeoPath(pathname) === '/account') {
    res.set('X-Robots-Tag', 'noindex, nofollow');
  }

  if (!indexHtmlTemplate) {
    return res.sendFile(INDEX_HTML_PATH);
  }

  const localeCode = resolveRequestLocale(req);
  const origin = SITE_URL || `${req.protocol}://${req.get('host')}`;

  try {
    const { html, status } = await injectSeoIntoHtml(
      indexHtmlTemplate,
      pathname,
      localeCode,
      origin,
      escapeHtml,
      {
        includeJsonLd: !['/admin', '/account'].includes(normalizeSeoPath(pathname)),
        plausibleDomain: PLAUSIBLE_DOMAIN,
        findItemBySlug: findPublicItemBySlug,
      },
    );

    const onItemRoute = isItemDetailRoute(pathname);
    const routePreloads = [BRAND_FONT_PRELOAD];
    if (ITEM_DETAIL_CHUNK_PRELOAD && onItemRoute) {
      routePreloads.push(ITEM_DETAIL_CHUNK_PRELOAD);
    }
    const body = html.replace('</head>', `  ${routePreloads.join('\n    ')}\n  </head>`);

    res.status(status).type('html').send(body);
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
      console.log(`Email replies → ${EMAIL_REPLY_TO}`);
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
