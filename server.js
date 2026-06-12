import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { Resend } from 'resend';
import { compareDateKeys, parseDateKey } from './src/lib/calendar.js';
import { validateReservationDates } from './src/lib/reservation-rules.js';
import {
  addReservation,
  createInventoryItem,
  deleteInventoryItem,
  ensureInventory,
  findInventoryItem,
  isValidInventoryImage,
  isValidTag,
  normalizeInventoryItem,
  patchReservation,
  removeReservation,
} from './src/lib/inventory-store.js';
import { assertSupabaseAdminConfigured } from './src/lib/supabase-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const STRICT_PORT = process.env.NODE_ENV === 'development' || process.env.STRICT_PORT === 'true';

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

const INVENTORY_ASSETS_DIR = path.join(__dirname, 'src', 'assets', 'inventory');
const INVENTORY_IMAGE_BASE = '/assets/inventory';

app.use(express.json({ limit: '10mb' }));
app.use('/assets/fonts', express.static(path.join(__dirname, 'src', 'assets', 'fonts')));
app.use('/assets/brand', express.static(path.join(__dirname, 'src', 'assets', 'brand')));
app.use(INVENTORY_IMAGE_BASE, express.static(INVENTORY_ASSETS_DIR));
app.use(express.static(path.join(__dirname, 'dist')));

app.get('/api/inventory', async (_req, res) => {
  try {
    const items = await ensureInventory();
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
    await ensureInventory();
    await createInventoryItem(item);
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
    await ensureInventory();
    const item = await findInventoryItem(itemId);

    if (!item) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    const tagValidation = validateReservationDates(item.tag, startDate, endDate);

    if (!tagValidation.ok) {
      return res.status(400).json({ error: tagValidation.error });
    }

    const result = await addReservation(itemId, { startDate, endDate });

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

    res.status(201).json({ reservation, item: reservationItemPayload(updatedItem) });
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
    const result = await removeReservation(itemId, reservationId);

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
    const item = await findInventoryItem(itemId);

    if (!item) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    const existing = item.reservations.find((entry) => entry.id === reservationId);

    if (!existing) {
      return res.status(404).json({ error: 'Reservation not found.' });
    }

    const startDate =
      typeof req.body?.startDate === 'string' ? req.body.startDate.trim() : existing.startDate;
    const endDate =
      typeof req.body?.endDate === 'string' ? req.body.endDate.trim() : existing.endDate;
    const status =
      req.body?.status === 'available'
        ? 'available'
        : req.body?.status === 'reserved'
          ? 'reserved'
          : existing.status;

    const tagValidation = validateReservationDates(item.tag, startDate, endDate);

    if (!tagValidation.ok) {
      return res.status(400).json({ error: tagValidation.error });
    }

    const result = await patchReservation(itemId, reservationId, { startDate, endDate, status });

    if (result.notFound) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    if (result.reservationNotFound) {
      return res.status(404).json({ error: 'Reservation not found.' });
    }

    if (result.invalidUpdate) {
      return res.status(400).json({ error: 'Invalid reservation update.' });
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
    const result = await deleteInventoryItem(id);

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
    if (apiKey) {
      console.log(`Reservation notification emails → ${RESERVE_INVENTORY_EMAIL_TO}`);
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
