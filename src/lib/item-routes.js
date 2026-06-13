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
};

export const ITEM_ROUTE_RE = /^\/(equipment|books|rooms)\/([^/]+)$/;

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

  return '/';
}
