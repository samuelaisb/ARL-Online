import en from '../../locales/en.json' with { type: 'json' };
import fr from '../../locales/fr.json' with { type: 'json' };

const dictionaries = { en, fr };
const META_MARKER = 'data-arl-seo';

export const PRODUCTION_SITE_ORIGIN = 'https://activistresourcelibrary.com';
export const DEFAULT_OG_IMAGE_PATH = '/assets/brand/apathy-is-boring-logo.png';

export const ROUTE_SEO_KEYS = {
  '/': {
    title: 'seo.home_title',
    description: 'seo.home_description',
  },
  '/equipment': {
    title: 'seo.category_equipment_title',
    description: 'seo.category_equipment_description',
  },
  '/books': {
    title: 'seo.category_books_title',
    description: 'seo.category_books_description',
  },
  '/rooms': {
    title: 'seo.category_rooms_title',
    description: 'seo.category_rooms_description',
  },
  '/howthisworks': {
    title: 'seo.how_this_works_title',
    description: 'seo.how_this_works_description',
  },
  '/about': {
    title: 'seo.about_title',
    description: 'seo.about_description',
  },
  '/admin': {
    title: 'seo.admin_title',
    description: 'seo.default_description',
    noindex: true,
  },
  '/account': {
    title: 'seo.account_title',
    description: 'seo.default_description',
    noindex: true,
  },
};

function lookup(dict, key) {
  const parts = key.split('.');
  let value = dict;

  for (const part of parts) {
    if (value == null || typeof value !== 'object') {
      return undefined;
    }
    value = value[part];
  }

  return value;
}

function translateLocale(localeCode, key) {
  const dict = dictionaries[localeCode] ?? dictionaries.en;
  let value = lookup(dict, key);

  if (value === undefined) {
    value = lookup(dictionaries.en, key) ?? key;
  }

  return typeof value === 'string' ? value : key;
}

export function normalizeSeoPath(pathname) {
  const path = typeof pathname === 'string' ? pathname.replace(/\/$/, '') : '';
  return path || '/';
}

function readRuntimeSiteUrl() {
  if (typeof window !== 'undefined') {
    const runtime = window.__ARL_ENV__;
    if (runtime?.SITE_URL) {
      return String(runtime.SITE_URL).replace(/\/$/, '');
    }
  }

  const viteSiteUrl = import.meta.env?.SITE_URL || import.meta.env?.VITE_SITE_URL;
  if (viteSiteUrl) {
    return String(viteSiteUrl).replace(/\/$/, '');
  }

  return '';
}

export function getSiteOrigin() {
  const configured = readRuntimeSiteUrl();
  if (configured) return configured;

  if (typeof window !== 'undefined') {
    return window.location.origin;
  }

  return PRODUCTION_SITE_ORIGIN;
}

export function buildCanonicalUrl(pathname, origin = getSiteOrigin()) {
  const path = normalizeSeoPath(pathname);
  if (path === '/') {
    return `${origin}/`;
  }
  return `${origin}${path}`;
}

export function buildHreflangUrl(pathname, localeCode, origin = getSiteOrigin()) {
  const canonical = buildCanonicalUrl(pathname, origin);
  const separator = canonical.includes('?') ? '&' : '?';
  return `${canonical}${separator}lang=${localeCode}`;
}

export function truncateSeoDescription(text, maxLength = 155) {
  const normalized = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

export function getItemDetailPath(item) {
  const tag = item?.tag || 'equipment';
  const slug = item?.slug;

  if (!slug) {
    return tag === 'equipment' ? '/' : `/${tag}`;
  }

  return `/${tag}/${slug}`;
}

export function getItemSeoConfig(item, localeCode = 'en', origin = getSiteOrigin()) {
  const path = getItemDetailPath(item);
  const title = `${item.title} | ${translateLocale(localeCode, 'seo.og_site_name')}`;
  const description = truncateSeoDescription(item.body);
  let ogImageUrl = `${origin}${DEFAULT_OG_IMAGE_PATH}`;

  if (typeof item.image === 'string' && item.image.trim()) {
    const image = item.image.trim();
    if (image.startsWith('data:')) {
      ogImageUrl = `${origin}${DEFAULT_OG_IMAGE_PATH}`;
    } else if (image.startsWith('http://') || image.startsWith('https://')) {
      ogImageUrl = image;
    } else if (image.startsWith('/')) {
      ogImageUrl = `${origin}${image}`;
    }
  }

  return {
    title,
    description,
    path,
    canonicalUrl: buildCanonicalUrl(path, origin),
    ogImageUrl,
    ogType: 'product',
    ogSiteName: translateLocale(localeCode, 'seo.og_site_name'),
    twitterCard: translateLocale(localeCode, 'seo.twitter_card'),
    locale: localeCode,
    noindex: false,
  };
}

export function getProductJsonLd(item, origin = getSiteOrigin()) {
  const path = getItemDetailPath(item);
  let image = `${origin}${DEFAULT_OG_IMAGE_PATH}`;

  if (typeof item.image === 'string' && item.image.trim()) {
    const itemImage = item.image.trim();
    if (itemImage.startsWith('data:')) {
      image = `${origin}${DEFAULT_OG_IMAGE_PATH}`;
    } else if (itemImage.startsWith('http://') || itemImage.startsWith('https://')) {
      image = itemImage;
    } else if (itemImage.startsWith('/')) {
      image = `${origin}${itemImage}`;
    }
  }

  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: item.title,
    description: truncateSeoDescription(item.body, 500),
    image,
    url: buildCanonicalUrl(path, origin),
  };
}

