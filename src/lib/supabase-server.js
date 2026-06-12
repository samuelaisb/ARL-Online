import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';

let adminClient = null;

export const supabaseAdminConfigured = Boolean(supabaseUrl && serviceRoleKey);

export function assertSupabaseAdminConfigured() {
  if (!supabaseAdminConfigured) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for inventory storage. ' +
        'Apply supabase/migrations/001_inventory.sql in your Supabase project, then set both in .env.',
    );
  }
}

/** Server-side Supabase client (service role — never expose to the browser). */
export function getSupabaseAdmin() {
  assertSupabaseAdminConfigured();

  if (!adminClient) {
    adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  return adminClient;
}
