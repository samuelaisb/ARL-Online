// Where links and emails point: the site origin, item page URLs and the email addresses the
// server sends from, replies to and receives the contact form at. Read from the environment once,
// at startup. Server only.

import { PRODUCTION_SITE_ORIGIN } from '../src/lib/seo.js';
import { slugifyTitle } from '../src/lib/slug.js';

const LEGACY_RESEND_FROM = 'onboarding@resend.dev';
const DEFAULT_EMAIL_FROM = 'noreply@activistresourcelibrary.com';

function resolveEmailFrom() {
  const configured = process.env.EMAIL_FROM?.trim();

  if (configured && configured !== LEGACY_RESEND_FROM) {
    return configured;
  }

  return DEFAULT_EMAIL_FROM;
}

export const FROM = resolveEmailFrom();
// The contact form's inbox. activistresourcelibrary.com receives no mail, so every other app
// email sets Reply-To to EMAIL_REPLY_TO (default: this inbox).
export const CONTACT_TO = 'samuel@apathyisboring.com';
export const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO?.trim() || CONTACT_TO;
export const SITE_URL = (process.env.SITE_URL || process.env.VITE_SITE_URL || '').replace(/\/$/, '');
export const EMAIL_SITE_ORIGIN = SITE_URL || PRODUCTION_SITE_ORIGIN;

export function absoluteSiteUrl(pathOrUrl) {
  if (!pathOrUrl) {
    return EMAIL_SITE_ORIGIN;
  }

  if (/^https?:\/\//i.test(pathOrUrl)) {
    return pathOrUrl;
  }

  const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
  return `${EMAIL_SITE_ORIGIN}${path}`;
}

export function itemPagePath(item) {
  const tag = typeof item?.tag === 'string' && item.tag.trim() ? item.tag.trim() : 'equipment';
  const slug =
    typeof item?.slug === 'string' && item.slug.trim() ? item.slug.trim() : slugifyTitle(item?.title);

  return `/${tag}/${encodeURIComponent(slug)}`;
}

export function itemPageUrl(item) {
  return absoluteSiteUrl(itemPagePath(item));
}