export function getSeoForRoute(pathname, localeCode = 'en') {
  const path = normalizeSeoPath(pathname);
  const routeConfig = ROUTE_SEO_KEYS[path];
  const titleKey = routeConfig?.title ?? 'seo.default_title';
  const descriptionKey = routeConfig?.description ?? 'seo.default_description';
  const origin = getSiteOrigin();

  return {
    title: translateLocale(localeCode, titleKey),
    description: translateLocale(localeCode, descriptionKey),
    path,
    canonicalUrl: buildCanonicalUrl(path, origin),
    ogImageUrl: `${origin}${DEFAULT_OG_IMAGE_PATH}`,
    ogType: translateLocale(localeCode, 'seo.og_type'),
    ogSiteName: translateLocale(localeCode, 'seo.og_site_name'),
    twitterCard: translateLocale(localeCode, 'seo.twitter_card'),
    locale: localeCode,
    noindex: Boolean(routeConfig?.noindex),
  };
}

export function getOrganizationJsonLd(origin = getSiteOrigin()) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: translateLocale('en', 'seo.og_site_name'),
    url: origin,
    logo: `${origin}${DEFAULT_OG_IMAGE_PATH}`,
    parentOrganization: {
      '@type': 'Organization',
      name: 'Apathy is Boring',
      url: 'https://www.apathyisboring.com',
    },
  };
}

export function getFaqJsonLd(localeCode = 'en') {
  const faqItems =
    lookup(dictionaries[localeCode], 'how_this_works.faq') ??
    lookup(dictionaries.en, 'how_this_works.faq');

  if (!Array.isArray(faqItems) || faqItems.length === 0) {
    return null;
  }

  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqItems.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer,
      },
    })),
  };
}

function upsertHeadElement(selector, create) {
  if (typeof document === 'undefined') return null;

  let element = document.head.querySelector(selector);

  if (!element) {
    element = create();
    element.setAttribute(META_MARKER, 'true');
    document.head.appendChild(element);
  }

  return element;
}

export function upsertMeta(name, content) {
  if (typeof document === 'undefined' || !content) return;

  const element = upsertHeadElement(`meta[name="${name}"]`, () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', name);
    return meta;
  });

  element.setAttribute('content', content);
}

export function upsertMetaProperty(property, content) {
  if (typeof document === 'undefined' || !content) return;

  const element = upsertHeadElement(`meta[property="${property}"]`, () => {
    const meta = document.createElement('meta');
    meta.setAttribute('property', property);
    return meta;
  });

  element.setAttribute('content', content);
}

export function upsertLink(rel, href, extraAttributes = {}) {
  if (typeof document === 'undefined' || !href) return;

  const attributeSelector = Object.entries(extraAttributes)
    .map(([key, value]) => `[${key}="${value}"]`)
    .join('');

  const element = upsertHeadElement(`link[rel="${rel}"]${attributeSelector}`, () => {
    const link = document.createElement('link');
    link.setAttribute('rel', rel);
    for (const [key, value] of Object.entries(extraAttributes)) {
      link.setAttribute(key, value);
    }
    return link;
  });

  element.setAttribute('href', href);
  for (const [key, value] of Object.entries(extraAttributes)) {
    element.setAttribute(key, value);
  }
}

export function setRobotsMeta(content = 'noindex, nofollow') {
  upsertMeta('robots', content);
}

export function clearRobotsMeta() {
  if (typeof document === 'undefined') return;

  document.head.querySelectorAll('meta[name="robots"][data-arl-seo]').forEach((element) => {
    element.remove();
  });
}

export function upsertJsonLd(id, data) {
  if (typeof document === 'undefined' || !data) return;

  const scriptId = `arl-jsonld-${id}`;
  let element = document.getElementById(scriptId);

  if (!element) {
    element = document.createElement('script');
    element.type = 'application/ld+json';
    element.id = scriptId;
    element.setAttribute(META_MARKER, 'true');
    document.head.appendChild(element);
  }

  element.textContent = JSON.stringify(data);
}

export function removeJsonLd(id) {
  if (typeof document === 'undefined') return;

  const element = document.getElementById(`arl-jsonld-${id}`);
  if (element) {
    element.remove();
  }
}

