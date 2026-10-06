import { derived, writable } from 'svelte/store';
import {
  isAuthError,
  isAuthRetryableFetchError,
  isAuthSessionMissingError,
  isAuthWeakPasswordError,
} from '@supabase/supabase-js';
import { categoryToPath, getItemRouteParams } from './item-routes.js';
import {
  PASSWORD_RESET_RETURN_PARAM,
  authCallbackError,
  authCallbackPasswordReset,
  authCallbackRecovery,
  fetchAuthSettings,
  getAuthRedirectUrl,
  supabase,
  supabaseConfigured,
} from './supabase.js';

export const session = writable(null);
export const authReady = writable(false);

/** Sign-up and new-password minimum (keep `auth.password_min_length` / `auth.password_hint` in sync). */
export const PASSWORD_MIN_LENGTH = 8;

/**
 * Which new-password dialog `SetPasswordModal` shows: 'recovery' after a reset link signs
 * the member in, 'change' from /account, null when closed. A reset link sets it before
 * the session lands, so `CompleteSignupModal` waits instead of stacking on top.
 */
export const passwordPrompt = writable(authCallbackRecovery ? 'recovery' : null);

export function openPasswordChange() {
  passwordPrompt.set('change');
}

export function closePasswordPrompt() {
  passwordPrompt.set(null);
}

/** True when the account has an email/password login, so Change password applies. */
export function userHasPasswordLogin(user) {
  if (!user) {
    return false;
  }
  const providers = user.app_metadata?.providers ?? [user.app_metadata?.provider];
  return (
    providers.includes('email') ||
    (user.identities ?? []).some((identity) => identity.provider === 'email')
  );
}

/** OAuth providers the UI knows how to show, in display order. */
export const OAUTH_PROVIDERS = ['google', 'discord'];
export const OAUTH_PROVIDER_NAMES = { google: 'Google', discord: 'Discord' };

/** Subset of OAUTH_PROVIDERS enabled in Supabase → Authentication → Providers. */
export const oauthProviders = writable([]);

/** Error message from an OAuth / email-link redirect that loaded this page ('' when none). */
export const authRedirectError = authCallbackError;

/** True when that redirect came from a password-reset email (`initAuth` reports its failure). */
export const authRedirectFromPasswordReset = authCallbackPasswordReset;

/**
 * OAuth sign-up skips the register form, so accounts created through a provider must
 * sign the member agreement after they land back on the site. Email accounts signed it
 * at registration (older ones predate the flag and are left alone).
 */
export function userNeedsMemberAgreement(user) {
  if (!user || user.user_metadata?.signed_member_agreement === true) {
    return false;
  }
  return (user.app_metadata?.provider ?? 'email') !== 'email';
}

export const needsMemberAgreement = derived(session, ($session) =>
  userNeedsMemberAgreement($session?.user),
);

const APATHY_ADMIN_DOMAIN = '@apathyisboring.com';

/** True when the signed-in user's email is an @apathyisboring.com address. */
export function isApathyAdmin(sessionValue) {
  const email = sessionValue?.user?.email?.trim();
  if (!email) {
    return false;
  }
  return email.toLowerCase().endsWith(APATHY_ADMIN_DOMAIN);
}

const PENDING_OAUTH_SIGNUP_KEY = 'arl-pending-oauth-signup';
const PENDING_OAUTH_SIGNUP_MAX_AGE_MS = 30 * 60 * 1000;

function savePendingOAuthSignup(data) {
  try {
    sessionStorage.setItem(PENDING_OAUTH_SIGNUP_KEY, JSON.stringify({ ...data, savedAt: Date.now() }));
  } catch {
    // storage disabled: the member agreement prompt after sign-in covers it
  }
}

function takePendingOAuthSignup() {
  try {
    const raw = sessionStorage.getItem(PENDING_OAUTH_SIGNUP_KEY);
    sessionStorage.removeItem(PENDING_OAUTH_SIGNUP_KEY);
    const pending = raw ? JSON.parse(raw) : null;
    if (!pending || Date.now() - pending.savedAt > PENDING_OAUTH_SIGNUP_MAX_AGE_MS) {
      return null;
    }
    return pending;
  } catch {
    return null;
  }
}

/** Saves agreement + opt-in choices made in the register form before an OAuth redirect. */
async function applyPendingOAuthSignup(user) {
  const pending = takePendingOAuthSignup();
  if (!pending?.signedMemberAgreement || !userNeedsMemberAgreement(user)) {
    return;
  }
  try {
    await completeMemberAgreement({ emailUpdatesOptIn: pending.emailUpdatesOptIn === true });
  } catch (error) {
    console.error('Failed to save member agreement after OAuth sign-up:', error);
  }
}

