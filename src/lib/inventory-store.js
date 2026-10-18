import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { compareDateKeys, hasReservationCollision, normalizeReservationStatus, parseDateKey } from './calendar.js';
import { isConsultationHeld, validateReservationDates } from './reservation-rules.js';
import { EXPERT_LONG_TEXT_MAX, EXPERT_NAME_MAX, EXPERT_SHORT_TEXT_MAX } from './expertise-fields.js';
import {
  hasPhysicalLocation,
  locationRowToApi,
  OFFICE_LOCATION,
  OFFICE_LOCATION_ID,
} from './item-location.js';
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
const ITEM_LOCATIONS_SCHEMA_MIGRATION = 'supabase/migrations/010_item_locations.sql';

export { INVENTORY_TAGS, DEFAULT_INVENTORY_TAG, INVENTORY_IMAGE_BASE };

export function isReservationSchemaError(message) {
  if (typeof message !== 'string') {
    return false;
  }

  return /user_email|time_slots|request_summary|meeting_at|expert_email|long_body|follow_up_of|zoom_|cancelled_|location_id|item_locations|inventory_items_tag_check|schema cache|reservations_status_check|check constraint.*status/i.test(
    message,
  );
}

export function reservationSchemaErrorMessage() {
  return `Database schema is out of date. Apply ${RESERVATION_SCHEMA_MIGRATION}, ${EXPERTISE_SCHEMA_MIGRATION}, ${SCHEDULING_SCHEMA_MIGRATION}, ${EXPERTISE_COPY_SCHEMA_MIGRATION}, ${FOLLOW_UP_SCHEMA_MIGRATION}, and ${ITEM_LOCATIONS_SCHEMA_MIGRATION} in the Supabase SQL Editor (adds user_email, pending/refused/cancelled statuses, the expertise tag, consultation request fields, Zoom meeting fields, expertise long text, follow-up consultations, and item locations).`;
}

/*
 * Item locations (migration 010). Read apart from the items, never as an embed, so a database
 * without 010 keeps working: every equipment, book and room item then shows the office.
 * Cached in process for 5 minutes (single Cloud Run instance; a stale copy only delays a change
 * made in SQL). Once a copy exists, an expired one is served while the next load runs, so no
 * request waits on it. A load never throws and gives up after 5 s: on an error the last good
 * copy is kept and the next request after 30 s tries again. No timers: Cloud Run throttles the
 * CPU between requests.
 */
const ITEM_LOCATIONS_TTL_MS = 5 * 60 * 1000;
const ITEM_LOCATIONS_RETRY_MS = 30 * 1000;
const ITEM_LOCATIONS_TIMEOUT_MS = 5 * 1000;
// A forced reload (an item points at a place the cache doesn't have) waits at least this long.
const ITEM_LOCATIONS_FORCED_RETRY_MS = 5 * 1000;
const ITEM_LOCATIONS_SCHEMA_ERROR_CODES = new Set(['PGRST205', '42P01']);

// `available`: true once a load worked, false once one found no table (010 not applied), null
// until either: not knowing must never be read as "not applied".
let itemLocations = { available: null, byId: new Map() };
let itemLocationsNextLoadAt = 0;
let itemLocationsNextForcedLoadAt = 0;
let itemLocationsLoading = null;
let itemLocationsFailing = false;
const loggedMissingLocationIds = new Set();

/**
 * Migration 010 isn't applied: the table doesn't exist. Only that (not a permission or network
 * error, which keep the last copy). Kept apart from isReservationSchemaError, like item views.
 */
function isItemLocationsSchemaError(error) {
  return (
    ITEM_LOCATIONS_SCHEMA_ERROR_CODES.has(error?.code) ||
    /could not find the table '[^']*item_locations'|relation "[^"]*item_locations" does not exist/i.test(
      error?.message ?? '',
    )
  );
}

async function fetchItemLocations() {
  const { data, error } = await getSupabaseAdmin()
    .from('item_locations')
    .select('*')
    .abortSignal(AbortSignal.timeout(ITEM_LOCATIONS_TIMEOUT_MS));

  if (error) {
    if (isItemLocationsSchemaError(error)) {
      return { available: false, byId: new Map() };
    }
    throw new Error(error.message || 'Could not load item locations.');
  }

  const byId = new Map();
  for (const row of data ?? []) {
    const location = locationRowToApi(row);
    if (location) {
      byId.set(location.id, location);
    }
  }

  return { available: true, byId };
}

