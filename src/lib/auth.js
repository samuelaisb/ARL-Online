import { derived, writable } from 'svelte/store';
import {
  authCallbackError,
  fetchAuthSettings,
  getAuthRedirectUrl,
  supabase,
  supabaseConfigured,
} from './supabase.js';

export const session = writable(null);
export const authReady = writable(false);

/** OAuth providers the UI knows how to show, in display order. */
export const OAUTH_PROVIDERS = ['google', 'discord'];
export const OAUTH_PROVIDER_NAMES = { google: 'Google', discord: 'Discord' };

/** Subset of OAUTH_PROVIDERS enabled in Supabase → Authentication → Providers. */
export const oauthProviders = writable([]);

/** Error message from an OAuth / email-link redirect that loaded this page ('' when none). */
export const authRedirectError = authCallbackError;

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

export async function initAuth() {
  if (!supabaseConfigured || !supabase) {
    authReady.set(true);
    return;
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
      }
    });
    authSubscription = listener.subscription;
  }

  authReady.set(true);
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

export async function signOut() {
  if (!supabase) throw new Error('Auth is not configured.');
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
  session.set(null);
}
