import { Marked } from 'marked';

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function isExternalHref(href) {
  return /^https?:\/\//i.test(href);
}

/**
 * Markdown renderer for the site's own legal copy (member agreement, privacy
 * policy). `opensInNewTab(href)` decides which links get target="_blank".
 * Uses its own Marked instance so options never leak into other callers.
 */
export function createMarkdownRenderer({ opensInNewTab = isExternalHref } = {}) {
  return new Marked({
    gfm: true,
    breaks: true,
    renderer: {
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        const titleAttr = title ? ` title="${escapeAttribute(title)}"` : '';
        const targetAttrs = opensInNewTab(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
        return `<a href="${escapeAttribute(href)}"${titleAttr}${targetAttrs}>${text}</a>`;
      },
    },
  });
}
