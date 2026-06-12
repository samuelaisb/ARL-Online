import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { compareDateKeys, hasReservationCollision, parseDateKey } from './calendar.js';
import { getSupabaseAdmin } from './supabase-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const LEGACY_INVENTORY_FILE = path.join(PROJECT_ROOT, 'data', 'inventory.json');
const SEED_INVENTORY_FILE = path.join(PROJECT_ROOT, 'src', 'assets', 'inventory', 'items.json');
const INVENTORY_IMAGE_BASE = '/assets/inventory';
const INVENTORY_TAGS = ['equipment', 'books', 'rooms'];
const DEFAULT_INVENTORY_TAG = 'equipment';

const JPEG_DATA_URL_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=\s]+$/;

export { INVENTORY_TAGS, DEFAULT_INVENTORY_TAG, INVENTORY_IMAGE_BASE, JPEG_DATA_URL_RE };

export function normalizeTag(raw) {
  const tag = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return INVENTORY_TAGS.includes(tag) ? tag : DEFAULT_INVENTORY_TAG;
}

export function isValidTag(raw) {
  const tag = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return INVENTORY_TAGS.includes(tag);
}

export function isValidInventoryImage(image) {
  if (typeof image !== 'string' || !image.trim()) {
    return false;
  }

  const trimmed = image.trim();
  return JPEG_DATA_URL_RE.test(trimmed) || trimmed.startsWith(`${INVENTORY_IMAGE_BASE}/`);
}

export function normalizeReservation(raw) {
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

export function normalizeReservations(rawReservations) {
  if (!Array.isArray(rawReservations)) {
    return [];
  }

  return rawReservations.map((reservation) => normalizeReservation(reservation)).filter(Boolean);
}

export function normalizeInventoryItem(raw, { requireAll = true } = {}) {
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

function reservationRowToApi(row) {
  return {
    id: row.id,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
  };
}

function itemRowToApi(itemRow, reservationRows = []) {
  return {
    id: itemRow.id,
    title: itemRow.title,
    body: itemRow.body,
    image: itemRow.image,
    tag: itemRow.tag,
    createdAt: Number(itemRow.created_at),
    reservations: reservationRows.map(reservationRowToApi),
  };
}

function itemToRow(item) {
  return {
    id: item.id,
    title: item.title,
    body: item.body,
    image: item.image,
    tag: item.tag,
    created_at: item.createdAt,
  };
}

function reservationToRow(itemId, reservation) {
  return {
    id: reservation.id,
    item_id: itemId,
    start_date: reservation.startDate,
    end_date: reservation.endDate,
    status: reservation.status,
  };
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

async function readLegacyInventoryFile() {
  try {
    const raw = await fs.readFile(LEGACY_INVENTORY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((entry) => normalizeInventoryItem(entry, { requireAll: false }))
      .filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

async function countInventoryItems() {
  const supabase = getSupabaseAdmin();
  const { count, error } = await supabase
    .from('inventory_items')
    .select('*', { count: 'exact', head: true });

  if (error) {
    throw new Error(error.message || 'Could not count inventory items.');
  }

  return count ?? 0;
}

async function insertInventoryItems(items) {
  if (items.length === 0) {
    return;
  }

  const supabase = getSupabaseAdmin();
  const itemRows = items.map(itemToRow);
  const { error: itemError } = await supabase.from('inventory_items').insert(itemRows);

  if (itemError) {
    throw new Error(itemError.message || 'Could not insert inventory items.');
  }

  const reservationRows = items.flatMap((item) =>
    (item.reservations ?? []).map((reservation) => reservationToRow(item.id, reservation)),
  );

  if (reservationRows.length === 0) {
    return;
  }

  const { error: reservationError } = await supabase.from('reservations').insert(reservationRows);

  if (reservationError) {
    throw new Error(reservationError.message || 'Could not insert reservations.');
  }
}

export async function fetchInventoryItems() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('inventory_items')
    .select('*, reservations(*)')
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(error.message || 'Could not load inventory.');
  }

  return (data ?? []).map((row) => {
    const reservations = Array.isArray(row.reservations) ? row.reservations : [];
    reservations.sort((a, b) => compareDateKeys(a.start_date, b.start_date));
    return itemRowToApi(row, reservations);
  });
}

export async function ensureInventory() {
  const existingCount = await countInventoryItems();
  if (existingCount > 0) {
    return fetchInventoryItems();
  }

  const legacyItems = await readLegacyInventoryFile();
  if (legacyItems.length > 0) {
    await insertInventoryItems(legacyItems);
    console.log(`Imported ${legacyItems.length} inventory items from data/inventory.json into Supabase.`);
    return fetchInventoryItems();
  }

  const seedItems = await loadSeedInventory();
  if (seedItems.length === 0) {
    return [];
  }

  await insertInventoryItems(seedItems);
  console.log(`Seeded ${seedItems.length} inventory items from MyTurn library into Supabase.`);
  return fetchInventoryItems();
}

export async function createInventoryItem(item) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from('inventory_items').insert(itemToRow(item));

  if (error) {
    throw new Error(error.message || 'Could not save inventory item.');
  }

  return item;
}

export async function deleteInventoryItem(id) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from('inventory_items').delete().eq('id', id).select('id');

  if (error) {
    throw new Error(error.message || 'Could not delete inventory item.');
  }

  if (!data || data.length === 0) {
    return { notFound: true };
  }

  return { success: true };
}

export async function findInventoryItem(id) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('inventory_items')
    .select('*, reservations(*)')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || 'Could not load inventory item.');
  }

  if (!data) {
    return null;
  }

  const reservations = Array.isArray(data.reservations) ? data.reservations : [];
  reservations.sort((a, b) => compareDateKeys(a.start_date, b.start_date));
  return itemRowToApi(data, reservations);
}

