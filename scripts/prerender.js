#!/usr/bin/env node
/**
 * Build-time prerender for static marketing/category routes (Tier 2 SEO).
 * Runs after `vite build`; copies dist/index.html with route-specific injected meta.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  buildSeoHeadHtml,
  getSeoForRoute,
  PRODUCTION_SITE_ORIGIN,
} from '../src/lib/seo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '..', 'dist');
const SOURCE_HTML = path.join(DIST_DIR, 'index.html');

const PRERENDER_ROUTES = ['/howthisworks', '/about', '/equipment', '/books', '/rooms'];

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function prerenderRoute(routePath, templateHtml, origin) {
  const seo = getSeoForRoute(routePath, 'en');
  const headInjection = buildSeoHeadHtml(seo, routePath, 'en', origin, escapeHtml, {
    includeJsonLd: true,
  });

  const html = templateHtml.replace('</head>', `    ${headInjection}\n  </head>`);
  const outputDir =
    routePath === '/'
      ? DIST_DIR
      : path.join(DIST_DIR, ...routePath.split('/').filter(Boolean));
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, 'index.html'), html, 'utf8');
}

async function main() {
  const templateHtml = await fs.readFile(SOURCE_HTML, 'utf8');
  const origin = (
    process.env.SITE_URL ||
    process.env.VITE_SITE_URL ||
    PRODUCTION_SITE_ORIGIN
  ).replace(/\/$/, '');

  for (const routePath of PRERENDER_ROUTES) {
    await prerenderRoute(routePath, templateHtml, origin);
    console.log(`Prerendered ${routePath} → dist${routePath === '/' ? '' : routePath}/index.html`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
