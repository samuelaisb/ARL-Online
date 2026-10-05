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

const AUTH_ERROR_PARAMS = ['error', 'error_code', 'error_description'];

/**
 * Reads and strips an auth error Supabase appended to the URL (cancelled OAuth consent,
 * provider without an email, expired confirmation link). supabase-js leaves these in the
 * URL and never surfaces them, so capture them before the client initializes.
 */
function takeAuthCallbackError() {
  if (typeof window === 'undefined') return '';
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  const source = [hash, url.searchParams].find((params) =>
    AUTH_ERROR_PARAMS.some((key) => params.has(key)),
  );
  if (!source) return '';

  const message = source.get('error_description') || source.get('error') || '';
  for (const key of AUTH_ERROR_PARAMS) {
    source.delete(key);
  }
  if (source === hash) {
    const rest = hash.toString();
    url.hash = rest ? `#${rest}` : '';
  }
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  return message.replace(/\+/g, ' ');
}

/** Auth error message from the redirect that loaded this page, if any. */
export const authCallbackError = supabaseConfigured ? takeAuthCallbackError() : '';

export const supabase = supabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

/** Public auth settings (which OAuth providers are enabled in the Supabase dashboard). */
export async function fetchAuthSettings() {
  if (!supabaseConfigured) return null;
  const response = await fetch(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/settings`, {
    headers: { apikey: supabaseAnonKey },
  });
  if (!response.ok) {
    throw new Error(`Auth settings request failed (${response.status})`);
  }
  return response.json();
}
