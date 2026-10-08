import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { compareDateKeys, hasReservationCollision, normalizeReservationStatus, parseDateKey } from './calendar.js';
import { isConsultationHeld, validateReservationDates } from './reservation-rules.js';
import { EXPERT_LONG_TEXT_MAX, EXPERT_NAME_MAX, EXPERT_SHORT_TEXT_MAX } from './expertise-fields.js';
import { isStorableImageDataUrl } from './item-media.js';
import { ensureUniqueSlug, slugifyTitle } from './slug.js';
import { getSupabaseAdmin } from './supabase-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const LEGACY_INVENTORY_FILE = path.join(PROJECT_ROOT, 'data', 'inventory.json');
const SEED_INVENTORY_FILE = path.join(PROJECT_ROOT, 'src', 'assets', 'inventory', 'items.json');
const INVENTORY_IMAGE_BASE = '/assets/inventory';
const INVENTORY_TAGS = ['equipment', 'books', 'rooms', 'expertise'];
const DEFAULT_INVENTORY_TAG = 'equipment';

/** In-process per-item lock — safe for single-instance Cloud Run only, not across replicas. */
const itemLocks = new Map();
/** One in-flight mentor-profile write per account email (same single-instance limit). */
const mentorProfileLocks = new Map();

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
const EXPERTISE_SCHEMA_MIGRATION = 'supabase/migrations/005_expertise.sql';
const SCHEDULING_SCHEMA_MIGRATION = 'supabase/migrations/006_consultation_scheduling.sql';
const EXPERTISE_COPY_SCHEMA_MIGRATION = 'supabase/migrations/007_expertise_copy.sql';
const FOLLOW_UP_SCHEMA_MIGRATION = 'supabase/migrations/008_consultation_follow_up.sql';

export { INVENTORY_TAGS, DEFAULT_INVENTORY_TAG, INVENTORY_IMAGE_BASE };

export function isReservationSchemaError(message) {
  if (typeof message !== 'string') {
    return false;
  }

  return /user_email|time_slots|request_summary|meeting_at|expert_email|long_body|follow_up_of|zoom_|cancelled_|inventory_items_tag_check|schema cache|reservations_status_check|check constraint.*status/i.test(
    message,
  );
}

