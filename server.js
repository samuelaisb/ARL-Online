import 'dotenv/config';
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { Resend } from 'resend';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const STRICT_PORT = process.env.NODE_ENV === 'development' || process.env.STRICT_PORT === 'true';

const apiKey = process.env.RESEND_API_KEY;
if (!apiKey) {
  console.error('Missing RESEND_API_KEY. Copy .env.example to .env and set your key.');
  process.exit(1);
}

const resend = new Resend(apiKey);
const FROM = process.env.EMAIL_FROM || 'onboarding@resend.dev';
const TO = process.env.EMAIL_TO || 'samuel@apathyisboring.com';
const RESERVE_INVENTORY_EMAIL_TO =
  process.env.RESERVE_INVENTORY_EMAIL_TO || process.env.EMAIL_TO || 'samuel@apathyisboring.com';

const INVENTORY_FILE = path.join(__dirname, 'data', 'inventory.json');
const SEED_INVENTORY_FILE = path.join(__dirname, 'src', 'assets', 'inventory', 'items.json');
const INVENTORY_ASSETS_DIR = path.join(__dirname, 'src', 'assets', 'inventory');
const INVENTORY_IMAGE_BASE = '/assets/inventory';

async function readInventory() {
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

async function writeInventory(items) {
  await fs.mkdir(path.dirname(INVENTORY_FILE), { recursive: true });
  await fs.writeFile(INVENTORY_FILE, JSON.stringify(items, null, 2), 'utf8');
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

  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : randomUUID();
  const createdAt =
    typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)
      ? raw.createdAt
      : Date.now();

  return { id, title, body, image, createdAt };
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
    const items = await ensureInventory();
    res.json({ items });
  } catch (error) {
    console.error('Failed to read inventory:', error);
    res.status(500).json({ error: 'Could not load inventory.' });
  }
});

app.post('/api/inventory', async (req, res) => {
  const item = normalizeInventoryItem(req.body);

  if (!item) {
    return res.status(400).json({ error: 'Title, body, and image are required.' });
  }

  try {
    const items = await ensureInventory();
    items.unshift(item);
    await writeInventory(items);
    res.status(201).json({ item });
  } catch (error) {
    console.error('Failed to save inventory item:', error);
    res.status(500).json({ error: 'Could not save inventory item.' });
  }
});

app.delete('/api/inventory/:id', async (req, res) => {
  const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';

  if (!id) {
    return res.status(400).json({ error: 'Item id is required.' });
  }

  try {
    const items = await ensureInventory();
    const index = items.findIndex((item) => item.id === id);

    if (index === -1) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    items.splice(index, 1);
    await writeInventory(items);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete inventory item:', error);
    res.status(500).json({ error: 'Could not delete inventory item.' });
  }
});

app.post('/api/reserve-inventory', async (req, res) => {
  const item = req.body?.item;

  if (!item || typeof item.title !== 'string' || !item.title.trim()) {
    return res.status(400).json({ error: 'Valid item details are required.' });
  }

  const title = item.title.trim();
  const body = typeof item.body === 'string' ? item.body.trim() : '';
  const image = typeof item.image === 'string' ? item.image.trim() : '';
  const isUploadedImage = image.startsWith('data:image/');
  const id = typeof item.id === 'string' ? item.id.trim() : 'unknown';
  const createdAt =
    typeof item.createdAt === 'number' && Number.isFinite(item.createdAt)
      ? new Date(item.createdAt).toLocaleString()
      : 'unknown';

  const subject = `Inventory reservation: ${title}`;
  const text = [
    'An inventory item has been reserved.',
    '',
    `Title: ${title}`,
    `Description: ${body}`,
    `Image: ${isUploadedImage ? '(uploaded image)' : image}`,
    `Item ID: ${id}`,
    `Added: ${createdAt}`,
  ].join('\n');

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

  const { data, error } = await resend.emails.send(emailPayload);

  if (error) {
    return res.status(500).json({ error: error.message || 'Failed to send reservation email.' });
  }

  res.json({ success: true, id: data.id });
});

app.post('/api/send-email', async (req, res) => {
  const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';

  if (!subject || !body) {
    return res.status(400).json({ error: 'Subject and body are required.' });
  }

  const { data, error } = await resend.emails.send({
    from: FROM,
    to: TO,
    subject,
    text: body,
    html: `<p>${escapeHtml(body).replace(/\n/g, '<br>')}</p>`,
  });

  if (error) {
    return res.status(500).json({ error: error.message || 'Failed to send email.' });
  }

  res.json({ success: true, id: data.id });
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
