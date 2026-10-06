import { createHash } from 'crypto';

/**
 * Uploaded photos (books, rooms, mentors) are stored as data URLs in
 * `inventory_items.image`. They leave the server as `/media/items/{id}/{hash}.{ext}`
 * URLs instead, served by `GET /media/items/:id/:file` with a one-year immutable
 * cache. The hash is taken over the stored data URL, so a new photo gets a new URL.
 * Server-only (uses Node `crypto`).
 */
export const ITEM_MEDIA_BASE = '/media/items';

/** Longest data URL accepted on upload (about 1.5 MB of image bytes). */
export const IMAGE_DATA_URL_MAX_LENGTH = 2_000_000;

const IMAGE_EXTENSIONS_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const IMAGE_DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/;

/** `{ mime, extension, base64 }` for a JPEG, PNG, WebP or GIF data URL; null otherwise (SVG included). */
export function parseImageDataUrl(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const match = IMAGE_DATA_URL_RE.exec(value);
  const extension = match ? IMAGE_EXTENSIONS_BY_MIME[match[1]] : undefined;

  if (!extension) {
    return null;
  }

  return { mime: match[1], extension, base64: match[2] };
}

export function isOversizedImageDataUrl(value) {
  return (
    typeof value === 'string' &&
    value.startsWith('data:') &&
    value.length > IMAGE_DATA_URL_MAX_LENGTH
  );
}

/** True for a data URL the write paths may store: one of the four types, within the size cap. */
export function isStorableImageDataUrl(value) {
  return !isOversizedImageDataUrl(value) && parseImageDataUrl(value) !== null;
}

/** `{hash}.{ext}` for a stored image data URL, or null when it is not one. */
export function itemMediaFileName(dataUrl) {
  const parsed = parseImageDataUrl(dataUrl);

  if (!parsed) {
    return null;
  }

  const hash = createHash('sha256').update(dataUrl).digest('hex').slice(0, 16);
  return `${hash}.${parsed.extension}`;
}

function itemMediaPrefix(itemId) {
  return `${ITEM_MEDIA_BASE}/${encodeURIComponent(itemId)}/`;
}

/** Public URL for an item's photo: data URLs become `/media/items/...`; anything else is returned as is. */
export function publicItemImageUrl(item) {
  const image = item?.image;
  const fileName = itemMediaFileName(image);

  if (!fileName || typeof item.id !== 'string' || !item.id) {
    return image;
  }

  return `${itemMediaPrefix(item.id)}${fileName}`;
}

/** Copy of `item` whose `image` is its public URL. Use on every response that carries an item. */
export function withPublicItemImage(item) {
  return item ? { ...item, image: publicItemImageUrl(item) } : item;
}

function itemMediaPathname(value) {
  if (typeof value !== 'string') {
    return '';
  }

  let pathname = value.trim();

  if (/^https?:\/\//i.test(pathname)) {
    try {
      pathname = new URL(pathname).pathname;
    } catch {
      return '';
    }
  }

  return pathname.startsWith(`${ITEM_MEDIA_BASE}/`) ? pathname : '';
}

/** True for a `/media/items/...` path (or an absolute URL to one). These are never stored. */
export function isItemMediaUrl(value) {
  return itemMediaPathname(value) !== '';
}

/**
 * True when a client sent back this item's own `/media/items/{id}/...` URL, which
 * means "photo unchanged" (clients may echo the URL they were given).
 */
export function isItemMediaUrlForItem(value, itemId) {
  const pathname = itemMediaPathname(value);
  return Boolean(pathname && typeof itemId === 'string' && itemId) && pathname.startsWith(itemMediaPrefix(itemId));
}