async function loadOAuthProviders() {
  try {
    const settings = await fetchAuthSettings();
    const external = settings?.external ?? {};
    oauthProviders.set(OAUTH_PROVIDERS.filter((provider) => external[provider] === true));
  } catch (error) {
    console.error('Failed to load auth providers:', error);
    oauthProviders.set([]);
  }
}

let authSubscription = null;
/** Prevents duplicate POSTs when sign-up, SIGNED_IN, and initAuth fire together. */
let welcomeEmailRequestedForUserId = null;

async function requestWelcomeEmail() {
  if (!supabaseConfigured || !supabase) {
    return;
  }

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    return;
  }

  try {
    await fetch('/api/auth/welcome-email', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    console.error('Welcome email request failed:', error);
  }
}

function maybeRequestWelcomeEmail(user) {
  const userId = user?.id;
  if (!userId || user?.user_metadata?.welcome_email_sent) {
    return;
  }
  if (welcomeEmailRequestedForUserId === userId) {
    return;
  }
  welcomeEmailRequestedForUserId = userId;
  requestWelcomeEmail();
}

/**
 * Resolves to `{ passwordResetLinkFailed }`: true when this page came from a reset email
 * whose link had expired or was already used, so the caller can offer a new one.
 */
export async function initAuth() {
  if (!supabaseConfigured || !supabase) {
    authReady.set(true);
    return { passwordResetLinkFailed: false };
  }

  let passwordResetLinkFailed = authCallbackPasswordReset && Boolean(authCallbackError);
  if (authCallbackRecovery) {
    // The client started initialize() itself; awaiting it again returns how reading the
    // recovery session from the URL went. On failure any stored session (possibly another
    // account) stays signed in, so don't offer it a new password.
    const { error: recoveryError } = await supabase.auth.initialize();
    if (recoveryError) {
      console.warn('Password recovery link was not accepted:', recoveryError.message);
      passwordPrompt.set(null);
      passwordResetLinkFailed = true;
    }
  }

  const { data, error } = await supabase.auth.getSession();
  if (error) {
    console.error('Failed to get auth session:', error);
  }
  session.set(data.session);

  loadOAuthProviders();

  if (data.session?.user) {
    maybeRequestWelcomeEmail(data.session.user);
    applyPendingOAuthSignup(data.session.user);
  }

  if (!authSubscription) {
    const { data: listener } = supabase.auth.onAuthStateChange((event, newSession) => {
      session.set(newSession);
      if (event === 'SIGNED_IN' && newSession?.user) {
        maybeRequestWelcomeEmail(newSession.user);
        // Supabase calls inside this callback can deadlock its auth lock; defer them.
        setTimeout(() => applyPendingOAuthSignup(newSession.user), 0);
      } else if (event === 'PASSWORD_RECOVERY' && newSession?.user && authCallbackRecovery) {
        // supabase-js relays auth events to the site's other tabs; only the tab that opened
        // the reset link asks for a new password (the one that requested it may still show
        // the log-in dialog, and the prompt would never clear there).
        passwordPrompt.set('recovery');
      } else if (event === 'SIGNED_OUT') {
        passwordPrompt.set(null);
      }
    });
    authSubscription = listener.subscription;
  }

  authReady.set(true);
  return { passwordResetLinkFailed };
}

export async function signInWithEmail(email, password) {
  if (!supabase) throw new Error('Auth is not configured.');
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  session.set(data.session);
  return data;
}

export async function signUpWithEmail(
  email,
  password,
  { signedMemberAgreement = false, emailUpdatesOptIn = false } = {},
) {
  if (!supabase) throw new Error('Auth is not configured.');
  const redirectTo = getAuthRedirectUrl();
  const options = {
    data: {
      signed_member_agreement: signedMemberAgreement,
      email_updates_opt_in: emailUpdatesOptIn,
    },
  };
  if (redirectTo) {
    options.emailRedirectTo = redirectTo;
  }
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options,
  });
  if (error) throw error;
  if (data.session) {
    session.set(data.session);
  }
  return data;
}

/**
 * Redirects to the provider's consent screen; Supabase sends the browser back to the
 * current page with a session. `signedMemberAgreement` / `emailUpdatesOptIn` carry the
 * register form's choices across the redirect.
 */
