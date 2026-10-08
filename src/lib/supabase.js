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
 * Query flag on the return URL of a password-reset email (see `requestPasswordReset` in
 * auth.js). Supabase's error redirect doesn't say which kind of email link failed, so
 * the flag is what tells an expired reset link apart from an expired sign-up link.
 */
export const PASSWORD_RESET_RETURN_PARAM = 'password_reset';

/**
 * Reads the auth redirect that loaded this page, before the client initializes:
 * - strips an auth error Supabase appended to the URL (cancelled OAuth consent, provider
 *   without an email, expired email link); supabase-js leaves these in the URL and never
 *   surfaces them;
 * - strips the password-reset flag;
 * - notes a recovery session in the hash (`type=recovery`), which supabase-js then reads.
 *   Its PASSWORD_RECOVERY event fires on a timer that can beat the auth listener;
 * - notes a sign-up confirmation session in the hash (`type=signup`), so Kimchi can say
 *   the email is confirmed. supabase-js strips the hash once it has read the session.
 */
function takeAuthCallback() {
  const result = { error: '', passwordReset: false, recovery: false, signupConfirmed: false };
  if (typeof window === 'undefined') return result;
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  result.recovery = hash.get('type') === 'recovery' && hash.has('access_token');
  result.signupConfirmed = hash.get('type') === 'signup' && hash.has('access_token');
  result.passwordReset = url.searchParams.has(PASSWORD_RESET_RETURN_PARAM);
  url.searchParams.delete(PASSWORD_RESET_RETURN_PARAM);

  const source = [hash, url.searchParams].find((params) =>
    AUTH_ERROR_PARAMS.some((key) => params.has(key)),
  );
  if (!source && !result.passwordReset) return result;

  if (source) {
    const message = source.get('error_description') || source.get('error') || '';
    result.error = message.replace(/\+/g, ' ');
    for (const key of AUTH_ERROR_PARAMS) {
      source.delete(key);
    }
    if (source === hash) {
      const rest = hash.toString();
      url.hash = rest ? `#${rest}` : '';
    }
  }
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  return result;
}

const authCallback = supabaseConfigured
  ? takeAuthCallback()
  : { error: '', passwordReset: false, recovery: false, signupConfirmed: false };

/** Auth error message from the redirect that loaded this page, if any. */
export const authCallbackError = authCallback.error;

/** True when this page was opened from a password-reset email (success or error). */
export const authCallbackPasswordReset = authCallback.passwordReset;

/** True when the URL carries a password-recovery session for supabase-js to read. */
export const authCallbackRecovery = authCallback.recovery;

/**
 * True when this page was opened from the sign-up confirmation email (its session is in the
 * hash). Only the implicit flow's `#type=signup` is recognised; see the PKCE note below.
 */
export const authCallbackSignupConfirmed = authCallback.signupConfirmed;

// Default options: implicit flow, so email links (confirmation, password reset) return
// tokens in the URL hash, which takeAuthCallback relies on (recovery and sign-up
// confirmation). Switching to PKCE (`?code=`) means updating it.
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
