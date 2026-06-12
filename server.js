import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { Resend } from 'resend';
import { compareDateKeys, parseDateKey } from './src/lib/calendar.js';
import { validateReservationDates } from './src/lib/reservation-rules.js';
import {
  addReservation,
  approveReservation,
  countPendingReservationsByEmail,
  createInventoryItem,
  deleteInventoryItem,
  ensureInventory,
  findInventoryItem,
  isValidInventoryImage,
  isValidTag,
  normalizeInventoryItem,
  patchReservation,
  refuseReservation,
  removeReservation,
} from './src/lib/inventory-store.js';
import { assertSupabaseAdminConfigured, getSupabaseAdmin } from './src/lib/supabase-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const STRICT_PORT = process.env.NODE_ENV === 'development' || process.env.STRICT_PORT === 'true';
const APATHY_ADMIN_DOMAIN = '@apathyisboring.com';
const VALID_RESERVATION_STATUSES = ['pending', 'reserved', 'refused'];
const MAX_PENDING_RESERVATIONS_PER_USER = 5;
const INLINE_IMAGE_CID = 'inventory-image';
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

const FROM = process.env.EMAIL_FROM || 'onboarding@resend.dev';
const RESERVE_INVENTORY_EMAIL_TO =
  process.env.RESERVE_INVENTORY_EMAIL_TO || process.env.EMAIL_TO || 'samuel@apathyisboring.com';
const SLACK_RESERVATION_WEBHOOK_URL = process.env.SLACK_RESERVATION_WEBHOOK_URL?.trim() || '';
const SITE_URL = (process.env.SITE_URL || process.env.VITE_SITE_URL || '').replace(/\/$/, '');

