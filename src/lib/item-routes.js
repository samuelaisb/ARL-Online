/** Path parsing for inventory and item detail URLs (no browser / Svelte deps). */

const DEFAULT_CATEGORY = 'equipment';

export function normalizePath(pathname) {
  const path = pathname.replace(/\/$/, '');
  return path || '/';
}

export const CATEGORY_ROUTES = {
  '/equipment': 'equipment',
  '/books': 'books',
  '/rooms': 'rooms',
  '/expertise': 'expertise',
};

export const ITEM_ROUTE_RE = /^\/(equipment|books|rooms|expertise)\/([^/]+)$/;

export function getItemRouteParams(pathname) {
  const normalized = normalizePath(pathname);
  const match = normalized.match(ITEM_ROUTE_RE);

  if (!match) {
    return null;
  }

  return {
    tag: match[1],
    slug: decodeURIComponent(match[2]),
  };
}

export function isItemDetailRoute(pathname) {
  return getItemRouteParams(pathname) !== null;
}

export function getCategoryFromPath(pathname) {
  const normalized = normalizePath(pathname);

  if (isItemDetailRoute(normalized)) {
    return null;
  }

  if (normalized === '/') {
    return DEFAULT_CATEGORY;
  }

  return CATEGORY_ROUTES[normalized] ?? null;
}

export function isInventoryHomePath(pathname) {
  const normalized = normalizePath(pathname);
  return normalized === '/' || normalized in CATEGORY_ROUTES;
}

/** Non-item paths App.svelte renders a page for (see the route checks in router.js). */
export const APP_PAGE_PATHS = [
  '/',
  ...Object.keys(CATEGORY_ROUTES),
  '/howthisworks',
  '/about',
  '/privacy',
  '/account',
  '/admin',
];

/**
 * True for a page path or a `/{tag}/{slug}` item path (the slug may still not
 * exist). Everything else is a 404: the server sends status 404 and the client
 * renders its not-found view.
 */
export function isKnownAppPath(pathname) {
  const normalized = normalizePath(pathname);
  return APP_PAGE_PATHS.includes(normalized) || isItemDetailRoute(normalized);
}

export function categoryToPath(tag) {
  if (tag === 'equipment') {
    return '/';
  }

  if (tag === 'books') {
    return '/books';
  }

  if (tag === 'rooms') {
    return '/rooms';
  }

  if (tag === 'expertise') {
    return '/expertise';
  }

  return '/';
}