export async function addReservation(itemId, { startDate, endDate }) {
  const item = await findInventoryItem(itemId);

  if (!item) {
    return { notFound: true };
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

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from('reservations').insert(reservationToRow(itemId, reservation));

  if (error) {
    throw new Error(error.message || 'Could not create reservation.');
  }

  item.reservations = [...reservations, reservation];
  return { item, reservation };
}

export async function removeReservation(itemId, reservationId) {
  const item = await findInventoryItem(itemId);

  if (!item) {
    return { notFound: true };
  }

  const reservations = Array.isArray(item.reservations) ? item.reservations : [];
  const exists = reservations.some((entry) => entry.id === reservationId);

  if (!exists) {
    return { reservationNotFound: true };
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('reservations')
    .delete()
    .eq('id', reservationId)
    .eq('item_id', itemId);

  if (error) {
    throw new Error(error.message || 'Could not delete reservation.');
  }

  item.reservations = reservations.filter((entry) => entry.id !== reservationId);
  return { item };
}

export async function patchReservation(itemId, reservationId, updates) {
  const item = await findInventoryItem(itemId);

  if (!item) {
    return { notFound: true };
  }

  const reservationIndex = item.reservations.findIndex((entry) => entry.id === reservationId);

  if (reservationIndex === -1) {
    return { reservationNotFound: true };
  }

  const existing = item.reservations[reservationIndex];
  const updated = normalizeReservation({
    id: existing.id,
    startDate: updates.startDate ?? existing.startDate,
    endDate: updates.endDate ?? existing.endDate,
    status: updates.status ?? existing.status,
  });

  if (!updated) {
    return { invalidUpdate: true };
  }

  if (
    updated.status === 'reserved' &&
    hasReservationCollision(item.reservations, updated.startDate, updated.endDate, reservationId)
  ) {
    return { collision: true };
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('reservations')
    .update({
      start_date: updated.startDate,
      end_date: updated.endDate,
      status: updated.status,
    })
    .eq('id', reservationId)
    .eq('item_id', itemId);

  if (error) {
    throw new Error(error.message || 'Could not update reservation.');
  }

  item.reservations = [...item.reservations];
  item.reservations[reservationIndex] = updated;
  return { item, reservation: updated };
}

/** Upsert all items from a legacy JSON array (manual migration script). */
export async function upsertInventoryFromJson(items) {
  const normalized = items
    .map((entry) => normalizeInventoryItem(entry, { requireAll: false }))
    .filter(Boolean);

  if (normalized.length === 0) {
    return { inserted: 0 };
  }

  const supabase = getSupabaseAdmin();
  const { error: itemError } = await supabase.from('inventory_items').upsert(
    normalized.map(itemToRow),
    { onConflict: 'id' },
  );

  if (itemError) {
    throw new Error(itemError.message || 'Could not upsert inventory items.');
  }

  const reservationRows = normalized.flatMap((item) =>
    (item.reservations ?? []).map((reservation) => reservationToRow(item.id, reservation)),
  );

  if (reservationRows.length > 0) {
    const { error: reservationError } = await supabase
      .from('reservations')
      .upsert(reservationRows, { onConflict: 'id' });

    if (reservationError) {
      throw new Error(reservationError.message || 'Could not upsert reservations.');
    }
  }

  return { inserted: normalized.length, reservations: reservationRows.length };
}
