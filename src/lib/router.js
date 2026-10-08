import { tick } from 'svelte';
import { get, writable } from 'svelte/store';
import { slugifyTitle } from './slug.js';
import {
  categoryToPath,
  isCategoryPath,
  isItemDetailRoute,
  normalizePath,
} from './item-routes.js';

// Also used by the server (SEO injection, catch-all 404s) and auth.js, so one copy.
export {
  CATEGORY_ROUTES,
  ITEM_ROUTE_RE,
  categoryToPath,
  getCategoryFromPath,
  getItemRouteParams,
  isCategoryPath,
  isItemDetailRoute,
  isKnownAppPath,
} from './item-routes.js';

const DEFAULT_CATEGORY = 'equipment';

/** Where the "Inventory" nav link and the "Back to inventory" links go. */
export const INVENTORY_PATH = categoryToPath(DEFAULT_CATEGORY);

function getPath() {
  return normalizePath(window.location.pathname);
}

export const path = writable(typeof window !== 'undefined' ? getPath() : '/');

export function itemToPath(item) {
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

/** True while a route change waits for the next page's code to load (App shows the hairline). */
export const pageLoading = writable(false);

// App.svelte's lazy-page loader: starts loading the page a path shows and returns a
// promise, or null when that page can render straight away.
let loadPage = () => null;

export function setPageLoader(loader) {
  loadPage = loader;
}

// Bumped by every route change, so a page that is still loading doesn't open once a
// newer change (another click, Back) has come in.
let routeChange = 0;

/**
 * Every route change goes through here; `apply` updates the URL and the path store.
 * While the next page's code loads, the current page stays on screen with the
 * hairline, so its title band never drops out. A failed load still applies, and
 * App's {:catch} shows the reload notice. Page-to-page changes then morph across
 * (morphPage). With nothing to load and nothing to morph, `apply` runs synchronously.
 * Resolves to true once the new route is in the DOM, false if a newer change won.
 */
async function changeRoute(next, apply, { morph = true } = {}) {
  const change = ++routeChange;
  // The page already showing (a deep link still loading its chunk) has its own pending branch.
  const loading = next === get(path) ? null : loadPage(next);
  if (loading) {
    pageLoading.set(true);
    await loading.catch(() => {});
    if (change !== routeChange) {
      return false;
    }
  }
  pageLoading.set(false);

  if (!morph || !shouldMorph(get(path), next)) {
    apply();
    return true;
  }

  return morphPage(() => {
    if (change !== routeChange) {
      return false;
    }
    apply();
    return true;
  });
}

// The item overlay is a dialog with its own entrance, and the category tabs share one page.
function shouldMorph(from, to) {
  return (
    typeof document.startViewTransition === 'function' &&
    document.visibilityState === 'visible' &&
    from !== to &&
    !isItemDetailRoute(from) &&
    !isItemDetailRoute(to) &&
    !(isCategoryPath(from) && isCategoryPath(to))
  );
}

/** Takes a band that is out of view out of the morph, so it doesn't fly in from (or off to) above. */
function unnameOffscreenBand() {
  const band = document.querySelector('.page-header');
  if (!band) {
    return null;
  }

  const rect = band.getBoundingClientRect();
  if (rect.bottom > 0 && rect.top < window.innerHeight) {
    return null;
  }
  band.style.viewTransitionName = 'none';
  return band;
}

/**
 * Runs `update` as a view transition: the title band (`view-transition-name: page-band`
 * in app.css) morphs from the old page's colour, height and title into the new one's,
 * and the rest of the page cross-fades. A band scrolled out of view (a footer link)
 * just fades instead. Browsers without view transitions never get here.
 */
async function morphPage(update) {
  const oldBand = unnameOffscreenBand();
  let applied = false;
  let newBand = null;
  const transition = document.startViewTransition(async () => {
    applied = update();
    await tick();
    newBand = unnameOffscreenBand();
  });

  // `ready` rejects when the transition is skipped (a newer one started); the update
  // still runs. `finished` rejects only along with updateCallbackDone, awaited below.
  transition.ready.catch(() => {});
  transition.finished
    .catch(() => {})
    .then(() => {
      oldBand?.style.removeProperty('view-transition-name');
      newBand?.style.removeProperty('view-transition-name');
    });

  await transition.updateCallbackDone;
  return applied;
}

/**
 * Go to `to`. `toTop` also scrolls to the top, in the same update as the new page.
 * Returns changeRoute's promise.
 */
export function navigate(to, { toTop = false } = {}) {
  const next = normalizePath(to.startsWith('/') ? to : `/${to}`);
  return changeRoute(next, () => {
    if (next !== getPath()) {
      window.history.pushState({}, '', next);
    }
    if (toTop) {
      window.scrollTo(0, 0);
    }
    path.set(next);
  });
}

/** True for a click the app should route itself: left button, no modifier key (those open a new tab or window). */
export function isPlainLeftClick(event) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * navigate() to another page and start it like a fresh load: scroll to the top and
 * focus its main heading, since the clicked link has usually unmounted (leaving focus
 * on <body>) or, in the site footer, stays at the bottom of the page. A heading can
 * render a moment after the page (the auth gates on /account and /admin), so poll
 * briefly for it (a timer, not requestAnimationFrame, which stalls in background
 * tabs). Gives up if the route changes or focus moves somewhere else in the meantime.
 */
export async function navigateToPage(to) {
  const startedFrom = document.activeElement;
  if (!(await navigate(to, { toTop: true }))) {
    return;
  }
  await tick();

  const routePath = get(path);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const active = document.activeElement;
    const focusMoved =
      active && active !== startedFrom && active !== document.body && active.isConnected;
    if (get(path) !== routePath || focusMoved) {
      return;
    }

    const heading = document.querySelector('#main-content h1');
    if (heading) {
      // Most page headings have no tabindex, and focus() does nothing without one.
      if (!heading.hasAttribute('tabindex')) {
        heading.setAttribute('tabindex', '-1');
      }
      heading.focus({ preventScroll: true });
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * navigate() to a `/page#section` link, keeping the hash in the URL. The page brings
 * the section into view and focuses it, on mount or on `hashchange` (AboutPage's
 * `#contact`). On the same page this is a plain fragment change, which keeps `?lang`.
 */
export function navigateToSection(to) {
  const url = new URL(to, window.location.origin);
  const next = normalizePath(url.pathname);
  return changeRoute(next, () => {
    if (next !== getPath()) {
      window.history.pushState({}, '', next + url.hash);
      path.set(next);
    } else if (window.location.hash === url.hash) {
      // Already at that hash: setting it again neither scrolls nor fires hashchange.
      const here = window.location.href;
      window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: here, newURL: here }));
    } else {
      window.location.hash = url.hash;
    }
  });
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
  changeRoute(url.pathname, () => {
    if (url.pathname !== getPath()) {
      window.history.pushState(ITEM_OVERLAY_STATE, '', target);
    }
    path.set(url.pathname);
  });
}

