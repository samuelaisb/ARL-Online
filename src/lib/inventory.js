import { translateKey } from './i18n.js';
import { supabase, supabaseConfigured } from './supabase.js';

const LEGACY_STORAGE_KEY = 'arl-inventory-items';

export const INVENTORY_TAGS = ['equipment', 'books', 'rooms', 'expertise'];
export const DEFAULT_INVENTORY_TAG = 'equipment';

function loadLegacyLocalItems() {
  try {
    const stored = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!stored) {
      return [];
    }

    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function clearLegacyLocalItems() {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // private browsing or storage disabled
  }
}

async function authHeaders(includeJson = false) {
  const headers = {};

  if (includeJson) {
    headers['Content-Type'] = 'application/json';
  }

  if (supabaseConfigured && supabase) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  return headers;
}

export async function fetchInventoryItem(tag, slug) {
  const response = await fetch(
    `/api/inventory/by-slug/${encodeURIComponent(tag)}/${encodeURIComponent(slug)}`,
    { cache: 'no-store' },
  );
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }

    throw new Error(result.error || translateKey('inventory.load_error'));
  }

  return result.item ?? null;
}

export async function fetchInventory() {
  const response = await fetch('/api/inventory');
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || translateKey('inventory.load_error'));
  }

  return Array.isArray(result.items) ? result.items : [];
}

export async function fetchAdminInventory() {
  const response = await fetch('/api/admin/inventory', {
    headers: await authHeaders(),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || translateKey('inventory.load_error'));
  }

  return Array.isArray(result.items) ? result.items : [];
}

export async function createInventoryItem(item) {
  const response = await fetch('/api/inventory', {
    method: 'POST',
    headers: await authHeaders(true),
    body: JSON.stringify(item),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || translateKey('add_item.save_error'));
  }

  return result.item;
}

export async function fetchMentorProfile() {
  const response = await fetch('/api/account/mentor-profile', {
    headers: await authHeaders(),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || translateKey('share_expertise.load_error'));
  }

  return {
    profile: result.profile ?? null,
    emailConfirmed: result.emailConfirmed !== false,
  };
}

function mentorProfileError(response, result) {
  const error = new Error(result.error || translateKey('share_expertise.save_error'));
  error.status = response.status;
  error.profile = result.profile ?? null;
  return error;
}

export async function createMentorProfile(payload) {
  const response = await fetch('/api/account/mentor-profile', {
    method: 'POST',
    headers: await authHeaders(true),
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw mentorProfileError(response, result);
  }

  return result.profile;
}

export async function updateMentorProfile(payload) {
  const response = await fetch('/api/account/mentor-profile', {
    method: 'PATCH',
    headers: await authHeaders(true),
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw mentorProfileError(response, result);
  }

  return result.profile;
}

export async function updateExpertiseItem(id, item) {
  const response = await fetch(`/api/inventory/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: await authHeaders(true),
    body: JSON.stringify(item),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || translateKey('admin.mentors_save_error'));
  }

  return result.item;
}

export async function deleteInventoryItem(id) {
  const response = await fetch(`/api/inventory/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || translateKey('admin.delete_error'));
  }

  return result;
}

async function migrateLegacyLocalItems() {
  const legacyItems = loadLegacyLocalItems();
  if (legacyItems.length === 0) {
    return [];
  }

  const migratedItems = [];

  for (const legacyItem of legacyItems) {
    try {
      const item = await createInventoryItem(legacyItem);
      migratedItems.push(item);
    } catch (error) {
      console.error('Failed to migrate legacy inventory item:', error);
    }
  }

  clearLegacyLocalItems();
  return migratedItems;
}

export async function loadInventoryItems() {
  let items = await fetchInventory();

  if (items.length === 0) {
    items = await migrateLegacyLocalItems();
  }

  return items;
}

/**
 * Create a reservation request. Payload is either calendar dates
 * ({ startDate, endDate }) or a consultation request ({ timeSlots, summary })
 * for expertise items.
 */
export async function createReservation(itemId, payload) {
  const response = await fetch(`/api/inventory/${encodeURIComponent(itemId)}/reservations`, {
    method: 'POST',
    headers: await authHeaders(true),
    body: JSON.stringify(payload),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || translateKey('calendar.create_error'));
  }

  return result;
}

export async function deleteReservation(itemId, reservationId) {
  const response = await fetch(
    `/api/inventory/${encodeURIComponent(itemId)}/reservations/${encodeURIComponent(reservationId)}`,
    { method: 'DELETE', headers: await authHeaders() },
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || translateKey('calendar.delete_error'));
  }

  return result;
}

export async function approveReservation(itemId, reservationId, { meetingAt = null } = {}) {
  const response = await fetch(
    `/api/inventory/${encodeURIComponent(itemId)}/reservations/${encodeURIComponent(reservationId)}/approve`,
    meetingAt
      ? {
          method: 'POST',
          headers: await authHeaders(true),
          body: JSON.stringify({ meetingAt }),
        }
      : { method: 'POST', headers: await authHeaders() },
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || translateKey('admin.approve_reservation_error'));
  }

  return result;
}

/** Consultations for the signed-in user: `{ asMember, asExpert }`. */
export async function fetchAccountConsultations() {
  const response = await fetch('/api/account/consultations', {
    headers: await authHeaders(),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || translateKey('account_consultations.load_error'));
  }

  return {
    asMember: Array.isArray(result.asMember) ? result.asMember : [],
    asExpert: Array.isArray(result.asExpert) ? result.asExpert : [],
  };
}

/** Expert picks the meeting time; the server creates the Zoom meeting and emails both. */
export async function scheduleConsultation(reservationId, meetingAt) {
  const response = await fetch(`/api/consultations/${encodeURIComponent(reservationId)}/schedule`, {
    method: 'POST',
    headers: await authHeaders(true),
    body: JSON.stringify({ meetingAt }),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || translateKey('account_consultations.schedule_error'));
  }

  return result.consultation;
}

/** Member or expert cancels; the server deletes the Zoom meeting and emails both. */
export async function cancelConsultation(reservationId) {
  const response = await fetch(`/api/consultations/${encodeURIComponent(reservationId)}/cancel`, {
    method: 'POST',
    headers: await authHeaders(),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || translateKey('account_consultations.cancel_error'));
  }

  return result.consultation;
}

export async function refuseReservation(itemId, reservationId) {
  const response = await fetch(
    `/api/inventory/${encodeURIComponent(itemId)}/reservations/${encodeURIComponent(reservationId)}/refuse`,
    { method: 'POST', headers: await authHeaders() },
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || translateKey('admin.refuse_reservation_error'));
  }

  return result;
}
