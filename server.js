import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Resend } from 'resend';
import { compareDateKeys, parseDateKey } from './src/lib/calendar.js';
import { validateReservationDates } from './src/lib/reservation-rules.js';
import {
  addReservation,
  approveReservation,
  checkReservationSchema,
  countPendingReservationsByEmail,
  createInventoryItem,
  deleteInventoryItem,
  ensureInventory,
  fetchInventoryItems,
  findInventoryItem,
  findInventoryItemBySlug,
  isReservationSchemaError,
  isValidInventoryImage,
  isValidTag,
  normalizeInventoryItem,
  reservationSchemaErrorMessage,
  patchReservation,
  refuseReservation,
  removeReservation,
} from './src/lib/inventory-store.js';
import { assertSupabaseAdminConfigured, getSupabaseAdmin } from './src/lib/supabase-server.js';
import { injectSeoIntoHtml, resolveRequestLocale } from './src/lib/seo-server.js';
import { normalizeSeoPath, PRODUCTION_SITE_ORIGIN } from './src/lib/seo.js';
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

function requireAdmin(req, res, next) {
  const email = req.user?.email?.trim();

  if (!email || !email.toLowerCase().endsWith(APATHY_ADMIN_DOMAIN)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  if (!req.user.email_confirmed_at && !req.user.confirmed_at) {
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
  return {
    ...item,
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

const APPROVAL_PICKUP_NOTICE =
  'Pickups and drop offs are between 10am and 5pm on Tuesdays at 5310 Saint-Laurent, Montreal QC H2T 1S1';

const WELCOME_EQUIPMENT_PICKUP_NOTICE =
  'Equipment reservations are typically on Tuesdays at 5310 Boul. Saint-Laurent, Montréal, QC H2T 1S1.';

function buildMemberDecisionEmailPayload(item, reservation, decision) {
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

  const textLines = [
    intro,
    '',
    `Item: ${title}`,
  ];

  if (dateRange) {
    textLines.push(`Dates: ${dateRange}`);
  }

  if (approved) {
    textLines.push('', APPROVAL_PICKUP_NOTICE);
  }

  textLines.push(
    '',
    `View item: ${itemUrl}`,
    `Browse library: ${libraryUrl}`,
    '',
    closing,
    '',
    '— Apathy is Boring / Activist Resource Library',
  );

  const html = `
    <h2>${approved ? 'Reservation Confirmed' : 'Reservation Not Available'}</h2>
    <p>${escapeHtml(intro)}</p>
    <ul>
      <li><strong>Item:</strong> <a href="${escapeHtml(itemUrl)}">${escapeHtml(title)}</a></li>
      ${dateRange ? `<li><strong>Dates:</strong> ${escapeHtml(dateRange)}</li>` : ''}
    </ul>
    ${approved ? `<p>${escapeHtml(APPROVAL_PICKUP_NOTICE)}</p>` : ''}
    <p>${escapeHtml(closing)}</p>
    <p><a href="${escapeHtml(itemUrl)}">View item</a> · <a href="${escapeHtml(libraryUrl)}">Browse the library</a></p>
    <p>— Apathy is Boring / Activist Resource Library</p>
  `;

  return {
    from: FROM,
    to,
    subject,
    text: textLines.join('\n'),
    html,
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

  const textLines = [
    'Welcome to the Activist Resource Library!',
    '',
    'Thanks for creating your member account with Apathy is Boring.',
    '',
    'To get started, read How it works — it walks through browsing inventory, reserving items, and pickup.',
    `How it works: ${howItWorksUrl}`,
    '',
    WELCOME_EQUIPMENT_PICKUP_NOTICE,
    '',
    'Questions? Contact us on the About page.',
    `About: ${aboutUrl}`,
    '',
    `Browse inventory: ${libraryUrl}`,
    '',
    '— Apathy is Boring / Activist Resource Library',
  ];

  const html = `
    <h2>Welcome to the Activist Resource Library</h2>
    <p>Thanks for creating your member account with Apathy is Boring.</p>
    <p>To get started, read <a href="${escapeHtml(howItWorksUrl)}">How it works</a> — it walks through browsing inventory, reserving items, and pickup.</p>
    <p>${escapeHtml(WELCOME_EQUIPMENT_PICKUP_NOTICE)}</p>
    <p>Questions? <a href="${escapeHtml(aboutUrl)}">Contact us on the About page</a>.</p>
    <p><a href="${escapeHtml(libraryUrl)}">Browse inventory</a></p>
    <p>— Apathy is Boring / Activist Resource Library</p>
  `;

  return {
    from: FROM,
    to,
    subject,
    text: textLines.join('\n'),
    html,
  };
}

async function sendWelcomeEmailIfNeeded(user) {
  if (user?.user_metadata?.welcome_email_sent) {
    return { sent: false, reason: 'already_sent' };
  }

  if (!isWithinWelcomeEmailSignupWindow(user)) {
    return { sent: false, reason: 'signup_window_expired' };
  }

  const email = user?.email?.trim();
  const emailPayload = buildWelcomeEmailPayload(email);

  if (!emailPayload) {
    return { sent: false, reason: 'no_email' };
  }

  const { error } = await getResend().emails.send(emailPayload);

  if (error) {
    throw new Error(error.message || 'Failed to send welcome email.');
  }

  const existingMetadata =
    user.user_metadata && typeof user.user_metadata === 'object' ? user.user_metadata : {};

  const { error: updateError } = await getSupabaseAdmin().auth.admin.updateUserById(user.id, {
    user_metadata: { ...existingMetadata, welcome_email_sent: true },
  });

  if (updateError) {
    console.error('Welcome email sent but failed to update user metadata:', updateError);
  }

  return { sent: true };
}

function isValidEmailAddress(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function buildContactEmailPayload({ name, email, message }) {
  const subject = `Activist Resource Library contact: ${name}`;
  const aboutUrl = absoluteSiteUrl('/about');
  const textLines = [
    'New message from the About page contact form.',
    '',
    `Name: ${name}`,
    `Email: ${email}`,
    '',
    'Message:',
    message,
    '',
    `Sent via ${aboutUrl}`,
    '',
    '— Apathy is Boring / Activist Resource Library',
  ];

  const html = `
    <h2>Contact form message</h2>
    <p>New message from the About page contact form.</p>
    <ul>
      <li><strong>Name:</strong> ${escapeHtml(name)}</li>
      <li><strong>Email:</strong> <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></li>
    </ul>
    <p><strong>Message:</strong></p>
    <p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>
    <p><a href="${escapeHtml(aboutUrl)}">About page</a></p>
    <p>— Apathy is Boring / Activist Resource Library</p>
  `;

  return {
    from: FROM,
    to: CONTACT_TO,
    replyTo: email,
    subject,
    text: textLines.join('\n'),
    html,
  };
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
  'https://www.google-analytics.com',
  'https://analytics.google.com',
  'https://region1.google-analytics.com',
);

const scriptSrc = ["'self'", "'unsafe-inline'"];
if (PLAUSIBLE_DOMAIN) {
  scriptSrc.push('https://plausible.io');
}
scriptSrc.push('https://www.googletagmanager.com');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
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
    return res.status(400).json({ error: 'Tag must be equipment, books, or rooms.' });
  }

  const image = typeof req.body?.image === 'string' ? req.body.image.trim() : '';
  if (!isValidInventoryImage(image)) {
    return res.status(400).json({
      error: 'Image must be a JPEG or WebP data URL or a path under /assets/inventory/.',
    });
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
    res.status(500).json({ error: 'Could not save inventory item.' });
  }
});

app.use(express.json({ limit: '100kb' }));

const SITEMAP_STATIC_PATHS = ['/', '/howthisworks', '/about', '/equipment', '/books', '/rooms'];

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
app.use(express.static(path.join(__dirname, 'dist')));

app.get('/api/inventory/by-slug/:tag/:slug', async (req, res) => {
  const tag = typeof req.params.tag === 'string' ? req.params.tag.trim() : '';
  const slug = typeof req.params.slug === 'string' ? req.params.slug.trim() : '';

  if (!isValidTag(tag)) {
    return res.status(400).json({ error: 'Tag must be equipment, books, or rooms.' });
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

app.post('/api/inventory/:id/reservations', reservationCreateLimiter, requireAuth, async (req, res) => {
  const itemId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
  const startDate = typeof req.body?.startDate === 'string' ? req.body.startDate.trim() : '';
  const endDate = typeof req.body?.endDate === 'string' ? req.body.endDate.trim() : '';
  const userEmail = req.user?.email?.trim() || null;

  if (!itemId || !startDate || !endDate) {
    return res.status(400).json({ error: 'Item id, startDate, and endDate are required.' });
  }

  if (!parseDateKey(startDate) || !parseDateKey(endDate)) {
    return res.status(400).json({ error: 'Dates must be valid YYYY-MM-DD values.' });
  }

  if (compareDateKeys(startDate, endDate) > 0) {
    return res.status(400).json({ error: 'startDate must be on or before endDate.' });
  }

  try {
    await ensureInventory();
    const item = await findInventoryItem(itemId);

    if (!item) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    const tagValidation = validateReservationDates(item.tag, startDate, endDate);

    if (!tagValidation.ok) {
      return res.status(400).json({ error: tagValidation.error });
    }

    const pendingCount = await countPendingReservationsByEmail(userEmail);

    if (pendingCount >= MAX_PENDING_RESERVATIONS_PER_USER) {
      return res.status(429).json({
        error: 'Too many pending reservations. Please wait for admin review before submitting more.',
      });
    }

    const result = await addReservation(itemId, { startDate, endDate, userEmail });

    if (result.notFound) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    if (result.collision) {
      return res.status(409).json({ error: 'Selected dates overlap an existing reservation.' });
    }

    const { item: updatedItem, reservation } = result;
    notifySlackReservation({ item: updatedItem, reservation });

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

    if (result.notFound) {
      return res.status(404).json({ error: 'Item not found.' });
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
