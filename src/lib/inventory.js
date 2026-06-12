import { translateKey } from './i18n.js';
import { supabase, supabaseConfigured } from './supabase.js';

const LEGACY_STORAGE_KEY = 'arl-inventory-items';

export const INVENTORY_TAGS = ['equipment', 'books', 'rooms'];
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

export async function createReservation(itemId, { startDate, endDate }) {
  const response = await fetch(`/api/inventory/${encodeURIComponent(itemId)}/reservations`, {
    method: 'POST',
    headers: await authHeaders(true),
    body: JSON.stringify({ startDate, endDate }),
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

export async function approveReservation(itemId, reservationId) {
  const response = await fetch(
    `/api/inventory/${encodeURIComponent(itemId)}/reservations/${encodeURIComponent(reservationId)}/approve`,
    { method: 'POST', headers: await authHeaders() },
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || translateKey('admin.approve_reservation_error'));
  }

  return result;
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