function startItemLocationsLoad() {
  itemLocationsLoading ??= (async () => {
    try {
      itemLocations = await fetchItemLocations();
      itemLocationsFailing = false;
      loggedMissingLocationIds.clear();
      itemLocationsNextLoadAt = Date.now() + ITEM_LOCATIONS_TTL_MS;
    } catch (error) {
      // Keep the last good copy. Logged once per run of failures, not on every request.
      if (!itemLocationsFailing) {
        console.error('Item locations failed to load; keeping the last copy:', error?.message || error);
      }
      itemLocationsFailing = true;
      itemLocationsNextLoadAt = Date.now() + ITEM_LOCATIONS_RETRY_MS;
    } finally {
      itemLocationsNextForcedLoadAt = Date.now() + ITEM_LOCATIONS_FORCED_RETRY_MS;
      itemLocationsLoading = null;
    }
    return itemLocations;
  })();
  return itemLocationsLoading;
}

/**
 * `{ available, byId }`: whether 010 is applied (true, false, or null while unknown), and its
 * rows by id. One load at a time. `force` reloads before the 5 minutes are up (at most every
 * 5 s) and waits for it, for an item that points at a place added since the last load.
 */
function loadItemLocations({ force = false } = {}) {
  const now = Date.now();

  if (itemLocationsLoading) {
    // The first load, or a forced one, waits; anything else keeps using the copy it has.
    return force || itemLocations.available === null ? itemLocationsLoading : Promise.resolve(itemLocations);
  }

  if (now < (force ? itemLocationsNextForcedLoadAt : itemLocationsNextLoadAt)) {
    return Promise.resolve(itemLocations);
  }

  const loading = startItemLocationsLoad();
  return force || itemLocations.available === null ? loading : Promise.resolve(itemLocations);
}

/** The cached locations, reloaded first when one of `locationIds` isn't in them yet. */
async function itemLocationsCovering(locations, locationIds) {
  const missing = locationIds.some((id) => id && !locations.byId.has(id));
  return missing ? loadItemLocations({ force: true }) : locations;
}

/**
 * An item's full location: null for expertise; its own row; or, when it has none (before 010,
 * or a row written without one), the office. The office's id falls back to OFFICE_LOCATION (the
 * same row) when the table can't be read. Any other id that still isn't known after a reload
 * gives null rather than a guess, so no email sends a member to the wrong address.
 */
function resolveItemLocation(tag, locationId, locations = itemLocations) {
  if (!hasPhysicalLocation(tag)) {
    return null;
  }

  if (locationId) {
    const location =
      locations.byId.get(locationId) ?? (locationId === OFFICE_LOCATION_ID ? OFFICE_LOCATION : null);
    if (!location && !loggedMissingLocationIds.has(locationId)) {
      loggedMissingLocationIds.add(locationId);
      console.warn(`Item location ${locationId} is not in item_locations; showing no location.`);
    }
    return location;
  }

  return locations.byId.get(OFFICE_LOCATION_ID) ?? OFFICE_LOCATION;
}

/** New equipment, books and rooms go to the office, once 010's office row exists. */
function withDefaultLocation(item, locations) {
  if (item.locationId || !hasPhysicalLocation(item.tag) || !locations.byId.has(OFFICE_LOCATION_ID)) {
    return item;
  }

  return { ...item, locationId: OFFICE_LOCATION_ID };
}

/**
 * Inserts item rows; if inventory_items.location_id doesn't exist (010 only half run by hand),
 * inserts them again without it, as the item would read back as the office anyway.
 */
async function insertItemRows(supabase, rows) {
  let { error } = await supabase.from('inventory_items').insert(rows);

  if (
    error &&
    rows.some((row) => 'location_id' in row) &&
    (error.code === 'PGRST204' || isMissingColumnError(error, 'location_id'))
  ) {
    ({ error } = await supabase
      .from('inventory_items')
      .insert(rows.map(({ location_id: _locationId, ...row }) => row)));
  }

  return error;
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
  // Not taken from the input: there's no location picker yet, and the store gives new
  // equipment, books and rooms the office (withDefaultLocation). Imports keep their row's value.
  const locationId = null;

  return { id, title, body, image, createdAt, reservations, tag, slug, expertEmail, longBody, locationId };
}

