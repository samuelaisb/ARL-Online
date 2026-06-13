import { writable } from 'svelte/store';
import { slugifyTitle } from './slug.js';

import {
  categoryToPath,
  getCategoryFromPath,
  getItemRouteParams,
  isInventoryHomePath,
  isItemDetailRoute,
  ITEM_ROUTE_RE,
  normalizePath,
  CATEGORY_ROUTES,
} from './item-routes.js';

export {
  categoryToPath,
  getCategoryFromPath,
  getItemRouteParams,
  isInventoryHomePath,
  isItemDetailRoute,
  ITEM_ROUTE_RE,
  CATEGORY_ROUTES,
};

export function itemToPathexport function itemToPath(item) {
  const tag = item?.tag || DEFAULT_CATEGORY;
  const slug = resolveItemSlug(item);

  return `/${tag}/${slug}`;
}

/**
 * Resolve a usable slug for an item. Prefers the server-provided slug; falls back
 * to a client-generated slug from the title so navigation never collapses to a
 * category path (which would silently no-op the Reserve flow). The real fix is the
 * server-side slug backfill — this is a defensive net for stale/null slug data.
 */
export function resolveItemSlug(item) {
  const slug = item?.slug;

  if (typeof slug === 'string' && slug.trim()) {
    return slug.trim();
  }

  return slugifyTitle(item?.title);
}

export function navigate(to) {
  const next = normalizePath(to.startsWith('/') ? to : `/${to}`);
  if (next === getPath()) {
    path.set(next);
    return;
  }
  window.history.pushState({}, '', next);
  path.set(next);
}

// Marks a history entry as an item-overlay push, so closeItemOverlay can decide
// between history.back() (return to the inventory entry we came from) and a fresh
// navigate() to the category (deep link / refresh, where there is no prior entry).
const ITEM_OVERLAY_STATE = { arlItemOverlay: true };

function isItemOverlayEntry() {
  return Boolean(window.history.state?.arlItemOverlay);
}

export function navigateToItem(item) {
  if (typeof window === 'undefined') {
    return;
  }

  const url = new URL(itemToPath(item), window.location.origin);
  preserveLangParam(url);

  const target = url.pathname + url.search;
  if (url.pathname === getPath()) {
    path.set(url.pathname);
    return;
  }

  window.history.pushState(ITEM_OVERLAY_STATE, '', target);
  path.set(url.pathname);
}

// Closes the item overlay and keeps the URL in sync. When we arrived via an
// in-app push (history.state marker present) we step back so the grid entry is
// restored; otherwise (deep link / refresh) we push the category path.
export function closeItemOverlay(tag) {
  if (typeof window === 'undefined') {
    return;
  }

  if (isItemOverlayEntry() && window.history.length > 1) {
    window.history.back();
    return;
  }

  navigate(categoryToPath(tag));
}

const RESERVE_QUERY = 'reserve';

export function hasReserveIntent(search) {
  if (search == null) {
    if (typeof window === 'undefined') {
      return false;
    }
    search = window.location.search;
  }

  const value = new URLSearchParams(search).get(RESERVE_QUERY);
  return value === '1' || value === 'true';
}

function preserveLangParam(url) {
  if (typeof window === 'undefined') {
    return;
  }

  const lang = new URLSearchParams(window.location.search).get('lang');
  if (lang === 'en' || lang === 'fr') {
    url.searchParams.set('lang', lang);
  }
}

export function setReserveIntent() {
  if (typeof window === 'undefined') {
    return;
  }

  const url = new URL(window.location.href);
  if (url.searchParams.get(RESERVE_QUERY) === '1') {
    return;
  }

  url.searchParams.set(RESERVE_QUERY, '1');
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
}

export function clearReserveIntent() {
  if (typeof window === 'undefined') {
    return;
  }

  const url = new URL(window.location.href);
  if (!url.searchParams.has(RESERVE_QUERY)) {
    return;
  }

  url.searchParams.delete(RESERVE_QUERY);
  const query = url.searchParams.toString();
  window.history.replaceState(
    window.history.state,
    '',
    url.pathname + (query ? `?${query}` : '') + url.hash,
  );
}

export function navigateToItemWithReserve(item) {
  if (typeof window === 'undefined') {
    return;
  }

  const url = new URL(itemToPath(item), window.location.origin);
  url.searchParams.set(RESERVE_QUERY, '1');
  preserveLangParam(url);

  const target = url.pathname + url.search;
  const pathOnly = url.pathname;

  if (pathOnly === getPath()) {
    // Already on the item detail page — ensure ?reserve=1 is in the URL so
    // tryOpenReserveFromQuery() can detect the intent via window.location.search.
    if (!hasReserveIntent()) {
      window.history.replaceState(window.history.state, '', target);
    }
    path.set(pathOnly);
    return;
  }

  window.history.pushState(ITEM_OVERLAY_STATE, '', target);
  path.set(pathOnly);
}

export function isAdminRoute(pathname) {
  return normalizePath(pathname) === '/admin';
}

export function isHowThisWorksRoute(pathname) {
  return normalizePath(pathname) === '/howthisworks';
}

export function isAboutRoute(pathname) {
  return normalizePath(pathname) === '/about';
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    path.set(getPath());
  });
}
