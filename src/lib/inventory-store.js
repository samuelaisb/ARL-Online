import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { compareDateKeys, hasReservationCollision, normalizeReservationStatus, parseDateKey } from './calendar.js';
import { validateReservationDates } from './reservation-rules.js';
import { ensureUniqueSlug, slugifyTitle } from './slug.js';
import { getSupabaseAdmin } from './supabase-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const LEGACY_INVENTORY_FILE = path.join(PROJECT_ROOT, 'data', 'inventory.json');
const SEED_INVENTORY_FILE = path.join(PROJECT_ROOT, 'src', 'assets', 'inventory', 'items.json');
const INVENTORY_IMAGE_BASE = '/assets/inventory';
const INVENTORY_TAGS = ['equipment', 'books', 'rooms'];
const DEFAULT_INVENTORY_TAG = 'equipment';

const IMAGE_DATA_URL_RE = /^data:image\/(jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const JPEG_DATA_URL_RE = IMAGE_DATA_URL_RE;

/** In-process per-item lock — safe for single-instance Cloud Run only, not across replicas. */
const itemLocks = new Map();

async function withItemLock(itemId, fn) {
  let release;
  const waitFor = itemLocks.get(itemId) ?? Promise.resolve();
  const next = waitFor.then(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  itemLocks.set(itemId, next);
  await waitFor;
  try {
    return await fn();
  } finally {
    release();
    if (itemLocks.get(itemId) === next) {
      itemLocks.delete(itemId);
    }
  }
}

let inventorySeeded = false;
let slugsBackfilled = false;

const RESERVATION_SCHEMA_MIGRATION = 'supabase/migrations/002_reservation_approval.sql';

export { INVENTORY_TAGS, DEFAULT_INVENTORY_TAG, INVENTORY_IMAGE_BASE, JPEG_DATA_URL_RE };

export function isReservationSchemaError(message) {
  if (typeof message !== 'string') {
    return false;
  }

  return /user_email|schema cache|reservations_status_check|check constraint.*status/i.test(message);
}

export function reservationSchemaErrorMessage() {
  return `Database schema is out of date. Apply ${RESERVATION_SCHEMA_MIGRATION} in the Supabase SQL Editor (adds user_email and pending/refused reservation statuses).`;
}

/** Warn at startup when migration 002 has not been applied. */
export async function checkReservationSchema() {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from('reservations').select('user_email').limit(0);

  if (error && isReservationSchemaError(error.message)) {
    return { ok: false, message: reservationSchemaErrorMessage(), detail: error.message };
  }

  if (error) {
    return { ok: false, message: error.message || 'Could not verify reservation schema.' };
  }

  return { ok: true };
}

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
  return IMAGE_DATA_URL_RE.test(trimmed) || trimmed.startsWith(`${INVENTORY_IMAGE_BASE}/`);
}

export function normalizeReservation(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const startDate = typeof raw.startDate === 'string' ? raw.startDate.trim() : '';
  const endDate = typeof raw.endDate === 'string' ? raw.endDate.trim() : '';
  const status = normalizeReservationStatus(raw.status);
  const userEmail =
    typeof raw.userEmail === 'string' && raw.userEmail.trim() ? raw.userEmail.trim() : null;

  if (!parseDateKey(startDate) || !parseDateKey(endDate)) {
    return null;
  }

  if (compareDateKeys(startDate, endDate) > 0) {
    return null;
  }

  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : randomUUID();

  return { id, startDate, endDate, status, userEmail };
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
  const slug =
    typeof raw.slug === 'string' && raw.slug.trim() ? raw.slug.trim() : null;

  return { id, title, body, image, createdAt, reservations, tag, slug };
}

function reservationRowToApi(row) {
  return {
    id: row.id,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    userEmail: row.user_email ?? null,
  };
}

function itemRowToApi(itemRow, reservationRows = []) {
  return {
    id: itemRow.id,
    title: itemRow.title,
    body: itemRow.body,
    image: itemRow.image,
    tag: itemRow.tag,
    slug: itemRow.slug ?? null,
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
    slug: item.slug ?? null,
    created_at: item.createdAt,
  };
}

function assignSlugsToItems(items) {
  const slugsByTag = Object.fromEntries(INVENTORY_TAGS.map((tag) => [tag, []]));

  return items.map((item) => {
    const tag = normalizeTag(item.tag);
    const baseSlug = slugifyTitle(item.title);
    const slug = ensureUniqueSlug(baseSlug, slugsByTag[tag]);
    slugsByTag[tag].push(slug);
    return { ...item, tag, slug };
  });
}

async function fetchSlugsForTag(tag) {
  const supabase = getSupabaseAdmin();
  const normalizedTag = normalizeTag(tag);
  const { data, error } = await supabase
    .from('inventory_items')
    .select('slug')
    .eq('tag', normalizedTag);

  if (error) {
    throw new Error(error.message || 'Could not load inventory slugs.');
  }

  return (data ?? [])
    .map((row) => row.slug)
    .filter((value) => typeof value === 'string' && value.trim());
}

async function backfillMissingSlugs() {
  const supabase = getSupabaseAdmin();
  const { data: rows, error } = await supabase
    .from('inventory_items')
    .select('id, title, tag, slug')
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(error.message || 'Could not load inventory for slug backfill.');
  }

  const slugsByTag = Object.fromEntries(INVENTORY_TAGS.map((tag) => [tag, []]));
  const updates = [];

  for (const row of rows ?? []) {
    const tag = normalizeTag(row.tag);
    if (typeof row.slug === 'string' && row.slug.trim()) {
      slugsByTag[tag].push(row.slug.trim());
    }
  }

  for (const row of rows ?? []) {
    if (typeof row.slug === 'string' && row.slug.trim()) {
      continue;
    }

    const tag = normalizeTag(row.tag);
    const slug = ensureUniqueSlug(slugifyTitle(row.title), slugsByTag[tag]);
    slugsByTag[tag].push(slug);
    updates.push({ id: row.id, slug });
  }

  for (const update of updates) {
    const { error: updateError } = await supabase
      .from('inventory_items')
      .update({ slug: update.slug })
      .eq('id', update.id);

    if (updateError) {
      throw new Error(updateError.message || 'Could not backfill inventory slug.');
    }
  }

  if (updates.length > 0) {
    console.log(`Backfilled slugs for ${updates.length} inventory item(s).`);
  }

  return updates.length;
}

