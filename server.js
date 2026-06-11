import 'dotenv/config';
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { Resend } from 'resend';
import {
  compareDateKeys,
  hasReservationCollision,
  parseDateKey,
} from './src/lib/calendar.js';
import { validateReservationDates } from './src/lib/reservation-rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const STRICT_PORT = process.env.NODE_ENV === 'development' || process.env.STRICT_PORT === 'true';

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

const INVENTORY_FILE = path.join(__dirname, 'data', 'inventory.json');
const SEED_INVENTORY_FILE = path.join(__dirname, 'src', 'assets', 'inventory', 'items.json');
const INVENTORY_ASSETS_DIR = path.join(__dirname, 'src', 'assets', 'inventory');
const INVENTORY_IMAGE_BASE = '/assets/inventory';
const INVENTORY_TAGS = ['equipment', 'books', 'rooms'];
const DEFAULT_INVENTORY_TAG = 'equipment';

const JPEG_DATA_URL_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=\s]+$/;

let inventoryLock = Promise.resolve();

function withInventoryLock(task) {
  const run = inventoryLock.then(task);
  inventoryLock = run.catch(() => {});
  return run;
}

function normalizeTag(raw) {
  const tag = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return INVENTORY_TAGS.includes(tag) ? tag : DEFAULT_INVENTORY_TAG;
}

function isValidTag(raw) {
  const tag = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return INVENTORY_TAGS.includes(tag);
}

function isValidInventoryImage(image) {
  if (typeof image !== 'string' || !image.trim()) {
    return false;
  }

  const trimmed = image.trim();
  return JPEG_DATA_URL_RE.test(trimmed) || trimmed.startsWith(`${INVENTORY_IMAGE_BASE}/`);
}

