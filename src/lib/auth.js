import { writable } from 'svelte/store';
import { supabase, supabaseConfigured, getAuthRedirectUrl } from './supabase.js';

export const session = writable(null);
export const authReady = writable(false);

const APATHY_ADMIN_DOMAIN = '@apathyisboring.com';

/** True when the signed-in user's email is an @apathyisboring.com address. */
export function isApathyAdmin(sessionValue) {
  const email = sessionValue?.user?.email?.trim();
  if (!email) {
    return false;
  }
  return email.toLowerCase().endsWith(APATHY_ADMIN_DOMAIN);
}

let authSubscription = null;

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
  if (!user?.user_metadata?.welcome_email_sent) {
    requestWelcomeEmail();
  }
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

  if (data.session?.user) {
    maybeRequestWelcomeEmail(data.session.user);
  }

  if (!authSubscription) {
    const { data: listener } = supabase.auth.onAuthStateChange((event, newSession) => {
      session.set(newSession);
      if (event === 'SIGNED_IN' && newSession?.user) {
        maybeRequestWelcomeEmail(newSession.user);
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
    maybeRequestWelcomeEmail(data.session.user);
  }
  return data;
}

export async function signOut() {
  if (!supabase) throw new Error('Auth is not configured.');
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
  session.set(null);
}