function reservationToRow(itemId, reservation) {
  return {
    id: reservation.id,
    item_id: itemId,
    start_date: reservation.startDate,
    end_date: reservation.endDate,
    status: reservation.status,
    user_email: reservation.userEmail ?? null,
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

async function seedInventoryIfEmpty() {
  if (inventorySeeded) {
    return;
  }

  const existingCount = await countInventoryItems();

  if (existingCount === 0) {
    const legacyItems = assignSlugsToItems(await readLegacyInventoryFile());
    if (legacyItems.length > 0) {
      await insertInventoryItems(legacyItems);
      console.log(`Imported ${legacyItems.length} inventory items from data/inventory.json into Supabase.`);
    } else {
      const seedItems = assignSlugsToItems(await loadSeedInventory());
      if (seedItems.length > 0) {
        await insertInventoryItems(seedItems);
        console.log(`Seeded ${seedItems.length} inventory items from MyTurn library into Supabase.`);
      }
    }
  }

  inventorySeeded = true;
}

/**
 * Backfill missing slugs once per process. Independent of the `inventorySeeded`
 * flag so existing rows (e.g. seeded before slugs existed, or after applying
 * 004_inventory_slug.sql) always get slugs. Retries on the next call if it fails;
 * errors are logged, never swallowed silently, and never break the inventory read.
 */
async function ensureSlugsBackfilled() {
  if (slugsBackfilled) {
    return;
  }

  try {
    await backfillMissingSlugs();
    slugsBackfilled = true;
  } catch (error) {
    console.error(
      'Inventory slug backfill failed; will retry on next request:',
      error?.message || error,
    );
  }
}

export async function ensureInventory() {
  await seedInventoryIfEmpty();
  await ensureSlugsBackfilled();
  return fetchInventoryItems();
}

export async function createInventoryItem(item) {
  const existingSlugs = await fetchSlugsForTag(item.tag);
  const slug = ensureUniqueSlug(slugifyTitle(item.title), existingSlugs);
  const itemWithSlug = { ...item, slug };

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from('inventory_items').insert(itemToRow(itemWithSlug));

  if (error) {
    throw new Error(error.message || 'Could not save inventory item.');
  }

  return itemWithSlug;
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

export async function findInventoryItemBySlug(tag, slug) {
  const normalizedTag = normalizeTag(tag);

  if (!isValidTag(normalizedTag)) {
    return null;
  }

  const normalizedSlug = typeof slug === 'string' ? slug.trim() : '';

  if (!normalizedSlug) {
    return null;
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('inventory_items')
    .select('*, reservations(*)')
    .eq('tag', normalizedTag)
    .eq('slug', normalizedSlug)
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

export async function countPendingReservationsByEmail(userEmail) {
  const email = typeof userEmail === 'string' ? userEmail.trim() : '';

  if (!email) {
    return 0;
  }

  const supabase = getSupabaseAdmin();
  const { count, error } = await supabase
    .from('reservations')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending')
    .eq('user_email', email);

  if (error) {
    throw new Error(error.message || 'Could not count pending reservations.');
  }

  return count ?? 0;
}

export async function addReservation(itemId, { startDate, endDate, userEmail = null }) {
  return withItemLock(itemId, async () => {
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
      status: userEmail ? 'pending' : 'reserved',
      userEmail: typeof userEmail === 'string' && userEmail.trim() ? userEmail.trim() : null,
    };

    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from('reservations').insert(reservationToRow(itemId, reservation));

    if (error) {
      throw new Error(error.message || 'Could not create reservation.');
    }

    item.reservations = [...reservations, reservation];
    return { item, reservation };
  });
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
    userEmail: updates.userEmail ?? existing.userEmail,
  });

  if (!updated) {
    return { invalidUpdate: true };
  }

  const tagValidation = validateReservationDates(item.tag, updated.startDate, updated.endDate);

  if (!tagValidation.ok) {
    return { invalidUpdate: true, validationError: tagValidation.error };
  }

  if (
    (updated.status === 'reserved' || updated.status === 'pending') &&
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
      user_email: updated.userEmail ?? null,
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

export async function approveReservation(itemId, reservationId) {
  return withItemLock(itemId, async () => {
    const item = await findInventoryItem(itemId);

    if (!item) {
      return { notFound: true };
    }

    const reservationIndex = item.reservations.findIndex((entry) => entry.id === reservationId);

    if (reservationIndex === -1) {
      return { reservationNotFound: true };
    }

    const existing = item.reservations[reservationIndex];

    if (existing.status !== 'pending') {
      return { invalidStatus: true };
    }

    const updated = { ...existing, status: 'reserved' };

    if (hasReservationCollision(item.reservations, updated.startDate, updated.endDate, reservationId)) {
      return { collision: true };
    }

    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from('reservations')
      .update({ status: 'reserved' })
      .eq('id', reservationId)
      .eq('item_id', itemId);

    if (error) {
      throw new Error(error.message || 'Could not approve reservation.');
    }

    item.reservations = [...item.reservations];
    item.reservations[reservationIndex] = updated;
    return { item, reservation: updated };
  });
}

export async function refuseReservation(itemId, reservationId) {
  const item = await findInventoryItem(itemId);

  if (!item) {
    return { notFound: true };
  }

  const reservationIndex = item.reservations.findIndex((entry) => entry.id === reservationId);

  if (reservationIndex === -1) {
    return { reservationNotFound: true };
  }

  const existing = item.reservations[reservationIndex];

  if (existing.status !== 'pending') {
    return { invalidStatus: true };
  }

  const updated = { ...existing, status: 'refused' };

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('reservations')
    .update({ status: 'refused' })
    .eq('id', reservationId)
    .eq('item_id', itemId);

  if (error) {
    throw new Error(error.message || 'Could not refuse reservation.');
  }

  item.reservations = [...item.reservations];
  item.reservations[reservationIndex] = updated;
  return { item, reservation: updated };
}

/** Upsert all items from a legacy JSON array (manual migration script). */
export async function upsertInventoryFromJson(items) {
  const normalized = assignSlugsToItems(
    items
      .map((entry) => normalizeInventoryItem(entry, { requireAll: false }))
      .filter(Boolean),
  );

  if (normalized.length === 0) {
    return { inserted: 0 };
  }

  const supabase = getSupabaseAdmin();
  const existingSlugsByTag = Object.fromEntries(
    await Promise.all(
      INVENTORY_TAGS.map(async (tag) => [tag, await fetchSlugsForTag(tag)]),
    ),
  );

  const withUniqueSlugs = normalized.map((item) => {
    if (item.slug && !existingSlugsByTag[item.tag]?.includes(item.slug)) {
      existingSlugsByTag[item.tag].push(item.slug);
      return item;
    }

    const slug = ensureUniqueSlug(slugifyTitle(item.title), existingSlugsByTag[item.tag]);
    existingSlugsByTag[item.tag].push(slug);
    return { ...item, slug };
  });

  const { error: itemError } = await supabase.from('inventory_items').upsert(
    withUniqueSlugs.map(itemToRow),
    { onConflict: 'id' },
  );

  if (itemError) {
    throw new Error(itemError.message || 'Could not upsert inventory items.');
  }

  await backfillMissingSlugs();

  const reservationRows = withUniqueSlugs.flatMap((item) =>
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

  return { inserted: withUniqueSlugs.length, reservations: reservationRows.length };
}

export { backfillMissingSlugs };
