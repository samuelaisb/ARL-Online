import {
  buildSeoHeadHtml,
  getItemSeoConfig,
  getProductJsonLd,
  getSeoForRoute,
  normalizeSeoPath,
  ROUTE_SEO_KEYS,
} from './seo.js';
import { getItemRouteParams } from './router.js';

const SUPPORTED_LOCALES = ['en', 'fr'];

/** Paths that receive server-injected SEO meta (mirrors client ROUTE_SEO_KEYS). */
export const ROUTE_META = Object.keys(ROUTE_SEO_KEYS);

export function resolveRequestLocale(req) {
  const queryLang = typeof req.query?.lang === 'string' ? req.query.lang.trim().toLowerCase() : '';

  if (SUPPORTED_LOCALES.includes(queryLang)) {
    return queryLang;
  }

  const acceptLanguage = req.headers['accept-language'];
  if (typeof acceptLanguage === 'string' && acceptLanguage.toLowerCase().includes('fr')) {
    return 'fr';
  }

  return 'en';
}

export function shouldInjectSeo(pathname) {
  const path = normalizeSeoPath(pathname);
  return path !== '/api' && !path.startsWith('/api/');
}

export async function injectSeoIntoHtml(
  html,
  pathname,
  localeCode,
  origin,
  escapeHtml,
  options = {},
) {
  if (!html || typeof html !== 'string') {
    return html;
  }

  const { findItemBySlug, ...headOptions } = options;
  const itemParams = getItemRouteParams(pathname);
  let seo = getSeoForRoute(pathname, localeCode);
  let productJsonLd = null;

  if (itemParams && typeof findItemBySlug === 'function') {
    try {
      const item = await findItemBySlug(itemParams.tag, itemParams.slug);

      if (item) {
        seo = getItemSeoConfig(item, localeCode, origin);
        productJsonLd = getProductJsonLd(item, origin);
      }
    } catch (error) {
      console.error('Failed to load item SEO metadata:', error);
    }
  }

  const headInjection = buildSeoHeadHtml(seo, pathname, localeCode, origin, escapeHtml, {
    ...headOptions,
    productJsonLd,
  });

  if (!headInjection) {
    return html;
  }

  return html.replace('</head>', `    ${headInjection}\n  </head>`);
}