export function clearHreflangTags() {
  if (typeof document === 'undefined') return;

  document.head
    .querySelectorAll(`link[rel="alternate"][hreflang][${META_MARKER}]`)
    .forEach((element) => element.remove());
}

export function applyHreflangTags(pathname, origin = getSiteOrigin()) {
  if (typeof document === 'undefined') return;

  clearHreflangTags();

  const locales = ['en', 'fr'];
  for (const localeCode of locales) {
    upsertLink('alternate', buildHreflangUrl(pathname, localeCode, origin), {
      hreflang: localeCode,
    });
  }

  upsertLink('alternate', buildHreflangUrl(pathname, 'en', origin), {
    hreflang: 'x-default',
  });
}

export function applySeoTags(seo) {
  if (typeof document === 'undefined' || !seo) return;

  document.title = seo.title;

  upsertMeta('description', seo.description);
  upsertLink('canonical', seo.canonicalUrl);

  upsertMetaProperty('og:title', seo.title);
  upsertMetaProperty('og:description', seo.description);
  upsertMetaProperty('og:url', seo.canonicalUrl);
  upsertMetaProperty('og:type', seo.ogType);
  upsertMetaProperty('og:site_name', seo.ogSiteName);
  upsertMetaProperty('og:image', seo.ogImageUrl);
  upsertMetaProperty('og:locale', seo.locale === 'fr' ? 'fr_CA' : 'en_CA');

  upsertMeta('twitter:card', seo.twitterCard);
  upsertMeta('twitter:title', seo.title);
  upsertMeta('twitter:description', seo.description);
  upsertMeta('twitter:image', seo.ogImageUrl);
}

export function buildSeoHeadHtml(seo, pathname, localeCode, origin, escapeHtml, options = {}) {
  const {
    includeJsonLd = true,
    plausibleDomain = '',
    productJsonLd = null,
  } = options;

  if (!seo || !escapeHtml) return '';

  const tags = [];

  tags.push(`<title>${escapeHtml(seo.title)}</title>`);
  tags.push(`<meta name="description" content="${escapeHtml(seo.description)}" />`);
  tags.push(`<link rel="canonical" href="${escapeHtml(seo.canonicalUrl)}" />`);

  if (seo.noindex) {
    tags.push('<meta name="robots" content="noindex, nofollow" />');
  }

  tags.push(`<meta property="og:title" content="${escapeHtml(seo.title)}" />`);
  tags.push(`<meta property="og:description" content="${escapeHtml(seo.description)}" />`);
  tags.push(`<meta property="og:url" content="${escapeHtml(seo.canonicalUrl)}" />`);
  tags.push(`<meta property="og:type" content="${escapeHtml(seo.ogType)}" />`);
  tags.push(`<meta property="og:site_name" content="${escapeHtml(seo.ogSiteName)}" />`);
  tags.push(`<meta property="og:image" content="${escapeHtml(seo.ogImageUrl)}" />`);
  tags.push(
    `<meta property="og:locale" content="${escapeHtml(seo.locale === 'fr' ? 'fr_CA' : 'en_CA')}" />`,
  );

  tags.push(`<meta name="twitter:card" content="${escapeHtml(seo.twitterCard)}" />`);
  tags.push(`<meta name="twitter:title" content="${escapeHtml(seo.title)}" />`);
  tags.push(`<meta name="twitter:description" content="${escapeHtml(seo.description)}" />`);
  tags.push(`<meta name="twitter:image" content="${escapeHtml(seo.ogImageUrl)}" />`);

  const path = normalizeSeoPath(pathname);
  for (const hreflang of ['en', 'fr']) {
    const href = buildHreflangUrl(path, hreflang, origin);
    tags.push(
      `<link rel="alternate" hreflang="${hreflang}" href="${escapeHtml(href)}" />`,
    );
  }
  tags.push(
    `<link rel="alternate" hreflang="x-default" href="${escapeHtml(buildHreflangUrl(path, 'en', origin))}" />`,
  );

  if (includeJsonLd && !seo.noindex) {
    if (productJsonLd) {
      tags.push(
        `<script type="application/ld+json">${JSON.stringify(productJsonLd)}</script>`,
      );
    }

    const jsonLd = getOrganizationJsonLd(origin);
    tags.push(
      `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`,
    );

    if (path === '/howthisworks') {
      const faqJsonLd = getFaqJsonLd(localeCode);
      if (faqJsonLd) {
        tags.push(
          `<script type="application/ld+json">${JSON.stringify(faqJsonLd)}</script>`,
        );
      }
    }
  }

  if (plausibleDomain) {
    tags.push(
      `<script defer data-domain="${escapeHtml(plausibleDomain)}" src="https://plausible.io/js/script.js"></script>`,
    );
  }

  return tags.join('\n    ');
}
