import { createClient } from '@supabase/supabase-js';

function readRuntimeEnv() {
  if (typeof window === 'undefined') return null;
  const runtime = window.__ARL_ENV__;
  return runtime && typeof runtime === 'object' ? runtime : null;
}

const runtimeEnv = readRuntimeEnv();

const supabaseUrl =
  runtimeEnv?.SUPABASE_URL ||
  import.meta.env.SUPABASE_URL ||
  import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey =
  runtimeEnv?.SUPABASE_API ||
  import.meta.env.SUPABASE_API ||
  import.meta.env.SUPABASE_ANON_KEY ||
  import.meta.env.VITE_SUPABASE_ANON_KEY;

const configuredSiteUrl = (
  runtimeEnv?.SITE_URL || import.meta.env.SITE_URL || import.meta.env.VITE_SITE_URL || ''
).replace(/\/$/, '');

/** URL Supabase should redirect to after email confirmation (and similar auth flows). */
export function getAuthRedirectUrl() {
  if (configuredSiteUrl) return configuredSiteUrl;
  if (typeof window !== 'undefined') return window.location.origin;
  return '';
}

export const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = supabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;
