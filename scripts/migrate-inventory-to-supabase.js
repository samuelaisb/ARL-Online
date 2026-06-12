#!/usr/bin/env node
/**
 * One-time import of data/inventory.json into Supabase (upsert by id).
 * Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and applied SQL migration.
 *
 * Usage: npm run migrate:inventory
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { upsertInventoryFromJson } from '../src/lib/inventory-store.js';
import { assertSupabaseAdminConfigured } from '../src/lib/supabase-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVENTORY_FILE = path.join(__dirname, '..', 'data', 'inventory.json');

async function main() {
  assertSupabaseAdminConfigured();

  let raw;
  try {
    raw = await fs.readFile(INVENTORY_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(`No file at ${INVENTORY_FILE}. Nothing to migrate.`);
      process.exit(1);
    }
    throw error;
  }

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    console.error('inventory.json must contain a JSON array.');
    process.exit(1);
  }

  const result = await upsertInventoryFromJson(parsed);
  console.log(
    `Upserted ${result.inserted} item(s)` +
      (result.reservations ? ` and ${result.reservations} reservation(s).` : '.'),
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