function absoluteAssetUrl(pathOrUrl) {
  if (!pathOrUrl || pathOrUrl.startsWith('data:') || /^https?:\/\//i.test(pathOrUrl)) {
    return pathOrUrl;
  }

  if (pathOrUrl.startsWith('/') && SITE_URL) {
    return `${SITE_URL}${pathOrUrl}`;
  }

  return pathOrUrl;
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

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildReservationEmailPayload(item, reservation = null) {
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  const body = typeof item.body === 'string' ? item.body.trim() : '';
  const image = typeof item.image === 'string' ? item.image.trim() : '';
  const isUploadedImage = image.startsWith('data:image/');
  const id = typeof item.id === 'string' ? item.id.trim() : 'unknown';
  const createdAt =
    typeof item.createdAt === 'number' && Number.isFinite(item.createdAt)
      ? new Date(item.createdAt).toLocaleString()
      : 'unknown';
  const startDate =
    typeof reservation?.startDate === 'string' ? reservation.startDate.trim() : '';
  const endDate = typeof reservation?.endDate === 'string' ? reservation.endDate.trim() : '';
  const dateRange =
    startDate && endDate ? `${startDate} to ${endDate}` : startDate || endDate || '';

  const subject = `Reservation request (pending reservation): ${title}`;
  const textLines = [
    'A member submitted a reservation request (pending AisB approval).',
    '',
    `Title: ${title}`,
    `Description: ${body}`,
    `Image: ${isUploadedImage ? '(uploaded image)' : image}`,
    `Item ID: ${id}`,
    `Added: ${createdAt}`,
  ];

  if (typeof reservation?.userEmail === 'string' && reservation.userEmail.trim()) {
    textLines.push(`Member email: ${reservation.userEmail.trim()}`);
  }

  if (dateRange) {
    textLines.push(`Dates: ${dateRange}`);
  }

  const text = textLines.join('\n');

  let imageHtml = '';
  let attachments;

  if (image) {
    if (isUploadedImage) {
      const parsedImage = parseDataUrlImage(image);
      if (parsedImage) {
        imageHtml = `<p><img src="cid:${INLINE_IMAGE_CID}" alt="${escapeHtml(title)}" style="max-width: 100%; height: auto;" /></p>`;
        attachments = [
          {
            filename: parsedImage.filename,
            content: parsedImage.content,
            contentType: parsedImage.contentType,
            inlineContentId: INLINE_IMAGE_CID,
          },
        ];
      }
    } else {
      const imageUrl = absoluteAssetUrl(image);
      imageHtml = `<p><img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(title)}" style="max-width: 100%; height: auto;" /></p>`;
    }
  }

  const html = `
    <h2>Reservation Request (Pending Reservation)</h2>
    <p>A member submitted a reservation request. Please review and approve or refuse in the admin panel.</p>
    <ul>
      <li><strong>Title:</strong> ${escapeHtml(title)}</li>
      <li><strong>Description:</strong> ${escapeHtml(body).replace(/\n/g, '<br>')}</li>
      <li><strong>Image:</strong> ${
        image
          ? isUploadedImage
            ? 'Uploaded image (see preview below)'
            : `<a href="${escapeHtml(absoluteAssetUrl(image))}">${escapeHtml(absoluteAssetUrl(image))}</a>`
          : '—'
      }</li>
      <li><strong>Item ID:</strong> ${escapeHtml(id)}</li>
      <li><strong>Added:</strong> ${escapeHtml(createdAt)}</li>
      ${
        typeof reservation?.userEmail === 'string' && reservation.userEmail.trim()
          ? `<li><strong>Member email:</strong> ${escapeHtml(reservation.userEmail.trim())}</li>`
          : ''
      }
      ${dateRange ? `<li><strong>Dates:</strong> ${escapeHtml(dateRange)}</li>` : ''}
    </ul>
    ${imageHtml}
  `;

  const emailPayload = {
    from: FROM,
    to: RESERVE_INVENTORY_EMAIL_TO,
    subject,
    text,
    html,
  };

  if (attachments) {
    emailPayload.attachments = attachments;
  }

  return emailPayload;
}

async function sendReservationNotificationEmail(item, reservation = null) {
  const emailPayload = buildReservationEmailPayload(item, reservation);
  const { data, error } = await getResend().emails.send(emailPayload);

  if (error) {
    throw new Error(error.message || 'Failed to send reservation email.');
  }

  return data;
}

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

  const textLines = [
    intro,
    '',
    `Item: ${title}`,
  ];

  if (dateRange) {
    textLines.push(`Dates: ${dateRange}`);
  }

  textLines.push('', closing, '', '— Apathy is Boring / Activist Resource Library');

  const html = `
    <h2>${approved ? 'Reservation Confirmed' : 'Reservation Not Available'}</h2>
    <p>${escapeHtml(intro)}</p>
    <ul>
      <li><strong>Item:</strong> ${escapeHtml(title)}</li>
      ${dateRange ? `<li><strong>Dates:</strong> ${escapeHtml(dateRange)}</li>` : ''}
    </ul>
    <p>${escapeHtml(closing)}</p>
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

function parseDataUrlImage(dataUrl) {
  const match = dataUrl.match(/^data:(image\/[\w.+-]+);base64,([\s\S]+)$/);
  if (!match) {
    return null;
  }

  const contentType = match[1];
  const extension = contentType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';

  return {
    contentType,
    content: match[2],
    filename: `inventory-image.${extension}`,
  };
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

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc,
        scriptSrc: ["'self'"],
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
      error: 'Image must be a JPEG data URL or a path under /assets/inventory/.',
    });
  }

  const item = normalizeInventoryItem(req.body);

  if (!item) {
    return res.status(400).json({ error: 'Title, body, and image are required.' });
  }

  try {
    await ensureInventory();
    await createInventoryItem(item);
    auditAdminAction(req, 'create_inventory_item', { itemId: item.id });
    res.status(201).json({ item });
  } catch (error) {
    console.error('Failed to save inventory item:', error);
    res.status(500).json({ error: 'Could not save inventory item.' });
  }
});

app.use(express.json({ limit: '100kb' }));
app.use('/assets/fonts', express.static(path.join(__dirname, 'src', 'assets', 'fonts')));
app.use('/assets/brand', express.static(path.join(__dirname, 'src', 'assets', 'brand')));
app.use(INVENTORY_IMAGE_BASE, express.static(INVENTORY_ASSETS_DIR));
app.use(express.static(path.join(__dirname, 'dist')));

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
    sendReservationNotificationEmail(updatedItem, reservation).catch((emailError) => {
      console.error('Reservation notification email failed:', emailError);
    });

    res.status(201).json({
      reservation: sanitizeReservationForPublic(reservation),
      item: reservationItemPayload(updatedItem),
    });
  } catch (error) {
    console.error('Failed to create reservation:', error);
    res.status(500).json({ error: 'Could not create reservation.' });
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

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
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
      console.log(`Reservation notification emails → ${RESERVE_INVENTORY_EMAIL_TO}`);
    }
    if (SLACK_RESERVATION_WEBHOOK_URL) {
      console.log('Slack reservation webhook → configured');
    }
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
