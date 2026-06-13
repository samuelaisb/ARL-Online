#!/usr/bin/env node
/**
 * Populate slugs on existing inventory_items rows that have a null/empty slug.
 * Safe to run repeatedly (idempotent — only updates rows missing a slug).
 * Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and 004_inventory_slug.sql applied.
 *
 * Usage: npm run backfill:slugs
 */

import 'dotenv/config';
import { backfillMissingSlugs } from '../src/lib/inventory-store.js';
import { assertSupabaseAdminConfigured } from '../src/lib/supabase-server.js';

async function main() {
  assertSupabaseAdminConfigured();

  const count = await backfillMissingSlugs();
  console.log(
    count > 0
      ? `Backfilled ${count} inventory slug(s).`
      : 'All inventory items already have slugs. Nothing to backfill.',
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
