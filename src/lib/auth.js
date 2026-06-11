import { writable } from 'svelte/store';
import { supabase, supabaseConfigured } from './supabase.js';

export const session = writable(null);
export const authReady = writable(false);

let authSubscription = null;

export async function initAuth() {
  if (!supabaseConfigured || !supabase) {
    authReady.set(true);
    return;
  }

  const { data } = await supabase.auth.getSession();
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

export async function signUpWithEmail(email, password) {
  if (!supabase) throw new Error('Auth is not configured.');
  const { data, error } = await supabase.auth.signUp({ email, password });
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