export async function signInWithOAuthProvider(
  provider,
  { signedMemberAgreement = false, emailUpdatesOptIn = false } = {},
) {
  if (!supabase) throw new Error('Auth is not configured.');
  if (!OAUTH_PROVIDERS.includes(provider)) throw new Error('Unsupported sign-in provider.');

  if (signedMemberAgreement) {
    savePendingOAuthSignup({ signedMemberAgreement: true, emailUpdatesOptIn });
  } else {
    takePendingOAuthSignup();
  }

  // Return to the page the visitor started from (it must match a Supabase redirect URL,
  // otherwise Supabase falls back to the Site URL).
  const redirectTo = `${window.location.origin}${window.location.pathname}${window.location.search}`;
  const { error } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo } });
  if (error) {
    takePendingOAuthSignup();
    throw error;
  }
}

/** Records the member agreement (and email-updates choice) on the signed-in user. */
export async function completeMemberAgreement({ emailUpdatesOptIn = false } = {}) {
  if (!supabase) throw new Error('Auth is not configured.');
  const { error } = await supabase.auth.updateUser({
    data: { signed_member_agreement: true, email_updates_opt_in: emailUpdatesOptIn },
  });
  if (error) throw error;
  const { data } = await supabase.auth.getSession();
  session.set(data.session);
}

/**
 * Where a reset email returns the member: the current page without `?reserve` (an item
 * page becomes its category, since the item overlay would cover the new-password dialog),
 * flagged with PASSWORD_RESET_RETURN_PARAM. Like OAuth, it must match a Supabase
 * redirect URL, otherwise Supabase falls back to the Site URL.
 */
function passwordResetReturnUrl() {
  const url = new URL(window.location.href);
  url.hash = '';
  url.searchParams.delete('reserve');
  const itemRoute = getItemRouteParams(url.pathname);
  if (itemRoute) {
    url.pathname = categoryToPath(itemRoute.tag);
  }
  url.searchParams.set(PASSWORD_RESET_RETURN_PARAM, '1');
  return url.toString();
}

/** Asks Supabase to email a reset link. Supabase answers the same whether or not the account exists. */
export async function requestPasswordReset(email) {
  if (!supabase) throw new Error('Auth is not configured.');
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: passwordResetReturnUrl(),
  });
  if (error) throw error;
}

/** Sets a new password on the signed-in account (reset-link session or /account). */
export async function updatePassword(password) {
  if (!supabase) throw new Error('Auth is not configured.');
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
}

const RATE_LIMIT_CODES = ['over_email_send_rate_limit', 'over_request_rate_limit'];
const SESSION_ERROR_CODES = [
  'bad_jwt',
  'session_expired',
  'session_not_found',
  'refresh_token_not_found',
  'refresh_token_already_used',
  'user_not_found',
];

function isRateLimitError(error) {
  return error?.status === 429 || RATE_LIMIT_CODES.includes(error?.code);
}

/** Network failure, gateway error, or a server error such as Supabase failing to send mail. */
function isRequestFailure(error) {
  return !isAuthError(error) || isAuthRetryableFetchError(error) || error.status >= 500;
}

/**
 * `$t` key for a failed reset request, or '' when the caller should show the neutral
 * "if an account exists" confirmation anyway. Only rate limits, a malformed address and
 * requests that never got an email out are reported. Supabase's message is English, so
 * it is only logged.
 */
export function passwordResetErrorKey(error) {
  if (isRateLimitError(error)) {
    return 'auth.rate_limited';
  }
  if (error?.code === 'email_address_invalid' || error?.code === 'validation_failed') {
    return 'auth.enter_valid_email';
  }
  if (isRequestFailure(error) || error?.code === 'email_address_not_authorized') {
    console.error('Password reset email failed:', error);
    return 'auth.reset_send_failed';
  }
  console.warn('Password reset request returned an error:', error?.code || error?.message);
  return '';
}

/** `$t` key for a failed `updatePassword`. */
export function passwordUpdateErrorKey(error) {
  const code = error?.code;
  if (isAuthWeakPasswordError(error) || code === 'weak_password') {
    return 'auth.password_weak';
  }
  if (code === 'same_password') {
    return 'auth.password_same';
  }
  if (code === 'reauthentication_needed' || code === 'reauthentication_not_valid') {
    return 'auth.password_reauth_needed';
  }
  if (isRateLimitError(error)) {
    return 'auth.rate_limited';
  }
  if (isAuthSessionMissingError(error) || error?.status === 401 || SESSION_ERROR_CODES.includes(code)) {
    return 'auth.password_session_expired';
  }
  console.error('Password update failed:', error);
  return 'auth.password_update_failed';
}

export async function signOut() {
  if (!supabase) throw new Error('Auth is not configured.');
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
  session.set(null);
}
