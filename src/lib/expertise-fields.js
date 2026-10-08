/** Mentor name on a self-serve expertise profile. */
export const EXPERT_NAME_MAX = 120;

/** Short blurb on the Expertise list. Stored as inventory_items.body. */
export const EXPERT_SHORT_TEXT_MAX = 180;

/** Long bio shown when an expert is opened. Stored as inventory_items.long_body. */
export const EXPERT_LONG_TEXT_MAX = 4000;

/** Optional note an expert adds when booking a follow-up. Stored as reservations.request_summary. */
export const FOLLOW_UP_NOTE_MAX = 1000;

/**
 * List text vs overlay text.
 * New items store them separately. Older bios keep a short first paragraph in
 * `body`, then a blank line, then the long text — that split is used until
 * `longBody` is set.
 */
export function splitExpertiseCopy(item) {
  const body = typeof item?.body === 'string' ? item.body.trim() : '';
  const longBody = typeof item?.longBody === 'string' ? item.longBody.trim() : '';

  if (longBody) {
    return { shortText: body, longText: longBody };
  }

  const parts = body.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);

  if (parts.length > 1) {
    return {
      shortText: parts[0],
      longText: parts.slice(1).join('\n\n'),
    };
  }

  return { shortText: body, longText: body };
}
