import { writable } from 'svelte/store';

function normalizePath(pathname) {
  const path = pathname.replace(/\/$/, '');
  return path || '/';
}

function getPath() {
  return normalizePath(window.location.pathname);
}

export const path = writable(typeof window !== 'undefined' ? getPath() : '/');

export function navigate(to) {
  const next = normalizePath(to.startsWith('/') ? to : `/${to}`);
  if (next === getPath()) {
    path.set(next);
    return;
  }
  window.history.pushState({}, '', next);
  path.set(next);
}

export function isAdminRoute(pathname) {
  return normalizePath(pathname) === '/admin';
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    path.set(getPath());
  });
}
