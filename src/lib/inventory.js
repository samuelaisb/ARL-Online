const LEGACY_STORAGE_KEY = 'arl-inventory-items';

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
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

export async function fetchInventory() {
  const response = await fetch('/api/inventory');
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || 'Could not load inventory.');
  }

  return Array.isArray(result.items) ? result.items : [];
}

export async function createInventoryItem(item) {
  const response = await fetch('/api/inventory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || 'Could not save inventory item.');
  }

  return result.item;
}

export async function deleteInventoryItem(id) {
  const response = await fetch(`/api/inventory/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || 'Could not delete inventory item.');
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
    const item = await createInventoryItem(legacyItem);
    migratedItems.push(item);
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

export async function reserveInventoryItem(item) {
  const response = await fetch('/api/reserve-inventory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item }),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || 'Failed to send reservation email.');
  }

  return result;
}