export function reservationSchemaErrorMessage() {
  return `Database schema is out of date. Apply ${RESERVATION_SCHEMA_MIGRATION}, ${EXPERTISE_SCHEMA_MIGRATION}, ${SCHEDULING_SCHEMA_MIGRATION}, ${EXPERTISE_COPY_SCHEMA_MIGRATION}, and ${FOLLOW_UP_SCHEMA_MIGRATION} in the Supabase SQL Editor (adds user_email, pending/refused/cancelled statuses, the expertise tag, consultation request fields, Zoom meeting fields, expertise long text, and follow-up consultations).`;
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

const SEED_IMAGE_PATH_MAX_LENGTH = 200;
const SEED_IMAGE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/** A short path under /assets/inventory/ made of plain file-name segments (no `.` or `..`). */
function isSeedImagePath(value) {
  const prefix = `${INVENTORY_IMAGE_BASE}/`;

  if (value.length > SEED_IMAGE_PATH_MAX_LENGTH || !value.startsWith(prefix)) {
    return false;
  }

  return value
    .slice(prefix.length)
    .split('/')
    .every((segment) => SEED_IMAGE_SEGMENT_RE.test(segment) && segment !== '.' && segment !== '..');
}

/** A JPEG, PNG, WebP or GIF data URL within the upload cap, or a seed path under /assets/inventory/. */
export function isValidInventoryImage(image) {
  if (typeof image !== 'string' || !image.trim()) {
    return false;
  }

  const trimmed = image.trim();
  return isStorableImageDataUrl(trimmed) || isSeedImagePath(trimmed);
}

function normalizeOptionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeReservation(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const startDate = typeof raw.startDate === 'string' ? raw.startDate.trim() : '';
  const endDate = typeof raw.endDate === 'string' ? raw.endDate.trim() : '';
  const status = normalizeReservationStatus(raw.status);
  const userEmail = normalizeOptionalText(raw.userEmail);
  const timeSlots = normalizeOptionalText(raw.timeSlots);
  const requestSummary = normalizeOptionalText(raw.requestSummary);
  const meetingAt = normalizeOptionalText(raw.meetingAt);

  if (!parseDateKey(startDate) || !parseDateKey(endDate)) {
    return null;
  }

  if (compareDateKeys(startDate, endDate) > 0) {
    return null;
  }

  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : randomUUID();

  return { id, startDate, endDate, status, userEmail, timeSlots, requestSummary, meetingAt };
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
  const tag = normalizeTag(raw.tag);
  const longBody =
    tag === 'expertise' ? normalizeOptionalText(raw.longBody ?? raw.long_body) : null;

  if (requireAll && (!title || !body || !image)) {
    return null;
  }

  if (requireAll && tag === 'expertise' && !longBody) {
    return null;
  }

  if (requireAll && tag === 'expertise' && body.length > EXPERT_SHORT_TEXT_MAX) {
    return null;
  }

  if (requireAll && longBody && longBody.length > EXPERT_LONG_TEXT_MAX) {
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
  const slug =
    typeof raw.slug === 'string' && raw.slug.trim() ? raw.slug.trim() : null;
  const expertEmail = tag === 'expertise' ? normalizeOptionalText(raw.expertEmail) : null;

  return { id, title, body, image, createdAt, reservations, tag, slug, expertEmail, longBody };
}

function reservationRowToApi(row) {
  return {
    id: row.id,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    userEmail: row.user_email ?? null,
    timeSlots: row.time_slots ?? null,
    requestSummary: row.request_summary ?? null,
    meetingAt: row.meeting_at ?? null,
    zoomMeetingId: row.zoom_meeting_id ?? null,
    zoomJoinUrl: row.zoom_join_url ?? null,
    zoomPassword: row.zoom_password ?? null,
    cancelledAt: row.cancelled_at ?? null,
    cancelledBy: row.cancelled_by ?? null,
    followUpOf: row.follow_up_of ?? null,
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
    expertEmail: itemRow.expert_email ?? null,
    longBody: itemRow.tag === 'expertise' ? itemRow.long_body ?? null : null,
    reservations: reservationRows.map(reservationRowToApi),
  };
}

function itemToRow(item) {
  const row = {
    id: item.id,
    title: item.title,
    body: item.body,
    image: item.image,
    tag: item.tag,
    slug: item.slug ?? null,
    created_at: item.createdAt,
  };

  // Only send expertise columns when set, so databases that have not applied
  // 005/007 keep working for equipment, books, and rooms.
  if (item.expertEmail) {
    row.expert_email = item.expertEmail;
  }

  if (item.longBody) {
    row.long_body = item.longBody;
  }

  return row;
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
  const row = {
    id: reservation.id,
    item_id: itemId,
    start_date: reservation.startDate,
    end_date: reservation.endDate,
    status: reservation.status,
    user_email: reservation.userEmail ?? null,
  };

  // Consultation fields only exist after 005_expertise.sql; omit when unset so
  // pre-migration databases keep working for regular reservations.
  if (reservation.timeSlots) {
    row.time_slots = reservation.timeSlots;
  }
  if (reservation.requestSummary) {
    row.request_summary = reservation.requestSummary;
  }
  if (reservation.meetingAt) {
    row.meeting_at = reservation.meetingAt;
  }

  return row;
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

/**
 * Update an expertise mentor's public copy and contact email.
 * The slug stays as created so existing /expertise/{slug} links keep working.
 * `image` is omitted to keep the current photo. `expertEmail` null clears it.
 */
export async function updateExpertiseItem(id, updates) {
  const itemId = typeof id === 'string' ? id.trim() : '';

  if (!itemId) {
    return { notFound: true };
  }

  return withItemLock(itemId, async () => {
    const existing = await findInventoryItem(itemId);

    if (!existing) {
      return { notFound: true };
    }

    if (existing.tag !== 'expertise') {
      return { notExpertise: true };
    }

    const row = {
      title: updates.title,
      body: updates.body,
      long_body: updates.longBody,
      expert_email: updates.expertEmail,
    };

    if (typeof updates.image === 'string' && updates.image) {
      row.image = updates.image;
    }

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('inventory_items')
      .update(row)
      .eq('id', itemId)
      .select('id');

    if (error) {
      throw new Error(error.message || 'Could not update mentor.');
    }

    if (!data || data.length === 0) {
      return { notFound: true };
    }

    const item = await findInventoryItem(itemId);
    if (!item) {
      return { notFound: true };
    }

    return { item };
  });
}

export async function deleteInventoryItem(id) {
  return withItemLock(id, async () => {
    const item = await findInventoryItem(id);
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.from('inventory_items').delete().eq('id', id).select('id');

    if (error) {
      throw new Error(error.message || 'Could not delete inventory item.');
    }

    if (!data || data.length === 0) {
      return { notFound: true };
    }

    return { success: true, item };
  });
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

/** Only the stored `image` value of one item (for `GET /media/items/...`); null when the item is missing. */
export async function findInventoryItemImage(id) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('inventory_items')
    .select('image')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || 'Could not load inventory image.');
  }

  return data?.image ?? null;
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

export async function addReservation(
  itemId,
  { startDate, endDate, userEmail = null, timeSlots = null, requestSummary = null },
) {
  return withItemLock(itemId, async () => {
    const item = await findInventoryItem(itemId);

    if (!item) {
      return { notFound: true };
    }

    const reservations = Array.isArray(item.reservations) ? item.reservations : [];

    // Expertise consultations have no calendar semantics — multiple members can
    // request the same expert at the same time, so date collisions do not apply.
    if (item.tag !== 'expertise' && hasReservationCollision(reservations, startDate, endDate)) {
      return { collision: true };
    }

    // One open request per member per expert: pending, or scheduled and not yet held.
    if (
      item.tag === 'expertise' &&
      reservations.some(
        (entry) =>
          emailsMatch(entry.userEmail, userEmail) &&
          (entry.status === 'pending' || (entry.status === 'reserved' && !isConsultationHeld(entry))),
      )
    ) {
      return { consultationAlreadyOpen: true };
    }

    const reservation = {
      id: randomUUID(),
      startDate,
      endDate,
      status: userEmail ? 'pending' : 'reserved',
      userEmail: typeof userEmail === 'string' && userEmail.trim() ? userEmail.trim() : null,
      timeSlots: typeof timeSlots === 'string' && timeSlots.trim() ? timeSlots.trim() : null,
      requestSummary:
        typeof requestSummary === 'string' && requestSummary.trim() ? requestSummary.trim() : null,
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
  return withItemLock(itemId, async () => {
    const item = await findInventoryItem(itemId);

    if (!item) {
      return { notFound: true };
    }

    const reservations = Array.isArray(item.reservations) ? item.reservations : [];
    const removed = reservations.find((entry) => entry.id === reservationId);

    if (!removed) {
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
    // `removed` is read inside the lock, so it includes a schedule that finished first.
    return { item, removed };
  });
}

/** Equipment / books / rooms only — expertise items return `{ isConsultation: true }`. */
export async function patchReservation(itemId, reservationId, updates) {
  return withItemLock(itemId, async () => {
    const item = await findInventoryItem(itemId);

    if (!item) {
      return { notFound: true };
    }

    // Consultations change only through schedule, cancel, or refuse, which keep Zoom
    // and the emails in step; a raw status edit would skip both.
    if (item.tag === 'expertise') {
      return { isConsultation: true };
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
      timeSlots: existing.timeSlots,
      requestSummary: existing.requestSummary,
      meetingAt: existing.meetingAt,
    });

    if (!updated) {
      return { invalidUpdate: true };
    }

    const tagValidation = validateReservationDates(item.tag, updated.startDate, updated.endDate);

    if (!tagValidation.ok) {
      return { invalidUpdate: true, validationError: tagValidation.error };
    }

    if (
      item.tag !== 'expertise' &&
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
  });
}

/** Equipment / books / rooms only — expertise items go through scheduleConsultation. */
export async function approveReservation(itemId, reservationId) {
  return withItemLock(itemId, async () => {
    const item = await findInventoryItem(itemId);

    if (!item) {
      return { notFound: true };
    }

    if (item.tag === 'expertise') {
      return { isConsultation: true };
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

function emailsMatch(a, b) {
  return (
    typeof a === 'string' &&
    typeof b === 'string' &&
    a.trim() !== '' &&
    a.trim().toLowerCase() === b.trim().toLowerCase()
  );
}

async function withMentorProfileLock(emailKey, fn) {
  let release;
  const waitFor = mentorProfileLocks.get(emailKey) ?? Promise.resolve();
  const next = waitFor.then(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  mentorProfileLocks.set(emailKey, next);
  await waitFor;

  try {
    return await fn();
  } finally {
    release();
    if (mentorProfileLocks.get(emailKey) === next) {
      mentorProfileLocks.delete(emailKey);
    }
  }
}

/**
 * The expertise item whose expert email matches this account.
 * When several match, the earliest one is the member's single mentor profile.
 */
export async function findMentorProfileByEmail(email) {
  const ownerEmail = typeof email === 'string' ? email.trim() : '';

  if (!ownerEmail) {
    return null;
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('inventory_items')
    .select('id, expert_email, created_at')
    .eq('tag', 'expertise');

  if (error) {
    throw new Error(error.message || 'Could not load mentor profile.');
  }

  const matches = (data ?? []).filter((row) => emailsMatch(row.expert_email, ownerEmail));
  matches.sort((a, b) => {
    const byTime = Number(a.created_at) - Number(b.created_at);
    if (byTime !== 0) {
      return byTime;
    }

    return String(a.id).localeCompare(String(b.id));
  });

  const match = matches[0];

  if (!match) {
    return null;
  }

  const item = await findInventoryItem(match.id);

  if (!item || item.tag !== 'expertise' || !emailsMatch(item.expertEmail, ownerEmail)) {
    return null;
  }

  return item;
}

function mentorProfileFieldsAreValid(fields) {
  const title = typeof fields?.title === 'string' ? fields.title.trim() : '';
  const body = typeof fields?.body === 'string' ? fields.body.trim() : '';
  const longBody = typeof fields?.longBody === 'string' ? fields.longBody.trim() : '';

  if (!title || !body || !longBody) {
    return false;
  }

  if (title.length > EXPERT_NAME_MAX || body.length > EXPERT_SHORT_TEXT_MAX || longBody.length > EXPERT_LONG_TEXT_MAX) {
    return false;
  }

  return true;
}

/** Creates the one expertise item owned by this account email. */
export async function createMentorProfileForEmail(email, fields) {
  const ownerEmail = typeof email === 'string' ? email.trim() : '';

  if (!ownerEmail || !mentorProfileFieldsAreValid(fields)) {
    return { invalid: true };
  }

  const image = typeof fields.image === 'string' ? fields.image.trim() : '';

  // Members upload a photo; /assets/inventory/ seed paths are admin-only.
  if (!isStorableImageDataUrl(image)) {
    return { invalid: true };
  }

  return withMentorProfileLock(ownerEmail.toLowerCase(), async () => {
    const existing = await findMentorProfileByEmail(ownerEmail);

    if (existing) {
      return { alreadyExists: true, item: existing };
    }

    const item = normalizeInventoryItem({
      title: fields.title,
      body: fields.body,
      longBody: fields.longBody,
      image,
      tag: 'expertise',
      expertEmail: ownerEmail,
    });

    if (!item || !emailsMatch(item.expertEmail, ownerEmail)) {
      return { invalid: true };
    }

    const saved = await createInventoryItem(item);
    return { item: saved };
  });
}

/** Updates that profile. The mentor email stays the account email. `previous` is the item before the update. */
export async function updateMentorProfileForEmail(email, fields) {
  const ownerEmail = typeof email === 'string' ? email.trim() : '';

  if (!ownerEmail || !mentorProfileFieldsAreValid(fields)) {
    return { invalid: true };
  }

  const nextImage = typeof fields.image === 'string' ? fields.image.trim() : '';

  if (nextImage && !isStorableImageDataUrl(nextImage)) {
    return { invalid: true };
  }

  return withMentorProfileLock(ownerEmail.toLowerCase(), async () => {
    const existing = await findMentorProfileByEmail(ownerEmail);

    if (!existing) {
      return { notFound: true };
    }

    const image = nextImage || existing.image;
    const item = normalizeInventoryItem({
      ...existing,
      title: fields.title,
      body: fields.body,
      longBody: fields.longBody,
      image,
      tag: 'expertise',
      expertEmail: existing.expertEmail,
    });

    if (!item || !emailsMatch(item.expertEmail, ownerEmail)) {
      return { invalid: true };
    }

    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from('inventory_items')
      .update({
        title: item.title,
        body: item.body,
        long_body: item.longBody,
        image: item.image,
      })
      .eq('id', existing.id)
      .eq('tag', 'expertise');

    if (error) {
      throw new Error(error.message || 'Could not update mentor profile.');
    }

    const updated = await findInventoryItem(existing.id);

    if (!updated || !emailsMatch(updated.expertEmail, ownerEmail)) {
      return { notFound: true };
    }

    return { item: updated, previous: existing };
  });
}

/**
 * Pending → reserved for an expertise consultation. `createMeeting(item, reservation)`
 * runs inside the item lock (so a double-submit cannot create two Zoom meetings) and
 * may return `{ id, joinUrl, password }` or null; `deleteMeeting(id)` undoes it if the
 * database write fails.
 */
export async function scheduleConsultation(
  itemId,
  reservationId,
  { meetingAt, createMeeting = null, deleteMeeting = null },
) {
  return withItemLock(itemId, async () => {
    const item = await findInventoryItem(itemId);

    if (!item || item.tag !== 'expertise') {
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

    const normalizedMeetingAt =
      typeof meetingAt === 'string' && meetingAt.trim() ? meetingAt.trim() : null;

    if (!normalizedMeetingAt || Number.isNaN(Date.parse(normalizedMeetingAt))) {
      return { meetingTimeRequired: true };
    }

    const meetingIso = new Date(normalizedMeetingAt).toISOString();
    const meeting = createMeeting ? await createMeeting(item, { ...existing, meetingAt: meetingIso }) : null;

    const updateRow = { status: 'reserved', meeting_at: meetingIso };
    if (meeting) {
      updateRow.zoom_meeting_id = meeting.id;
      updateRow.zoom_join_url = meeting.joinUrl;
      updateRow.zoom_password = meeting.password || null;
    }

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('reservations')
      .update(updateRow)
      .eq('id', reservationId)
      .eq('item_id', itemId)
      .eq('status', 'pending')
      .select('id');

    // Zero rows means the request was refused, cancelled, or deleted while Zoom was
    // being called (supabase-js reports no error for that), so undo the meeting.
    const unchanged = !error && (!data || data.length === 0);

    if (error || unchanged) {
      if (meeting && deleteMeeting) {
        await deleteMeeting(meeting.id).catch((cleanupError) =>
          console.error('Could not remove Zoom meeting after failed schedule:', cleanupError),
        );
      }
      if (unchanged) {
        return { invalidStatus: true };
      }
      throw new Error(error.message || 'Could not schedule consultation.');
    }

    const updated = {
      ...existing,
      status: 'reserved',
      meetingAt: meetingIso,
      zoomMeetingId: meeting?.id ?? null,
      zoomJoinUrl: meeting?.joinUrl ?? null,
      zoomPassword: meeting?.password || null,
    };

    item.reservations = [...item.reservations];
    item.reservations[reservationIndex] = updated;
    return { item, reservation: updated };
  });
}

/**
 * Pending or reserved → cancelled. `cancelledBy` is 'member', 'expert', or 'admin'.
 * A meeting that has already been held can't be cancelled (`alreadyHeld`).
 */
export async function cancelConsultation(itemId, reservationId, { cancelledBy }) {
  return withItemLock(itemId, async () => {
    const item = await findInventoryItem(itemId);

    if (!item || item.tag !== 'expertise') {
      return { notFound: true };
    }

    const reservationIndex = item.reservations.findIndex((entry) => entry.id === reservationId);

    if (reservationIndex === -1) {
      return { reservationNotFound: true };
    }

    const existing = item.reservations[reservationIndex];

    if (existing.status !== 'pending' && existing.status !== 'reserved') {
      return { invalidStatus: true };
    }

    if (isConsultationHeld(existing)) {
      return { alreadyHeld: true };
    }

    const cancelledAt = new Date().toISOString();
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from('reservations')
      .update({ status: 'cancelled', cancelled_at: cancelledAt, cancelled_by: cancelledBy })
      .eq('id', reservationId)
      .eq('item_id', itemId);

    if (error) {
      throw new Error(error.message || 'Could not cancel consultation.');
    }

    const updated = { ...existing, status: 'cancelled', cancelledAt, cancelledBy };
    item.reservations = [...item.reservations];
    item.reservations[reservationIndex] = updated;
    return { item, reservation: updated, previousStatus: existing.status };
  });
}

/**
 * Books a follow-up to a scheduled consultation whose meeting has started: a new row for the
 * same member and expert, written straight as `reserved` with its own Zoom meeting and
 * `follow_up_of` set to the source. The one-open-request rule still holds, ignoring the source
 * itself (so the follow-up can be booked at the end of the call). `createMeeting` and
 * `deleteMeeting` work as in scheduleConsultation.
 */
export async function bookFollowUpConsultation(
  itemId,
  sourceReservationId,
  { meetingAt, note = null, today, createMeeting = null, deleteMeeting = null },
) {
  return withItemLock(itemId, async () => {
    const item = await findInventoryItem(itemId);

    if (!item || item.tag !== 'expertise') {
      return { notFound: true };
    }

    const source = item.reservations.find((entry) => entry.id === sourceReservationId);

    if (!source) {
      return { reservationNotFound: true };
    }

    const sourceStart = Date.parse(source.meetingAt ?? '');

    if (source.status !== 'reserved' || Number.isNaN(sourceStart) || sourceStart > Date.now()) {
      return { invalidStatus: true };
    }

    const alreadyOpen = item.reservations.some(
      (entry) =>
        entry.id !== source.id &&
        emailsMatch(entry.userEmail, source.userEmail) &&
        (entry.status === 'pending' || (entry.status === 'reserved' && !isConsultationHeld(entry))),
    );

    if (alreadyOpen) {
      return { followUpAlreadyOpen: true };
    }

    const normalizedMeetingAt =
      typeof meetingAt === 'string' && meetingAt.trim() ? meetingAt.trim() : null;

    if (!normalizedMeetingAt || Number.isNaN(Date.parse(normalizedMeetingAt))) {
      return { meetingTimeRequired: true };
    }

    const meetingIso = new Date(normalizedMeetingAt).toISOString();
    const reservation = {
      id: randomUUID(),
      startDate: today,
      endDate: today,
      status: 'reserved',
      userEmail: source.userEmail,
      timeSlots: null,
      requestSummary: typeof note === 'string' && note.trim() ? note.trim() : null,
      meetingAt: meetingIso,
      followUpOf: source.id,
    };

    const meeting = createMeeting ? await createMeeting(item, reservation) : null;
    const row = { ...reservationToRow(itemId, reservation), follow_up_of: source.id };
    if (meeting) {
      row.zoom_meeting_id = meeting.id;
      row.zoom_join_url = meeting.joinUrl;
      row.zoom_password = meeting.password || null;
    }

    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from('reservations').insert(row);

    if (error) {
      if (meeting && deleteMeeting) {
        await deleteMeeting(meeting.id).catch((cleanupError) =>
          console.error('Could not remove Zoom meeting after failed follow-up booking:', cleanupError),
        );
      }
      throw new Error(error.message || 'Could not book the follow-up consultation.');
    }

    const created = {
      ...reservation,
      zoomMeetingId: meeting?.id ?? null,
      zoomJoinUrl: meeting?.joinUrl ?? null,
      zoomPassword: meeting?.password || null,
      cancelledAt: null,
      cancelledBy: null,
    };

    item.reservations = [...item.reservations, created];
    return { item, reservation: created };
  });
}

/** Locates a reservation by id and returns its parent item (with all reservations). */
export async function findReservationWithItem(reservationId) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('reservations')
    .select('item_id')
    .eq('id', reservationId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || 'Could not load reservation.');
  }

  if (!data) {
    return null;
  }

  const item = await findInventoryItem(data.item_id);
  const reservation = item?.reservations.find((entry) => entry.id === reservationId);
  return item && reservation ? { item, reservation } : null;
}

export function isConsultationExpert(item, email) {
  return item?.tag === 'expertise' && emailsMatch(item.expertEmail, email);
}

export function isConsultationMember(reservation, email) {
  return emailsMatch(reservation?.userEmail, email);
}

/**
 * Consultations visible on /account: requests the user made (`asMember`) and
 * requests addressed to them as the item's expert (`asExpert`, confirmed email only).
 */
export async function listConsultationsForUser(email, { includeExpert = false } = {}) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('inventory_items')
    .select('*, reservations(*)')
    .eq('tag', 'expertise');

  if (error) {
    throw new Error(error.message || 'Could not load consultations.');
  }

  const asMember = [];
  const asExpert = [];

  for (const row of data ?? []) {
    const item = itemRowToApi(row, Array.isArray(row.reservations) ? row.reservations : []);
    const isExpert = includeExpert && isConsultationExpert(item, email);

    for (const reservation of item.reservations) {
      if (reservation.status === 'available') {
        continue;
      }
      if (isConsultationMember(reservation, email)) {
        asMember.push({ item, reservation });
      }
      if (isExpert) {
        asExpert.push({ item, reservation });
      }
    }
  }

  return { asMember, asExpert };
}

const MEMBER_RESERVATION_STATUSES = ['pending', 'reserved', 'refused', 'cancelled'];

/** LIKE pattern that matches `value` literally (`\`, `%` and `_` escaped). */
function literalLikePattern(value) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Equipment, book and room reservations made by this account email (compared
 * case-insensitively), each with its item's id, title, slug and tag, earliest start first.
 * Consultations are listed by listConsultationsForUser instead.
 */
export async function listReservationsForMember(email) {
  const memberEmail = typeof email === 'string' ? email.trim() : '';

  if (!memberEmail) {
    return [];
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('reservations')
    .select('id, item_id, start_date, end_date, status, user_email, inventory_items(id, title, slug, tag)')
    .ilike('user_email', literalLikePattern(memberEmail))
    .in('status', MEMBER_RESERVATION_STATUSES);

  if (error) {
    throw new Error(error.message || 'Could not load reservations.');
  }

  const entries = [];

  for (const row of data ?? []) {
    const itemRow = Array.isArray(row.inventory_items) ? row.inventory_items[0] : row.inventory_items;

    // The ilike only narrows the query; ownership is decided here.
    if (!itemRow || itemRow.tag === 'expertise' || !emailsMatch(row.user_email, memberEmail)) {
      continue;
    }

    entries.push({
      item: { id: itemRow.id, title: itemRow.title, slug: itemRow.slug ?? null, tag: itemRow.tag },
      reservation: reservationRowToApi(row),
    });
  }

  entries.sort((a, b) => compareDateKeys(a.reservation.startDate, b.reservation.startDate));
  return entries;
}

/**
 * A member withdraws their own equipment, book or room reservation: `pending`, or
 * `reserved` with `startDate` after `today` (a `YYYY-MM-DD` key) → `cancelled`,
 * `cancelled_by: 'member'`. Someone else's reservation, or a consultation, is `notFound`.
 */
export async function cancelReservationForMember(reservationId, email, { today }) {
  const id = typeof reservationId === 'string' ? reservationId.trim() : '';
  const memberEmail = typeof email === 'string' ? email.trim() : '';

  if (!id || !memberEmail) {
    return { notFound: true };
  }

  const supabase = getSupabaseAdmin();
  const { data: located, error: locateError } = await supabase
    .from('reservations')
    .select('item_id')
    .eq('id', id)
    .maybeSingle();

  if (locateError) {
    throw new Error(locateError.message || 'Could not load reservation.');
  }

  if (!located) {
    return { notFound: true };
  }

  const itemId = located.item_id;

  return withItemLock(itemId, async () => {
    const item = await findInventoryItem(itemId);
    const reservationIndex = item ? item.reservations.findIndex((entry) => entry.id === id) : -1;

    if (!item || item.tag === 'expertise' || reservationIndex === -1) {
      return { notFound: true };
    }

    const existing = item.reservations[reservationIndex];

    if (!emailsMatch(existing.userEmail, memberEmail)) {
      return { notFound: true };
    }

    if (existing.status === 'reserved' && compareDateKeys(existing.startDate, today) <= 0) {
      return { alreadyStarted: true };
    }

    if (existing.status !== 'pending' && existing.status !== 'reserved') {
      return { invalidStatus: true };
    }

    const cancelledAt = new Date().toISOString();
    const { error } = await supabase
      .from('reservations')
      .update({ status: 'cancelled', cancelled_at: cancelledAt, cancelled_by: 'member' })
      .eq('id', id)
      .eq('item_id', itemId);

    if (error) {
      throw new Error(error.message || 'Could not cancel reservation.');
    }

    const updated = { ...existing, status: 'cancelled', cancelledAt, cancelledBy: 'member' };
    item.reservations = [...item.reservations];
    item.reservations[reservationIndex] = updated;
    return { item, reservation: updated, previousStatus: existing.status };
  });
}

export async function refuseReservation(itemId, reservationId) {
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
  });
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
