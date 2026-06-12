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

  if (!authSubscription) {
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      session.set(newSession);
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

export async function signUpWithEmail(email, password, { signedMemberAgreement = false } = {}) {
  if (!supabase) throw new Error('Auth is not configured.');
  const redirectTo = getAuthRedirectUrl();
  const options = {
    data: {
      signed_member_agreement: signedMemberAgreement,
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

export async function signOut() {
  if (!supabase) throw new Error('Auth is not configured.');
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
  session.set(null);
}