/** A timestamptz from PostgREST (`…+00:00`, microseconds) as `toISOString()`, or null. */
function timestampToIso(value) {
  const ms = typeof value === 'string' && value ? Date.parse(value) : NaN;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
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
    // When the request was made (009; the DB default fills it). Older rows are null.
    createdAt: timestampToIso(row.created_at),
    // When a deleted account's email was stripped from the row (009); null otherwise. Admin only.
    anonymizedAt: timestampToIso(row.anonymized_at),
  };
}

/** `locations`: loadItemLocations()'s result (expertise rows need none: they have no location). */
function itemRowToApi(itemRow, reservationRows = [], locations = itemLocations) {
  // location_id is undefined before 010.
  const locationId = hasPhysicalLocation(itemRow.tag) ? itemRow.location_id ?? null : null;

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
    locationId,
    // The full address and exact point: server side only. Public routes send toPublicItem().
    location: resolveItemLocation(itemRow.tag, locationId, locations),
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

  // Only set once 010 exists (withDefaultLocation checks), and never cleared from here, so an
  // import's upsert keeps the location an item already has.
  if (item.locationId) {
    row.location_id = item.locationId;
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
  const locations = await loadItemLocations();
  const itemRows = items.map((item) => itemToRow(withDefaultLocation(item, locations)));
  const itemError = await insertItemRows(supabase, itemRows);

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
  const [{ data, error }, cachedLocations] = await Promise.all([
    supabase.from('inventory_items').select('*, reservations(*)').order('created_at', { ascending: false }),
    loadItemLocations(),
  ]);

  if (error) {
    throw new Error(error.message || 'Could not load inventory.');
  }

  const rows = data ?? [];
  const locations = await itemLocationsCovering(
    cachedLocations,
    rows.map((row) => row.location_id),
  );

  return rows.map((row) => {
    const reservations = Array.isArray(row.reservations) ? row.reservations : [];
    reservations.sort((a, b) => compareDateKeys(a.start_date, b.start_date));
    return itemRowToApi(row, reservations, locations);
  });
}

/** One item row as an API item, with its location (see fetchInventoryItems). */
async function itemRowWithLocation(row, cachedLocations) {
  const locations = await itemLocationsCovering(cachedLocations, [row.location_id]);
  const reservations = Array.isArray(row.reservations) ? row.reservations : [];
  reservations.sort((a, b) => compareDateKeys(a.start_date, b.start_date));
  return itemRowToApi(row, reservations, locations);
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
  const [existingSlugs, locations] = await Promise.all([fetchSlugsForTag(item.tag), loadItemLocations()]);
  const slug = ensureUniqueSlug(slugifyTitle(item.title), existingSlugs);
  const itemWithSlug = withDefaultLocation({ ...item, slug }, locations);

  const supabase = getSupabaseAdmin();
  const error = await insertItemRows(supabase, [itemToRow(itemWithSlug)]);

  if (error) {
    throw new Error(error.message || 'Could not save inventory item.');
  }

  return {
    ...itemWithSlug,
    location: resolveItemLocation(itemWithSlug.tag, itemWithSlug.locationId, locations),
  };
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
  const [{ data, error }, locations] = await Promise.all([
    supabase
      .from('inventory_items')
      .select('*, reservations(*)')
      .eq('tag', normalizedTag)
      .eq('slug', normalizedSlug)
      .maybeSingle(),
    loadItemLocations(),
  ]);

  if (error) {
    throw new Error(error.message || 'Could not load inventory item.');
  }

  if (!data) {
    return null;
  }

  return itemRowWithLocation(data, locations);
}

export async function findInventoryItem(id) {
  const supabase = getSupabaseAdmin();
  const [{ data, error }, locations] = await Promise.all([
    supabase.from('inventory_items').select('*, reservations(*)').eq('id', id).maybeSingle(),
    loadItemLocations(),
  ]);

  if (error) {
    throw new Error(error.message || 'Could not load inventory item.');
  }

  if (!data) {
    return null;
  }

  return itemRowWithLocation(data, locations);
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

/**
 * `status` defaults to `pending` for a member's request (`reserved` without an email); staff
 * bookings from admin pass `reserved`.
 */
export async function addReservation(
  itemId,
  { startDate, endDate, userEmail = null, timeSlots = null, requestSummary = null, status = null },
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
      status: status ?? (userEmail ? 'pending' : 'reserved'),
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

/** Same account email: trimmed, case-insensitive, and never two empty values. */
export function emailsMatch(a, b) {
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
 * itself (so the follow-up can be booked at the end of the call). A source without a member
 * email (the account was deleted) is `invalidStatus`, before any Zoom meeting is made.
 * `createMeeting` and `deleteMeeting` work as in scheduleConsultation.
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
    // A deleted member's held consultation stays as history with no email: no one to meet again.
    const sourceMember = typeof source.userEmail === 'string' ? source.userEmail.trim() : '';

    if (
      source.status !== 'reserved' ||
      Number.isNaN(sourceStart) ||
      sourceStart > Date.now() ||
      !sourceMember
    ) {
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

/** An undefined column, e.g. inventory_items.location_id before 010. */
function isMissingColumnError(error, column) {
  return error?.code === '42703' || new RegExp(column, 'i').test(error?.message ?? '');
}

/**
 * Equipment, book and room reservations made by this account email (compared
 * case-insensitively), each with its item's id, title, slug, tag and full location, earliest
 * start first. Consultations are listed by listConsultationsForUser instead.
 */
export async function listReservationsForMember(email) {
  const memberEmail = typeof email === 'string' ? email.trim() : '';

  if (!memberEmail) {
    return [];
  }

  const supabase = getSupabaseAdmin();
  const cachedLocations = await loadItemLocations();
  const selectReservations = (withLocation) =>
    supabase
      .from('reservations')
      .select(
        `id, item_id, start_date, end_date, status, user_email, inventory_items(id, title, slug, tag${withLocation ? ', location_id' : ''})`,
      )
      .ilike('user_email', literalLikePattern(memberEmail))
      .in('status', MEMBER_RESERVATION_STATUSES);

  // Leaves location_id out only when 010 is known to be missing. Otherwise asks for it (an item
  // elsewhere must never fall back to the office), and asks again without it if the column
  // turns out not to exist.
  const askForLocation = cachedLocations.available !== false;
  let { data, error } = await selectReservations(askForLocation);
  if (error && askForLocation && isMissingColumnError(error, 'location_id')) {
    ({ data, error } = await selectReservations(false));
  }

  if (error) {
    throw new Error(error.message || 'Could not load reservations.');
  }

  const itemRowOf = (row) =>
    Array.isArray(row.inventory_items) ? row.inventory_items[0] : row.inventory_items;
  const locations = await itemLocationsCovering(
    cachedLocations,
    (data ?? []).map((row) => itemRowOf(row)?.location_id),
  );
  const entries = [];

  for (const row of data ?? []) {
    const itemRow = itemRowOf(row);

    // The ilike only narrows the query; ownership is decided here.
    if (!itemRow || itemRow.tag === 'expertise' || !emailsMatch(row.user_email, memberEmail)) {
      continue;
    }

    const locationId = itemRow.location_id ?? null;
    entries.push({
      item: {
        id: itemRow.id,
        title: itemRow.title,
        slug: itemRow.slug ?? null,
        tag: itemRow.tag,
        locationId,
        location: resolveItemLocation(itemRow.tag, locationId, locations),
      },
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

/**
 * Staff cancel an equipment, book or room reservation (deleting a member account): `pending`
 * or `reserved` → `cancelled`, `cancelled_by: 'admin'`, even once the loan has started. The row
 * stays as history. Consultations go through cancelConsultation instead (`isConsultation`).
 */
export async function cancelReservationByAdmin(itemId, reservationId) {
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

    if (existing.status !== 'pending' && existing.status !== 'reserved') {
      return { invalidStatus: true };
    }

    const cancelledAt = new Date().toISOString();
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from('reservations')
      .update({ status: 'cancelled', cancelled_at: cancelledAt, cancelled_by: 'admin' })
      .eq('id', reservationId)
      .eq('item_id', itemId);

    if (error) {
      throw new Error(error.message || 'Could not cancel reservation.');
    }

    const updated = { ...existing, status: 'cancelled', cancelledAt, cancelledBy: 'admin' };
    item.reservations = [...item.reservations];
    item.reservations[reservationIndex] = updated;
    return { item, reservation: updated, previousStatus: existing.status };
  });
}

/**
 * Strips a deleted account from its reservation history: every row whose `user_email` matches
 * (case-insensitively, any tag, any status) keeps its item, dates and status but loses
 * `user_email`, `time_slots` and `request_summary`, and gets `anonymized_at` (009) so Stats
 * still counts it as a member's request. A later account with the same email then inherits
 * nothing. Rows are updated by id, one item at a time under that item's lock.
 */
export async function anonymizeReservationsForEmail(email) {
  const memberEmail = typeof email === 'string' ? email.trim() : '';

  if (!memberEmail) {
    return { count: 0 };
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('reservations')
    .select('id, item_id, user_email')
    .ilike('user_email', literalLikePattern(memberEmail));

  if (error) {
    throw new Error(error.message || 'Could not load reservations.');
  }

  const idsByItem = new Map();

  for (const row of data ?? []) {
    // The ilike only narrows the query; ownership is decided here.
    if (!emailsMatch(row.user_email, memberEmail)) {
      continue;
    }

    const ids = idsByItem.get(row.item_id) ?? [];
    ids.push(row.id);
    idsByItem.set(row.item_id, ids);
  }

  let count = 0;
  const anonymizedAt = new Date().toISOString();

  for (const [itemId, ids] of idsByItem) {
    count += await withItemLock(itemId, async () => {
      const { data: updated, error: updateError } = await supabase
        .from('reservations')
        .update({
          user_email: null,
          time_slots: null,
          request_summary: null,
          anonymized_at: anonymizedAt,
        })
        .in('id', ids)
        .eq('item_id', itemId)
        .ilike('user_email', literalLikePattern(memberEmail))
        .select('id');

      if (updateError) {
        throw new Error(updateError.message || 'Could not anonymize reservations.');
      }

      return updated?.length ?? 0;
    });
  }

  return { count };
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

const ITEM_VIEWS_SCHEMA_ERROR_CODES = new Set(['PGRST205', 'PGRST202', '42P01', '42883']);

/**
 * Migration 009 (item_views and its functions) isn't applied. Kept apart from
 * isReservationSchemaError, whose "schema cache" match would name migrations 002–008.
 */
function isItemViewsSchemaError(error) {
  return (
    ITEM_VIEWS_SCHEMA_ERROR_CODES.has(error?.code) ||
    /item_views|increment_item_view|item_view_summary|item_view_daily/i.test(error?.message ?? '')
  );
}

/**
 * Adds one view of the item on `day` (a libraryTodayKey()). Resolves `{ recorded }`,
 * `{ unknownItem }` (no such item: the foreign key failed) or `{ schemaMissing }` (009 not
 * applied); other Supabase errors throw.
 */
export async function recordItemView(itemId, day) {
  const { error } = await getSupabaseAdmin().rpc('increment_item_view', {
    p_item_id: itemId,
    p_day: day,
  });

  if (!error) {
    return { recorded: true };
  }

  // Checked first: the foreign-key message also names item_views.
  if (error.code === '23503') {
    return { unknownItem: true };
  }

  if (isItemViewsSchemaError(error)) {
    return { schemaMissing: true };
  }

  throw new Error(error.message || 'Could not record the item view.');
}

/**
 * View counts for /admin Stats: per item (all time, since `since30`, since `since60`), views per
 * day since `dailySince` (days without views are left out), and the first day counted. All dates
 * are `YYYY-MM-DD`. Resolves `{ available: false }` when migration 009 isn't applied.
 */
export async function loadItemViewStats({ since30, since60, dailySince }) {
  const supabase = getSupabaseAdmin();
  const [summary, daily, started] = await Promise.all([
    supabase.rpc('item_view_summary', { p_since_30: since30, p_since_60: since60 }),
    supabase.rpc('item_view_daily', { p_since: dailySince }),
    supabase.rpc('item_views_started'),
  ]);
  const errors = [summary.error, daily.error, started.error].filter(Boolean);

  if (errors.some(isItemViewsSchemaError)) {
    return { available: false };
  }

  if (errors.length) {
    throw new Error(errors[0].message || 'Could not load item views.');
  }

  return {
    available: true,
    items: (summary.data ?? []).map((row) => ({
      itemId: row.item_id,
      total: Number(row.views_total) || 0,
      last30: Number(row.views_30) || 0,
      last60: Number(row.views_60) || 0,
    })),
    daily: (daily.data ?? []).map((row) => ({ day: row.day, views: Number(row.views) || 0 })),
    firstDay: typeof started.data === 'string' && started.data ? started.data : null,
  };
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