// Closes the item overlay and keeps the URL in sync. When we arrived via an
// in-app push (history.state marker present) we step back so the grid entry is
// restored. Otherwise (deep link, refresh, OAuth return) we replace the item entry
// with the category path: a push would leave the item one Back away, and Android
// Chrome's system Back (a dialog close request) would then reopen the overlay.
export function closeItemOverlay(tag) {
  if (typeof window === 'undefined') {
    return;
  }

  if (isItemOverlayEntry() && window.history.length > 1) {
    window.history.back();
    return;
  }

  const url = new URL(categoryToPath(tag), window.location.origin);
  preserveLangParam(url);
  changeRoute(url.pathname, () => {
    window.history.replaceState({}, '', url.pathname + url.search);
    path.set(url.pathname);
  });
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

  changeRoute(pathOnly, () => {
    if (pathOnly !== getPath()) {
      window.history.pushState(ITEM_OVERLAY_STATE, '', target);
    } else if (!hasReserveIntent()) {
      // Already on the item detail page — ensure ?reserve=1 is in the URL so
      // tryOpenReserveFromQuery() can detect the intent via window.location.search.
      window.history.replaceState(window.history.state, '', target);
    }
    path.set(pathOnly);
  });
}

export function isHomeRoute(pathname) {
  return normalizePath(pathname) === '/';
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

export function isPrivacyRoute(pathname) {
  return normalizePath(pathname) === '/privacy';
}

export function isAccountRoute(pathname) {
  return normalizePath(pathname) === '/account';
}

if (typeof window !== 'undefined') {
  // Back and Forward swap without the morph: the browser restores the scroll position
  // right after popstate, which must land on the page it belongs to, not the old one.
  window.addEventListener('popstate', () => {
    const next = getPath();
    changeRoute(next, () => path.set(next), { morph: false });
  });
}
