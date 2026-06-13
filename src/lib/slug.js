/**
 * Convert an item title into a URL slug (lowercase, hyphen-separated).
 */
export function slugifyTitle(title) {
  if (typeof title !== 'string') {
    return 'item';
  }

  const slug = title
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);

  return slug || 'item';
}

/**
 * Return a slug unique within `existingSlugs` (appends -2, -3, … on collision).
 */
export function ensureUniqueSlug(baseSlug, existingSlugs = []) {
  const taken = new Set(
    (existingSlugs ?? []).filter((value) => typeof value === 'string' && value.trim()),
  );
  const base = baseSlug || 'item';

  if (!taken.has(base)) {
    return base;
  }

  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) {
    suffix += 1;
  }

  return `${base}-${suffix}`;
}