async function readInventoryFile() {
  try {
    const raw = await fs.readFile(INVENTORY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

async function writeInventoryFile(items) {
  await fs.mkdir(path.dirname(INVENTORY_FILE), { recursive: true });
  await fs.writeFile(INVENTORY_FILE, JSON.stringify(items, null, 2), 'utf8');
}

async function migrateInventoryTags(items) {
  if (items.length === 0) {
    return items;
  }

  let changed = false;
  const migrated = items.map((raw) => {
    const item = normalizeInventoryItem(raw, { requireAll: false });
    if (!item) {
      return raw;
    }

    if (raw.tag !== item.tag) {
      changed = true;
    }

    return item;
  });

  if (changed) {
    await writeInventoryFile(migrated);
  }

  return migrated;
}

async function readInventory() {
  const items = await readInventoryFile();
  return migrateInventoryTags(items);
}

async function writeInventory(items) {
  await writeInventoryFile(items);
}

function resolveSeedImagePath(image) {
  if (typeof image !== 'string' || !image.trim()) {
    return '';
  }

  const trimmed = image.trim();
  if (trimmed.startsWith('/')) {
    return trimmed;
  }

  return `${INVENTORY_IMAGE_BASE}/${trimmed.replace(/^\//, '')}`;
}

async function loadSeedInventory() {
  try {
    const raw = await fs.readFile(SEED_INVENTORY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    const seededAt = Date.now();

    return parsed
      .map((item, index) =>
        normalizeInventoryItem(
          {
            id:
              typeof item.sourceId === 'string' && item.sourceId.trim()
                ? `myturn-${item.sourceId.trim()}`
                : undefined,
            title: item.title,
            body: item.body,
            image: resolveSeedImagePath(item.image),
            tag: item.tag,
            createdAt: seededAt - (parsed.length - index) * 1000,
          },
          { requireAll: true },
        ),
      )
      .filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

async function ensureInventory() {
  const items = await readInventory();
  if (items.length > 0) {
    return items;
  }

  const seedItems = await loadSeedInventory();
  if (seedItems.length === 0) {
    return items;
  }

  await writeInventory(seedItems);
  console.log(`Seeded ${seedItems.length} inventory items from MyTurn library.`);
  return seedItems;
}

function normalizeReservation(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const startDate = typeof raw.startDate === 'string' ? raw.startDate.trim() : '';
  const endDate = typeof raw.endDate === 'string' ? raw.endDate.trim() : '';
  const status = raw.status === 'available' ? 'available' : 'reserved';

  if (!parseDateKey(startDate) || !parseDateKey(endDate)) {
    return null;
  }

  if (compareDateKeys(startDate, endDate) > 0) {
    return null;
  }

  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : randomUUID();

  return { id, startDate, endDate, status };
}

function normalizeReservations(rawReservations) {
  if (!Array.isArray(rawReservations)) {
    return [];
  }

  return rawReservations.map((reservation) => normalizeReservation(reservation)).filter(Boolean);
}

function normalizeInventoryItem(raw, { requireAll = true } = {}) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const body = typeof raw.body === 'string' ? raw.body.trim() : '';
  const image = typeof raw.image === 'string' ? raw.image.trim() : '';

  if (requireAll && (!title || !body || !image)) {
    return null;
  }

  if (requireAll && !isValidInventoryImage(image)) {
    return null;
  }

  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : randomUUID();
  const createdAt =
    typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)
      ? raw.createdAt
      : Date.now();
  const reservations = normalizeReservations(raw.reservations);
  const tag = normalizeTag(raw.tag);

  return { id, title, body, image, createdAt, reservations, tag };
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

  const subject = `Inventory reservation: ${title}`;
  const textLines = [
    'An inventory item has been reserved.',
    '',
    `Title: ${title}`,
    `Description: ${body}`,
    `Image: ${isUploadedImage ? '(uploaded image)' : image}`,
    `Item ID: ${id}`,
    `Added: ${createdAt}`,
  ];

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
      imageHtml = `<p><img src="${escapeHtml(image)}" alt="${escapeHtml(title)}" style="max-width: 100%; height: auto;" /></p>`;
    }
  }

  const html = `
    <h2>Inventory Reservation</h2>
    <p>An inventory item has been reserved.</p>
    <ul>
      <li><strong>Title:</strong> ${escapeHtml(title)}</li>
      <li><strong>Description:</strong> ${escapeHtml(body).replace(/\n/g, '<br>')}</li>
      <li><strong>Image:</strong> ${
        image
          ? isUploadedImage
            ? 'Uploaded image (see preview below)'
            : `<a href="${escapeHtml(image)}">${escapeHtml(image)}</a>`
          : '—'
      }</li>
      <li><strong>Item ID:</strong> ${escapeHtml(id)}</li>
      <li><strong>Added:</strong> ${escapeHtml(createdAt)}</li>
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

function reservationItemPayload(item) {
  return { id: item.id, reservations: item.reservations };
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

const INLINE_IMAGE_CID = 'inventory-image';

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

app.use(express.json({ limit: '10mb' }));
app.use('/assets/fonts', express.static(path.join(__dirname, 'src', 'assets', 'fonts')));
app.use('/assets/brand', express.static(path.join(__dirname, 'src', 'assets', 'brand')));
app.use(INVENTORY_IMAGE_BASE, express.static(INVENTORY_ASSETS_DIR));
app.use(express.static(path.join(__dirname, 'dist')));

app.get('/api/inventory', async (_req, res) => {
  try {
    const items = await withInventoryLock(() => ensureInventory());
    res.json({ items });
  } catch (error) {
    console.error('Failed to read inventory:', error);
    res.status(500).json({ error: 'Could not load inventory.' });
  }
});

app.post('/api/inventory', async (req, res) => {
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
    await withInventoryLock(async () => {
      const current = await ensureInventory();
      current.unshift(item);
      await writeInventory(current);
    });
    res.status(201).json({ item });
  } catch (error) {
    console.error('Failed to save inventory item:', error);
    res.status(500).json({ error: 'Could not save inventory item.' });
  }
});

app.post('/api/inventory/:id/reservations', async (req, res) => {
  const itemId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
  const startDate = typeof req.body?.startDate === 'string' ? req.body.startDate.trim() : '';
  const endDate = typeof req.body?.endDate === 'string' ? req.body.endDate.trim() : '';

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
    const result = await withInventoryLock(async () => {
      const items = await ensureInventory();
      const index = items.findIndex((entry) => entry.id === itemId);

      if (index === -1) {
        return { notFound: true };
      }

      const item = normalizeInventoryItem(items[index], { requireAll: false });
      const tagValidation = validateReservationDates(item.tag, startDate, endDate);

      if (!tagValidation.ok) {
        return { validationError: tagValidation.error };
      }

      const reservations = Array.isArray(item.reservations) ? item.reservations : [];

      if (hasReservationCollision(reservations, startDate, endDate)) {
        return { collision: true };
      }

      const reservation = {
        id: randomUUID(),
        startDate,
        endDate,
        status: 'reserved',
      };

      item.reservations = [...reservations, reservation];
      items[index] = item;
      await writeInventory(items);

      return { item, reservation };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    if (result.validationError) {
      return res.status(400).json({ error: result.validationError });
    }

    if (result.collision) {
      return res.status(409).json({ error: 'Selected dates overlap an existing reservation.' });
    }

    const { item, reservation } = result;
    notifySlackReservation({ item, reservation });
    sendReservationNotificationEmail(item, reservation).catch((error) => {
      console.error('Reservation notification email failed:', error);
    });

    res.status(201).json({ reservation, item: reservationItemPayload(item) });
  } catch (error) {
    console.error('Failed to create reservation:', error);
    res.status(500).json({ error: 'Could not create reservation.' });
  }
});

app.delete('/api/inventory/:id/reservations/:reservationId', async (req, res) => {
  const itemId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
  const reservationId =
    typeof req.params.reservationId === 'string' ? req.params.reservationId.trim() : '';

  if (!itemId || !reservationId) {
    return res.status(400).json({ error: 'Item id and reservation id are required.' });
  }

  try {
    const result = await withInventoryLock(async () => {
      const items = await ensureInventory();
      const index = items.findIndex((entry) => entry.id === itemId);

      if (index === -1) {
        return { notFound: true };
      }

      const item = items[index];
      const reservations = Array.isArray(item.reservations) ? item.reservations : [];
      const reservationIndex = reservations.findIndex((entry) => entry.id === reservationId);

      if (reservationIndex === -1) {
        return { reservationNotFound: true };
      }

      item.reservations = reservations.filter((entry) => entry.id !== reservationId);
      items[index] = item;
      await writeInventory(items);

      return { item };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    if (result.reservationNotFound) {
      return res.status(404).json({ error: 'Reservation not found.' });
    }

    res.json({ success: true, item: result.item });
  } catch (error) {
    console.error('Failed to delete reservation:', error);
    res.status(500).json({ error: 'Could not delete reservation.' });
  }
});

app.patch('/api/inventory/:id/reservations/:reservationId', async (req, res) => {
  const itemId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
  const reservationId =
    typeof req.params.reservationId === 'string' ? req.params.reservationId.trim() : '';

  if (!itemId || !reservationId) {
    return res.status(400).json({ error: 'Item id and reservation id are required.' });
  }

  try {
    const result = await withInventoryLock(async () => {
      const items = await ensureInventory();
      const index = items.findIndex((entry) => entry.id === itemId);

      if (index === -1) {
        return { notFound: true };
      }

      const item = normalizeInventoryItem(items[index], { requireAll: false });
      const reservationIndex = item.reservations.findIndex((r) => r.id === reservationId);

      if (reservationIndex === -1) {
        return { reservationNotFound: true };
      }

      const existing = item.reservations[reservationIndex];
      const updated = normalizeReservation({
        id: existing.id,
        startDate:
          typeof req.body?.startDate === 'string' ? req.body.startDate.trim() : existing.startDate,
        endDate:
          typeof req.body?.endDate === 'string' ? req.body.endDate.trim() : existing.endDate,
        status:
          req.body?.status === 'available'
            ? 'available'
            : req.body?.status === 'reserved'
              ? 'reserved'
              : existing.status,
      });

      if (!updated) {
        return { invalidUpdate: true };
      }

      const tagValidation = validateReservationDates(
        item.tag,
        updated.startDate,
        updated.endDate,
      );

      if (!tagValidation.ok) {
        return { validationError: tagValidation.error };
      }

      if (
        updated.status === 'reserved' &&
        hasReservationCollision(item.reservations, updated.startDate, updated.endDate, reservationId)
      ) {
        return { collision: true };
      }

      item.reservations = [...item.reservations];
      item.reservations[reservationIndex] = updated;
      items[index] = item;
      await writeInventory(items);

      return { item, reservation: updated };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    if (result.reservationNotFound) {
      return res.status(404).json({ error: 'Reservation not found.' });
    }

    if (result.invalidUpdate) {
      return res.status(400).json({ error: 'Invalid reservation update.' });
    }

    if (result.validationError) {
      return res.status(400).json({ error: result.validationError });
    }

    if (result.collision) {
      return res.status(409).json({ error: 'Updated dates overlap an existing reservation.' });
    }

    res.json({ item: result.item, reservation: result.reservation });
  } catch (error) {
    console.error('Failed to update reservation:', error);
    res.status(500).json({ error: 'Could not update reservation.' });
  }
});

app.delete('/api/inventory/:id', async (req, res) => {
  const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';

  if (!id) {
    return res.status(400).json({ error: 'Item id is required.' });
  }

  try {
    const result = await withInventoryLock(async () => {
      const items = await ensureInventory();
      const index = items.findIndex((entry) => entry.id === id);

      if (index === -1) {
        return { notFound: true };
      }

      items.splice(index, 1);
      await writeInventory(items);

      return { success: true };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete inventory item:', error);
    res.status(500).json({ error: 'Could not delete inventory item.' });
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
